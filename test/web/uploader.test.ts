import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobStatus } from '../../src/shared/protocol.ts';
import type { FinderDrop } from '../../src/web/finder.ts';
import { Limiter, runUploads, uploadOne, type UploaderDeps } from '../../src/web/uploader.ts';

const drop = (rels: string[], emptyDirs: string[] = []): FinderDrop => ({
  item: { name: 'x', isDir: true, size: 0, files: rels.length, mtimeMs: 0 },
  files: rels.map((rel) => ({ rel, file: new File(['1'], rel || 'x', { lastModified: 1000 }) })),
  emptyDirs,
});

beforeAll(() => {
  // The page's token, as a `#token=` link hands it over.
  vi.stubGlobal('location', { hash: '#token=abc123', pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: () => undefined });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined });
});

function fakeDeps(opts: {
  status?: (id: string, calls: number) => JobStatus | undefined;
  fail?: (url: string) => boolean;
  throwOn?: (url: string) => boolean;
}) {
  const calls: { url: string; method: string }[] = [];
  const auth: (string | undefined)[] = [];
  const deps: UploaderDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      auth.push((init?.headers as Record<string, string> | undefined)?.authorization);
      if (opts.throwOn?.(url)) throw new TypeError('network');
      return new Response('{}', { status: opts.fail?.(url) ? 409 : 200 });
    },
    jobStatus: (id) => opts.status?.(id, calls.length) ?? 'uploading',
  };
  return { deps, calls, auth };
}

describe('uploadOne', () => {
  it('sends each file, then empty folders, then complete', async () => {
    const { deps, calls } = fakeDeps({});
    const out = await uploadOne({ jobId: 'j1', drop: drop(['a', 'sub/b c'], ['e']) }, deps);
    expect(out).toBe('completed');
    expect(calls).toEqual([
      { url: '/api/uploads/j1/file?path=a&mtime=1000', method: 'PUT' },
      { url: '/api/uploads/j1/file?path=sub%2Fb%20c&mtime=1000', method: 'PUT' },
      { url: '/api/uploads/j1/dir?path=e', method: 'POST' },
      { url: '/api/uploads/j1/complete', method: 'POST' },
    ]);
  });

  it('sends the page token with every request', async () => {
    const { deps, auth } = fakeDeps({});
    await uploadOne({ jobId: 'j1', drop: drop(['a'], ['e']) }, deps);
    expect(auth).toEqual(['Bearer abc123', 'Bearer abc123', 'Bearer abc123']);
  });

  it('keeps going while the job has no event yet', async () => {
    const { deps } = fakeDeps({ status: () => undefined });
    expect(await uploadOne({ jobId: 'j1', drop: drop(['a']) }, deps)).toBe('completed');
  });

  it('stops as soon as the job is no longer uploading', async () => {
    // Cancelled after the first file went up.
    const { deps, calls } = fakeDeps({
      status: (_id, n) => (n >= 1 ? 'cancelled' : 'uploading'),
    });
    const out = await uploadOne({ jobId: 'j1', drop: drop(['a', 'b', 'c']) }, deps);
    expect(out).toBe('stopped');
    expect(calls.map((c) => c.url)).toEqual(['/api/uploads/j1/file?path=a&mtime=1000']);
  });

  it('stops on a non-2xx response without completing', async () => {
    const { deps, calls } = fakeDeps({ fail: (u) => u.includes('path=b&') });
    const out = await uploadOne({ jobId: 'j1', drop: drop(['a', 'b', 'c']) }, deps);
    expect(out).toBe('failed');
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('drops a request that never settles once the job stops uploading', async () => {
    let status: JobStatus = 'uploading';
    const deps: UploaderDeps = {
      fetch: (_url, init) =>
        new Promise((_res, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      jobStatus: () => status,
      checkMs: 5,
    };
    const out = uploadOne({ jobId: 'j1', drop: drop(['a']) }, deps);
    await new Promise((r) => setTimeout(r, 20));
    status = 'failed';
    expect(await out).toBe('failed');
  });

  it('treats a network error as a failure', async () => {
    const { deps } = fakeDeps({ throwOn: () => true });
    expect(await uploadOne({ jobId: 'j1', drop: drop(['a']) }, deps)).toBe('failed');
  });
});

describe('runUploads', () => {
  it('runs at most the concurrency limit and finishes every task', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: UploaderDeps = {
      fetch: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return new Response('{}');
      },
      jobStatus: () => 'uploading',
    };
    const tasks = Array.from({ length: 7 }, (_, i) => ({ jobId: `j${i}`, drop: drop(['a']) }));
    const results = await runUploads(tasks, deps, new Limiter(3));
    expect(peak).toBe(3);
    expect([...results.values()]).toEqual(Array(7).fill('completed'));
  });

  it('shares the limit across drops so uploads never take every connection', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: UploaderDeps = {
      fetch: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return new Response('{}');
      },
      jobStatus: () => 'uploading',
    };
    const batch = (p: string) =>
      Array.from({ length: 4 }, (_, i) => ({ jobId: `${p}${i}`, drop: drop(['a', 'b']) }));
    const all = await Promise.all([
      runUploads(batch('x'), deps),
      runUploads(batch('y'), deps),
      runUploads(batch('z'), deps),
    ]);
    expect(peak).toBe(3);
    expect(all.flatMap((m) => [...m.values()])).toEqual(Array(12).fill('completed'));
  });

  it('one failing job does not stop the others', async () => {
    const { deps } = fakeDeps({ fail: (u) => u.includes('/j1/') });
    const results = await runUploads(
      [
        { jobId: 'j0', drop: drop(['a']) },
        { jobId: 'j1', drop: drop(['a']) },
        { jobId: 'j2', drop: drop(['a']) },
      ],
      deps,
      new Limiter(1),
    );
    expect(Object.fromEntries(results)).toEqual({
      j0: 'completed',
      j1: 'failed',
      j2: 'completed',
    });
  });
});

describe('Limiter', () => {
  it('hands a freed slot to the next waiter, never to a newcomer', async () => {
    const limiter = new Limiter(1);
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    let releaseA!: () => void;
    const job = (name: string, wait?: Promise<void>) => async () => {
      running++;
      peak = Math.max(peak, running);
      order.push(name);
      await (wait ?? Promise.resolve());
      running--;
    };
    const a = limiter.run(job('a', new Promise((r) => (releaseA = r))));
    const b = limiter.run(job('b'));
    await Promise.resolve();
    releaseA();
    await a;
    // Arrives after the slot was freed but before b got to run.
    const c = limiter.run(job('c'));
    await Promise.all([b, c]);
    expect(peak).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
