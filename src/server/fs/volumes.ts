import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from '../errors.ts';
import type { OfflineVolume } from '../../shared/protocol.ts';

const run = promisify(execFile);

export interface Mount {
  source: string;
  mountPoint: string;
  type: string;
}

/** Filesystems whose calls can hang when the server goes away. */
const NETWORK_FS = new Set([
  'smbfs',
  'afpfs',
  'nfs',
  'nfs4',
  'webdav',
  'ftp',
  'cifs',
  'smb3',
  'sshfs',
  'fuse.sshfs',
  'davfs',
  'fuse.davfs2',
  'fuse.rclone',
  '9p',
]);

/** Errors that mean "the server stopped answering", not "this file is wrong". */
const NETWORK_ERRNOS = new Set([
  'EIO',
  'ENOTCONN',
  'ESTALE',
  'ETIMEDOUT',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENXIO',
]);

/** macOS `mount`: `//user@host/Share on /Volumes/Share (smbfs, nodev, nosuid, ...)`. */
export function parseDarwinMounts(out: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of out.split('\n')) {
    const on = line.indexOf(' on ');
    const paren = line.lastIndexOf(' (');
    if (on <= 0 || paren <= on) continue;
    const type = line
      .slice(paren + 2)
      .split(/[,)]/)[0]!
      .trim();
    mounts.push({ source: line.slice(0, on), mountPoint: line.slice(on + 4, paren), type });
  }
  return mounts;
}

/** `/proc/self/mounts`: space-separated, with spaces and tabs in names escaped as octal. */
export function parseLinuxMounts(text: string): Mount[] {
  const unescape = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split('\n')
    .map((l) => l.split(' '))
    .filter((f) => f.length >= 3)
    .map(([source, mountPoint, type]) => ({
      source: unescape(source!),
      mountPoint: unescape(mountPoint!),
      type: type!,
    }));
}

/**
 * Identity of a share across remounts: `//Alex@nas.local/Share` and
 * `//alex@nas.local/Share` are the same share, so the user part is dropped and
 * the host compared case-insensitively.
 */
export function sourceKey(source: string): string {
  const m = /^\/\/(?:[^@/]*@)?([^/]+)(\/.*)?$/.exec(source);
  if (m) return `//${m[1]!.toLowerCase()}${m[2] ?? ''}`;
  const nfs = /^([^:/]+):(\/.*)$/.exec(source);
  if (nfs) return `${nfs[1]!.toLowerCase()}:${nfs[2]}`;
  return source;
}

export const isNetworkMount = (m: Mount) => NETWORK_FS.has(m.type);

const under = (p: string, mountPoint: string) =>
  p === mountPoint || p.startsWith(mountPoint.endsWith('/') ? mountPoint : mountPoint + '/');

export type VolumeEvent =
  | { type: 'offline'; mountPoint: string }
  | { type: 'online'; mountPoint: string }
  | { type: 'moved'; from: string; to: string }
  | { type: 'gaveUp'; mountPoint: string; name: string };

export interface VolumeMonitorDeps {
  readMounts: () => Promise<Mount[]>;
  /** True if the volume answered within `timeoutMs`. Must never hang past it. */
  probe: (mountPoint: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  probeEveryMs?: number;
  probeTimeoutMs?: number;
  /** How long jobs wait for an offline volume before failing. */
  giveUpAfterMs?: number;
  /** How long a guarded file call may take on a network volume. */
  callTimeoutMs?: number;
}

interface OfflineState {
  key: string;
  mount: Mount;
  since: number;
  giveUpAt: number;
  gaveUp: boolean;
  timer: NodeJS.Timeout | null;
}

export const offlineError = (name: string) =>
  new HttpError(503, `${name} is offline. Waiting for it to reconnect.`, 'OFFLINE');

export const isOfflineError = (err: unknown) => err instanceof HttpError && err.code === 'OFFLINE';

const movedError = (to: string) =>
  new HttpError(404, `This share is now at ${to}. Open it from there.`, 'NOT_FOUND');

/**
 * Tracks network mounts and which of them stopped answering. A dropped SMB/NFS share often
 * makes file calls hang rather than fail, and a hung call can't be cancelled, so the first
 * timeout or network error marks the volume offline; after that, calls on it fail at once
 * and a probe (in a child process that can be abandoned) watches for it to come back.
 */
export class VolumeMonitor {
  private readonly deps: VolumeMonitorDeps;
  private readonly now: () => number;
  private mounts: Mount[] = [];
  private readonly offline = new Map<string, OfflineState>();
  /**
   * Mount points a share left for a new one (Share to Share-1), mapped to where it went. The
   * old entry can linger in the table, dead, until the system drops it. It must never mark
   * the share offline (that would take the live mount down too), and its path must never
   * look local once it leaves the table: on Linux the empty directory stays, and a write
   * there would land on the local disk.
   */
  private readonly retired = new Map<string, string>();
  private readonly listeners = new Set<(ev: VolumeEvent) => void>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: VolumeMonitorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start() {
    await this.refreshMounts();
    // New shares get mounted while the app runs; the table is cheap to read.
    this.refreshTimer = setInterval(() => void this.refreshMounts(), 10_000);
    this.refreshTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const o of this.offline.values()) if (o.timer) clearTimeout(o.timer);
  }

  onEvent(cb: (ev: VolumeEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The network volume containing `p`, including offline ones that dropped out of the table. */
  volumeOf(p: string): Mount | null {
    let best: Mount | null = null;
    const candidates = [...this.mounts, ...[...this.offline.values()].map((o) => o.mount)];
    for (const m of candidates) {
      if (under(p, m.mountPoint) && (!best || m.mountPoint.length > best.mountPoint.length)) {
        best = m;
      }
    }
    return best;
  }

  /** The offline volume containing `p`, if any. */
  offlineFor(p: string): OfflineVolume | null {
    const m = this.volumeOf(p);
    const o = m && this.offline.get(sourceKey(m.source));
    return o ? this.describe(o) : null;
  }

  offlineList(): OfflineVolume[] {
    return [...this.offline.values()].map((o) => this.describe(o));
  }

  private retiredFor(p: string): string | null {
    for (const [from, to] of this.retired) if (under(p, from)) return to;
    return null;
  }

  /** Probes `p`'s volume now. False (and marked offline) if it doesn't answer. */
  async check(p: string): Promise<boolean> {
    if (this.retiredFor(p)) return true;
    const m = this.volumeOf(p);
    if (!m) return true;
    if (this.offline.has(sourceKey(m.source))) return false;
    if (await this.deps.probe(m.mountPoint, this.probeTimeout)) return true;
    await this.onDead(m);
    return false;
  }

  /**
   * Runs a file call for `p`. Local paths run as-is. On a network volume the call gets a
   * deadline, and a timeout or network error marks the volume offline.
   */
  async guard<T>(p: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const movedTo = this.retiredFor(p);
    if (movedTo) throw movedError(movedTo);
    const m = this.volumeOf(p);
    if (!m) return fn();
    const known = this.offline.get(sourceKey(m.source));
    if (known) throw offlineError(path.basename(known.mount.mountPoint));
    const limit = timeoutMs ?? this.deps.callTimeoutMs ?? 10_000;
    const settled = fn().then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([
        settled,
        new Promise<null>((res) => (timer = setTimeout(() => res(null), limit))),
      ]);
      clearTimeout(timer);
      if (r?.ok) return r.value;
      if (r) {
        const code = (r.err as NodeJS.ErrnoException).code;
        // A missing path is only a network problem when the share itself has gone away.
        const unmounted = code === 'ENOENT' && !(await this.stillMounted(m));
        if ((code && NETWORK_ERRNOS.has(code)) || unmounted) {
          await this.onDead(m);
          throw offlineError(path.basename(m.mountPoint));
        }
        throw r.err;
      }
      // Slow isn't dead: listing a huge folder on a busy share can take a while. The call
      // keeps its chance as long as the share still answers a quick probe.
      if (!(await this.deps.probe(m.mountPoint, this.probeTimeout))) {
        await this.onDead(m);
        throw offlineError(path.basename(m.mountPoint));
      }
    }
  }

  private get probeTimeout() {
    return this.deps.probeTimeoutMs ?? 4000;
  }

  private describe(o: OfflineState): OfflineVolume {
    return {
      mountPoint: o.mount.mountPoint,
      name: path.basename(o.mount.mountPoint),
      since: o.since,
      giveUpAt: o.giveUpAt,
    };
  }

  /** `from` is a dead mount of a share now at `to`; see `retired`. Emits `moved`. */
  private retire(from: string, to: string) {
    this.retired.set(from, to);
    this.retired.delete(to);
    // Older retirements that pointed at `from` follow on, so their "moved" errors stay right.
    for (const [k, v] of this.retired) if (v === from) this.retired.set(k, to);
    this.emit({ type: 'moved', from, to });
  }

  private emit(ev: VolumeEvent) {
    for (const cb of this.listeners) cb(ev);
  }

  private async refreshMounts() {
    let next: Mount[];
    try {
      next = (await this.deps.readMounts()).filter(isNetworkMount);
    } catch {
      // Keep the last table; a failed read must not make volumes look local.
      return;
    }
    // Decided before a fresh mount clears a retirement below: a stale mount that left must
    // not mark its share offline even when something new now sits at its mount point.
    const gone = this.mounts.filter(
      (m) =>
        !this.retired.has(m.mountPoint) &&
        !next.some((n) => n.mountPoint === m.mountPoint && n.source === m.source),
    );
    // A fresh mount at a retired point (the share, or another one, mounted there again) is live.
    for (const n of next) {
      const known = this.mounts.some((m) => m.mountPoint === n.mountPoint && m.source === n.source);
      if (!known) this.retired.delete(n.mountPoint);
    }
    this.mounts = next;
    // A share that vanished from the table was unmounted (or dropped and cleaned up by the
    // system). Its paths must not start looking local, so it waits as offline.
    for (const m of gone) this.onGone(m);
  }

  private async stillMounted(m: Mount): Promise<boolean> {
    await this.refreshMounts();
    return this.mounts.some((x) => x.mountPoint === m.mountPoint && x.source === m.source);
  }

  /**
   * Another live-looking mount of the same share. A share reconnected in Finder while its
   * dead entry lingered (possibly before this app started) has two; the dead one must not
   * take the share offline.
   */
  private siblingOf(m: Mount): Mount | null {
    const key = sourceKey(m.source);
    return (
      this.mounts.find(
        (x) =>
          x.mountPoint !== m.mountPoint &&
          sourceKey(x.source) === key &&
          !this.retired.has(x.mountPoint),
      ) ?? null
    );
  }

  private moveToSibling(m: Mount, sibling: Mount) {
    this.retire(m.mountPoint, sibling.mountPoint);
    this.emit({ type: 'online', mountPoint: sibling.mountPoint });
  }

  /** An entry left the table. If its share is still listed elsewhere, that's where it went. */
  private onGone(m: Mount) {
    // Already offline: its probe loop decides where the share comes back.
    if (this.offline.has(sourceKey(m.source))) return;
    const sibling = this.siblingOf(m);
    if (sibling) this.moveToSibling(m, sibling);
    else this.markOffline(m);
  }

  /**
   * A call or probe on `m` failed. With a sibling still listed, which of the two died isn't
   * known, so the sibling is asked first: if it answers, `m` is the stale one.
   */
  private async onDead(m: Mount) {
    const sibling = this.siblingOf(m);
    if (sibling && (await this.deps.probe(sibling.mountPoint, this.probeTimeout))) {
      const stillSo =
        !this.stopped &&
        !this.offline.has(sourceKey(m.source)) &&
        !this.retired.has(m.mountPoint) &&
        this.siblingOf(m) === sibling;
      if (stillSo) this.moveToSibling(m, sibling);
      return;
    }
    this.markOffline(m);
  }

  private markOffline(m: Mount) {
    const key = sourceKey(m.source);
    if (this.offline.has(key) || this.stopped) return;
    const since = this.now();
    const o: OfflineState = {
      key,
      mount: m,
      since,
      giveUpAt: since + (this.deps.giveUpAfterMs ?? 30 * 60_000),
      gaveUp: false,
      timer: null,
    };
    this.offline.set(key, o);
    this.emit({ type: 'offline', mountPoint: m.mountPoint });
    this.scheduleProbe(o);
  }

  private scheduleProbe(o: OfflineState) {
    if (this.stopped) return;
    o.timer = setTimeout(() => void this.probeOffline(o), this.deps.probeEveryMs ?? 5000);
    o.timer.unref?.();
  }

  /** One probe cycle for an offline volume; schedules the next unless it came back. */
  private async probeOffline(o: OfflineState) {
    if (this.offline.get(o.key) !== o) return;
    await this.refreshMounts();
    const mountsOfShare = () => this.mounts.filter((m) => sourceKey(m.source) === o.key);
    if (!mountsOfShare().length) {
      // An automounted share (autofs) leaves the table when idle and comes back only when its
      // path is touched; nothing else in the app touches it while it's offline. The probe's
      // child does, harmlessly, and the table says whether a mount came of it.
      await this.deps.probe(o.mount.mountPoint, this.probeTimeout);
      if (this.offline.get(o.key) !== o) return;
      await this.refreshMounts();
    }
    // The share may come back at another mount point (/Volumes/Share-1) while the old
    // one lingers as a stale mount, so try every mount of this share, newest path first.
    const candidates = mountsOfShare().sort(
      (a, b) =>
        Number(a.mountPoint === o.mount.mountPoint) - Number(b.mountPoint === o.mount.mountPoint),
    );
    let current: Mount | null = null;
    for (const c of candidates) {
      if (await this.deps.probe(c.mountPoint, this.probeTimeout)) {
        current = c;
        break;
      }
    }
    if (current) {
      if (this.offline.get(o.key) !== o) return;
      this.offline.delete(o.key);
      this.retired.delete(current.mountPoint);
      if (current.mountPoint !== o.mount.mountPoint) {
        this.retire(o.mount.mountPoint, current.mountPoint);
      }
      this.emit({ type: 'online', mountPoint: current.mountPoint });
      return;
    }
    if (!o.gaveUp && this.now() >= o.giveUpAt) {
      o.gaveUp = true;
      this.emit({
        type: 'gaveUp',
        mountPoint: o.mount.mountPoint,
        name: path.basename(o.mount.mountPoint),
      });
    }
    this.scheduleProbe(o);
  }
}

/** Reads the mount table without touching any mounted filesystem. */
export async function readSystemMounts(): Promise<Mount[]> {
  if (process.platform === 'darwin') {
    const r = await run('/sbin/mount', [], { timeout: 5000 });
    return parseDarwinMounts(r.stdout);
  }
  if (process.platform === 'linux')
    return parseLinuxMounts(await readFile('/proc/self/mounts', 'utf8'));
  return [];
}

/**
 * Lists the volume root in a child process. A call stuck on a dead share can't be cancelled
 * inside Node, but a child can be abandoned. Callers arriving while a probe runs share its
 * answer. A child that outlives its timeout stops blocking new probes (so a share that comes
 * back is noticed), but at most `maxStuck` such children per mount point may exist at once.
 */
export function makeProbe(maxStuck = 3) {
  const inflight = new Map<string, Promise<boolean>>();
  const stuck = new Map<string, number>();
  return (mountPoint: string, timeoutMs: number): Promise<boolean> => {
    const running = inflight.get(mountPoint);
    if (running) return running;
    if ((stuck.get(mountPoint) ?? 0) >= maxStuck) return Promise.resolve(false);
    const p = new Promise<boolean>((resolve) => {
      const child = spawn('/bin/ls', ['-f', '--', mountPoint], { stdio: 'ignore' });
      let timedOut = false;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (inflight.get(mountPoint) === p) inflight.delete(mountPoint);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stuck.set(mountPoint, (stuck.get(mountPoint) ?? 0) + 1);
        child.kill('SIGKILL');
        done(false);
      }, timeoutMs);
      const exited = (ok: boolean) => {
        if (timedOut) stuck.set(mountPoint, Math.max(0, (stuck.get(mountPoint) ?? 1) - 1));
        else done(ok);
      };
      child.on('error', () => exited(false));
      child.on('close', (code) => exited(code === 0));
    });
    inflight.set(mountPoint, p);
    return p;
  };
}
