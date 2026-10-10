import type { JobStatus } from '../shared/protocol.ts';
import type { FinderDrop } from './finder.ts';

export interface UploadTask {
  jobId: string;
  drop: FinderDrop;
}

export interface UploaderDeps {
  fetch: typeof fetch;
  /** Current status from the store; undefined until the job's first event arrives. */
  jobStatus: (jobId: string) => JobStatus | undefined;
  /** How often an open request checks whether its job still wants it. */
  checkMs?: number;
}

export type UploadOutcome = 'completed' | 'stopped' | 'failed';

/**
 * How many jobs upload at once across every drop; each sends its files one at a time.
 * Browsers allow 6 HTTP/1.1 connections per host, so this leaves room for everything else
 * the page asks for (Cancel, listings, the next drop's plan) while long uploads run.
 */
export const UPLOAD_CONCURRENCY = 3;

/** First come, first served slots. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter so a newcomer can't jump the line.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const sharedLimiter = new Limiter(UPLOAD_CONCURRENCY);

const base = (jobId: string) => `/api/uploads/${encodeURIComponent(jobId)}`;

/**
 * Sends one dropped item. The server owns the job: it counts the bytes, and on cancel or
 * failure it changes the status, so the uploader only has to notice and stop.
 */
export async function uploadOne(task: UploadTask, deps: UploaderDeps): Promise<UploadOutcome> {
  const { jobId, drop } = task;
  // The commit response can beat the job's first WebSocket event, so "unknown" means go on.
  const stillWanted = () => {
    const s = deps.jobStatus(jobId);
    return s === undefined || s === 'uploading';
  };
  // A request whose job the server already failed or cancelled is dropped by the page too:
  // one that never settles (a file read stuck on a dropped share) would otherwise hold one
  // of the page's few upload slots for good.
  const send = async (url: string, init: RequestInit): Promise<boolean> => {
    const ac = new AbortController();
    const watch = setInterval(() => {
      if (!stillWanted()) ac.abort();
    }, deps.checkMs ?? 1000);
    try {
      return (await deps.fetch(url, { ...init, signal: ac.signal })).ok;
    } catch {
      return false;
    } finally {
      clearInterval(watch);
    }
  };
  for (const f of drop.files) {
    if (!stillWanted()) return 'stopped';
    const query = `path=${encodeURIComponent(f.rel)}&mtime=${f.file.lastModified}`;
    const ok = await send(`${base(jobId)}/file?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: f.file,
    });
    if (!ok) return 'failed';
  }
  for (const d of drop.emptyDirs) {
    if (!stillWanted()) return 'stopped';
    if (!(await send(`${base(jobId)}/dir?path=${encodeURIComponent(d)}`, { method: 'POST' })))
      return 'failed';
  }
  if (!stillWanted()) return 'stopped';
  return (await send(`${base(jobId)}/complete`, { method: 'POST' })) ? 'completed' : 'failed';
}

/** Uploads every task, sharing `limiter` (by default, one for the whole page). */
export async function runUploads(
  tasks: UploadTask[],
  deps: UploaderDeps,
  limiter: Limiter = sharedLimiter,
): Promise<Map<string, UploadOutcome>> {
  const results = new Map<string, UploadOutcome>();
  await Promise.all(
    tasks.map((task) =>
      limiter.run(async () => results.set(task.jobId, await uploadOne(task, deps))),
    ),
  );
  return results;
}
