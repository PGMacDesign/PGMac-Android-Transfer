import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Adb } from '../src/server/adb/adb.ts';
import { buildApp } from '../src/server/app.ts';
import { AndroidFs } from '../src/server/fs/android.ts';
import { MacFs } from '../src/server/fs/mac.ts';
import { listenForForceStop } from '../src/server/parentPort.ts';
import { StateStore } from '../src/server/stateStore.ts';
import { AdbRunner } from '../src/server/transfers/adbRunner.ts';
import * as children from '../src/server/transfers/children.ts';
import { forceStop, trackChild, trackedPids } from '../src/server/transfers/children.ts';
import type { RunHandle, TransferRunner } from '../src/server/transfers/queue.ts';

// Passes through to the real registry, so the runner test can see that its cp was tracked.
vi.mock('../src/server/transfers/children.ts', async (orig) => {
  const real = await orig<typeof import('../src/server/transfers/children.ts')>();
  return { ...real, trackChild: vi.fn(real.trackChild) };
});

const spawned: ChildProcess[] = [];
const sleeper = () => {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  spawned.push(c);
  return c;
};
const isRunning = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
// A SIGKILLed child is only gone once it has been reaped, which the exit event reports.
const exitOf = (c: ChildProcess) =>
  isRunning(c) ? once(c, 'exit').then(([, signal]) => signal) : Promise.resolve(c.signalCode);

afterEach(() => {
  forceStop();
  for (const c of spawned.splice(0)) if (isRunning(c)) c.kill('SIGKILL');
});

describe('transfer child registry', () => {
  it('kills every registered child and nothing else', async () => {
    const a = sleeper();
    const b = sleeper();
    const outsider = sleeper();
    trackChild(a);
    trackChild(b);
    expect(trackedPids().sort()).toEqual([a.pid, b.pid].sort());
    forceStop();
    expect(await exitOf(a)).toBe('SIGKILL');
    expect(await exitOf(b)).toBe('SIGKILL');
    expect(trackedPids()).toEqual([]);
    // Signal 0 only checks the process exists.
    expect(() => process.kill(outsider.pid!, 0)).not.toThrow();
    expect(isRunning(outsider)).toBe(true);
  });

  it('swallows ESRCH for a pid that already exited and keeps killing the rest', async () => {
    const gone = spawn('true');
    await once(gone, 'exit');
    // Stands in for a child that exited before its exit event ran: its pid is still listed.
    const stale = Object.assign(new EventEmitter(), { pid: gone.pid }) as unknown as ChildProcess;
    trackChild(stale);
    const live = sleeper();
    trackChild(live);
    expect(() => forceStop()).not.toThrow();
    expect(await exitOf(live)).toBe('SIGKILL');
    expect(trackedPids()).toEqual([]);
  });

  it('drops a child that exits on its own', async () => {
    const c = spawn('true');
    trackChild(c);
    expect(trackedPids()).toEqual([c.pid]);
    await once(c, 'exit');
    expect(trackedPids()).toEqual([]);
  });

  it('skips a child that failed to spawn', async () => {
    const c = spawn('/nonexistent/binary');
    c.on('error', () => undefined);
    trackChild(c);
    expect(trackedPids()).toEqual([]);
  });

  it("tracks the runner's cp and leaves the registry empty once the job completes", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-children-'));
    await mkdir(path.join(d, 'dest'));
    await writeFile(path.join(d, 'a.txt'), 'hello');
    const adb = new Adb(null);
    const serial = () => {
      throw new Error('copy jobs must not need a device');
    };
    const runner = new AdbRunner({
      adb,
      serial,
      android: new AndroidFs(adb, serial),
      mac: new MacFs(d),
      pollMs: 20,
    });
    vi.mocked(children.trackChild).mockClear();
    await runner.start(
      {
        direction: 'copy',
        srcPath: path.join(d, 'a.txt'),
        isDir: false,
        partialPath: path.join(d, 'dest', '.a.txt.pgmac-partial'),
        finalPath: path.join(d, 'dest', 'a.txt'),
        replace: false,
      },
      {
        onTotal: () => undefined,
        onProgress: () => undefined,
        onCommit: () => undefined,
      },
    ).done;
    expect(await readFile(path.join(d, 'dest', 'a.txt'), 'utf8')).toBe('hello');
    expect(children.trackChild).toHaveBeenCalledTimes(1);
    expect(vi.mocked(children.trackChild).mock.calls[0]![0].pid).toEqual(expect.any(Number));
    expect(trackedPids()).toEqual([]);
  });
});

/** A runner whose child ignores cancellation: cancel() returns without stopping it. */
class StubbornRunner implements TransferRunner {
  child: ChildProcess | null = null;
  start(): RunHandle {
    const child = sleeper();
    trackChild(child);
    this.child = child;
    return {
      done: new Promise<void>(() => undefined),
      cancel: async () => undefined,
    };
  }
}

describe('shutdown', () => {
  it('kills a transfer child that cancelling left running', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pgmac-children-home-'));
    await writeFile(path.join(home, 'a.txt'), 'hello');
    await mkdir(path.join(home, 'dest'));
    const runner = new StubbornRunner();
    const app = await buildApp({
      config: {
        port: 4997,
        defaultDeviceIp: null,
        maxConcurrent: 3,
        adbPath: '/nonexistent/adb',
        openBrowser: false,
        stateDir: null,
      },
      home,
      store: new StateStore(path.join(home, 'state.json')),
      runner,
      resolveAdb: async () => null,
      stagingRoot: path.join(home, 'staging'),
      reveal: () => undefined,
    });
    const plan = await app.queue.plan({
      from: 'paths',
      destSide: 'mac',
      destDir: path.join(home, 'dest'),
      srcPaths: [path.join(home, 'a.txt')],
    });
    app.queue.commit({ batchId: plan.batchId, decisions: {} });
    await vi.waitFor(() => expect(runner.child).not.toBeNull());
    const child = runner.child!;
    await app.shutdown();
    expect(trackedPids()).toEqual([]);
    expect(await exitOf(child)).toBe('SIGKILL');
  });
});

describe('listenForForceStop', () => {
  const fakePort = () => {
    const port = new EventEmitter();
    return Object.assign(port, {
      deliver: (data: unknown) => port.emit('message', { data }),
    });
  };

  it('runs forceStop and then exits when the desktop app asks', () => {
    const port = fakePort();
    const calls: string[] = [];
    expect(
      listenForForceStop(port, {
        forceStop: () => calls.push('forceStop'),
        exit: (code) => calls.push(`exit ${code}`),
      }),
    ).toBe(true);
    port.deliver({ type: 'something-else' });
    expect(calls).toEqual([]);
    port.deliver({ type: 'forceStop' });
    expect(calls).toEqual(['forceStop', 'exit 1']);
  });

  it('kills real registered children through the handler', async () => {
    const port = fakePort();
    const exit = vi.fn();
    listenForForceStop(port, { forceStop, exit });
    const c = sleeper();
    trackChild(c);
    port.deliver({ type: 'forceStop' });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(await exitOf(c)).toBe('SIGKILL');
  });

  it('does nothing in browser mode, where there is no parent port', () => {
    expect(listenForForceStop(undefined, { forceStop, exit: vi.fn() })).toBe(false);
  });
});

describe('server entry', () => {
  it('kills registered children on any exit and listens for forceStop from the desktop app', async () => {
    const src = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts'),
      'utf8',
    );
    expect(src).toContain("process.on('exit', forceStop);");
    expect(src).toMatch(/listenForForceStop\(parentPort, \{ forceStop, exit: /);
  });
});
