import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Adb } from '../src/server/adb/adb.ts';
import { AndroidFs } from '../src/server/fs/android.ts';
import { MacFs } from '../src/server/fs/mac.ts';
import { AdbRunner } from '../src/server/transfers/adbRunner.ts';
import { isOfflineError } from '../src/server/fs/volumes.ts';

function runner(home: string) {
  const adb = new Adb(null);
  const serial = () => {
    throw new Error('copy jobs must not need a device');
  };
  return new AdbRunner({
    adb,
    serial,
    android: new AndroidFs(adb, serial),
    mac: new MacFs(home),
    pollMs: 20,
  });
}

const hooks = () => {
  const progress: number[] = [];
  let total = 0;
  return {
    progress,
    total: () => total,
    onTotal: (b: number) => (total = b),
    onProgress: (b: number) => progress.push(b),
    onCommit: () => undefined,
  };
};

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'pgmac-copy-'));

describe('AdbRunner copy (Mac to Mac)', () => {
  it('copies a folder through a partial and renames it into place', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-copy-'));
    await mkdir(path.join(d, 'src', 'Pics', 'sub'), { recursive: true });
    await writeFile(path.join(d, 'src', 'Pics', 'sub', 'a.txt'), 'hello');
    await mkdir(path.join(d, 'dest'));
    const h = hooks();
    await runner(d).start(
      {
        direction: 'copy',
        srcPath: path.join(d, 'src', 'Pics'),
        isDir: true,
        partialPath: path.join(d, 'dest', '.Pics.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'Pics'),
        replace: false,
      },
      h,
    ).done;
    expect(await readFile(path.join(d, 'dest', 'Pics', 'sub', 'a.txt'), 'utf8')).toBe('hello');
    expect(await readdir(path.join(d, 'dest'))).toEqual(['Pics']);
    expect(h.total()).toBe(5);
    // The staged source stays for a retry; the queue deletes it.
    expect(await readdir(path.join(d, 'src'))).toEqual(['Pics']);
  });

  it('keeps the source dates on copied files and folders', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-copy-'));
    const old = new Date('2020-01-02T03:04:05Z');
    await mkdir(path.join(d, 'src', 'Pics', 'sub'), { recursive: true });
    await writeFile(path.join(d, 'src', 'Pics', 'sub', 'a.txt'), 'hello');
    for (const p of ['Pics/sub/a.txt', 'Pics/sub', 'Pics']) {
      await utimes(path.join(d, 'src', p), old, old);
    }
    await mkdir(path.join(d, 'dest'));
    await runner(d).start(
      {
        direction: 'copy',
        srcPath: path.join(d, 'src', 'Pics'),
        isDir: true,
        partialPath: path.join(d, 'dest', '.Pics.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'Pics'),
        replace: false,
      },
      hooks(),
    ).done;
    for (const p of ['Pics/sub/a.txt', 'Pics/sub', 'Pics']) {
      expect((await stat(path.join(d, 'dest', p))).mtimeMs, p).toBe(old.getTime());
    }
  });

  it('replaces an existing file', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-copy-'));
    await writeFile(path.join(d, 'new.txt'), 'new');
    await mkdir(path.join(d, 'dest'));
    await writeFile(path.join(d, 'dest', 'a.txt'), 'old');
    await runner(d).start(
      {
        direction: 'copy',
        srcPath: path.join(d, 'new.txt'),
        isDir: false,
        partialPath: path.join(d, 'dest', '.a.txt.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'a.txt'),
        replace: true,
      },
      hooks(),
    ).done;
    expect(await readFile(path.join(d, 'dest', 'a.txt'), 'utf8')).toBe('new');
    expect(await readdir(path.join(d, 'dest'))).toEqual(['a.txt']);
  });

  it('aborts a stalled pull whose share stopped answering, without hanging', async () => {
    const d = await tmp();
    // A fake adb: shell commands answer at once, pull hangs like a write to a dead share.
    const fake = path.join(d, 'adb');
    await writeFile(fake, '#!/bin/sh\ncase "$*" in *" pull "*) exec sleep 600;; esac\necho 5\n', {
      mode: 0o755,
    });
    await mkdir(path.join(d, 'nas'));
    const adb = new Adb(fake);
    const serial = () => 'fake-serial';
    const nas = path.join(d, 'nas');
    const r = new AdbRunner({
      adb,
      serial,
      android: new AndroidFs(adb, serial),
      mac: new MacFs(d),
      pollMs: 20,
      stallMs: 100,
      exitCapMs: 500,
      volumes: {
        volumeOf: (p) =>
          p.startsWith(nas) ? { source: '//nas/x', mountPoint: nas, type: 'smbfs' } : null,
        check: async () => false,
      },
    });
    const started = Date.now();
    const done = r.start(
      {
        direction: 'pull',
        srcPath: '/sdcard/x',
        isDir: false,
        partialPath: path.join(nas, '.x.pgmac-partial'),
        finalPath: path.join(nas, 'x'),
        replace: false,
      },
      hooks(),
    ).done;
    await expect(done).rejects.toSatisfy(isOfflineError);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('AdbRunner cancel before the final rename', () => {
  // A MacFs whose dating step waits for the test, so a cancel can land in the middle of it.
  class GatedMac extends MacFs {
    entered!: Promise<void>;
    release!: () => void;
    constructor(home: string) {
      super(home);
      let enter!: () => void;
      this.entered = new Promise((r) => (enter = r));
      const gate = new Promise<void>((r) => (this.release = r));
      const wait = async () => {
        enter();
        await gate;
      };
      this.copyTimes = wait;
      this.setTimes = wait;
    }
  }

  const replaceSpec = (d: string, direction: 'copy' | 'pull') => ({
    direction,
    srcPath: path.join(d, 'new.txt'),
    isDir: false,
    partialPath: path.join(d, 'dest', '.a.txt.pgmac-partial'),
    finalPath: path.join(d, 'dest', 'a.txt'),
    replace: true,
  });

  const setupDirs = async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-cancel-'));
    await writeFile(path.join(d, 'new.txt'), 'INCOMING');
    await mkdir(path.join(d, 'dest'));
    await writeFile(path.join(d, 'dest', 'a.txt'), 'ORIGINAL');
    return d;
  };

  for (const direction of ['copy', 'pull'] as const) {
    it(`a ${direction} cancelled while dates are applied never replaces the original`, async () => {
      const d = await setupDirs();
      const mac = new GatedMac(d);
      // Pull stand-ins: the "phone" is a local file and adb pull is cp.
      const android = {
        measure: async () => ({ bytes: 8, files: 1 }),
        times: async () => [{ rel: '', mtimeMs: 1 }],
      } as unknown as AndroidFs;
      const adb = {
        spawn: (args: string[]) => spawn('cp', [args.at(-2)!, args.at(-1)!]),
      } as unknown as Adb;
      const r = new AdbRunner({ adb, serial: () => 'x', android, mac, pollMs: 20 });
      const h = r.start(replaceSpec(d, direction), hooks());
      await mac.entered;
      const cancelling = h.cancel();
      mac.release();
      await cancelling;
      await expect(h.done).rejects.toThrow('Cancelled');
      expect(await readFile(path.join(d, 'dest', 'a.txt'), 'utf8')).toBe('ORIGINAL');
      expect(await readdir(path.join(d, 'dest'))).toEqual(['a.txt']);
    });
  }

  it("a pull cancelled while reading the phone's dates stops at once", async () => {
    const d = await setupDirs();
    let spawned = false;
    const android = {
      measure: async () => ({ bytes: 8, files: 1 }),
      times: (_p: string, signal: AbortSignal) =>
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    } as unknown as AndroidFs;
    const adb = {
      spawn: () => {
        spawned = true;
        return spawn('true');
      },
    } as unknown as Adb;
    const r = new AdbRunner({ adb, serial: () => 'x', android, mac: new MacFs(d), pollMs: 20 });
    const h = r.start(replaceSpec(d, 'pull'), hooks());
    await new Promise((res) => setTimeout(res, 20));
    const t0 = Date.now();
    await h.cancel();
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(h.done).rejects.toThrow();
    expect(spawned).toBe(false);
  });
});

describe('AdbRunner progress sampling', () => {
  it('never stacks samples on a destination whose calls hang', async () => {
    const d = await tmp();
    await writeFile(path.join(d, 'new.txt'), 'x');
    await mkdir(path.join(d, 'dest'));
    let calls = 0;
    class HungMac extends MacFs {
      override measure(): Promise<{ bytes: number; files: number }> {
        calls++;
        return new Promise(() => {});
      }
    }
    const android = {
      measure: async () => ({ bytes: 8, files: 1 }),
      times: async () => [],
    } as unknown as AndroidFs;
    // A pull that never finishes, like adb writing to a share that just dropped.
    const adb = { spawn: () => spawn('sleep', ['5']) } as unknown as Adb;
    const r = new AdbRunner({ adb, serial: () => 'x', android, mac: new HungMac(d), pollMs: 10 });
    const h = r.start(
      {
        direction: 'pull',
        srcPath: '/sdcard/new.txt',
        isDir: false,
        partialPath: path.join(d, 'dest', '.new.txt.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'new.txt'),
        replace: false,
      },
      hooks(),
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(calls).toBe(1);
    await h.cancel();
    await h.done.catch(() => undefined);
  });
});

describe('AdbRunner device-done signal', () => {
  const pullWith = async (cmd: string[]) => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-done-'));
    await writeFile(path.join(d, 'new.txt'), 'x');
    await mkdir(path.join(d, 'dest'));
    const android = {
      measure: async () => ({ bytes: 1, files: 1 }),
      times: async () => [],
    } as unknown as AndroidFs;
    const adb = {
      spawn: (args: string[]) =>
        cmd.length ? spawn(cmd[0]!, cmd.slice(1)) : spawn('cp', [args.at(-2)!, args.at(-1)!]),
    } as unknown as Adb;
    const r = new AdbRunner({ adb, serial: () => 'x', android, mac: new MacFs(d), pollMs: 20 });
    let doneCalls = 0;
    const h = r.start(
      {
        direction: 'pull',
        srcPath: path.join(d, 'new.txt'),
        isDir: false,
        partialPath: path.join(d, 'dest', '.new.txt.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'new.txt'),
        replace: false,
      },
      { ...hooks(), onDeviceDone: () => doneCalls++ },
    );
    await h.done.catch(() => undefined);
    return doneCalls;
  };

  it('fires once after adb pull succeeds, never when it fails', async () => {
    expect(await pullWith([])).toBe(1);
    expect(await pullWith(['false'])).toBe(0);
  });
});
