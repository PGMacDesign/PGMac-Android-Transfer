import { describe, expect, it } from 'vitest';
import type { Job, ServerSnapshot } from '../../src/shared/protocol.ts';
import { applyMessage, fsKey, initialServerState } from '../../src/web/reducer.ts';

const snapshot = (jobs: Job[] = []): ServerSnapshot => ({
  adb: { found: true, path: '/usr/bin/adb', version: '37' },
  session: {
    state: 'idle',
    device: null,
    battery: null,
    storage: null,
    error: null,
    reconnectDeadline: null,
  },
  pairing: null,
  jobs,
  settings: { maxConcurrent: 3, downloadsDir: '/Users/pat/Downloads' },
  mac: { home: '/Users/pat', platform: 'darwin', storage: null },
  offlineVolumes: [],
});

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  batchId: 'b',
  direction: 'pull',
  origin: 'pane',
  srcPath: `/sdcard/${id}`,
  destDir: '/Users/pat',
  destName: id,
  isDir: false,
  itemCount: 1,
  totalBytes: 100,
  transferredBytes: 0,
  bytesPerSec: 0,
  status: 'queued',
  error: null,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  retryable: true,
  waitingFor: null,
  ...over,
});

describe('applyMessage', () => {
  it('ignores incremental messages before the first snapshot', () => {
    const s = applyMessage(initialServerState, {
      type: 'settings',
      seq: 5,
      settings: { maxConcurrent: 1, downloadsDir: '/d' },
    });
    expect(s).toBe(initialServerState);
  });

  it('drops messages at or below the snapshot seq', () => {
    const s1 = applyMessage(initialServerState, {
      type: 'snapshot',
      seq: 10,
      snapshot: snapshot(),
    });
    const s2 = applyMessage(s1, {
      type: 'settings',
      seq: 10,
      settings: { maxConcurrent: 1, downloadsDir: '/d' },
    });
    expect(s2).toBe(s1);
    const s3 = applyMessage(s1, {
      type: 'settings',
      seq: 11,
      settings: { maxConcurrent: 1, downloadsDir: '/d' },
    });
    expect(s3.snapshot?.settings.maxConcurrent).toBe(1);
    expect(s3.seq).toBe(11);
  });

  it('upserts and removes jobs by id', () => {
    let s = applyMessage(initialServerState, {
      type: 'snapshot',
      seq: 1,
      snapshot: snapshot([job('a')]),
    });
    s = applyMessage(s, { type: 'job', seq: 2, job: job('b') });
    s = applyMessage(s, {
      type: 'job',
      seq: 3,
      job: job('a', { status: 'running', transferredBytes: 40 }),
    });
    expect(s.snapshot?.jobs.map((j) => [j.id, j.status])).toEqual([
      ['a', 'running'],
      ['b', 'queued'],
    ]);
    s = applyMessage(s, { type: 'jobsRemoved', seq: 4, ids: ['a'] });
    expect(s.snapshot?.jobs.map((j) => j.id)).toEqual(['b']);
  });

  it('a fresh snapshot replaces state even with a lower seq (server restart)', () => {
    let s = applyMessage(initialServerState, {
      type: 'snapshot',
      seq: 50,
      snapshot: snapshot([job('a')]),
    });
    s = applyMessage(s, { type: 'snapshot', seq: 0, snapshot: snapshot() });
    expect(s.seq).toBe(0);
    expect(s.snapshot?.jobs).toEqual([]);
  });

  it('bumps the folder version on fsChanged', () => {
    let s = applyMessage(initialServerState, { type: 'snapshot', seq: 1, snapshot: snapshot() });
    s = applyMessage(s, { type: 'fsChanged', seq: 2, side: 'mac', dir: '/Users/pat' });
    s = applyMessage(s, { type: 'fsChanged', seq: 3, side: 'mac', dir: '/Users/pat' });
    expect(s.fsVersions[fsKey('mac', '/Users/pat')]).toBe(2);
  });

  it('bumps the listing epoch on every snapshot so missed fsChanged events are recovered', () => {
    const first = applyMessage(initialServerState, {
      type: 'snapshot',
      seq: 1,
      snapshot: {} as never,
    });
    const second = applyMessage(first, { type: 'snapshot', seq: 1, snapshot: {} as never });
    expect(second.listEpoch).toBe(first.listEpoch + 1);
  });
});

describe('network volumes', () => {
  const vol = (mountPoint: string) => ({
    mountPoint,
    name: mountPoint.split('/').pop()!,
    since: 1,
    giveUpAt: 2,
  });
  const start = () =>
    applyMessage(initialServerState, { type: 'snapshot', seq: 0, snapshot: snapshot() });

  it('tracks offline volumes and refetches listings when one comes back', () => {
    let s = start();
    const epoch = s.listEpoch;
    s = applyMessage(s, { type: 'volumes', seq: 1, offlineVolumes: [vol('/Volumes/Share')] });
    expect(s.snapshot!.offlineVolumes.map((v) => v.name)).toEqual(['Share']);
    expect(s.listEpoch).toBe(epoch);
    s = applyMessage(s, { type: 'volumes', seq: 2, offlineVolumes: [] });
    expect(s.snapshot!.offlineVolumes).toEqual([]);
    expect(s.listEpoch).toBe(epoch + 1);
  });

  it('records each remount as a new move and refetches', () => {
    let s = start();
    const epoch = s.listEpoch;
    s = applyMessage(s, { type: 'volumeMoved', seq: 1, from: '/Volumes/A', to: '/Volumes/A-1' });
    expect(s.volumeMove).toEqual({ from: '/Volumes/A', to: '/Volumes/A-1', n: 1 });
    s = applyMessage(s, { type: 'volumeMoved', seq: 2, from: '/Volumes/A-1', to: '/Volumes/A' });
    expect(s.volumeMove?.n).toBe(2);
    expect(s.listEpoch).toBe(epoch + 2);
  });

  it('keeps the last move across a snapshot', () => {
    let s = start();
    s = applyMessage(s, { type: 'volumeMoved', seq: 1, from: '/Volumes/A', to: '/Volumes/A-1' });
    s = applyMessage(s, { type: 'snapshot', seq: 5, snapshot: snapshot() });
    expect(s.volumeMove?.n).toBe(1);
  });
});
