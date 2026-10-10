import { Hub } from '../src/server/hub.ts';
import type { SideFs } from '../src/server/fs/types.ts';
import type {
  QueueVolumes,
  RunHandle,
  RunHooks,
  StagingLike,
  TransferRunner,
  TransferSpec,
} from '../src/server/transfers/queue.ts';
import type {
  EntryMeta,
  FileEntry,
  OfflineVolume,
  ServerMessage,
  ServerSnapshot,
} from '../src/shared/protocol.ts';

export function recordingHub() {
  const hub = new Hub();
  const messages: ServerMessage[] = [];
  hub.setSnapshotProvider(() => ({}) as ServerSnapshot);
  hub.add({ send: (d) => messages.push(JSON.parse(d) as ServerMessage) });
  messages.length = 0;
  return { hub, messages };
}

/** In-memory SideFs: a map of absolute path to entry. */
export class MemoryFs implements SideFs {
  readonly files = new Map<string, EntryMeta>();
  constructor(entries: Record<string, EntryMeta> = {}) {
    for (const [p, m] of Object.entries(entries)) this.files.set(p, m);
  }
  async list(dir: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (const [p, m] of this.files) {
      const i = p.lastIndexOf('/');
      const parent = i === 0 ? '/' : p.slice(0, i);
      if (parent === dir) out.push({ name: p.slice(i + 1), isSymlink: false, ...m });
    }
    return out;
  }
  async stat(p: string) {
    return this.files.get(p) ?? null;
  }
  async mkdir(p: string) {
    this.files.set(p, { isDir: true, size: 0, mtimeMs: 0 });
  }
  async rename() {}
  async remove(paths: string[]) {
    for (const p of paths) this.files.delete(p);
  }
  async measure(p: string) {
    const m = this.files.get(p);
    return { bytes: m?.size ?? 0, files: 1 };
  }
  async storage() {
    return null;
  }
}

export interface FakeRun {
  spec: TransferSpec;
  hooks: RunHooks;
  succeed(): void;
  fail(msg: string): void;
  /** Rejects with this exact error (e.g. an OFFLINE HttpError). */
  failWith(err: Error): void;
  cancelled: boolean;
  /** True until the run settles or its cancel finishes. */
  alive: boolean;
  /** Completes a held cancel (see FakeRunner.holdCancels). */
  finishCancel(): void;
}

export class FakeRunner implements TransferRunner {
  readonly runs: FakeRun[] = [];
  /** When true, cancel() stays pending until the test calls run.finishCancel(). */
  holdCancels = false;
  start(spec: TransferSpec, hooks: RunHooks): RunHandle {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const run: FakeRun = {
      spec,
      hooks,
      cancelled: false,
      alive: true,
      succeed: () => {
        run.alive = false;
        resolve();
      },
      fail: (msg) => {
        run.alive = false;
        reject(new Error(msg));
      },
      failWith: (err) => {
        run.alive = false;
        reject(err);
      },
      finishCancel: () => releaseCancel(),
    };
    let releaseCancel: () => void = () => undefined;
    this.runs.push(run);
    return {
      done,
      cancel: async () => {
        run.cancelled = true;
        reject(new Error('Cancelled'));
        if (this.holdCancels) await new Promise<void>((r) => (releaseCancel = r));
        run.alive = false;
      },
    };
  }
  live() {
    return this.runs.filter((r) => r.alive);
  }
}

export const flush = () => new Promise((r) => setImmediate(r));

/** In-memory staging: records removals; `staged` says what measure() finds. */
export class FakeStaging implements StagingLike {
  readonly removed: string[] = [];
  readonly staged = new Map<string, { bytes: number; files: number }>();
  free: number | null = 1e12;
  itemPath(jobId: string, name: string) {
    return `/staging/${jobId}/${name}`;
  }
  resolve(itemPath: string, rel: string) {
    return rel ? `${itemPath}/${rel}` : itemPath;
  }
  async remove(jobId: string) {
    this.removed.push(jobId);
  }
  async freeBytes() {
    return this.free;
  }
  async measure(itemPath: string, isDir: boolean) {
    return this.staged.get(itemPath) ?? (isDir ? { bytes: 0, files: 0 } : null);
  }
}

/** Network volumes for queue tests: mount points under which paths count as shared. */
export class FakeVolumes implements QueueVolumes {
  readonly mounts: string[];
  readonly offline = new Map<string, OfflineVolume>();
  /** What check() reports for a volume that isn't already offline. */
  probeOk = true;
  constructor(mounts: string[] = ['/Volumes/NAS']) {
    this.mounts = mounts;
  }
  private mountOf(p: string) {
    return this.mounts.find((m) => p === m || p.startsWith(m + '/')) ?? null;
  }
  volumeOf(p: string) {
    const m = this.mountOf(p);
    return m ? { source: `//nas${m}`, mountPoint: m, type: 'smbfs' } : null;
  }
  offlineFor(p: string) {
    const m = this.mountOf(p);
    return (m && this.offline.get(m)) || null;
  }
  async check(p: string) {
    const m = this.mountOf(p);
    if (!m) return true;
    if (this.offline.has(m)) return false;
    if (!this.probeOk) this.goOffline(m);
    return this.probeOk;
  }
  goOffline(m: string) {
    const name = m.split('/').pop()!;
    const since = Date.now();
    this.offline.set(m, { mountPoint: m, name, since, giveUpAt: since + 30 * 60_000 });
  }
}
