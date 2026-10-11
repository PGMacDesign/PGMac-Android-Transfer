import { spawn, type ChildProcess } from 'node:child_process';
import { shQuote, type Adb } from '../adb/adb.ts';
import type { AndroidFs } from '../fs/android.ts';
import type { MacFs } from '../fs/mac.ts';
import { isOfflineError, offlineError, type Mount } from '../fs/volumes.ts';
import {
  DEVICE_LOST,
  type RunHandle,
  type RunHooks,
  type TransferRunner,
  type TransferSpec,
} from './queue.ts';

/** Turns adb push/pull stderr into a short message for the transfer row. */
export function describeAdbFailure(output: string): string {
  const text = output.trim();
  if (
    /device .*not found|device offline|no devices|closed|connection reset|broken pipe/i.test(text)
  ) {
    return DEVICE_LOST;
  }
  if (/No space left/i.test(text)) return 'Not enough free space at the destination';
  if (/Permission denied|Operation not permitted|Read-only file system/i.test(text)) {
    return 'Permission denied at the destination';
  }
  const line = text.split('\n').filter(Boolean).pop() ?? '';
  return line.replace(/^adb: error: /, '').slice(0, 200) || 'Transfer failed';
}

export interface AdbRunnerDeps {
  adb: Adb;
  serial: () => string;
  android: AndroidFs;
  mac: MacFs;
  /** How often to sample the destination size. */
  pollMs?: number;
  /** Network volume awareness for the Mac side (see volumes.ts). */
  volumes?: { volumeOf(p: string): Mount | null; check(p: string): Promise<boolean> };
  /** No progress for this long on a network volume triggers a probe. */
  stallMs?: number;
  /** How long to wait for a killed process to exit before moving on without it. */
  exitCapMs?: number;
}

/**
 * Runs one transfer with `adb push` / `adb pull` into a hidden partial path next to the
 * destination, then renames it into place. adb only prints progress to a TTY, so progress
 * comes from polling the partial's size.
 */
export class AdbRunner implements TransferRunner {
  private readonly deps: AdbRunnerDeps;
  constructor(deps: AdbRunnerDeps) {
    this.deps = deps;
  }

  stopBackground() {
    this.deps.android.stopBackground();
  }

  start(spec: TransferSpec, hooks: RunHooks): RunHandle {
    const { adb, android, mac } = this.deps;
    const copy = spec.direction === 'copy';
    // Copy (Mac to Mac) runs without a device session.
    const serial = copy ? '' : this.deps.serial();
    const push = spec.direction === 'push';
    const pull = spec.direction === 'pull';
    const srcFs = spec.direction === 'pull' ? android : mac;
    const destFs = push ? android : mac;
    let child: ChildProcess | null = null;
    let cancelled = false;
    // Ends phone calls made before adb starts (measuring, reading dates) when cancelled.
    const abort = new AbortController();
    const stopped = () => cancelled;
    let committing = false;
    let poll: NodeJS.Timeout | null = null;
    let exited: Promise<void> = Promise.resolve();
    const exitCap = this.deps.exitCapMs ?? 10_000;
    // A process blocked on a dead network share may not exit even after SIGKILL, so every
    // wait on it is capped; the job moves on and the process is left to the kernel.
    const capped = (p: Promise<unknown>) =>
      Promise.race([p, new Promise((r) => setTimeout(r, exitCap).unref())]);

    const removePartial = async () => {
      if (push) {
        await adb
          .shell(serial, `rm -rf -- ${shQuote(spec.partialPath)}`, { timeoutMs: 15_000 })
          .catch(() => undefined);
      } else {
        await mac.removePartial(spec.partialPath);
      }
    };

    // The ends of the transfer that may sit on a NAS share: the source of a push, the
    // destination of a pull, and both ends of a copy (a desktop-app Finder drop copies from
    // wherever the files are).
    const macPaths = push
      ? [spec.srcPath]
      : copy
        ? [spec.srcPath, spec.partialPath]
        : [spec.partialPath];
    const shared = macPaths
      .map((p) => this.deps.volumes?.volumeOf(p) ?? null)
      .filter((m): m is Mount => m !== null);
    let volumeLost: Error | null = null;
    let forceExit: (() => void) | null = null;
    const abortForVolume = (err: Error) => {
      if (volumeLost || cancelled) return;
      volumeLost = err;
      if (poll) clearInterval(poll);
      const proc = child as ChildProcess | null;
      proc?.kill('SIGKILL');
      setTimeout(() => forceExit?.(), exitCap).unref();
    };

    let lastBytes = -1;
    let lastChange = Date.now();
    let probing = false;
    const stallMs = this.deps.stallMs ?? 30_000;
    const sample = async () => {
      try {
        const m = await destFs.measure(spec.partialPath);
        if (m.bytes !== lastBytes) {
          lastBytes = m.bytes;
          lastChange = Date.now();
        }
        hooks.onProgress(m.bytes);
      } catch (err) {
        if (isOfflineError(err)) abortForVolume(err as Error);
        // Otherwise the partial doesn't exist until the first byte is written.
      }
      // A transfer reading from or writing to a dead share can stall without any error.
      if (shared.length && !probing && !volumeLost && Date.now() - lastChange > stallMs) {
        probing = true;
        let dead: Mount | null = null;
        for (const m of shared) {
          if (await this.deps.volumes!.check(m.mountPoint).catch(() => true)) continue;
          dead = m;
          break;
        }
        probing = false;
        if (dead) abortForVolume(offlineError(dead.mountPoint.split('/').pop() ?? 'The share'));
        else lastChange = Date.now();
      }
    };

    const done = (async () => {
      const total = pull
        ? await android.measure(spec.srcPath, abort.signal)
        : await srcFs.measure(spec.srcPath);
      if (cancelled) throw new Error('Cancelled');
      hooks.onTotal(total.bytes, total.files);
      // Not `adb pull -a`: it fails the whole pull when it can't chmod the copy, which SMB
      // shares can refuse. The dates are read up front and applied after instead.
      const times = pull ? await android.times(spec.srcPath, abort.signal).catch(() => []) : [];
      if (cancelled) throw new Error('Cancelled');
      await removePartial();
      if (cancelled) throw new Error('Cancelled');

      // cp -R into a new name creates it with the source's contents, like adb push/pull.
      // No -p: SMB shares reject ownership changes and cp would exit non-zero.
      child = copy
        ? spawn('cp', ['-R', '--', spec.srcPath, spec.partialPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : adb.spawn(['-s', serial, push ? 'push' : 'pull', spec.srcPath, spec.partialPath]);
      const proc = child;
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
      proc.stderr?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
      const code = await new Promise<number | null>((resolve) => {
        forceExit = () => resolve(-1);
        exited = new Promise<void>((r) => {
          proc.on('close', (c) => {
            resolve(c);
            r();
          });
          proc.on('error', (err) => {
            output += `\n${err.message}`;
            resolve(-1);
            r();
          });
        });
        // Push polls a remote shell per sample, so it samples less often than pull.
        const every = this.deps.pollMs ?? (push ? 1000 : 500);
        // One sample at a time: on a share that just died each one hangs a pool thread
        // until the volume is marked offline (~14 s), so overlapping ticks would pile up
        // enough of them to stall every file call in the app.
        let sampling = false;
        poll = setInterval(() => {
          if (sampling) return;
          sampling = true;
          void sample().finally(() => (sampling = false));
        }, every);
      });
      if (poll) clearInterval(poll);
      if (cancelled) throw new Error('Cancelled');
      if (volumeLost) {
        await removePartial();
        throw volumeLost;
      }
      if (code !== 0) {
        await removePartial();
        throw new Error(describeAdbFailure(output));
      }
      if (cancelled) throw new Error('Cancelled');
      if (pull) hooks.onDeviceDone?.();
      // cp without -p dates every copy "now"; put the source dates back before it lands.
      if (copy) await mac.copyTimes(spec.srcPath, spec.partialPath, stopped);
      if (pull) await mac.setTimes(spec.partialPath, times, stopped);
      // Dating a big tree on a share takes a while; a cancel meanwhile must not land it.
      if (cancelled) throw new Error('Cancelled');
      committing = true;
      hooks.onCommit();
      try {
        await destFs.finalize(spec.partialPath, spec.finalPath, spec.replace);
      } catch (err) {
        await removePartial();
        throw err;
      }
      hooks.onProgress(total.bytes);
    })();

    return {
      done,
      cancel: async () => {
        // Once the final rename has started, let it finish; finalize restores the original
        // if it fails, and removing the partial now could race it.
        if (committing) {
          await done.catch(() => undefined);
          return;
        }
        cancelled = true;
        abort.abort();
        if (poll) clearInterval(poll);
        const proc = child as ChildProcess | null;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM');
          const force = setTimeout(() => proc.kill('SIGKILL'), 2000);
          await capped(exited);
          clearTimeout(force);
        }
        forceExit?.();
        await capped(done.catch(() => undefined));
        await removePartial();
      },
    };
  }
}
