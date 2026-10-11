import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRASH_TIMEOUT_MS,
  trashThroughParent,
  type TrashPort,
  type TrashRequest,
} from '../src/server/parentPort.ts';

function fakePort() {
  const port = new EventEmitter();
  const posted: TrashRequest[] = [];
  return Object.assign(port as EventEmitter & TrashPort, {
    posted,
    postMessage: (m: TrashRequest) => void posted.push(m),
    deliver: (data: unknown) => port.emit('message', { data }),
  });
}

/** Records how a promise settled, and how many times. */
function track(p: Promise<void>) {
  const settled: string[] = [];
  p.then(
    () => settled.push('resolved'),
    (err: Error) => settled.push(`rejected: ${err.message}`),
  );
  return settled;
}

describe('trashThroughParent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks main to trash the paths and resolves on a reply without an error', async () => {
    const port = fakePort();
    const trash = trashThroughParent(port);
    const settled = track(trash(['/Users/me/a.txt', '/Users/me/b.txt']));
    expect(port.posted).toEqual([
      { type: 'trash', id: expect.any(Number), paths: ['/Users/me/a.txt', '/Users/me/b.txt'] },
    ]);
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(['resolved']);
    // The timeout no longer fires once the reply settled it.
    await vi.advanceTimersByTimeAsync(TRASH_TIMEOUT_MS);
    expect(settled).toEqual(['resolved']);
  });

  it("rejects with main's error message", async () => {
    const port = fakePort();
    const settled = track(trashThroughParent(port)(['/Volumes/nas/a.txt']));
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id, error: 'No Trash here' });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(['rejected: No Trash here']);
  });

  it('matches replies to requests by id and ignores other messages', async () => {
    const port = fakePort();
    const trash = trashThroughParent(port);
    const first = track(trash(['/a']));
    const second = track(trash(['/b']));
    const [a, b] = port.posted;
    expect(a!.id).not.toBe(b!.id);
    port.deliver({ type: 'activeCount', count: 1 });
    port.deliver({ type: 'trashResult', id: 9999 });
    port.deliver(null);
    port.deliver({ type: 'trashResult', id: b!.id, error: 'nope' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual([]);
    expect(second).toEqual(['rejected: nope']);
    port.deliver({ type: 'trashResult', id: a!.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual(['resolved']);
  });

  it('rejects at the timeout and then ignores the late reply', async () => {
    const port = fakePort();
    const settled = track(trashThroughParent(port)(['/a']));
    await vi.advanceTimersByTimeAsync(TRASH_TIMEOUT_MS - 1);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatch(/^rejected: .*in time/);
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id });
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id, error: 'late' });
    await vi.advanceTimersByTimeAsync(TRASH_TIMEOUT_MS);
    expect(settled).toHaveLength(1);
  });

  it('settles once when a second reply arrives for the same request', async () => {
    const port = fakePort();
    const settled = track(trashThroughParent(port)(['/a']));
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id });
    port.deliver({ type: 'trashResult', id: port.posted[0]!.id, error: 'again' });
    await vi.advanceTimersByTimeAsync(TRASH_TIMEOUT_MS);
    expect(settled).toEqual(['resolved']);
  });
});

describe('server entry', () => {
  it('injects the parent-port trash only when there is a parent port', async () => {
    const src = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts'),
      'utf8',
    );
    expect(src).toContain('trash: parentPort ? trashThroughParent(parentPort) : undefined,');
  });
});
