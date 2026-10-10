import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/shared/protocol.ts';
import { orderJobs, summarize, waitsForDevice } from '../../src/web/components/TransferPanel.tsx';

const job = (status: Job['status'], done: number, total: number): Job => ({
  id: Math.random().toString(36),
  batchId: 'b',
  direction: 'push',
  origin: 'pane',
  srcPath: '/x',
  destDir: '/sdcard',
  destName: 'x',
  isDir: false,
  itemCount: 1,
  totalBytes: total,
  transferredBytes: done,
  bytesPerSec: 0,
  status,
  error: null,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  retryable: true,
  waitingFor: null,
});

describe('transfer summary', () => {
  it('counts active and queued, excluding failed/cancelled bytes', () => {
    const s = summarize(
      [
        job('running', 50e6, 100e6),
        job('queued', 0, 100e6),
        job('failed', 10e6, 100e6),
        job('cancelled', 0, 5e6),
      ],
      'connected',
    );
    expect(s.text).toBe('1 active, 1 queued · 50 MB of 200 MB');
    expect(s.failed).toBe(1);
    expect(s.pct).toBe(25);
  });
  it('reports queued jobs as waiting while reconnecting', () => {
    const s = summarize([job('queued', 0, 1e6), job('queued', 0, 1e6)], 'reconnecting');
    expect(s.waiting).toBe(2);
    expect(s.queued).toBe(0);
  });
  it('says all finished when nothing is pending', () => {
    expect(summarize([job('done', 1, 1)], 'idle').text).toBe('All transfers finished');
    expect(summarize([], 'idle').text).toBe('No transfers');
  });
});

describe('orderJobs', () => {
  it('lists running, then queued in queue order, then failed, then finished newest first', () => {
    const at = (
      status: Job['status'],
      createdAt: number,
      finishedAt: number | null,
      id: string,
    ) => ({
      ...job(status, 0, 1),
      id,
      createdAt,
      finishedAt,
    });
    const ordered = orderJobs([
      at('done', 1, 10, 'old-done'),
      at('queued', 5, null, 'q2'),
      at('done', 2, 20, 'new-done'),
      at('running', 3, null, 'run'),
      at('queued', 4, null, 'q1'),
      at('failed', 0, 15, 'fail'),
    ]).map((j) => j.id);
    expect(ordered).toEqual(['run', 'q1', 'q2', 'fail', 'new-done', 'old-done']);
  });
});

describe('v2 job kinds', () => {
  it('counts uploading jobs as reading from Finder and sorts them with running ones', () => {
    const up = { ...job('uploading', 1, 10), id: 'up', createdAt: 2 };
    const run = { ...job('running', 1, 10), id: 'run', createdAt: 1 };
    const q = { ...job('queued', 0, 10), id: 'q', createdAt: 0 };
    expect(summarize([up, q], 'connected').text).toMatch(
      /^1 reading from Finder, 0 active, 1 queued/,
    );
    expect(orderJobs([q, up, run]).map((j) => j.id)).toEqual(['run', 'up', 'q']);
  });

  it('leaves bytes read from Finder out of the transferred total', () => {
    // The transfer after the read counts from zero, so counting the read would run the
    // total up while the phone is unplugged and then drop it back.
    const s = summarize([job('uploading', 2e9, 8e9), job('done', 1e6, 1e6)], 'reconnecting');
    expect(s.text).toBe('1 reading from Finder, 0 active, 0 queued · 1 MB of 8 GB');
    expect(s.preparing).toBe(1);
    expect(s.running).toBe(0);
    expect(s.pct).toBeCloseTo((1e6 / 8.001e9) * 100);
  });

  it('does not show Mac-to-Mac copies as waiting for the device', () => {
    const copy = { ...job('queued', 0, 1), direction: 'copy' as const };
    expect(waitsForDevice(copy, 'reconnecting')).toBe(false);
    expect(waitsForDevice(job('queued', 0, 1), 'reconnecting')).toBe(true);
    expect(summarize([copy], 'reconnecting').queued).toBe(1);
  });
});
