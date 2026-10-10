import { chmod, lstat, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { invalid } from '../errors.ts';

/**
 * Finder uploads land here before they become normal transfers: `<root>/<jobId>/<item name>`.
 * The browser never reveals where dropped files live, so their bytes must be copied once.
 */
export class Staging {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  itemPath(jobId: string, name: string) {
    return path.join(this.root, jobId, name);
  }

  /**
   * Absolute path for `rel` inside a staged item. `rel` comes from the page, so every segment
   * must be a plain name (no `..`, empty segments, leading or trailing spaces, or NUL bytes).
   */
  resolve(itemPath: string, rel: string): string {
    if (!rel) return itemPath;
    const segments = rel.split('/');
    for (const seg of segments) {
      if (!seg || seg === '.' || seg === '..' || seg.includes('\0') || seg !== seg.trim()) {
        throw invalid('Invalid upload path.');
      }
      if (Buffer.byteLength(seg) > 255) throw invalid('Invalid upload path.');
    }
    const full = path.resolve(itemPath, ...segments);
    if (!full.startsWith(itemPath + path.sep)) throw invalid('Invalid upload path.');
    return full;
  }

  async remove(jobId: string) {
    await rm(path.join(this.root, jobId), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Startup: anything left here belongs to a previous run whose jobs no longer exist. */
  async clearAll() {
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
    await this.ensureRoot();
  }

  /** Staged copies of the user's files stay private whatever the umask is. */
  async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  /** Bytes and files staged for an item. A folder that never got a file is created empty. */
  async measure(
    itemPath: string,
    isDir: boolean,
  ): Promise<{ bytes: number; files: number } | null> {
    const st = await lstat(itemPath).catch(() => null);
    if (!st) {
      if (!isDir) return null;
      await mkdir(itemPath, { recursive: true });
      return { bytes: 0, files: 0 };
    }
    if (st.isDirectory() !== isDir) return null;
    if (!isDir) return { bytes: st.size, files: 1 };
    let bytes = 0;
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const it of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) await walk(full);
        else if (it.isFile()) {
          bytes += (await lstat(full)).size;
          files += 1;
        }
      }
    };
    await walk(itemPath);
    return { bytes, files };
  }

  async freeBytes(): Promise<number | null> {
    try {
      await this.ensureRoot();
      const s = await statfs(this.root);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }
}
