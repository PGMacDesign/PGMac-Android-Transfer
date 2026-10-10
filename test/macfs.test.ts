import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacFs } from '../src/server/fs/mac.ts';
import { HttpError } from '../src/server/errors.ts';

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'pgmac-macfs-'));
}

describe('MacFs.rename', () => {
  it('allows a case-only rename of the same file', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'a.txt'), 'x');
    await new MacFs(d).rename(path.join(d, 'a.txt'), 'A.txt');
    expect(await readdir(d)).toEqual(['A.txt']);
  });

  it('refuses to rename onto a different existing file', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'a.txt'), 'a');
    await writeFile(path.join(d, 'b.txt'), 'b');
    await expect(new MacFs(d).rename(path.join(d, 'a.txt'), 'b.txt')).rejects.toThrow(/exists/);
    expect(await readFile(path.join(d, 'b.txt'), 'utf8')).toBe('b');
  });
});

describe('MacFs.setTimes', () => {
  it('dates paths under the root and ignores ones that would leave it', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'root', 'sub'), { recursive: true });
    await writeFile(path.join(d, 'root', 'sub', 'a.txt'), 'a');
    await writeFile(path.join(d, 'outside.txt'), 'o');
    const before = (await stat(path.join(d, 'outside.txt'))).mtimeMs;
    const old = Date.parse('2020-01-02T03:04:05Z');
    await new MacFs(d).setTimes(path.join(d, 'root'), [
      { rel: 'sub/a.txt', mtimeMs: old },
      { rel: '', mtimeMs: old },
      { rel: '../outside.txt', mtimeMs: old },
      { rel: 'missing.txt', mtimeMs: old },
    ]);
    expect((await stat(path.join(d, 'root', 'sub', 'a.txt'))).mtimeMs).toBe(old);
    expect((await stat(path.join(d, 'root'))).mtimeMs).toBe(old);
    expect((await stat(path.join(d, 'outside.txt'))).mtimeMs).toBe(before);
  });

  it('stops dating a pull when the share drops', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'a.txt'), 'a');
    const guard = {
      guard: async () => {
        throw new HttpError(503, 'NAS is offline.', 'OFFLINE');
      },
      volumeOf: () => null,
      offlineFor: () => null,
      check: async () => false,
    };
    await expect(
      new MacFs(d, guard).setTimes(d, [{ rel: 'a.txt', mtimeMs: 1 }]),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });
});

describe('MacFs.finalize', () => {
  it('moves a partial into place when nothing is there', async () => {
    const d = await tmp();
    await writeFile(path.join(d, '.a.txt.pgmac-partial'), 'new');
    await new MacFs(d).finalize(path.join(d, '.a.txt.pgmac-partial'), path.join(d, 'a.txt'), false);
    expect(await readFile(path.join(d, 'a.txt'), 'utf8')).toBe('new');
  });

  it('refuses to overwrite without Replace', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'a.txt'), 'old');
    await writeFile(path.join(d, '.a.txt.pgmac-partial'), 'new');
    await expect(
      new MacFs(d).finalize(path.join(d, '.a.txt.pgmac-partial'), path.join(d, 'a.txt'), false),
    ).rejects.toThrow(/appeared/);
    expect(await readFile(path.join(d, 'a.txt'), 'utf8')).toBe('old');
  });

  it('replaces a folder and leaves no backup behind', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'pics'));
    await writeFile(path.join(d, 'pics', 'old.jpg'), 'old');
    await mkdir(path.join(d, '.pics.pgmac-partial'));
    await writeFile(path.join(d, '.pics.pgmac-partial', 'new.jpg'), 'new');
    await new MacFs(d).finalize(path.join(d, '.pics.pgmac-partial'), path.join(d, 'pics'), true);
    expect(await readdir(path.join(d, 'pics'))).toEqual(['new.jpg']);
    expect(await readdir(d)).toEqual(['pics']);
  });

  it('leaves the original untouched when the partial is missing', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'pics'));
    await writeFile(path.join(d, 'pics', 'old.jpg'), 'old');
    await expect(
      new MacFs(d).finalize(path.join(d, '.missing.pgmac-partial'), path.join(d, 'pics'), true),
    ).rejects.toThrow();
    expect(await readdir(path.join(d, 'pics'))).toEqual(['old.jpg']);
  });
});

describe('MacFs on network volumes', () => {
  const offline = () => new HttpError(503, 'NAS is offline.', 'OFFLINE');
  const guardFor = (root: string, opts: { failOn?: string; probe?: boolean } = {}) => ({
    async guard<T>(p: string, fn: () => Promise<T>) {
      if (opts.failOn && p.endsWith(opts.failOn)) throw offline();
      return fn();
    },
    volumeOf: (p: string) =>
      p.startsWith(root) ? { source: '//nas/x', mountPoint: root, type: 'smbfs' } : null,
    offlineFor: () => null,
    check: async () => opts.probe ?? true,
  });

  it('reports a share that drops mid-listing as offline, not as missing files', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'a.txt'), 'a');
    await writeFile(path.join(d, 'b.txt'), 'b');
    const fs = new MacFs(d, guardFor(d, { failOn: 'b.txt' }));
    await expect(fs.list(d)).rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(fs.stat(path.join(d, 'b.txt'))).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('offers a permanent delete when a share has no Trash', async () => {
    const root = '/Volumes/pgmac-test-no-such-volume';
    const fs = new MacFs(os.homedir(), guardFor(root));
    await expect(fs.remove([`${root}/a.txt`])).rejects.toMatchObject({ code: 'NO_TRASH' });
  });

  it('reports offline instead of NO_TRASH when the share stopped answering', async () => {
    const root = '/Volumes/pgmac-test-no-such-volume';
    const fs = new MacFs(os.homedir(), guardFor(root, { probe: false }));
    await expect(fs.remove([`${root}/a.txt`])).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('deletes permanently', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'x', 'y'), { recursive: true });
    await new MacFs(d).removePermanently([path.join(d, 'x')]);
    expect(await readdir(d)).toEqual([]);
  });

  it('copies dates best effort, but stops when the share drops', async () => {
    const d = await tmp();
    const old = new Date('2020-01-02T03:04:05Z');
    await mkdir(path.join(d, 'src', 'sub'), { recursive: true });
    await writeFile(path.join(d, 'src', 'sub', 'a.txt'), 'a');
    await utimes(path.join(d, 'src', 'sub', 'a.txt'), old, old);
    await mkdir(path.join(d, 'dest'));
    // dest/sub is missing: a plain error is skipped, not thrown.
    await expect(new MacFs(d).copyTimes(path.join(d, 'src'), path.join(d, 'dest'))).resolves.toBe(
      undefined,
    );
    const fs = new MacFs(d, guardFor(d, { failOn: 'a.txt' }));
    await expect(fs.copyTimes(path.join(d, 'src'), path.join(d, 'dest'))).rejects.toMatchObject({
      code: 'OFFLINE',
    });
  });

  it('puts back an original parked by a Replace the share interrupted', async () => {
    const d = await tmp();
    await mkdir(path.join(d, 'pics'));
    await writeFile(path.join(d, 'pics', 'old.jpg'), 'old');
    await mkdir(path.join(d, '.pics.pgmac-partial'));
    let calls = 0;
    let down = false;
    const guard = {
      ...guardFor(d),
      async guard<T>(_p: string, fn: () => Promise<T>) {
        calls++;
        // The share drops right after the original is parked (the 3rd call: the rename).
        if (calls === 4) down = true;
        if (down) throw offline();
        return fn();
      },
    };
    const fs = new MacFs(d, guard);
    await expect(
      fs.finalize(path.join(d, '.pics.pgmac-partial'), path.join(d, 'pics'), true),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(await readdir(d)).not.toContain('pics');
    down = false;
    calls = 100;
    await fs.restoreParked();
    expect(await readdir(path.join(d, 'pics'))).toEqual(['old.jpg']);
  });

  // A folder Replace on `root`: the original pics/old.jpg is replaced by a new partial.
  const replaceSetup = async () => {
    const d = await tmp();
    const root = path.join(d, 'NAS');
    await mkdir(path.join(root, 'pics'), { recursive: true });
    await writeFile(path.join(root, 'pics', 'old.jpg'), 'old');
    await mkdir(path.join(root, '.pics.pgmac-partial'));
    return { d, root };
  };
  const finalizeOn = (fs: MacFs, root: string) =>
    fs.finalize(path.join(root, '.pics.pgmac-partial'), path.join(root, 'pics'), true);

  it('finds the original when the parking rename landed but its reply was lost', async () => {
    const { root } = await replaceSetup();
    let calls = 0;
    let down = false;
    const fs = new MacFs(root, {
      ...guardFor(root),
      async guard<T>(_p: string, fn: () => Promise<T>) {
        if (down) throw offline();
        // The 3rd call is the parking rename: it happens, then the share drops.
        if (++calls === 3) {
          await fn();
          down = true;
          throw offline();
        }
        return fn();
      },
    });
    await expect(finalizeOn(fs, root)).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(await readdir(root)).not.toContain('pics');
    down = false;
    await fs.restoreParked();
    expect(await readdir(path.join(root, 'pics'))).toEqual(['old.jpg']);
  });

  it('restores at the new mount point after the share moved', async () => {
    const { d, root } = await replaceSetup();
    let calls = 0;
    let down = false;
    const fs = new MacFs(root, {
      ...guardFor(root),
      async guard<T>(_p: string, fn: () => Promise<T>) {
        if (++calls === 4) down = true;
        if (down) throw offline();
        return fn();
      },
    });
    await expect(finalizeOn(fs, root)).rejects.toMatchObject({ code: 'OFFLINE' });
    const moved = path.join(d, 'NAS-1');
    await rename(root, moved);
    fs.noteMove(root, moved);
    down = false;
    await fs.restoreParked();
    expect(await readdir(path.join(moved, 'pics'))).toEqual(['old.jpg']);
  });

  it('leaves a Replace that is still in progress to its finalize', async () => {
    const { root } = await replaceSetup();
    let calls = 0;
    let down = false;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fs = new MacFs(root, {
      ...guardFor(root),
      async guard<T>(_p: string, fn: () => Promise<T>) {
        const n = ++calls;
        // Hold the second rename while a restore for another share runs, then drop.
        if (n === 4) {
          await gate;
          down = true;
        }
        if (down) throw offline();
        return fn();
      },
    });
    const running = finalizeOn(fs, root);
    for (const deadline = Date.now() + 2000; calls < 4 && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(calls).toBe(4);
    await fs.restoreParked();
    expect(await readdir(root)).not.toContain('pics');
    release();
    await expect(running).rejects.toMatchObject({ code: 'OFFLINE' });
    down = false;
    await fs.restoreParked();
    expect(await readdir(path.join(root, 'pics'))).toEqual(['old.jpg']);
  });
});
