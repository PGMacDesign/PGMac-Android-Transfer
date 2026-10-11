import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import type { StateStore } from './stateStore.ts';
import type { AttachedDevice, ConnectResult, MdnsService } from './adb/parse.ts';
import { splitHostPort, transportOf } from './adb/parse.ts';
import type {
  BatteryInfo,
  Candidate,
  DeviceInfo,
  SessionSnapshot,
  SessionState,
  StartSessionResponse,
  StorageInfo,
  Transport,
} from '../shared/protocol.ts';

export interface SessionAdb {
  devices(): Promise<AttachedDevice[]>;
  mdnsServices(): Promise<MdnsService[]>;
  connect(addr: string, timeoutMs?: number): Promise<ConnectResult>;
  disconnect(serial: string): Promise<void>;
  getState(serial: string, timeoutMs?: number): Promise<string | null>;
  getprop(serial: string, key: string): Promise<string>;
  battery(serial: string): Promise<BatteryInfo | null>;
  storage(serial: string): Promise<StorageInfo | null>;
}

export interface SessionQueue {
  onDeviceLost(): void;
  onDeviceReady(): void;
  onSessionLost(): void;
  cancelAll(): Promise<void>;
  cancelDeviceJobs(): Promise<void>;
}

interface CandidateTarget {
  candidate: Candidate;
  /** Already attached to adb under this serial. */
  serial: string | null;
  /** `adb connect` target for WiFi devices that aren't attached yet. */
  connectAddr: string | null;
  host: string | null;
}

export interface SessionTiming {
  healthMs: number;
  statusMs: number;
  reconnectWindowMs: number;
  backoffMs: number[];
}

export const DEFAULT_TIMING: SessionTiming = {
  healthMs: 3000,
  statusMs: 30_000,
  reconnectWindowMs: 120_000,
  backoffMs: [1000, 2000, 3000, 5000, 8000, 10_000],
};

export interface SessionDeps {
  adb: SessionAdb;
  hub: Hub;
  store: StateStore;
  /** Read at each Start Session, so a changed setting applies without a restart. */
  defaultIp: () => string | null;
  timing?: Partial<SessionTiming>;
  now?: () => number;
}

const LEGACY_PORT = 5555;
const CONNECT_FAILED: ConnectResult = { ok: false, error: null };

/**
 * One device session at a time. Every async result is stamped with the generation it was
 * started in and dropped if a newer start/end has happened since.
 */
export class SessionManager {
  private readonly deps: SessionDeps;
  private readonly timing: SessionTiming;
  private readonly now: () => number;
  private queue: SessionQueue | null = null;

  private state: SessionState = 'idle';
  private gen = 0;
  private device: DeviceInfo | null = null;
  private battery: BatteryInfo | null = null;
  private storage: StorageInfo | null = null;
  private error: string | null = null;
  private reconnectDeadline: number | null = null;
  /** Why the latest reconnect attempt's `adb connect` failed, shown if reconnecting gives up. */
  private reconnectError: string | null = null;
  private host: string | null = null;

  private starting = false;
  private sessionCounter = 0;
  /**
   * One per connected stretch. Reconnecting keeps the session generation, so the
   * health/status loops check this instead; a refresh that outlives a drop then can't
   * schedule a second loop after the reconnect.
   */
  private loopEpoch = 0;
  private targets = new Map<string, CandidateTarget>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
  }

  attachQueue(queue: SessionQueue) {
    this.queue = queue;
  }

  /** Identifies the current device session; bumps on each new connect, not on reconnect. */
  get sessionId(): number {
    return this.sessionCounter;
  }

  get serial(): string | null {
    return this.state === 'connected' ? (this.device?.serial ?? null) : null;
  }

  isConnected() {
    return this.state === 'connected';
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      device: this.device ? { ...this.device } : null,
      battery: this.battery,
      storage: this.storage,
      error: this.error,
      reconnectDeadline: this.reconnectDeadline,
    };
  }

  private emit() {
    this.deps.hub.emit({ type: 'session', session: this.snapshot() });
  }

  private setState(s: SessionState) {
    this.state = s;
    this.emit();
  }

  // ------------------------------------------------------------ start / connect

  async start(): Promise<StartSessionResponse> {
    if (this.starting) throw new HttpError(409, 'Already looking for devices.', 'CONFLICT');
    this.starting = true;
    try {
      return await this.startInner();
    } finally {
      this.starting = false;
    }
  }

  private async startInner(): Promise<StartSessionResponse> {
    if (this.state === 'lost') await this.endLost();
    if (this.state !== 'idle') {
      throw new HttpError(409, 'A session is already active. End it first.', 'CONFLICT');
    }
    const gen = ++this.gen;
    this.error = null;
    const candidates = await this.discover();
    if (gen !== this.gen) throw new HttpError(409, 'Start Session was interrupted.', 'CONFLICT');

    const ip = this.deps.defaultIp();
    if (ip) {
      const matches = candidates.filter((c) => this.targets.get(c.id)?.host === ip);
      if (matches.length === 1) return this.connectAndReport(matches[0]!.id);
      if (matches.length === 0) {
        // Devices put into legacy `adb tcpip 5555` mode don't advertise over mDNS.
        const legacy = `${ip}:${LEGACY_PORT}`;
        // Short timeout: an unreachable host otherwise stalls Start Session for the full TCP timeout.
        const { ok } = await this.deps.adb.connect(legacy, 3000).catch(() => CONNECT_FAILED);
        if (gen !== this.gen)
          throw new HttpError(409, 'Start Session was interrupted.', 'CONFLICT');
        if (ok) {
          const id = `addr:${legacy}`;
          this.targets.set(id, {
            candidate: { id, model: null, address: legacy, transport: 'wifi', lastUsed: false },
            serial: legacy,
            connectAddr: null,
            host: ip,
          });
          return this.connectAndReport(id);
        }
      }
    }
    if (candidates.length === 1) return this.connectAndReport(candidates[0]!.id);
    if (candidates.length === 0) return { result: 'pair' };
    return { result: 'pick', candidates };
  }

  private async connectAndReport(id: string): Promise<StartSessionResponse> {
    const session = await this.connect(id);
    return { result: 'connected', session };
  }

  /** Lists attached devices plus WiFi devices advertising over mDNS, deduplicated. */
  async discover(): Promise<Candidate[]> {
    const [attached, services] = await Promise.all([
      this.deps.adb.devices().catch(() => [] as AttachedDevice[]),
      this.deps.adb.mdnsServices().catch(() => [] as MdnsService[]),
    ]);
    const last = this.deps.store.lastUsed;
    const targets = new Map<string, CandidateTarget>();
    const claimed = new Set<string>();

    for (const d of attached) {
      if (d.state !== 'device') continue;
      const hp = splitHostPort(d.serial);
      const svc = services.find(
        (s) =>
          s.kind === 'connect' &&
          ((hp && s.host === hp.host && s.port === hp.port) ||
            d.serial.startsWith(`${s.instance}.`)),
      );
      if (svc) claimed.add(svc.instance);
      const host = hp?.host ?? svc?.host ?? null;
      const id = `serial:${d.serial}`;
      targets.set(id, {
        candidate: {
          id,
          model: d.model,
          address: addressFor(d.transport, d.serial, svc),
          transport: d.transport,
          lastUsed: !!last && (last.serial === d.serial || (!!host && last.host === host)),
        },
        serial: d.serial,
        connectAddr: null,
        host,
      });
    }
    for (const s of services) {
      if (s.kind !== 'connect' || claimed.has(s.instance)) continue;
      claimed.add(s.instance);
      const addr = `${s.host}:${s.port}`;
      const id = `mdns:${s.instance}`;
      targets.set(id, {
        candidate: {
          id,
          model: last?.host === s.host ? last.model : null,
          address: addr,
          transport: 'wifi',
          lastUsed: last?.host === s.host,
        },
        serial: null,
        connectAddr: addr,
        host: s.host,
      });
    }
    this.targets = targets;
    return [...targets.values()].map((t) => t.candidate);
  }

  async connect(id: string): Promise<SessionSnapshot> {
    if (this.state !== 'idle') {
      throw new HttpError(409, 'A session is already active. End it first.', 'CONFLICT');
    }
    const target = this.targets.get(id);
    if (!target)
      throw new HttpError(
        404,
        'That device is no longer available. Start Session again.',
        'NOT_FOUND',
      );
    const gen = ++this.gen;
    this.error = null;
    this.setState('connecting');
    try {
      let serial = target.serial;
      if (!serial && target.connectAddr) {
        const res = await this.deps.adb.connect(target.connectAddr);
        if (!res.ok)
          throw new Error(
            res.error ??
              `Could not connect to ${target.connectAddr}. Is Wireless debugging still on?`,
          );
        serial = target.connectAddr;
      }
      if (!serial) throw new Error('That device has no usable address.');
      const state = await this.waitForDevice(serial, 10_000);
      if (state !== 'device') {
        throw new Error(
          state === 'unauthorized'
            ? 'The device has not authorized this computer. Accept the prompt on the phone.'
            : 'The device did not respond.',
        );
      }
      const info = await this.readDeviceInfo(serial, target.candidate.transport, target.host);
      if (gen !== this.gen) throw new HttpError(409, 'Connect was interrupted.', 'CONFLICT');
      this.device = info;
      this.host = target.host;
      this.sessionCounter++;
      this.error = null;
      this.setState('connected');
      void this.deps.store.setLastUsed({ serial, host: target.host, model: info.model });
      this.queue?.onDeviceReady();
      this.startLoops(gen);
      return this.snapshot();
    } catch (err) {
      if (gen === this.gen) {
        this.error = (err as Error).message;
        this.device = null;
        this.setState('idle');
      }
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, (err as Error).message, 'ADB');
    }
  }

  /**
   * After pairing: wait for the paired device's connect service, then connect to it.
   * `stillWanted` lets a cancelled or superseded pairing attempt stop before connecting.
   */
  async connectAfterPairing(
    host: string,
    stillWanted: () => boolean = () => true,
    timeoutMs = 20_000,
  ): Promise<SessionSnapshot> {
    const deadline = this.now() + timeoutMs;
    const abandoned = () =>
      new HttpError(409, 'Pairing was cancelled before the phone connected.', 'CONFLICT');
    while (this.now() < deadline) {
      if (!stillWanted()) throw abandoned();
      const cands = await this.discover();
      if (!stillWanted()) throw abandoned();
      const match = cands.find((c) => this.targets.get(c.id)?.host === host);
      if (match) {
        if (this.state === 'lost') await this.endLost();
        if (!stillWanted()) throw abandoned();
        return this.connect(match.id);
      }
      await sleep(1000);
    }
    throw new HttpError(
      504,
      'Paired, but the phone did not show up for connecting. Try Start Session.',
      'ADB',
    );
  }

  private async waitForDevice(serial: string, timeoutMs: number): Promise<string | null> {
    const deadline = this.now() + timeoutMs;
    let last: string | null = null;
    while (this.now() < deadline) {
      last = await this.deps.adb.getState(serial);
      if (last === 'device') return last;
      await sleep(500);
    }
    return last;
  }

  private async readDeviceInfo(
    serial: string,
    transport: Transport,
    host: string | null,
  ): Promise<DeviceInfo> {
    const [model, version] = await Promise.all([
      this.deps.adb.getprop(serial, 'ro.product.model').catch(() => ''),
      this.deps.adb.getprop(serial, 'ro.build.version.release').catch(() => ''),
    ]);
    const t = transportOf(serial) === 'usb' ? transport : transportOf(serial);
    return {
      serial,
      model: model || 'Android device',
      androidVersion: version ? `Android ${version}` : 'Android',
      transport: t,
      address: t === 'wifi' ? (splitHostPort(serial) ? serial : host) : null,
    };
  }

  // ------------------------------------------------------------ loops

  private schedule(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private startLoops(gen: number) {
    const epoch = ++this.loopEpoch;
    const current = () =>
      gen === this.gen && epoch === this.loopEpoch && this.state === 'connected';
    const health = async () => {
      if (!current() || !this.device) return;
      const st = await this.deps.adb.getState(this.device.serial);
      if (!current()) return;
      if (st === 'device') this.schedule(health, this.timing.healthMs);
      else this.enterReconnecting(gen);
    };
    const status = async () => {
      if (!current() || !this.device) return;
      await this.refreshStatus(gen);
      if (current()) this.schedule(status, this.timing.statusMs);
    };
    this.schedule(health, this.timing.healthMs);
    void status();
  }

  async refreshStatus(gen = this.gen) {
    const serial = this.device?.serial;
    if (!serial) return;
    const [battery, storage] = await Promise.all([
      this.deps.adb.battery(serial).catch(() => null),
      this.deps.adb.storage(serial).catch(() => null),
    ]);
    if (gen !== this.gen || this.device?.serial !== serial) return;
    this.battery = battery ?? this.battery;
    this.storage = storage ?? this.storage;
    this.emit();
  }

  private enterReconnecting(gen: number) {
    if (gen !== this.gen) return;
    this.clearTimers();
    this.loopEpoch++;
    this.reconnectDeadline = this.now() + this.timing.reconnectWindowMs;
    this.reconnectError = null;
    this.setState('reconnecting');
    this.queue?.onDeviceLost();
    this.schedule(() => this.giveUp(gen), this.timing.reconnectWindowMs);
    this.schedule(() => void this.attemptReconnect(gen, 0), this.timing.backoffMs[0] ?? 1000);
  }

  private async attemptReconnect(gen: number, n: number) {
    const stale = () => gen !== this.gen || this.state !== 'reconnecting';
    if (stale() || !this.device) return;
    const { serial, error } = await this.tryRecover(this.device);
    if (stale()) return;
    this.reconnectError = error;
    if (serial) {
      this.clearTimers();
      this.device = {
        ...this.device,
        serial,
        address: this.device.transport === 'wifi' ? serial : null,
      };
      this.reconnectDeadline = null;
      this.error = null;
      this.setState('connected');
      this.queue?.onDeviceReady();
      this.startLoops(gen);
      return;
    }
    const delays = this.timing.backoffMs;
    this.schedule(
      () => void this.attemptReconnect(gen, n + 1),
      delays[Math.min(n + 1, delays.length - 1)] ?? 10_000,
    );
  }

  /**
   * The serial the device is reachable at now, or null, with the reason a connect failed when
   * there is one worth showing. The port may have changed.
   */
  private async tryRecover(
    device: DeviceInfo,
  ): Promise<{ serial: string | null; error: string | null }> {
    if ((await this.deps.adb.getState(device.serial)) === 'device') {
      return { serial: device.serial, error: null };
    }
    if (device.transport !== 'wifi' || !this.host) return { serial: null, error: null };
    const services = await this.deps.adb.mdnsServices().catch(() => [] as MdnsService[]);
    const svc = services.find((s) => s.kind === 'connect' && s.host === this.host);
    const addrs = svc ? [`${svc.host}:${svc.port}`] : [];
    if (!addrs.includes(device.serial) && splitHostPort(device.serial)) addrs.push(device.serial);
    let error: string | null = null;
    for (const addr of addrs) {
      const res = await this.deps.adb.connect(addr).catch(() => CONNECT_FAILED);
      if (!res.ok) {
        error ??= res.error;
        continue;
      }
      if ((await this.deps.adb.getState(addr)) === 'device') return { serial: addr, error: null };
    }
    return { serial: null, error };
  }

  private giveUp(gen: number) {
    if (gen !== this.gen || this.state !== 'reconnecting') return;
    this.clearTimers();
    this.reconnectDeadline = null;
    this.error = this.reconnectError ?? `Lost connection to ${this.device?.model ?? 'the device'}.`;
    this.setState('lost');
    this.queue?.onSessionLost();
  }

  /** Manual Reconnect from the `lost` state. */
  reconnect(): SessionSnapshot {
    if (this.state !== 'lost' || !this.device) {
      throw new HttpError(409, 'There is no lost session to reconnect.', 'CONFLICT');
    }
    const gen = ++this.gen;
    this.reconnectDeadline = this.now() + this.timing.reconnectWindowMs;
    this.reconnectError = null;
    this.error = null;
    this.setState('reconnecting');
    this.schedule(() => this.giveUp(gen), this.timing.reconnectWindowMs);
    this.schedule(() => void this.attemptReconnect(gen, 0), 0);
    return this.snapshot();
  }

  // ------------------------------------------------------------ end

  /** End Session: everything in the queue is cancelled, device or not. */
  end(): Promise<SessionSnapshot> {
    return this.endWith(() => this.queue?.cancelAll());
  }

  /** Clears a lost session for a new one; transfers that don't use the device continue. */
  private endLost(): Promise<SessionSnapshot> {
    return this.endWith(() => this.queue?.cancelDeviceJobs());
  }

  private async endWith(cancel: () => Promise<void> | undefined): Promise<SessionSnapshot> {
    if (this.state === 'idle') return this.snapshot();
    ++this.gen;
    this.clearTimers();
    const device = this.device;
    this.setState('ending');
    await cancel();
    if (device?.transport === 'wifi') await this.deps.adb.disconnect(device.serial);
    this.device = null;
    this.battery = null;
    this.storage = null;
    this.host = null;
    this.error = null;
    this.reconnectDeadline = null;
    this.setState('idle');
    return this.snapshot();
  }

  /** For shutdown: stop all timers without touching the device. */
  dispose() {
    ++this.gen;
    this.clearTimers();
  }
}

function addressFor(transport: Transport, serial: string, svc: MdnsService | undefined): string {
  if (transport === 'usb') return 'USB';
  if (transport === 'emulator') return serial;
  if (svc) return `${svc.host}:${svc.port}`;
  return serial;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
