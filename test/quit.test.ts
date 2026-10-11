import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/server/app.ts';
import {
  activeJobCount,
  listenForQuit,
  type QuitPort,
  type QuitReply,
} from '../src/server/parentPort.ts';
import { StateStore } from '../src/server/stateStore.ts';
import { forceStop, trackChild, trackedPids } from '../src/server/transfers/children.ts';
import type { RunHandle, TransferRunner, TransferSpec } from '../src/server/transfers/queue.ts';
import type { Job } from '../src/shared/protocol.ts';
import { FakeRunner, flush } from './helpers.ts';

// The server's Host check refuses anything but its own address.
const H = { host: '127.0.0.1:4996' };
const isRunning = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

afterEach(() => {
  forceStop();
});

function fakePort() {
  const port = new EventEmitter();
  const posted: QuitReply[] = [];
  return Object.assign(port as EventEmitter & QuitPort, {
    posted,
    postMessage: (m: QuitReply) => void posted.push(m),
    deliver: (data: unknown) => port.emit('message', { data }),
  });
}

async function setup(runner: TransferRunner, onQuit?: () => void) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pgmac-quit-'));
  await mkdir(path.join(home, 'dest'));
  const app = await buildApp({
    config: {
      port: 4996,
      defaultDeviceIp: null,
      maxConcurrent: 1,
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
    onQuit,
  });
  return { app, home };
}

/** Copies `names` from home into home/dest: with one slot, the first runs and the rest queue. */
async function startCopies(app: App, home: string, names: string[]) {
  for (const n of names) await writeFile(path.join(home, n), n);
  const plan = await app.queue.plan({
    from: 'paths',
    destSide: 'mac',
    destDir: path.join(home, 'dest'),
    srcPaths: names.map((n) => path.join(home, n)),
  });
  app.queue.commit({ batchId: plan.batchId, decisions: {} });
}

/**
 * Holds each transfer open with a real, registered child process and a partial file at the
 * destination, and keeps the real runner's cancel contract: stop the process, then remove the
 * partial.
 */
class ProcessRunner implements TransferRunner {
  readonly children: ChildProcess[] = [];
  start(spec: TransferSpec): RunHandle {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    trackChild(child);
    this.children.push(child);
    const exited = once(child, 'exit');
    const ready = writeFile(spec.partialPath, 'partial');
    return {
      done: exited.then(() => {
        throw new Error('Cancelled');
      }),
      cancel: async () => {
        await ready;
        if (isRunning(child)) child.kill('SIGTERM');
        await exited;
        await rm(spec.partialPath, { force: true });
      },
    };
  }
}

const job = (status: Job['status']) => ({ status }) as Job;

describe('activeJobCount', () => {
  it('counts running, queued and uploading jobs, not finished ones', () => {
    const jobs = ['running', 'queued', 'uploading', 'done', 'failed', 'cancelled'] as const;
    expect(activeJobCount(jobs.map(job))).toBe(3);
    expect(activeJobCount([])).toBe(0);
  });
});

describe('listenForQuit', () => {
  it('does nothing in browser mode, where there is no parent port', () => {
    expect(
      listenForQuit(undefined, {
        activeCount: () => 0,
        shutdown: async () => undefined,
        exit: vi.fn(),
      }),
    ).toBe(false);
  });

  it('answers the count with running and queued jobs', async () => {
    const runner = new FakeRunner();
    const { app, home } = await setup(runner);
    const port = fakePort();
    listenForQuit(port, {
      activeCount: () => activeJobCount(app.queue.jobs()),
      shutdown: app.shutdown,
      exit: vi.fn(),
    });
    port.deliver({ type: 'countActive' });
    expect(port.posted).toEqual([{ type: 'activeCount', count: 0 }]);
    await startCopies(app, home, ['a.txt', 'b.txt']);
    await vi.waitFor(() => expect(runner.runs).toHaveLength(1));
    port.deliver({ type: 'countActive' });
    expect(port.posted.at(-1)).toEqual({ type: 'activeCount', count: 2 });
    await app.shutdown();
  });

  it('leaves nothing running: jobs cancelled, partials removed, no live child, then exits', async () => {
    const runner = new ProcessRunner();
    const { app, home } = await setup(runner);
    const port = fakePort();
    const exit = vi.fn();
    listenForQuit(port, {
      activeCount: () => activeJobCount(app.queue.jobs()),
      shutdown: app.shutdown,
      exit,
    });
    await startCopies(app, home, ['a.txt', 'b.txt']);
    await vi.waitFor(async () => {
      expect(runner.children).toHaveLength(1);
      expect(await readdir(path.join(home, 'dest'))).toEqual(['.a.txt.pgmac-partial']);
    });
    const child = runner.children[0]!;
    expect(trackedPids()).toEqual([child.pid]);

    port.deliver({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(port.posted).toEqual([{ type: 'shutdownDone' }]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.queue.jobs().map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
    expect(await readdir(path.join(home, 'dest'))).toEqual([]);
    expect(trackedPids()).toEqual([]);
    expect(isRunning(child)).toBe(false);
    // The originals are untouched.
    expect(await readFile(path.join(home, 'a.txt'), 'utf8')).toBe('a.txt');
  });

  it('replies only after shutdown resolves, and exits only after replying', async () => {
    const calls: string[] = [];
    let finish!: () => void;
    const port = fakePort();
    port.postMessage = (m) => void calls.push(m.type);
    listenForQuit(port, {
      activeCount: () => 0,
      shutdown: () => new Promise<void>((r) => (finish = r)),
      exit: (code) => void calls.push(`exit ${code}`),
    });
    port.deliver({ type: 'shutdown' });
    await flush();
    expect(calls).toEqual([]);
    finish();
    await flush();
    expect(calls).toEqual(['shutdownDone', 'exit 0']);
  });

  it('exits without shutdownDone when the shutdown fails', async () => {
    const port = fakePort();
    const exit = vi.fn();
    const log = vi.fn();
    listenForQuit(port, {
      activeCount: () => 0,
      shutdown: async () => {
        throw new Error('close failed');
      },
      exit,
      log,
    });
    port.deliver({ type: 'shutdown' });
    await flush();
    expect(port.posted).toEqual([]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it('ignores other messages, including forceStop, which has its own handler', () => {
    const port = fakePort();
    const exit = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    listenForQuit(port, { activeCount: () => 0, shutdown, exit });
    for (const m of [null, 'shutdown', { type: 'forceStop' }, { type: 'listening' }]) {
      port.deliver(m);
    }
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(port.posted).toEqual([]);
  });
});

describe('one shared shutdown', () => {
  it('POST /api/quit and then the desktop shutdown both wait for the slow cancel', async () => {
    const runner = new FakeRunner();
    runner.holdCancels = true;
    const onQuit = vi.fn();
    const { app, home } = await setup(runner, onQuit);
    const port = fakePort();
    const exit = vi.fn();
    listenForQuit(port, {
      activeCount: () => activeJobCount(app.queue.jobs()),
      shutdown: app.shutdown,
      exit,
    });
    await startCopies(app, home, ['a.txt']);
    await vi.waitFor(() => expect(runner.runs).toHaveLength(1));

    const res = await app.server.inject({ method: 'POST', url: '/api/quit', headers: H });
    expect(res.statusCode).toBe(200);
    await flush();
    port.deliver({ type: 'shutdown' });
    expect(app.shutdown()).toBe(app.shutdown());
    for (let i = 0; i < 5; i++) await flush();
    expect(runner.runs[0]!.cancelled).toBe(true);
    expect(onQuit).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(port.posted).toEqual([]);

    runner.runs[0]!.finishCancel();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(onQuit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(port.posted).toEqual([{ type: 'shutdownDone' }]);
    expect(app.queue.jobs().map((j) => j.status)).toEqual(['cancelled']);
  });

  it('the desktop shutdown and then POST /api/quit both wait too', async () => {
    const runner = new FakeRunner();
    runner.holdCancels = true;
    const onQuit = vi.fn();
    const { app, home } = await setup(runner, onQuit);
    const port = fakePort();
    const exit = vi.fn();
    listenForQuit(port, { activeCount: () => 0, shutdown: app.shutdown, exit });
    await startCopies(app, home, ['a.txt']);
    await vi.waitFor(() => expect(runner.runs).toHaveLength(1));

    port.deliver({ type: 'shutdown' });
    await flush();
    // The server only closes once the cancels are done, so the route still answers.
    const res = await app.server.inject({ method: 'POST', url: '/api/quit', headers: H });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await flush();
    expect(onQuit).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    runner.runs[0]!.finishCancel();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    await vi.waitFor(() => expect(onQuit).toHaveBeenCalledOnce());
  });
});

describe('server entry', () => {
  it('answers the desktop quit sequence with the shared shutdown', async () => {
    const src = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts'),
      'utf8',
    );
    expect(src).toMatch(/listenForQuit\(parentPort, \{/);
    expect(src).toContain('shutdown: app.shutdown,');
    // Signals wait for the same shutdown before exiting.
    expect(src).toMatch(/await app\.shutdown\(\);\s*process\.exit\(0\);/);
  });
});
