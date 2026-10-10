import { shQuote, type Adb, type ExecResult } from '../adb/adb.ts';
import { parseFindListing, parseFindTimes, sumSizes } from '../adb/parse.ts';
import { HttpError, exists, notFound } from '../errors.ts';
import { PARTIAL_SUFFIX, type EntryMeta, type FileEntry } from '../../shared/protocol.ts';
import { baseName, dirName, joinPosix, replaceBackupPath, validateName } from './paths.ts';
import type { SideFs } from './types.ts';

const LIST_FMT = `'%M\\t%s\\t%T@\\t%f\\0'`;

function failure(r: ExecResult, what: string): HttpError {
  const msg = (r.stderr || r.stdout).trim();
  if (/No such file/i.test(msg)) return notFound(`${what} was not found on the device.`);
  if (/Permission denied/i.test(msg))
    return new HttpError(403, `Android won't allow access to ${what}.`);
  if (r.timedOut) return new HttpError(504, 'The device took too long to respond.', 'ADB');
  return new HttpError(502, msg || `adb failed (${what}).`, 'ADB');
}

/**
 * Android shared storage over `adb shell`. Commands use toybox (Android 6+), whose `find`
 * supports `-printf` and `-H`. `-H` matters because `/sdcard` itself is a symlink.
 */
export class AndroidFs implements SideFs {
  private readonly adb: Adb;
  private readonly serial: () => string;
  private readonly cleanups = new Set<AbortController>();
  constructor(adb: Adb, serial: () => string) {
    this.adb = adb;
    this.serial = serial;
  }

  private sh(cmd: string, timeoutMs = 20_000) {
    return this.adb.shell(this.serial(), cmd, { timeoutMs });
  }

  async list(dir: string): Promise<FileEntry[]> {
    const q = shQuote(dir);
    const r = await this.sh(`find -H ${q} -mindepth 1 -maxdepth 1 -printf ${LIST_FMT}`, 30_000);
    const entries = parseFindListing(r.stdout);
    // find exits non-zero when some children are unreadable but still prints the rest.
    if (r.code !== 0 && entries.length === 0) {
      const probe = await this.sh(`[ -d ${q} ] && echo DIR`);
      if (probe.stdout.trim() !== 'DIR') throw failure(r, dir);
    }
    if (entries.some((e) => e.isSymlink)) {
      const d = await this.sh(`find -L ${q} -mindepth 1 -maxdepth 1 -type d -printf '%f\\0'`);
      const dirs = new Set(d.stdout.split('\0').filter(Boolean));
      for (const e of entries) if (e.isSymlink && dirs.has(e.name)) e.isDir = true;
    }
    return entries.filter((e) => !e.name.endsWith(PARTIAL_SUFFIX));
  }

  async stat(p: string): Promise<EntryMeta | null> {
    const r = await this.sh(`find -H ${shQuote(p)} -maxdepth 0 -printf ${LIST_FMT}`);
    const e = parseFindListing(r.stdout)[0];
    if (!e) return null;
    return { isDir: e.isDir, size: e.size, mtimeMs: e.mtimeMs };
  }

  async mkdir(p: string): Promise<void> {
    if (await this.stat(p)) throw exists(`“${baseName(p)}” already exists.`);
    const r = await this.sh(`mkdir -- ${shQuote(p)}`);
    if (r.code !== 0) throw failure(r, p);
  }

  async rename(p: string, newName: string): Promise<void> {
    const name = validateName(newName);
    const dest = joinPosix(dirName(p), name);
    if (dest === p) return;
    if (!(await this.stat(p))) throw notFound(`“${baseName(p)}” no longer exists.`);
    if (await this.stat(dest)) throw exists(`“${name}” already exists.`);
    const r = await this.sh(`mv -- ${shQuote(p)} ${shQuote(dest)}`);
    if (r.code !== 0) throw failure(r, p);
  }

  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const r = await this.sh(`rm -rf -- ${paths.map(shQuote).join(' ')}`, 120_000);
    if (r.code !== 0) throw failure(r, paths.length === 1 ? paths[0]! : `${paths.length} items`);
  }

  async measure(p: string, signal?: AbortSignal): Promise<{ bytes: number; files: number }> {
    const r = await this.adb.shell(this.serial(), `find -H ${shQuote(p)} -type f -printf '%s\\n'`, {
      timeoutMs: 60_000,
      signal,
    });
    if (r.code !== 0 && !r.stdout.trim()) {
      const st = await this.stat(p);
      if (!st) throw notFound(`“${baseName(p)}” was not found on the device.`);
    }
    return sumSizes(r.stdout);
  }

  /** Modification dates of `p` and everything under it, by path relative to `p`. */
  async times(p: string, signal?: AbortSignal): Promise<{ rel: string; mtimeMs: number }[]> {
    const r = await this.adb.shell(this.serial(), `find -H ${shQuote(p)} -printf '%T@\\t%P\\0'`, {
      timeoutMs: 60_000,
      signal,
    });
    return parseFindTimes(r.stdout);
  }

  storage() {
    return this.adb.storage(this.serial());
  }

  /** Moves a finished partial into place, replacing whatever is at `finalPath`. */
  async finalize(partialPath: string, finalPath: string, replace: boolean): Promise<void> {
    // Resolved once: the session can leave `connected` (End Session, a drop) while the swap
    // runs, and the swap must still be reported as the success it was.
    const serial = this.serial();
    const pq = shQuote(partialPath);
    const fq = shQuote(finalPath);
    const backup = replaceBackupPath(finalPath);
    const bq = shQuote(backup);
    // Replace parks the original under a backup name and puts it back if the new item can't
    // be moved in. Only renames happen here, so the swap is quick even for big folders.
    const cmd = replace
      ? `if [ -e ${fq} ]; then mv -- ${fq} ${bq} || exit 1; fi; ` +
        `if mv -- ${pq} ${fq}; then exit 0; fi; ` +
        `[ -e ${bq} ] && mv -- ${bq} ${fq}; exit 1`
      : `[ ! -e ${fq} ] && mv -- ${pq} ${fq}`;
    const r = await this.adb.shell(serial, cmd, { timeoutMs: 60_000 });
    if (r.code !== 0) {
      throw new HttpError(
        409,
        replace
          ? `Could not replace “${baseName(finalPath)}”.`
          : `“${baseName(finalPath)}” appeared while transferring.`,
        'CONFLICT',
      );
    }
    if (replace) this.deleteInBackground(serial, backup);
  }

  /**
   * The transfer has already succeeded when this runs, and deleting a large old folder over
   * FUSE can take minutes, so it doesn't hold the job's slot or delay its completion. If it
   * fails or is stopped, the leftover is hidden from listings and costs only space.
   */
  private deleteInBackground(serial: string, p: string) {
    const ac = new AbortController();
    this.cleanups.add(ac);
    void this.adb
      .shell(serial, `rm -rf -- ${shQuote(p)}`, { timeoutMs: 600_000, signal: ac.signal })
      .catch(() => undefined)
      .finally(() => this.cleanups.delete(ac));
  }

  /** Kills background deletes so End Session leaves no adb process running. */
  stopBackground() {
    for (const ac of this.cleanups) ac.abort();
    this.cleanups.clear();
  }
}
