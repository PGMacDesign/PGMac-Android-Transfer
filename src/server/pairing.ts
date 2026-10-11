import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import type { MdnsService } from './adb/parse.ts';
import type { PairCodeRequest, PairingSnapshot, SessionSnapshot } from '../shared/protocol.ts';

export interface PairingAdb {
  mdnsServices(): Promise<MdnsService[]>;
  pair(addr: string, code: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface PairingSession {
  isConnected(): boolean;
  connectAfterPairing(host: string, stillWanted: () => boolean): Promise<SessionSnapshot>;
}

export interface PairingDeps {
  adb: PairingAdb;
  hub: Hub;
  session: PairingSession;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Info-level log lines. The server has no logger of its own, so this defaults to stdout. */
  log?: (line: string) => void;
}

interface Attempt {
  snap: PairingSnapshot;
  serviceName: string | null;
  /** The secret `adb pair` is given: the QR password, or the code the user typed. */
  password: string | null;
  timer: NodeJS.Timeout | null;
  /** How many `_adb-tls-pairing` services the last poll saw, so only changes are logged. */
  pairingSeen: number;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomToken = (n: number) =>
  Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

/**
 * Wireless debugging pairing. QR mode follows Android Studio's scheme: we show
 * `WIFI:T:ADB;S:<name>;P:<password>;;`, the phone advertises `_adb-tls-pairing` under that
 * name after scanning, and we run `adb pair` against it. Only one attempt is live at a time.
 */
export class PairingManager {
  private readonly deps: PairingDeps;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly logLine: (line: string) => void;
  private current: Attempt | null = null;

  constructor(deps: PairingDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
    this.pollMs = deps.pollMs ?? 1000;
    this.now = deps.now ?? Date.now;
    this.logLine = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Logs a line about attempt `a`. Its password is cut out of everything, including adb's own
   * error text, which can echo the command line it was given.
   */
  private log(a: Attempt, message: string) {
    const secret = a.password;
    const text = secret ? message.split(secret).join('[password]') : message;
    this.logLine(`[pairing ${a.snap.mode} ${a.snap.attemptId.slice(0, 8)}] ${text}`);
  }

  snapshot(): PairingSnapshot | null {
    return this.current ? { ...this.current.snap } : null;
  }

  private emit() {
    this.deps.hub.emit({ type: 'pairing', pairing: this.snapshot() });
  }

  private isLive(a: Attempt) {
    return this.current === a;
  }

  private update(a: Attempt, patch: Partial<PairingSnapshot>) {
    if (!this.isLive(a)) return;
    Object.assign(a.snap, patch);
    this.emit();
  }

  cancel() {
    const a = this.current;
    if (a?.timer) clearTimeout(a.timer);
    this.current = null;
    if (a) {
      this.log(a, `Cancelled (was ${a.snap.status})`);
      this.emit();
    }
  }

  async startQr(): Promise<PairingSnapshot> {
    this.cancel();
    const serviceName = `studio-${randomToken(10)}`;
    const password = randomToken(12);
    const qrSvg = await QRCode.toString(`WIFI:T:ADB;S:${serviceName};P:${password};;`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    const a: Attempt = {
      snap: {
        attemptId: randomUUID(),
        mode: 'qr',
        status: 'waiting',
        qrSvg,
        expiresAt: this.now() + this.timeoutMs,
        error: null,
        deviceName: null,
      },
      serviceName,
      password,
      timer: null,
      pairingSeen: 0,
    };
    this.current = a;
    this.log(a, `QR attempt started, waiting for _adb-tls-pairing service ${serviceName}`);
    this.emit();
    this.schedulePoll(a);
    return { ...a.snap };
  }

  private schedulePoll(a: Attempt) {
    a.timer = setTimeout(() => void this.poll(a), this.pollMs);
  }

  private async poll(a: Attempt) {
    if (!this.isLive(a) || a.snap.status !== 'waiting') return;
    if (this.now() >= a.snap.expiresAt) {
      this.log(a, `Timed out after ${this.timeoutMs} ms without seeing ${a.serviceName}`);
      this.update(a, { status: 'timeout' });
      return;
    }
    const services = await this.deps.adb.mdnsServices().catch(() => [] as MdnsService[]);
    if (!this.isLive(a)) return;
    const pairing = services.filter((s) => s.kind === 'pairing');
    if (pairing.length !== a.pairingSeen) {
      a.pairingSeen = pairing.length;
      const names = pairing.map((s) => s.instance).join(', ');
      this.log(
        a,
        `Seeing ${pairing.length} _adb-tls-pairing service(s)${names ? `: ${names}` : ''}`,
      );
    }
    const svc = pairing.find((s) => s.instance === a.serviceName);
    if (!svc) {
      this.schedulePoll(a);
      return;
    }
    this.log(a, `Found ${svc.instance} at ${svc.host}:${svc.port}`);
    this.update(a, { status: 'pairing' });
    await this.pairAndConnect(a, svc.host, svc.port, a.password!);
  }

  async pairWithCode(req: PairCodeRequest): Promise<PairingSnapshot> {
    const host = String(req.host ?? '').trim();
    const port = Number(req.port);
    const code = String(req.code ?? '').trim();
    if (!/^[0-9a-fA-F.:]+$/.test(host))
      throw new HttpError(400, 'Enter the IP address shown on the phone.', 'INVALID');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new HttpError(400, 'Enter the port shown on the phone.', 'INVALID');
    }
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'The pairing code is 6 digits.', 'INVALID');
    this.cancel();
    const a: Attempt = {
      snap: {
        attemptId: randomUUID(),
        mode: 'code',
        status: 'pairing',
        qrSvg: null,
        expiresAt: this.now() + this.timeoutMs,
        error: null,
        deviceName: null,
      },
      serviceName: null,
      password: code,
      timer: null,
      pairingSeen: 0,
    };
    this.current = a;
    this.log(a, `Code attempt started for ${host}:${port}`);
    this.emit();
    void this.pairAndConnect(a, host, port, code);
    return { ...a.snap };
  }

  private async pairAndConnect(a: Attempt, host: string, port: number, code: string) {
    const res = await this.deps.adb
      .pair(`${host}:${port}`, code)
      .catch((err: Error) => ({ ok: false as const, error: err.message }));
    if (!this.isLive(a)) return;
    if (!res.ok) {
      this.log(a, `adb pair ${host}:${port} failed: ${res.error}`);
      this.update(a, { status: 'error', error: res.error });
      return;
    }
    this.log(a, `adb pair ${host}:${port} succeeded`);
    this.update(a, { status: 'success' });
    if (this.deps.session.isConnected()) {
      this.log(a, 'A session is already connected, so not connecting to the paired device');
      return;
    }
    try {
      const s = await this.deps.session.connectAfterPairing(host, () => this.isLive(a));
      this.log(a, `Connected to ${s.device?.model ?? 'the device'} at ${host}`);
      this.update(a, { deviceName: s.device?.model ?? null });
    } catch (err) {
      this.log(a, `Connecting to ${host} failed: ${(err as Error).message}`);
      this.update(a, { status: 'error', error: (err as Error).message });
    }
  }
}
