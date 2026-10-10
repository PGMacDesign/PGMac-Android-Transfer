import { execFile } from 'node:child_process';
import {
  access,
  constants,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError, exists, notFound } from '../errors.ts';
import {
  PARTIAL_SUFFIX,
  type EntryMeta,
  type FileEntry,
  type StorageInfo,
} from '../../shared/protocol.ts';
import { baseName, replaceBackupPath, validateName } from './paths.ts';
import { offlineError, type Mount } from './volumes.ts';
import type { SideFs } from './types.ts';

const run = promisify(execFile);

function mapFsError(err: unknown, p: string): never {
  if (err instanceof HttpError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw notFound(`“${baseName(p)}” was not found.`);
  if (code === 'EEXIST' || code === 'ENOTEMPTY') throw exists(`“${baseName(p)}” already exists.`);
  if (code === 'EACCES' || code === 'EPERM') {
    throw new HttpError(403, `macOS won't allow access to “${baseName(p)}”.`);
  }
  throw new HttpError(500, (err as Error).message);
}

async function moveToTrash(paths: string[]): Promise<void> {
  // macOS 15+ ships /usr/bin/trash; older versions go through Finder.
  try {
    await access('/usr/bin/trash', constants.X_OK);
    await run('/usr/bin/trash', paths, { timeout: 60_000 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (process.platform === 'darwin') {
    const list = paths.map((p) => `POSIX file ${JSON.stringify(p)}`).join(', ');
    await run('osascript', ['-e', `tell application "Finder" to delete {${list}}`], {
      timeout: 60_000,
    });
    return;
  }
  await run('gio', ['trash', '--', ...paths], { timeout: 60_000 });
}

/** What MacFs needs from the volume monitor; the default treats every path as local. */
export interface VolumeGuard {
  guard<T>(p: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
  volumeOf(p: string): Mount | null;
  offlineFor(p: string): { name: string } | null;
  check(p: string): Promise<boolean>;
}

const LOCAL: VolumeGuard = {
  guard: (_p, fn) => fn(),
  volumeOf: () => null,
  offlineFor: () => null,
  check: async () => true,
};

const isOffline = (err: unknown) => err instanceof HttpError && err.code === 'OFFLINE';

/**
 * The Mac side. Every file call goes through `io`, which gives calls on network volumes a
 * deadline and fails them at once while their volume is offline (see volumes.ts).
 */
export class MacFs implements SideFs {
  readonly home: string;
  private readonly vol: VolumeGuard;
  /**
   * Originals a folder Replace moved aside, from just before that rename until the new copy
   * is in. Records are mutable so noteMove can follow a share to a new mount point; restores
   * skip `active` ones, which a finalize still owns.
   */
  private readonly parked = new Set<{ final: string; backup: string; active: boolean }>();
  /** Restores run one at a time so each sees every move noted before it. */
  private restoring: Promise<void> = Promise.resolve();
  constructor(home: string, vol: VolumeGuard = LOCAL) {
    this.home = home;
    this.vol = vol;
  }

  private io<T>(p: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return this.vol.guard(p, fn, timeoutMs);
  }

  async list(dir: string): Promise<FileEntry[]> {
    let names: string[];
    try {
      names = await this.io(dir, () => readdir(dir));
    } catch (err) {
      mapFsError(err, dir);
    }
    const entries = await Promise.all(
      names.map(async (name): Promise<FileEntry | null> => {
        if (name.endsWith(PARTIAL_SUFFIX)) return null;
        const full = path.join(dir, name);
        try {
          const l = await this.io(full, () => lstat(full));
          let isDir = l.isDirectory();
          if (l.isSymbolicLink()) {
            isDir = await this.io(full, () => stat(full)).then(
              (s) => s.isDirectory(),
              (err: unknown) => {
                if (isOffline(err)) throw err;
                return false;
              },
            );
          }
          return {
            name,
            isDir,
            isSymlink: l.isSymbolicLink(),
            size: isDir ? 0 : l.size,
            mtimeMs: Math.round(l.mtimeMs),
          };
        } catch (err) {
          // A half-listed share would look like files vanished; report it offline instead.
          if (isOffline(err)) throw err;
          return null;
        }
      }),
    );
    return entries.filter((e): e is FileEntry => e !== null);
  }

  async stat(p: string): Promise<EntryMeta | null> {
    try {
      const s = await this.io(p, () => stat(p));
      return {
        isDir: s.isDirectory(),
        size: s.isDirectory() ? 0 : s.size,
        mtimeMs: Math.round(s.mtimeMs),
      };
    } catch (err) {
      if (isOffline(err)) throw err;
      return null;
    }
  }

  async mkdir(p: string): Promise<void> {
    try {
      await this.io(p, () => mkdir(p));
    } catch (err) {
      mapFsError(err, p);
    }
  }

  async rename(p: string, newName: string): Promise<void> {
    const name = validateName(newName);
    const dest = path.join(path.dirname(p), name);
    if (dest === p) return;
    const quiet = (q: string) =>
      this.io(q, () => lstat(q)).catch((err: unknown) => {
        if (isOffline(err)) throw err;
        return null;
      });
    const src = await quiet(p);
    if (!src) throw notFound(`“${baseName(p)}” no longer exists.`);
    // On a case-insensitive volume a case-only rename finds the source itself at `dest`;
    // anything else at `dest` (including a different file on a case-sensitive volume) is a clash.
    const existing = await quiet(dest);
    if (existing && (existing.ino !== src.ino || existing.dev !== src.dev)) {
      throw exists(`“${name}” already exists.`);
    }
    try {
      await this.io(p, () => rename(p, dest));
    } catch (err) {
      mapFsError(err, p);
    }
  }

  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    for (const p of paths) {
      const off = this.vol.offlineFor(p);
      if (off) throw offlineError(off.name);
    }
    try {
      await moveToTrash(paths);
    } catch (err) {
      const shared = paths.find((p) => this.vol.volumeOf(p));
      if (shared && !(await this.vol.check(shared))) {
        throw offlineError(this.vol.offlineFor(shared)?.name ?? baseName(shared));
      }
      // Shares and external drives often have no Trash; the UI offers a permanent delete.
      if (shared || paths.some((p) => p.startsWith('/Volumes/'))) {
        const what = paths.length === 1 ? `“${baseName(paths[0]!)}”` : `${paths.length} items`;
        throw new HttpError(409, `${what} can't be moved to the Trash on this volume.`, 'NO_TRASH');
      }
      const msg = ((err as { stderr?: string }).stderr || (err as Error).message).trim();
      throw new HttpError(500, `Could not move to Trash: ${msg}`);
    }
  }

  /** Deletes for good; only offered after the Trash refused (NO_TRASH). */
  async removePermanently(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        // Large folders on a share can take a while; this only guards against a dead share.
        await this.io(p, () => rm(p, { recursive: true }), 10 * 60_000);
      } catch (err) {
        mapFsError(err, p);
      }
    }
  }

  /** Best-effort delete of a transfer's partial; never throws. */
  async removePartial(p: string): Promise<void> {
    await this.io(p, () => rm(p, { recursive: true, force: true })).catch(() => undefined);
  }

  async measure(p: string): Promise<{ bytes: number; files: number }> {
    let s;
    try {
      s = await this.io(p, () => lstat(p));
    } catch (err) {
      mapFsError(err, p);
    }
    if (!s.isDirectory()) return { bytes: s.size, files: 1 };
    let bytes = 0;
    let files = 0;
    const quiet = <T>(q: string, fn: () => Promise<T>, fallback: T) =>
      this.io(q, fn).catch((err: unknown) => {
        if (isOffline(err)) throw err;
        return fallback;
      });
    const walk = async (dir: string): Promise<void> => {
      const items = await quiet(dir, () => readdir(dir, { withFileTypes: true }), []);
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) await walk(full);
        else if (it.isFile()) {
          const st = await quiet(full, () => lstat(full), null);
          if (st) {
            bytes += st.size;
            files += 1;
          }
        }
      }
    };
    await walk(p);
    return { bytes, files };
  }

  async storage(): Promise<StorageInfo | null> {
    try {
      const s = await statfs(this.home);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }

  /** A share came back at a new mount point: parked paths follow it. */
  noteMove(from: string, to: string) {
    const move = (p: string) =>
      p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p;
    for (const r of this.parked) {
      r.final = move(r.final);
      r.backup = move(r.backup);
    }
  }

  /**
   * Restores originals parked by an interrupted Replace. Called when a share comes back,
   * before its paused transfers restart. Records whose share is still unreachable are kept.
   */
  restoreParked(): Promise<void> {
    this.restoring = this.restoring.then(() => this.restoreAll());
    return this.restoring;
  }

  private async restoreAll() {
    const present = async (p: string) =>
      this.io(p, () => lstat(p)).then(
        () => true,
        (err: unknown) => {
          if (isOffline(err)) throw err;
          return false;
        },
      );
    for (const r of [...this.parked]) {
      if (r.active) continue;
      try {
        // No backup: the parking rename never happened, or the original is already back.
        // Both present: the new copy landed (or the user reused the name); leave both.
        if ((await present(r.backup)) && !(await present(r.final))) {
          await this.io(r.final, () => rename(r.backup, r.final));
        }
        this.parked.delete(r);
      } catch (err) {
        if (!isOffline(err)) this.parked.delete(r);
      }
    }
  }

  /**
   * Copies modification dates from `src` onto the matching paths under `dest`. Best effort,
   * except that a share going offline throws so the job pauses instead of walking the rest
   * of the tree against a dead mount. `stop` ends it early (a cancelled job).
   */
  async copyTimes(src: string, dest: string, stop: () => boolean = () => false): Promise<void> {
    if (stop()) return;
    const soft =
      <T>(fallback: T) =>
      (err: unknown): T => {
        if (isOffline(err)) throw err;
        return fallback;
      };
    const st = await this.io(src, () => lstat(src)).catch(soft(null));
    if (!st) return;
    if (st.isDirectory()) {
      const names = await this.io(src, () => readdir(src)).catch(soft([] as string[]));
      for (const n of names) await this.copyTimes(path.join(src, n), path.join(dest, n), stop);
    }
    await this.io(dest, () => utimes(dest, st.atime, st.mtime)).catch(soft(undefined));
  }

  /** Applies dates read from the source (paths relative to `root`). Best effort; see copyTimes. */
  async setTimes(
    root: string,
    times: { rel: string; mtimeMs: number }[],
    stop: () => boolean = () => false,
  ): Promise<void> {
    for (const t of times) {
      if (stop()) return;
      if (path.isAbsolute(t.rel) || t.rel.split('/').includes('..')) continue;
      const p = t.rel ? path.join(root, t.rel) : root;
      const d = new Date(t.mtimeMs);
      // Like copyTimes: a share going offline throws so the job pauses.
      await this.io(p, () => utimes(p, d, d)).catch((err: unknown) => {
        if (isOffline(err)) throw err;
      });
    }
  }

  /** Moves a finished partial into place, replacing whatever is at `finalPath`. */
  async finalize(partialPath: string, finalPath: string, replace: boolean): Promise<void> {
    const io = <T>(fn: () => Promise<T>) => this.io(finalPath, fn);
    const existing = await io(() => lstat(finalPath)).catch((err: unknown) => {
      if (isOffline(err)) throw err;
      return null;
    });
    if (!existing) {
      await io(() => rename(partialPath, finalPath));
      return;
    }
    if (!replace) {
      throw new HttpError(409, `“${baseName(finalPath)}” appeared while transferring.`, 'CONFLICT');
    }
    const incoming = await io(() => lstat(partialPath));
    if (!existing.isDirectory() && !incoming.isDirectory()) {
      // rename(2) swaps one file for another atomically.
      await io(() => rename(partialPath, finalPath));
      return;
    }
    // Folders can't be renamed over each other: park the original until the new one is in.
    // Recorded before the rename: on a share that drops, the rename can land with its reply
    // lost, and the original must still be found when the share returns.
    const rec = { final: finalPath, backup: replaceBackupPath(finalPath), active: true };
    this.parked.add(rec);
    try {
      await io(() => rename(rec.final, rec.backup));
    } catch (err) {
      if (isOffline(err)) rec.active = false;
      else this.parked.delete(rec);
      throw err;
    }
    try {
      await io(() => rename(partialPath, rec.final));
    } catch (err) {
      const restored = await io(() => rename(rec.backup, rec.final)).then(
        () => true,
        () => false,
      );
      // Otherwise the share dropped between the renames: the original goes back on return.
      if (restored) this.parked.delete(rec);
      else rec.active = false;
      throw err;
    }
    this.parked.delete(rec);
    await io(() => rm(rec.backup, { recursive: true, force: true })).catch(() => undefined);
  }
}
