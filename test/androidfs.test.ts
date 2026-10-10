import { describe, expect, it } from 'vitest';
import type { Adb, ExecOptions, ExecResult } from '../src/server/adb/adb.ts';
import { AndroidFs } from '../src/server/fs/android.ts';

interface Call {
  serial: string;
  cmd: string;
  opts: ExecOptions;
  resolve(r: Partial<ExecResult>): void;
}

/** adb whose shell commands stay pending until the test resolves them. */
function fakeAdb() {
  const calls: Call[] = [];
  const adb = {
    shell(serial: string, cmd: string, opts: ExecOptions = {}) {
      return new Promise<ExecResult>((res) => {
        calls.push({
          serial,
          cmd,
          opts,
          resolve: (r) => res({ code: 0, stdout: '', stderr: '', timedOut: false, ...r }),
        });
      });
    },
  };
  return { adb: adb as unknown as Adb, calls };
}

describe('AndroidFs.finalize (Replace)', () => {
  it('reports success when the session ends right after the swap', async () => {
    const { adb, calls } = fakeAdb();
    let serial: string | null = 'dev1';
    const fs = new AndroidFs(adb, () => {
      if (!serial) throw new Error('No device session');
      return serial;
    });
    const done = fs.finalize('/sdcard/.a.pgmac-partial', '/sdcard/a', true);
    serial = null;
    calls[0]!.resolve({ code: 0 });
    await expect(done).resolves.toBeUndefined();
    expect(calls.map((c) => c.serial)).toEqual(['dev1', 'dev1']);
    expect(calls[1]!.cmd).toMatch(/^rm -rf -- '\/sdcard\/\.a\.[0-9a-f]+\.pgmac-partial'$/);
  });

  it('completes without waiting for the backup delete, which stopBackground kills', async () => {
    const { adb, calls } = fakeAdb();
    const fs = new AndroidFs(adb, () => 'dev1');
    const done = fs.finalize('/sdcard/.a.pgmac-partial', '/sdcard/a', true);
    calls[0]!.resolve({ code: 0 });
    await done;
    const rm = calls[1]!;
    expect(rm.opts.signal?.aborted).toBe(false);
    fs.stopBackground();
    expect(rm.opts.signal?.aborted).toBe(true);
  });

  it('starts no delete when the swap fails', async () => {
    const { adb, calls } = fakeAdb();
    const fs = new AndroidFs(adb, () => 'dev1');
    const done = fs.finalize('/sdcard/.a.pgmac-partial', '/sdcard/a', true);
    calls[0]!.resolve({ code: 1 });
    await expect(done).rejects.toThrow(/Could not replace/);
    expect(calls).toHaveLength(1);
  });
});
