import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_LOST,
  NO_STAGING_SPACE,
  UPLOAD_INTERRUPTED,
  TransferQueue,
} from '../src/server/transfers/queue.ts';
import { FakeRunner, FakeStaging, FakeVolumes, MemoryFs, flush, recordingHub } from './helpers.ts';
import type { Job } from '../src/shared/protocol.ts';
import { HttpError } from '../src/server/errors.ts';

const file = (size: number) => ({ isDir: false, size, mtimeMs: 1 });
const dir = { isDir: true, size: 0, mtimeMs: 1 };

function setup(opts: { max?: number; macFiles?: number; volumes?: FakeVolumes } = {}) {
  const n = opts.macFiles ?? 5;
  const macEntries: Record<string, ReturnType<typeof file> | typeof dir> = { '/m': dir };
  for (let i = 0; i < n; i++) macEntries[`/m/f${i}.txt`] = file(100);
  const mac = new MemoryFs(macEntries);
  const android = new MemoryFs({ '/sdcard': dir, '/sdcard/Download': dir });
  const runner = new FakeRunner();
  const staging = new FakeStaging();
  const revealed: string[][] = [];
  const { hub, messages } = recordingHub();
  let connected = true;
  let sessionId = 1;
  const queue = new TransferQueue({
    hub,
    fs: { mac, android },
    runner,
    isConnected: () => connected,
    sessionId: () => sessionId,
    maxConcurrent: opts.max ?? 2,
    staging,
    reveal: (paths) => revealed.push(paths),
    volumes: opts.volumes,
  });
  const push = async (names: string[], decisions = {}) => {
    const plan = await queue.plan({
      from: 'mac',
      srcPaths: names.map((n) => `/m/${n}`),
      destDir: '/sdcard/Download',
    });
    return { plan, commit: queue.commit({ batchId: plan.batchId, decisions }) };
  };
  const status = () => Object.fromEntries(queue.jobs().map((j) => [j.destName, j.status]));
  const drop = async (
    names: string[],
    destSide: 'mac' | 'android' = 'mac',
    decisions = {},
    pageId = 'page-1',
  ) => {
    const plan = await queue.plan({
      from: 'finder',
      destSide,
      destDir: destSide === 'mac' ? '/m' : '/sdcard/Download',
      items: names.map((name) => ({ name, isDir: false, size: 10, files: 1, mtimeMs: 1 })),
    });
    return queue.commit({ batchId: plan.batchId, decisions, pageId });
  };
  const byName = (n: string) => queue.jobs().find((j) => j.destName === n)!;
  return {
    queue,
    runner,
    staging,
    revealed,
    drop,
    byName,
    mac,
    android,
    messages,
    push,
    status,
    setConnected: (c: boolean) => (connected = c),
    newSession: () => sessionId++,
  };
}

describe('TransferQueue', () => {
  it('never runs more than the limit and drains every job (slot release + liveness)', async () => {
    const t = setup({ max: 2 });
    await t.push(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    expect(t.queue.runningCount()).toBe(2);
    t.runner.runs[0]!.succeed();
    await t.queue.cancel(t.queue.jobs().find((j) => j.status === 'running')!.id);
    await flush();
    expect(t.queue.runningCount()).toBeLessThanOrEqual(2);
    let guard = 0;
    while (t.runner.live().length && guard++ < 20) {
      expect(t.queue.runningCount()).toBeLessThanOrEqual(2);
      const r = t.runner.live()[0]!;
      if (r.spec.finalPath.endsWith('f3.txt')) r.fail('boom');
      else r.succeed();
      await flush();
    }
    expect(t.queue.runningCount()).toBe(0);
    expect(Object.values(t.status()).every((s) => s !== 'queued' && s !== 'running')).toBe(true);
    expect(t.status()['f3.txt']).toBe('failed');
  });

  it('emits exactly one terminal state when cancel races a successful exit', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const id = t.queue.jobs()[0]!.id;
    t.runner.runs[0]!.succeed();
    await t.queue.cancel(id);
    await flush();
    const terminal = t.messages.filter(
      (m) =>
        m.type === 'job' &&
        m.job.id === id &&
        ['done', 'failed', 'cancelled'].includes(m.job.status),
    );
    expect(terminal).toHaveLength(1);
    expect(t.queue.runningCount()).toBe(0);
  });

  it('keeps progress monotonic, clamped, and below 100% until done', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const run = t.runner.runs[0]!;
    run.hooks.onTotal(1000, 1);
    for (const s of [100, 400, 300, 5000]) run.hooks.onProgress(s);
    const series = t.messages
      .filter((m): m is Extract<typeof m, { type: 'job' }> => m.type === 'job')
      .map((m) => m.job)
      .filter((j) => j.status === 'running')
      .map((j) => j.transferredBytes);
    for (let i = 1; i < series.length; i++)
      expect(series[i]!).toBeGreaterThanOrEqual(series[i - 1]!);
    expect(Math.max(...series)).toBeLessThan(1000);
    run.succeed();
    await flush();
    expect(t.queue.jobs()[0]!.transferredBytes).toBe(1000);
  });

  it('drops progress samples that arrive after the job is terminal', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const id = t.queue.jobs()[0]!.id;
    const run = t.runner.runs[0]!;
    await t.queue.cancel(id);
    const before = t.messages.length;
    run.hooks.onProgress(50);
    run.hooks.onTotal(999, 3);
    expect(t.messages.length).toBe(before);
  });

  it('device loss spares a pull whose bytes are already on the Mac', async () => {
    const t = setup({ max: 2 });
    t.android.files.set('/sdcard/Download/a.jpg', file(1));
    t.android.files.set('/sdcard/Download/b.jpg', file(1));
    const plan = await t.queue.plan({
      from: 'android',
      srcPaths: ['/sdcard/Download/a.jpg', '/sdcard/Download/b.jpg'],
      destDir: '/m',
    });
    t.queue.commit({ batchId: plan.batchId, decisions: {} });
    t.runner.runs[0]!.hooks.onDeviceDone?.();
    t.setConnected(false);
    t.queue.onDeviceLost();
    await t.queue.cancelDeviceJobs();
    await flush();
    expect(t.byName('b.jpg')).toMatchObject({ status: 'failed', error: DEVICE_LOST });
    expect(t.byName('a.jpg').status).toBe('running');
    t.runner.runs[0]!.succeed();
    await flush();
    expect(t.byName('a.jpg').status).toBe('done');
  });

  it('device loss fails running jobs, pauses queued ones, and resumes on reconnect', async () => {
    const t = setup({ max: 2 });
    await t.push(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    t.setConnected(false);
    t.queue.onDeviceLost();
    await flush();
    const s = t.status();
    expect(Object.values(s).filter((x) => x === 'failed')).toHaveLength(2);
    expect(Object.values(s).filter((x) => x === 'queued')).toHaveLength(3);
    expect(t.runner.live()).toHaveLength(0);
    expect(
      t.queue
        .jobs()
        .filter((j) => j.status === 'failed')
        .every((j) => j.error === DEVICE_LOST),
    ).toBe(true);
    t.setConnected(true);
    t.queue.onDeviceReady();
    expect(t.queue.runningCount()).toBe(2);
  });

  it('fails waiting jobs when the session is lost', async () => {
    const t = setup({ max: 1 });
    await t.push(['f0.txt', 'f1.txt']);
    t.queue.onDeviceLost();
    t.queue.onSessionLost();
    expect(Object.values(t.status())).toEqual(['failed', 'failed']);
  });

  it('cancelAll leaves nothing non-terminal and no live runs', async () => {
    const t = setup({ max: 2 });
    await t.push(['f0.txt', 'f1.txt', 'f2.txt']);
    await t.queue.cancelAll();
    expect(Object.values(t.status())).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(t.runner.live()).toHaveLength(0);
  });

  it('writes to a hidden partial and only targets the final name on finalize', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const spec = t.runner.runs[0]!.spec;
    expect(spec.partialPath).toBe('/sdcard/Download/.f0.txt.pgmac-partial');
    expect(spec.finalPath).toBe('/sdcard/Download/f0.txt');
  });

  it('gives concurrent Keep-both batches distinct names', async () => {
    const t = setup({ max: 1 });
    t.android.files.set('/sdcard/Download/f0.txt', file(1));
    const p1 = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/f0.txt'],
      destDir: '/sdcard/Download',
    });
    const p2 = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/f0.txt'],
      destDir: '/sdcard/Download',
    });
    t.queue.commit({ batchId: p1.batchId, decisions: { 'f0.txt': 'keep' } });
    t.queue.commit({ batchId: p2.batchId, decisions: { 'f0.txt': 'keep' } });
    const names = t.queue.jobs().map((j: Job) => j.destName);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(['f0 (1).txt', 'f0 (2).txt']);
  });

  it('reports a name reserved by an active job as a conflict and refuses to replace it', async () => {
    const t = setup({ max: 1 });
    await t.push(['f0.txt']);
    const plan = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/f0.txt'],
      destDir: '/sdcard/Download',
    });
    expect(plan.conflicts.map((c) => c.name)).toEqual(['f0.txt']);
    expect(() =>
      t.queue.commit({ batchId: plan.batchId, decisions: { 'f0.txt': 'replace' } }),
    ).toThrow(/already being transferred/);
  });

  it('skips conflicts by default and replaces when asked', async () => {
    const t = setup({ max: 5 });
    t.android.files.set('/sdcard/Download/f0.txt', file(1));
    t.android.files.set('/sdcard/Download/f1.txt', file(1));
    await t.push(['f0.txt', 'f1.txt', 'f2.txt'], { 'f1.txt': 'replace' });
    const runs = t.runner.runs.map((r) => [r.spec.finalPath, r.spec.replace]);
    expect(runs).toEqual([
      ['/sdcard/Download/f1.txt', true],
      ['/sdcard/Download/f2.txt', false],
    ]);
  });

  it('refuses file ops on paths involved in an active transfer, including ancestors', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    expect(() => t.queue.assertNotBusy('mac', '/m/f0.txt')).toThrow(/being transferred/);
    expect(() => t.queue.assertNotBusy('mac', '/m')).toThrow(/being transferred/);
    expect(() => t.queue.assertNotBusy('android', '/sdcard/Download')).toThrow(/being transferred/);
    expect(() => t.queue.assertNotBusy('mac', '/m/f1.txt')).not.toThrow();
    t.runner.runs[0]!.succeed();
    await flush();
    expect(() => t.queue.assertNotBusy('mac', '/m/f0.txt')).not.toThrow();
  });

  it('retries a failed job as a fresh attempt and ignores the stale one', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const id = t.queue.jobs()[0]!.id;
    const first = t.runner.runs[0]!;
    first.fail('boom');
    await flush();
    t.queue.retry(id);
    expect(t.queue.jobs()[0]!.status).toBe('running');
    first.hooks.onProgress(42);
    expect(t.queue.jobs()[0]!.transferredBytes).toBe(0);
    t.runner.runs[1]!.succeed();
    await flush();
    expect(t.queue.jobs()[0]!.status).toBe('done');
  });

  it('rejects planning without a session', async () => {
    const t = setup();
    t.setConnected(false);
    await expect(
      t.queue.plan({ from: 'mac', srcPaths: ['/m/f0.txt'], destDir: '/sdcard/Download' }),
    ).rejects.toThrow(/No device/);
  });

  it('Keep both never collides with another item in the same batch', async () => {
    const t = setup({ max: 5 });
    t.mac.files.set('/m/a.txt', file(1));
    t.mac.files.set('/m/a (1).txt', file(1));
    t.android.files.set('/sdcard/Download/a.txt', file(1));
    await t.push(['a.txt', 'a (1).txt'], { 'a.txt': 'keep' });
    const names = t.queue.jobs().map((j) => j.destName);
    expect(names.sort()).toEqual(['a (1).txt', 'a (2).txt']);
  });

  it('a cancelled job keeps its slot and name until teardown finishes', async () => {
    const t = setup({ max: 1 });
    t.runner.holdCancels = true;
    await t.push(['f0.txt', 'f1.txt']);
    const id = t.queue.jobs()[0]!.id;
    const stopped = t.queue.cancel(id);
    await flush();
    // Slot still held: the queued job must not start while adb is being stopped.
    expect(t.runner.runs).toHaveLength(1);
    expect(() => t.queue.retry(id)).toThrow(/still stopping/);
    expect(() => t.queue.assertNotBusy('android', '/sdcard/Download/f0.txt')).toThrow();
    t.runner.runs[0]!.finishCancel();
    await stopped;
    await flush();
    expect(t.runner.runs).toHaveLength(2);
    expect(t.runner.runs[1]!.spec.finalPath).toBe('/sdcard/Download/f1.txt');
  });

  it('device loss holds slots until the killed transfers have exited', async () => {
    const t = setup({ max: 1 });
    t.runner.holdCancels = true;
    await t.push(['f0.txt', 'f1.txt']);
    t.queue.onDeviceLost();
    t.queue.onDeviceReady();
    await flush();
    expect(t.runner.runs).toHaveLength(1);
    t.runner.runs[0]!.finishCancel();
    await flush();
    await flush();
    expect(t.runner.runs).toHaveLength(2);
  });

  it('refuses to retry or commit work from a previous device session', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const id = t.queue.jobs()[0]!.id;
    t.runner.runs[0]!.fail('boom');
    await flush();
    const stalePlan = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/f1.txt'],
      destDir: '/sdcard/Download',
    });
    t.newSession();
    expect(() => t.queue.retry(id)).toThrow(/previous session/);
    expect(() => t.queue.commit({ batchId: stalePlan.batchId, decisions: {} })).toThrow(/expired/);
    expect(t.runner.runs).toHaveLength(1);
  });

  it('treats names that differ only by case as the same destination', async () => {
    const t = setup({ max: 5 });
    t.mac.files.set('/m/photo.jpg', file(1));
    t.mac.files.set('/m/PHOTO.JPG', file(1));
    t.android.files.set('/sdcard/Download/Photo.jpg', file(1));
    const plan = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/photo.jpg'],
      destDir: '/sdcard/Download',
    });
    expect(plan.conflicts.map((c) => c.name)).toEqual(['photo.jpg']);
    t.queue.commit({ batchId: plan.batchId, decisions: { 'photo.jpg': 'keep' } });
    // A second batch with another case variant must not reuse a reserved name.
    const p2 = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/PHOTO.JPG'],
      destDir: '/sdcard/Download',
    });
    t.queue.commit({ batchId: p2.batchId, decisions: { 'PHOTO.JPG': 'keep' } });
    const keys = t.queue.jobs().map((j) => j.destName.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('treats folder paths that differ only by case as the same folder for reservations', async () => {
    const t = setup({ max: 5 });
    t.android.files.set('/sdcard/download', dir);
    await t.push(['f0.txt']);
    const p2 = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/f0.txt'],
      destDir: '/sdcard/download',
    });
    t.queue.commit({ batchId: p2.batchId, decisions: { 'f0.txt': 'keep' } });
    expect(t.queue.jobs().map((j) => j.destName)).toEqual(['f0.txt', 'f0 (1).txt']);
  });

  it('cancelAll stops background work after the jobs settle', async () => {
    const t = setup();
    let stopped = 0;
    Object.assign(t.runner, { stopBackground: () => stopped++ });
    await t.push(['f0.txt']);
    await t.queue.cancelAll();
    expect(stopped).toBe(1);
    expect(t.runner.live()).toHaveLength(0);
  });

  it('gives case-only duplicates inside one batch distinct names without a prompt', async () => {
    const t = setup({ max: 5 });
    t.mac.files.set('/m/x/a.txt', file(1));
    t.mac.files.set('/m/y/A.txt', file(1));
    const r = await t.queue.plan({
      from: 'mac',
      srcPaths: ['/m/x/a.txt', '/m/y/A.txt'],
      destDir: '/sdcard/Download',
    });
    expect(r.conflicts).toEqual([]);
    t.queue.commit({ batchId: r.batchId, decisions: {} });
    expect(t.queue.jobs().map((j) => j.destName)).toEqual(['a.txt', 'A (1).txt']);
  });

  it('rejects a plan whose device session changed while it was being prepared', async () => {
    const t = setup();
    const list = t.android.list.bind(t.android);
    t.android.list = async (dir: string) => {
      t.newSession();
      return list(dir);
    };
    await expect(
      t.queue.plan({ from: 'mac', srcPaths: ['/m/f0.txt'], destDir: '/sdcard/Download' }),
    ).rejects.toThrow(/device changed/);
  });

  it('cancel during the final rename reports the real outcome', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const id = t.queue.jobs()[0]!.id;
    const run = t.runner.runs[0]!;
    run.hooks.onCommit();
    const cancelled = t.queue.cancel(id);
    expect(t.queue.jobs()[0]!.status).toBe('running');
    run.succeed();
    await cancelled;
    await flush();
    expect(t.queue.jobs()[0]!.status).toBe('done');
  });

  it('device loss during the final rename lets the rename decide the outcome', async () => {
    const t = setup();
    await t.push(['f0.txt']);
    const run = t.runner.runs[0]!;
    run.hooks.onCommit();
    t.queue.onDeviceLost();
    expect(t.queue.jobs()[0]!.status).toBe('running');
    run.fail('Device disconnected');
    await flush();
    expect(t.queue.jobs()[0]!.status).toBe('failed');
  });

  it('End Session waits for a final rename instead of abandoning it', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.push(['f0.txt']);
      const run = t.runner.runs[0]!;
      run.hooks.onCommit();
      let ended = false;
      const ending = t.queue.cancelAll(8000, 90_000).then(() => (ended = true));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ended).toBe(false);
      run.succeed();
      await vi.advanceTimersByTimeAsync(0);
      await ending;
      expect(t.queue.jobs()[0]!.status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Finder uploads', () => {
  it('holds no slot while uploading, and pane jobs still start', async () => {
    const t = setup({ max: 1 });
    await t.drop(['x.bin', 'y.bin']);
    expect(t.queue.jobs().map((j) => j.status)).toEqual(['uploading', 'uploading']);
    await t.push(['f0.txt']);
    expect(t.status()['f0.txt']).toBe('running');
    expect(t.runner.runs.map((r) => r.spec.srcPath)).toEqual(['/m/f0.txt']);
  });

  it('a lost session making way for a new one keeps work that never used the device', async () => {
    const t = setup({ max: 5 });
    await t.drop(['up.bin']);
    const copy = (await t.drop(['run.bin'])).uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${copy}/run.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(copy);
    const bad = (await t.drop(['bad.bin'])).uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${bad}/bad.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(bad);
    t.runner.runs.at(-1)!.fail('disk error');
    await flush();
    await t.drop(['phone.bin'], 'android');
    await t.push(['f0.txt']);
    await t.queue.cancelDeviceJobs();
    expect(t.byName('up.bin').status).toBe('uploading');
    expect(t.byName('run.bin').status).toBe('running');
    expect(t.byName('bad.bin')).toMatchObject({ status: 'failed', retryable: true });
    expect(t.staging.removed).not.toContain(bad);
    expect(t.byName('phone.bin').status).toBe('cancelled');
    expect(t.byName('f0.txt').status).toBe('cancelled');
    expect(t.staging.removed).not.toContain(copy);
  });

  it('queues a job once the page completes it, then copies from staging', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    const run = t.runner.runs[0]!;
    expect(run.spec).toMatchObject({ direction: 'copy', srcPath: `/staging/${id}/x.bin` });
    expect(run.spec.finalPath).toBe('/m/x.bin');
    run.succeed();
    await flush();
    expect(t.byName('x.bin').status).toBe('done');
    expect(t.staging.removed).toEqual([id]);
  });

  it('fails an upload whose request breaks, without a retry', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    const ac = t.queue.beginUpload(id);
    t.queue.endUpload(id, ac, false);
    const job = t.byName('x.bin');
    expect(job).toMatchObject({ status: 'failed', error: UPLOAD_INTERRUPTED, retryable: false });
    expect(t.staging.removed).toEqual([id]);
    expect(() => t.queue.retry(id)).toThrow(/can't be retried/);
  });

  it('fails an upload when the page stops sending (liveness)', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.drop(['x.bin']);
      vi.advanceTimersByTime(59_000);
      expect(t.byName('x.bin').status).toBe('uploading');
      vi.advanceTimersByTime(2_000);
      expect(t.byName('x.bin').status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an item waiting its turn alive while its batch is uploading', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { uploads } = await t.drop(['a.bin', 'b.bin']);
      const ac = t.queue.beginUpload(uploads[0]!.jobId);
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(30_000);
        t.queue.uploadProgress(uploads[0]!.jobId, 1000);
      }
      expect(t.byName('b.bin').status).toBe('uploading');
      t.queue.endUpload(uploads[0]!.jobId, ac, true);
      vi.advanceTimersByTime(59_000);
      expect(t.byName('b.bin').status).toBe('uploading');
      vi.advanceTimersByTime(62_000);
      expect(t.byName('b.bin')).toMatchObject({ status: 'failed', error: UPLOAD_INTERRUPTED });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a drop waiting behind another drop alive while that one uploads', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const first = (await t.drop(['a.bin'])).uploads[0]!.jobId;
      await t.drop(['b.bin']);
      t.queue.beginUpload(first);
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(30_000);
        t.queue.uploadProgress(first, 1000);
      }
      expect(t.byName('b.bin').status).toBe('uploading');
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a reloaded page's waiting items even while the new page uploads", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      // The old page had a2 waiting its turn when it was reloaded.
      await t.drop(['a2.bin'], 'mac', {}, 'old-page');
      const fresh = (await t.drop(['b.bin'], 'mac', {}, 'new-page')).uploads[0]!.jobId;
      t.queue.beginUpload(fresh);
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(30_000);
        t.queue.uploadProgress(fresh, 1000);
      }
      expect(t.byName('a2.bin')).toMatchObject({ status: 'failed', error: UPLOAD_INTERRUPTED });
      expect(t.byName('b.bin').status).toBe('uploading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a stalled request and its waiting batch, aborting the request (liveness)', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { uploads } = await t.drop(['a.bin', 'b.bin']);
      const ac = t.queue.beginUpload(uploads[0]!.jobId);
      t.queue.uploadProgress(uploads[0]!.jobId, 1000);
      // Open, but no bytes after the first chunk.
      vi.advanceTimersByTime(59_000);
      expect(t.byName('a.bin').status).toBe('uploading');
      vi.advanceTimersByTime(62_000);
      expect(t.byName('a.bin')).toMatchObject({ status: 'failed', error: UPLOAD_INTERRUPTED });
      expect(ac.signal.aborted).toBe(true);
      vi.advanceTimersByTime(62_000);
      expect(t.byName('b.bin')).toMatchObject({ status: 'failed', error: UPLOAD_INTERRUPTED });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails an item at once when the page sends an impossible path', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    expect(() => t.queue.uploadTarget(uploads[0]!.jobId, 'sub/a', 'file')).toThrow();
    expect(t.byName('x.bin')).toMatchObject({ status: 'failed', retryable: false });
  });

  it('does not time out a long request that keeps sending bytes', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { uploads } = await t.drop(['x.bin']);
      t.queue.beginUpload(uploads[0]!.jobId);
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(30_000);
        t.queue.uploadProgress(uploads[0]!.jobId, 1000);
      }
      expect(t.byName('x.bin').status).toBe('uploading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel aborts in-flight requests and refuses later ones', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    const ac = t.queue.beginUpload(id);
    await t.queue.cancel(id);
    expect(ac.signal.aborted).toBe(true);
    expect(() => t.queue.uploadTarget(id, '', 'file')).toThrow(/no longer accepting/);
    expect(() => t.queue.beginUpload(id)).toThrow(/no longer accepting/);
    expect(t.byName('x.bin').retryable).toBe(false);
    t.queue.endUpload(id, ac, false);
    await flush();
    expect(t.staging.removed).toEqual([id]);
  });

  it('deletes staging only after an aborted request has let go of it', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    const ac = t.queue.beginUpload(id);
    await t.queue.cancel(id);
    await flush();
    expect(t.staging.removed).toEqual([]);
    t.queue.endUpload(id, ac, false);
    await flush();
    expect(t.staging.removed).toEqual([id]);
  });

  it('refuses new requests once the page has completed an item', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    const completing = t.queue.completeUpload(id);
    expect(() => t.queue.beginUpload(id)).toThrow(/no longer accepting/);
    await completing;
    expect(t.byName('x.bin').status).toBe('running');
  });

  it('fails a folder whose names differ only by case instead of losing a file', async () => {
    const t = setup();
    const plan = await t.queue.plan({
      from: 'finder',
      destSide: 'mac',
      destDir: '/m',
      items: [{ name: 'Pics', isDir: true, size: 2, files: 2, mtimeMs: 1 }],
    });
    const { uploads } = t.queue.commit({ batchId: plan.batchId, decisions: {} });
    const id = uploads[0]!.jobId;
    t.queue.uploadTarget(id, 'a.txt', 'file');
    t.queue.uploadTarget(id, 'a.txt', 'file');
    expect(() => t.queue.uploadTarget(id, 'A.txt', 'file')).toThrow(/differ only by case/);
    expect(t.byName('Pics')).toMatchObject({ status: 'failed', retryable: false });
  });

  it('releases retained staging at End Session', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin'], 'android');
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    t.runner.runs[0]!.fail('boom');
    await flush();
    expect(t.staging.removed).toEqual([]);
    await t.queue.cancelAll();
    expect(t.staging.removed).toEqual([id]);
    expect(t.byName('x.bin').retryable).toBe(false);
  });

  it('keeps staging for a retryable failure and retries from it', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    t.runner.runs[0]!.fail('disk full');
    await flush();
    expect(t.staging.removed).toEqual([]);
    t.queue.retry(id);
    expect(t.runner.runs[1]!.spec.srcPath).toBe(`/staging/${id}/x.bin`);
    t.runner.runs[1]!.fail('again');
    await flush();
    t.queue.clearFinished();
    expect(t.staging.removed).toEqual([id]);
  });

  it('fails when nothing was staged', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    await t.queue.completeUpload(uploads[0]!.jobId);
    expect(t.byName('x.bin')).toMatchObject({ status: 'failed', retryable: false });
  });

  it('refuses a drop that would not fit in staging', async () => {
    const t = setup();
    t.staging.free = 1000;
    await expect(t.drop(['x.bin'])).rejects.toThrow(NO_STAGING_SPACE);
  });

  it('refuses two dropped items with the same name', async () => {
    const t = setup();
    await expect(t.drop(['x.bin', 'x.bin'])).rejects.toThrow(/both named/);
  });

  it('needs a session only for drops onto the Android pane', async () => {
    const t = setup();
    t.setConnected(false);
    await expect(t.drop(['x.bin'], 'android')).rejects.toThrow(/No device/);
    await expect(t.drop(['y.bin'], 'mac')).resolves.toMatchObject({ jobIds: [expect.any(String)] });
  });

  it('fails a staged push whose session was lost meanwhile', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin'], 'android');
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    t.setConnected(false);
    t.queue.onDeviceLost();
    t.queue.onSessionLost();
    await t.queue.completeUpload(id);
    expect(t.byName('x.bin')).toMatchObject({ status: 'failed', error: DEVICE_LOST });
    expect(t.runner.runs).toHaveLength(0);
  });
});

describe('Job eligibility', () => {
  it('runs copy jobs while the device is away, and holds device jobs', async () => {
    const t = setup({ max: 5 });
    t.queue.onDeviceLost();
    t.setConnected(false);
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    expect(t.byName('x.bin').status).toBe('running');
  });

  it('leaves running copy jobs alone when the device drops', async () => {
    const t = setup({ max: 5 });
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    await t.push(['f0.txt']);
    t.queue.onDeviceLost();
    t.queue.onSessionLost();
    expect(t.byName('x.bin').status).toBe('running');
    expect(t.status()['f0.txt']).toBe('failed');
  });

  it('retries a copy job without a session', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    t.runner.runs[0]!.fail('boom');
    await flush();
    t.setConnected(false);
    t.queue.onDeviceLost();
    t.queue.retry(id);
    expect(t.byName('x.bin').status).toBe('running');
  });

  it('protects both ends of a copy job', async () => {
    const t = setup();
    const { uploads } = await t.drop(['x.bin']);
    const id = uploads[0]!.jobId;
    t.staging.staged.set(`/staging/${id}/x.bin`, { bytes: 10, files: 1 });
    await t.queue.completeUpload(id);
    expect(() => t.queue.assertNotBusy('mac', '/m/x.bin')).toThrow(/being transferred/);
  });
});

describe('Show in Finder', () => {
  const pullBatch = async (t: ReturnType<typeof setup>, names: string[]) => {
    for (const n of names) t.android.files.set(`/sdcard/Download/${n}`, file(1));
    const plan = await t.queue.plan({
      from: 'android',
      srcPaths: names.map((n) => `/sdcard/Download/${n}`),
      destDir: '/m',
      reveal: true,
    });
    return t.queue.commit({ batchId: plan.batchId, decisions: {} });
  };

  it('reveals once, after the whole batch, only the copied items', async () => {
    const t = setup({ max: 5 });
    const { jobIds } = await pullBatch(t, ['a.jpg', 'b.jpg', 'c.jpg']);
    t.runner.runs[0]!.succeed();
    t.runner.runs[1]!.fail('nope');
    await flush();
    expect(t.revealed).toEqual([]);
    t.runner.runs[2]!.succeed();
    await flush();
    expect(t.revealed).toEqual([['/m/a.jpg', '/m/c.jpg']]);
    t.queue.retry(jobIds[1]!);
    t.runner.runs[3]!.succeed();
    await flush();
    expect(t.revealed).toHaveLength(1);
  });

  it('still reveals items whose jobs were cleared before the batch ended', async () => {
    const t = setup({ max: 5 });
    await pullBatch(t, ['a.jpg', 'b.jpg']);
    t.runner.runs[0]!.succeed();
    await flush();
    t.queue.clearFinished();
    t.runner.runs[1]!.succeed();
    await flush();
    expect(t.revealed).toEqual([['/m/a.jpg', '/m/b.jpg']]);
  });

  it('does not reveal when nothing was copied', async () => {
    const t = setup({ max: 5 });
    const { jobIds } = await pullBatch(t, ['a.jpg']);
    await t.queue.cancel(jobIds[0]!);
    expect(t.revealed).toEqual([]);
  });

  it('reveals the existing copy of a skipped item along with the copied ones', async () => {
    const t = setup({ max: 5 });
    t.mac.files.set('/m/A.jpg', file(1));
    await pullBatch(t, ['a.jpg', 'b.jpg']);
    expect(t.runner.runs).toHaveLength(1);
    t.runner.runs[0]!.succeed();
    await flush();
    expect(t.revealed).toEqual([['/m/A.jpg', '/m/b.jpg']]);
  });

  it('reveals at once when every item was skipped', async () => {
    const t = setup({ max: 5 });
    t.mac.files.set('/m/a.jpg', file(1));
    const { jobIds } = await pullBatch(t, ['a.jpg']);
    expect(jobIds).toEqual([]);
    expect(t.revealed).toEqual([['/m/a.jpg']]);
  });

  it('never reveals ordinary pane transfers', async () => {
    const t = setup({ max: 5 });
    await t.push(['f0.txt']);
    t.runner.runs[0]!.succeed();
    await flush();
    expect(t.revealed).toEqual([]);
  });
});

describe('Network volumes', () => {
  const nas = () => {
    const volumes = new FakeVolumes();
    const t = setup({ max: 5, volumes });
    t.mac.files.set('/Volumes/NAS', dir);
    t.mac.files.set('/Volumes/NAS/dl', dir);
    const pull = async (names: string[]) => {
      for (const n of names) t.android.files.set(`/sdcard/Download/${n}`, file(5));
      const plan = await t.queue.plan({
        from: 'android',
        srcPaths: names.map((n) => `/sdcard/Download/${n}`),
        destDir: '/Volumes/NAS/dl',
      });
      return t.queue.commit({ batchId: plan.batchId, decisions: {} });
    };
    return { ...t, volumes, pull };
  };

  it('pauses a job whose share went offline instead of failing it, then resumes', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    const first = t.runner.runs[0]!;
    t.volumes.goOffline('/Volumes/NAS');
    first.fail('Read error');
    await flush();
    await flush();
    expect(t.byName('a.jpg')).toMatchObject({ status: 'queued', waitingFor: 'NAS', error: null });
    expect(t.queue.runningCount()).toBe(0);
    t.volumes.offline.clear();
    t.queue.onVolumeEvent({ type: 'online', mountPoint: '/Volumes/NAS' });
    expect(t.byName('a.jpg')).toMatchObject({ status: 'running', waitingFor: null });
    expect(t.runner.runs).toHaveLength(2);
  });

  it('fails a job that starts waiting after its share already gave up', async () => {
    const t = nas();
    t.volumes.goOffline('/Volumes/NAS');
    t.volumes.offline.get('/Volumes/NAS')!.giveUpAt = Date.now() - 1;
    await t.pull(['late.jpg']);
    expect(t.byName('late.jpg')).toMatchObject({
      status: 'failed',
      error: 'NAS was offline for 30 minutes',
    });
  });

  it('a pull paused for its share needs the phone again when it restarts', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    t.runner.runs[0]!.hooks.onDeviceDone?.();
    t.volumes.goOffline('/Volumes/NAS');
    t.runner.runs[0]!.failWith(new HttpError(503, 'NAS is offline.', 'OFFLINE'));
    await flush();
    await flush();
    expect(t.byName('a.jpg').status).toBe('queued');
    await t.queue.cancelDeviceJobs();
    expect(t.byName('a.jpg').status).toBe('cancelled');
  });

  it('keeps a held share waiting until it is released', async () => {
    const t = nas();
    t.volumes.goOffline('/Volumes/NAS');
    await t.pull(['a.jpg']);
    expect(t.byName('a.jpg')).toMatchObject({ status: 'queued', waitingFor: 'NAS' });
    // Back online, but the app is still restoring parked originals.
    t.volumes.offline.clear();
    t.queue.holdVolume('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'moved', from: '/Volumes/X', to: '/Volumes/Y' });
    expect(t.byName('a.jpg')).toMatchObject({ status: 'queued', waitingFor: 'NAS' });
    expect(t.runner.runs).toHaveLength(0);
    t.queue.onVolumeEvent({ type: 'online', mountPoint: '/Volumes/NAS' });
    expect(t.byName('a.jpg')).toMatchObject({ status: 'running', waitingFor: null });
  });

  it('never fails a job over an OFFLINE error', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    t.runner.runs[0]!.failWith(new HttpError(503, 'NAS is offline.', 'OFFLINE'));
    await flush();
    await flush();
    // The share answers again, so the paused job starts over at once.
    expect(t.byName('a.jpg')).toMatchObject({ status: 'running', error: null });
    expect(t.runner.runs).toHaveLength(2);
  });

  it('fails normally when the share still answers', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    t.runner.runs[0]!.fail('Permission denied at the destination');
    await flush();
    await flush();
    expect(t.byName('a.jpg')).toMatchObject({ status: 'failed', waitingFor: null });
  });

  it('pauses running jobs on that share only, and holds queued ones', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    await t.push(['f0.txt']);
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    expect(t.runner.runs[0]!.cancelled).toBe(true);
    expect(t.byName('a.jpg')).toMatchObject({ status: 'queued', waitingFor: 'NAS' });
    expect(t.status()['f0.txt']).toBe('running');
    await t.pull(['b.jpg']);
    expect(t.byName('b.jpg')).toMatchObject({ status: 'queued', waitingFor: 'NAS' });
  });

  it('never lets the interrupted attempt finish the paused job', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    const old = t.runner.runs[0]!;
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    old.succeed();
    await flush();
    expect(t.byName('a.jpg').status).toBe('queued');
  });

  it('waits for the interrupted attempt to clean up before restarting', async () => {
    const t = nas();
    t.runner.holdCancels = true;
    await t.pull(['a.jpg']);
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    t.volumes.offline.clear();
    t.queue.onVolumeEvent({ type: 'online', mountPoint: '/Volumes/NAS' });
    expect(t.runner.runs).toHaveLength(1);
    t.runner.runs[0]!.finishCancel();
    await flush();
    await flush();
    expect(t.runner.runs).toHaveLength(2);
    expect(t.byName('a.jpg').status).toBe('running');
  });

  it('refuses to retry while the share is still offline', async () => {
    const t = nas();
    const { jobIds } = await t.pull(['a.jpg']);
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    t.queue.onVolumeEvent({ type: 'gaveUp', mountPoint: '/Volumes/NAS', name: 'NAS' });
    expect(() => t.queue.retry(jobIds[0]!)).toThrow(/still offline/);
  });

  it('fails every waiting job on the share at once when it gives up (liveness)', async () => {
    const t = nas();
    await t.pull(['a.jpg', 'b.jpg']);
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    t.queue.onVolumeEvent({ type: 'gaveUp', mountPoint: '/Volumes/NAS', name: 'NAS' });
    expect(t.byName('a.jpg')).toMatchObject({
      status: 'failed',
      error: 'NAS was offline for 30 minutes',
      retryable: true,
    });
    expect(t.byName('b.jpg').status).toBe('failed');
  });

  it('follows a share remounted at a new path', async () => {
    const t = nas();
    await t.pull(['a.jpg']);
    t.volumes.goOffline('/Volumes/NAS');
    t.queue.onVolumeEvent({ type: 'offline', mountPoint: '/Volumes/NAS' });
    t.volumes.offline.clear();
    t.volumes.mounts.push('/Volumes/NAS-1');
    t.queue.onVolumeEvent({ type: 'moved', from: '/Volumes/NAS', to: '/Volumes/NAS-1' });
    t.queue.onVolumeEvent({ type: 'online', mountPoint: '/Volumes/NAS-1' });
    await flush();
    expect(t.byName('a.jpg').destDir).toBe('/Volumes/NAS-1/dl');
    expect(t.runner.runs.at(-1)!.spec.finalPath).toBe('/Volumes/NAS-1/dl/a.jpg');
  });
});
