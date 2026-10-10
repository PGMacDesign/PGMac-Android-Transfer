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
}

interface Attempt {
  snap: PairingSnapshot;
  serviceName: string | null;
  password: string | null;
  timer: NodeJS.Timeout | null;
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
  private current: Attempt | null = null;

  constructor(deps: PairingDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
    this.pollMs = deps.pollMs ?? 1000;
    this.now = deps.now ?? Date.now;
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
    if (a) this.emit();
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
    };
    this.current = a;
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
      this.update(a, { status: 'timeout' });
      return;
    }
    const services = await this.deps.adb.mdnsServices().catch(() => [] as MdnsService[]);
    if (!this.isLive(a)) return;
    const svc = services.find((s) => s.kind === 'pairing' && s.instance === a.serviceName);
    if (!svc) {
      this.schedulePoll(a);
      return;
    }
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
      password: null,
      timer: null,
    };
    this.current = a;
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
      this.update(a, { status: 'error', error: res.error });
      return;
    }
    this.update(a, { status: 'success' });
    if (this.deps.session.isConnected()) return;
    try {
      const s = await this.deps.session.connectAfterPairing(host, () => this.isLive(a));
      this.update(a, { deviceName: s.device?.model ?? null });
    } catch (err) {
      this.update(a, { status: 'error', error: (err as Error).message });
    }
  }
}
