import { randomUUID } from 'node:crypto';
import { stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, busy, invalid, noSession, notFound } from '../errors.ts';
import { baseName, joinPosix, pathsOverlap, validateName } from '../fs/paths.ts';
import type { SideFs } from '../fs/types.ts';
import type { Hub } from '../hub.ts';
import {
  PARTIAL_SUFFIX,
  type CommitRequest,
  type CommitResponse,
  type Conflict,
  type Direction,
  type EntryMeta,
  type FinderItem,
  type Job,
  type PlanRequest,
  type PlanResponse,
  type Side,
} from '../../shared/protocol.ts';
import { keepBothName, nameKey } from './naming.ts';
import { isOfflineError, type Mount, type VolumeEvent } from '../fs/volumes.ts';
import type { OfflineVolume } from '../../shared/protocol.ts';

export interface TransferSpec {
  direction: Direction;
  srcPath: string;
  isDir: boolean;
  partialPath: string;
  finalPath: string;
  replace: boolean;
}

export interface RunHandle {
  /** Resolves when the copy and the final rename both succeed. Rejects with a user-facing Error. */
  done: Promise<void>;
  /** Stops the copy and removes the partial. Resolves once the process has exited. */
  cancel(): Promise<void>;
}

export interface RunHooks {
  onTotal(bytes: number, files: number): void;
  onProgress(bytes: number): void;
  /** The copy finished and the final rename is starting; it can no longer be cancelled. */
  onCommit(): void;
  /** A pull's bytes are all on the Mac; losing the phone from here on doesn't matter. */
  onDeviceDone?(): void;
}

export interface TransferRunner {
  start(spec: TransferSpec, hooks: RunHooks): RunHandle;
  /** Stops work that outlives a job (e.g. deleting a Replace backup). */
  stopBackground?(): void;
}

interface UploadState {
  /**
   * One per in-flight upload request; cancel aborts them. Each maps to a promise that
   * settles when its request handler is done with the staged file.
   */
  requests: Map<AbortController, { settled: Promise<void>; settle: () => void }>;
  /** Runs for as long as the job is uploading; see onUploadIdle. */
  idle: NodeJS.Timeout | null;
  received: number;
  lastEmit: number;
  lastActivity: number;
  /** Set once the page says it's done; no more requests are accepted. */
  completing: boolean;
  /** Uploads with the same key come from one page load (see CommitRequest.pageId). */
  pageKey: string;
  /** Staged paths by case-insensitive key, to catch names macOS would merge. */
  staged: Map<string, string>;
}

/** Where Finder uploads are staged; see staging.ts. */
export interface StagingLike {
  itemPath(jobId: string, name: string): string;
  resolve(itemPath: string, rel: string): string;
  remove(jobId: string): Promise<void>;
  freeBytes(): Promise<number | null>;
  /** Bytes and files staged for an item; creates an empty folder item. Null if nothing arrived. */
  measure(itemPath: string, isDir: boolean): Promise<{ bytes: number; files: number } | null>;
}

interface Entry {
  job: Job;
  replace: boolean;
  attempt: number;
  handle: RunHandle | null;
  last: { t: number; bytes: number } | null;
  /** Device session the job was planned against; retry is refused once it changes. */
  sessionId: number;
  /**
   * Set while a cancelled or failed attempt is still killing adb and removing its partial.
   * The job keeps its destination name, slot and busy paths until this settles, so a retry
   * can't share the partial path with the attempt being torn down.
   */
  stopping: Promise<void> | null;
  /** The running attempt is renaming its partial into place; cancel waits for the outcome. */
  committing: boolean;
  /** The running attempt no longer needs the device (see RunHooks.onDeviceDone). */
  deviceDone: boolean;
  /** Set while a Finder job is still receiving its bytes from the page. */
  upload: UploadState | null;
}

interface PlanItem {
  /** Empty for Finder items until the job's staging path exists. */
  srcPath: string;
  name: string;
  meta: EntryMeta;
  files: number;
}

interface Plan {
  kind: 'pane' | 'finder';
  direction: Direction;
  destDir: string;
  reveal: boolean;
  items: PlanItem[];
  /** Name keys (see nameKey) in the destination folder when the plan was made. */
  listing: Set<string>;
  /** The actual names behind `listing`, for revealing skipped items. */
  listingNames: Map<string, string>;
  createdAt: number;
  sessionId: number;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const noop = () => undefined;
const PLAN_TTL_MS = 30 * 60_000;
export const DEVICE_LOST = 'Device disconnected';
export const UPLOAD_INTERRUPTED = 'Upload interrupted (the page was closed or reloaded)';
export const NO_STAGING_SPACE = 'Not enough space on this Mac to stage these files.';
const STAGING_MARGIN = 64 * 1024 * 1024;

const destSideOf = (d: Direction): Side => (d === 'push' ? 'android' : 'mac');
const srcSideOf = (d: Direction): Side => (d === 'pull' ? 'android' : 'mac');
/** push and pull need the device; copy (Mac to Mac) doesn't. */
const usesDevice = (d: Direction) => d !== 'copy';
/** The Mac ends of a job, either of which may be on a network volume. */
const macPathsOf = (j: Pick<Job, 'direction' | 'srcPath' | 'destDir'>): string[] =>
  j.direction === 'push'
    ? [j.srcPath]
    : j.direction === 'pull'
      ? [j.destDir]
      : [j.srcPath, j.destDir];
const under = (p: string, root: string) => p === root || p.startsWith(root + '/');

/** The direction a plan request runs in. */
export function planDirection(
  req: { from: 'mac' } | { from: 'android' } | { from: 'finder' | 'paths'; destSide: Side },
): Direction {
  if (req.from === 'mac') return 'push';
  if (req.from === 'android') return 'pull';
  // Finder drops (staged uploads or real paths) come from the Mac: a push onto the phone,
  // or a copy onto the Mac pane that needs no device.
  return req.destSide === 'android' ? 'push' : 'copy';
}

/**
 * Whether the Mac volume holding `p` tells names apart by case. Looking `p` up with one
 * component's case swapped finds the same file on a case-insensitive volume (the macOS
 * default) and nothing, or another file, on a case-sensitive one. Anything that can't be
 * probed counts as case-insensitive, the default.
 */
export async function probeCaseSensitive(p: string): Promise<boolean> {
  const parts = p.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const name = parts[i]!;
    const swapped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
    if (swapped === name) continue;
    const variant = [...parts.slice(0, i), swapped, ...parts.slice(i + 1)].join('/');
    try {
      const a = await fsStat(p, { bigint: true });
      const b = await fsStat(variant, { bigint: true }).catch(() => null);
      return !b || a.dev !== b.dev || a.ino !== b.ino;
    } catch {
      return false;
    }
  }
  return false;
}

/** What the queue needs from the volume monitor (see volumes.ts). */
export interface QueueVolumes {
  volumeOf(p: string): Mount | null;
  offlineFor(p: string): OfflineVolume | null;
  check(p: string): Promise<boolean>;
}
const partialName = (name: string) => `.${name}${PARTIAL_SUFFIX}`;

export interface QueueDeps {
  hub: Hub;
  fs: Record<Side, SideFs>;
  runner: TransferRunner;
  isConnected: () => boolean;
  /** Changes whenever a different device session starts (not on reconnect). */
  sessionId: () => number;
  maxConcurrent: number;
  now?: () => number;
  /** Required for Finder drops. */
  staging?: StagingLike;
  /** Opens the file manager with these paths selected (Show in Finder batches). */
  reveal?: (paths: string[]) => void;
  /** How long an uploading job may go without a request before it fails. */
  uploadIdleMs?: number;
  /** Network volume awareness; without it every Mac path counts as local. */
  volumes?: QueueVolumes;
  /** Whether the Mac volume holding a path is case-sensitive (defaults to probeCaseSensitive). */
  caseSensitive?: (macPath: string) => Promise<boolean>;
}

/**
 * Owns every transfer job. All state changes go through this class; `finish` is the only
 * way a job becomes terminal, and it ignores anything from a stale attempt.
 */
export class TransferQueue {
  private readonly deps: QueueDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<string>();
  private readonly plans = new Map<string, Plan>();
  /**
   * Show in Finder batches still running: jobs not yet finished, and the paths already copied
   * (kept here because Clear can drop finished jobs before the batch ends).
   */
  private readonly revealBatches = new Map<string, { pending: Set<string>; copied: string[] }>();
  /** Mount points back online but not yet released (parked originals are being restored). */
  private readonly held = new Set<string>();
  /** Every in-flight upload request, including ones whose job already finished. */
  private readonly uploadRequests = new Map<AbortController, { settle: () => void }>();
  private max: number;
  /** No device to run push/pull jobs on (dropped, ended, or never connected). */
  private devicePaused: boolean;
  /** Reconnecting gave up; device jobs that finish uploading afterwards fail. */
  private sessionLost = false;
  private readonly now: () => number;

  constructor(deps: QueueDeps) {
    this.deps = deps;
    this.max = deps.maxConcurrent;
    this.devicePaused = !deps.isConnected();
    this.now = deps.now ?? Date.now;
  }

  get maxConcurrent() {
    return this.max;
  }

  jobs(): Job[] {
    return [...this.entries.values()].map((e) => ({ ...e.job }));
  }

  runningCount() {
    return this.running.size;
  }

  // ------------------------------------------------------------ planning

  async plan(req: PlanRequest): Promise<PlanResponse> {
    if (req.from === 'finder') return this.planFinder(req);
    // A desktop-app Finder drop names real Mac paths, so it runs like a drag from the Mac pane.
    const direction = planDirection(req);
    if (usesDevice(direction) && !this.deps.isConnected()) throw noSession();
    // Captured before any await: the probes below must all come from this device session.
    const sessionId = this.deps.sessionId();
    const srcFs = this.deps.fs[srcSideOf(direction)];
    if (!req.srcPaths.length) throw new HttpError(400, 'Nothing to transfer.', 'INVALID');
    const items: PlanItem[] = [];
    for (const srcPath of new Set(req.srcPaths)) {
      // cp -R into its own subtree would keep copying what it just wrote.
      if (direction === 'copy' && (await this.copiesIntoItself(srcPath, req.destDir))) {
        throw invalid(`“${baseName(srcPath)}” can't be copied into itself.`);
      }
      const meta = await srcFs.stat(srcPath);
      if (!meta) throw notFound(`“${baseName(srcPath)}” no longer exists.`);
      items.push({ srcPath, name: baseName(srcPath), meta, files: meta.isDir ? 0 : 1 });
    }
    return this.finishPlan({
      kind: 'pane',
      direction,
      destDir: req.destDir,
      reveal: req.from !== 'paths' && !!req.reveal,
      items,
      sessionId,
    });
  }

  private async planFinder(req: Extract<PlanRequest, { from: 'finder' }>): Promise<PlanResponse> {
    const direction = planDirection(req);
    if (usesDevice(direction) && !this.deps.isConnected()) throw noSession();
    const sessionId = this.deps.sessionId();
    const staging = this.deps.staging;
    if (!staging) throw new HttpError(500, 'Finder drops are not available.');
    if (!Array.isArray(req.items) || !req.items.length) throw invalid('Nothing to transfer.');
    const seen = new Set<string>();
    const items: PlanItem[] = req.items.map((raw: FinderItem) => {
      const name = String(raw?.name ?? '');
      if (validateName(name) !== name) throw invalid(`“${name}” can't be copied.`);
      // The page maps uploads to jobs by name, so two items can't share one.
      if (seen.has(name)) throw invalid(`Two dropped items are both named “${name}”.`);
      seen.add(name);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      const isDir = raw.isDir === true;
      return {
        srcPath: '',
        name,
        meta: { isDir, size: num(raw.size), mtimeMs: num(raw.mtimeMs) },
        files: isDir ? num(raw.files) : 1,
      };
    });
    const total = items.reduce((n, i) => n + i.meta.size, 0);
    const free = await staging.freeBytes();
    if (free !== null && free < total + STAGING_MARGIN) {
      throw new HttpError(507, NO_STAGING_SPACE, 'NO_SPACE');
    }
    return this.finishPlan({
      kind: 'finder',
      direction,
      destDir: req.destDir,
      reveal: false,
      items,
      sessionId,
    });
  }

  /** Whether `destDir` is `src` or inside it, ignoring case only where the volume does. */
  private async copiesIntoItself(src: string, destDir: string): Promise<boolean> {
    const inside = (foldCase: boolean) => {
      const key = (p: string) => {
        const k = path.posix.resolve(p).normalize('NFC');
        return foldCase ? k.toLowerCase() : k;
      };
      const rel = path.posix.relative(key(src), key(destDir));
      return rel !== '..' && !rel.startsWith('../');
    };
    if (inside(false)) return true;
    // Only a match that needs case folding depends on the volume, so only it is probed.
    return inside(true) && !(await (this.deps.caseSensitive ?? probeCaseSensitive)(src));
  }

  private async finishPlan(
    p: Omit<Plan, 'listing' | 'listingNames' | 'createdAt'>,
  ): Promise<PlanResponse> {
    const destFs = this.deps.fs[destSideOf(p.direction)];
    const destMeta = await destFs.stat(p.destDir);
    if (!destMeta?.isDir) throw notFound(`The destination folder no longer exists.`);
    const listingEntries = await destFs.list(p.destDir);
    if (
      usesDevice(p.direction) &&
      (!this.deps.isConnected() || this.deps.sessionId() !== p.sessionId)
    ) {
      throw new HttpError(409, 'The device changed while preparing this transfer.', 'CONFLICT');
    }
    const byKey = new Map(listingEntries.map((e) => [nameKey(e.name), e]));
    const reserved = this.reservedNames(destSideOf(p.direction), p.destDir);
    const taken = new Set([
      ...byKey.keys(),
      ...reserved.keys(),
      ...p.items.map((i) => nameKey(i.name)),
    ]);

    // Items whose names only clash with each other get Keep-both names at commit without a
    // prompt; only clashes with the destination folder or an active transfer are asked about.
    const conflicts: Conflict[] = [];
    for (const it of p.items) {
      const k = nameKey(it.name);
      const existing = byKey.get(k);
      const reservedBy = reserved.get(k);
      if (!existing && !reservedBy) continue;
      conflicts.push({
        name: it.name,
        incoming: it.meta,
        existing: existing
          ? { isDir: existing.isDir, size: existing.size, mtimeMs: existing.mtimeMs }
          : { isDir: reservedBy!.isDir, size: reservedBy!.totalBytes, mtimeMs: this.now() },
        keepBothName: keepBothName(it.name, it.meta.isDir, taken),
      });
    }

    this.prunePlans();
    const batchId = randomUUID();
    this.plans.set(batchId, {
      ...p,
      listing: new Set(byKey.keys()),
      listingNames: new Map([...byKey].map(([k, e]) => [k, e.name])),
      createdAt: this.now(),
    });
    return { batchId, itemCount: p.items.length, conflicts };
  }

  commit(req: CommitRequest): CommitResponse {
    const plan = this.plans.get(req.batchId);
    if (plan && usesDevice(plan.direction) && !this.deps.isConnected()) throw noSession();
    if (!plan || (usesDevice(plan.direction) && plan.sessionId !== this.deps.sessionId())) {
      this.plans.delete(req.batchId);
      throw new HttpError(410, 'This transfer request expired. Drag the files again.', 'INVALID');
    }
    const direction = plan.direction;
    const destSide = destSideOf(direction);
    const destDir = plan.destDir;
    const reserved = this.reservedNames(destSide, destDir);
    // Every incoming name counts as taken so a Keep-both rename can't land on a sibling in
    // the same batch (dropping `a.txt` and `a (1).txt` next to an existing `a.txt`).
    const taken = new Set([
      ...plan.listing,
      ...reserved.keys(),
      ...plan.items.map((i) => nameKey(i.name)),
    ]);
    const assigned = new Set<string>();
    const skipped: string[] = [];

    const decided: { item: Plan['items'][number]; destName: string; replace: boolean }[] = [];
    for (const item of plan.items) {
      const k = nameKey(item.name);
      let destName = item.name;
      let replace = false;
      if (plan.listing.has(k) || reserved.has(k)) {
        const decision = req.decisions[item.name] ?? 'skip';
        if (decision === 'skip') {
          // Show in Finder still shows the copy that's already there.
          const existing = plan.listingNames.get(k);
          if (plan.reveal && existing) skipped.push(joinPosix(destDir, existing));
          continue;
        }
        if (decision === 'replace') {
          if (reserved.has(k)) {
            throw new HttpError(
              409,
              `“${item.name}” is already being transferred to this folder.`,
              'CONFLICT',
            );
          }
          replace = true;
        } else {
          destName = keepBothName(item.name, item.meta.isDir, taken);
        }
      }
      // Two items in one batch that differ only by case would share a destination.
      if (assigned.has(nameKey(destName))) {
        destName = keepBothName(item.name, item.meta.isDir, taken);
        replace = false;
      }
      taken.add(nameKey(destName));
      assigned.add(nameKey(destName));
      decided.push({ item, destName, replace });
    }
    this.plans.delete(req.batchId);

    const finder = plan.kind === 'finder';
    const ids: string[] = [];
    const uploads: CommitResponse['uploads'] = [];
    for (const d of decided) {
      const id = randomUUID();
      const job: Job = {
        id,
        batchId: req.batchId,
        direction,
        origin: finder ? 'finder' : 'pane',
        srcPath: finder ? this.deps.staging!.itemPath(id, d.item.name) : d.item.srcPath,
        destDir,
        destName: d.destName,
        isDir: d.item.meta.isDir,
        itemCount: d.item.files,
        totalBytes: finder || !d.item.meta.isDir ? d.item.meta.size : 0,
        transferredBytes: 0,
        bytesPerSec: 0,
        status: finder ? 'uploading' : 'queued',
        error: null,
        createdAt: this.now(),
        startedAt: null,
        finishedAt: null,
        retryable: true,
        waitingFor: null,
      };
      const entry: Entry = {
        job,
        replace: d.replace,
        attempt: 0,
        handle: null,
        last: null,
        sessionId: plan.sessionId,
        stopping: null,
        committing: false,
        deviceDone: false,
        upload: finder
          ? {
              requests: new Map(),
              idle: null,
              received: 0,
              lastEmit: 0,
              lastActivity: this.now(),
              completing: false,
              pageKey: req.pageId ?? req.batchId,
              staged: new Map(),
            }
          : null,
      };
      this.entries.set(id, entry);
      ids.push(id);
      if (finder) {
        uploads.push({ name: d.item.name, jobId: id });
        this.armUploadIdle(entry);
      }
      this.emitJob(id);
    }
    if (plan.reveal && ids.length) {
      this.revealBatches.set(req.batchId, { pending: new Set(ids), copied: skipped });
    } else if (skipped.length) {
      this.deps.reveal?.(skipped);
    }
    this.pump();
    return { jobIds: ids, uploads };
  }

  // ------------------------------------------------------------ Finder uploads

  /** The staged path one upload request writes to. Refuses jobs no longer uploading. */
  uploadTarget(id: string, rel: string, kind: 'file' | 'dir'): string {
    const e = this.uploadingEntry(id);
    try {
      if (!e.job.isDir && (rel || kind === 'dir')) throw invalid('A dropped file has no folders.');
      if (!rel && kind === 'file' && e.job.isDir) throw invalid('A folder upload needs a path.');
      const target = this.deps.staging!.resolve(e.job.srcPath, rel);
      // Staging lives on the Mac's usually case-insensitive disk, where `a.txt` and `A.txt`
      // from a case-sensitive source would land on one file and silently lose data.
      const key = nameKey(rel);
      const prior = e.upload!.staged.get(key);
      if (prior !== undefined && prior !== rel) {
        throw invalid(`“${prior}” and “${rel}” differ only by case and can't both be copied.`);
      }
      e.upload!.staged.set(key, rel);
      return target;
    } catch (err) {
      // The page has no way to send this item correctly, so fail it now rather than at idle.
      this.failUpload(id, `Could not upload “${e.job.destName}”: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Registers an in-flight upload request; cancelling the job aborts it. */
  beginUpload(id: string): AbortController {
    const e = this.uploadingEntry(id);
    const up = e.upload!;
    up.lastActivity = this.now();
    this.armUploadIdle(e);
    const ac = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    up.requests.set(ac, { settled, settle });
    this.uploadRequests.set(ac, { settle });
    return ac;
  }

  uploadProgress(id: string, bytes: number) {
    const e = this.entries.get(id);
    if (!e?.upload || e.job.status !== 'uploading') return;
    const up = e.upload;
    up.received += bytes;
    up.lastActivity = this.now();
    const job = e.job;
    job.transferredBytes = Math.min(up.received, Math.max(job.totalBytes - 1, 0));
    const t = this.now();
    if (t - up.lastEmit >= 250) {
      up.lastEmit = t;
      this.emitJob(id);
    }
  }

  /** An upload request ended. A broken request fails the job; it can't be resumed. */
  endUpload(id: string, ac: AbortController, ok: boolean, error = UPLOAD_INTERRUPTED) {
    const e = this.entries.get(id);
    const req = this.uploadRequests.get(ac);
    this.uploadRequests.delete(ac);
    req?.settle();
    if (!e?.upload) return;
    e.upload.requests.delete(ac);
    e.upload.lastActivity = this.now();
    if (e.job.status !== 'uploading') return;
    if (!ok) {
      this.failUpload(id, error);
      return;
    }
    this.armUploadIdle(e);
  }

  /** The page sent every file: measure the staged copy and queue the job. */
  async completeUpload(id: string): Promise<void> {
    const e = this.uploadingEntry(id);
    const up = e.upload!;
    if (up.requests.size) throw new HttpError(409, 'Files are still uploading.', 'CONFLICT');
    if (up.idle) clearTimeout(up.idle);
    up.idle = null;
    // Measuring is async; a request arriving meanwhile would change what gets copied.
    up.completing = true;
    const job = e.job;
    const staged = await this.deps.staging!.measure(job.srcPath, job.isDir).catch(() => null);
    if (job.status !== 'uploading') return;
    if (!staged) {
      this.failUpload(id, 'Nothing was uploaded.');
      return;
    }
    e.upload = null;
    if (usesDevice(job.direction) && (this.sessionLost || e.sessionId !== this.deps.sessionId())) {
      job.retryable = false;
      this.finish(id, null, 'failed', DEVICE_LOST);
      return;
    }
    job.totalBytes = staged.bytes;
    job.itemCount = staged.files;
    job.transferredBytes = 0;
    job.status = 'queued';
    this.emitJob(id);
    this.pump();
  }

  failUpload(id: string, error: string) {
    const e = this.entries.get(id);
    if (!e || e.job.status !== 'uploading') return;
    // Only the page had the original files, so there is nothing to retry from.
    e.job.retryable = false;
    this.finish(id, null, 'failed', error);
  }

  private uploadingEntry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw notFound('That transfer no longer exists.');
    if (e.job.status !== 'uploading' || !e.upload || e.upload.completing) {
      throw new HttpError(409, 'That transfer is no longer accepting files.', 'CONFLICT');
    }
    return e;
  }

  private armUploadIdle(e: Entry) {
    const up = e.upload;
    if (!up) return;
    if (up.idle) clearTimeout(up.idle);
    const t = setTimeout(() => this.onUploadIdle(e), this.idleMs);
    t.unref?.();
    up.idle = t;
  }

  private get idleMs() {
    return this.deps.uploadIdleMs ?? 60_000;
  }

  /**
   * An item that moved recently is fine. One with a request open but no bytes for the idle
   * window has stalled (e.g. the browser is reading from a share that dropped), and nothing
   * else would ever end that request. The page uploads a few items at a time across all its
   * drops, so an item may also wait its turn with no request of its own, even behind another
   * drop; it has been abandoned once nothing from its page is moving. Another page's uploads
   * don't count: after a reload, the old page's waiting items are gone for good.
   */
  private onUploadIdle(e: Entry) {
    const up = e.upload;
    if (e.job.status !== 'uploading' || !up) return;
    const cutoff = this.now() - this.idleMs;
    const moving = (o: Entry) => o.upload !== null && o.upload.lastActivity > cutoff;
    if (moving(e)) return this.armUploadIdle(e);
    if (up.requests.size) return this.failUpload(e.job.id, UPLOAD_INTERRUPTED);
    const samePage = (o: Entry) => o.upload?.pageKey === up.pageKey;
    if ([...this.entries.values()].some((o) => samePage(o) && moving(o))) this.armUploadIdle(e);
    else this.failUpload(e.job.id, UPLOAD_INTERRUPTED);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * The only rule for whether a queued job may start: device jobs need the device of the
   * session they were planned in; copy jobs need nothing. Uploading jobs are never queued.
   * Jobs with a Mac end on an offline volume wait (see refreshWaiting).
   */
  private canStart(e: Entry): boolean {
    if (e.job.status !== 'queued') return false;
    // A paused job's interrupted attempt may still be cleaning up its partial path.
    if (e.stopping) return false;
    if (e.job.waitingFor) return false;
    if (!usesDevice(e.job.direction)) return true;
    return !this.devicePaused && e.sessionId === this.deps.sessionId();
  }

  /** Marks queued jobs whose Mac end is on an offline volume, and clears ones that returned. */
  private refreshWaiting() {
    const vols = this.deps.volumes;
    for (const e of this.entries.values()) {
      if (e.job.status !== 'queued') continue;
      const paths = macPathsOf(e.job);
      const off = paths.map((p) => vols?.offlineFor(p) ?? null).find((o) => o) ?? null;
      // Queued after the give-up (a Finder upload that finished late): the deadline belongs
      // to the volume, so it has already passed.
      if (off && this.now() >= off.giveUpAt) {
        this.finish(e.job.id, null, 'failed', `${off.name} was offline for 30 minutes`);
        continue;
      }
      const hold = [...this.held].find((mp) => paths.some((p) => under(p, mp)));
      const name = off?.name ?? (hold ? baseName(hold) : null);
      if (e.job.waitingFor !== name) {
        e.job.waitingFor = name;
        this.emitJob(e.job.id);
      }
    }
  }

  private pump() {
    this.refreshWaiting();
    const queued = [...this.entries.values()]
      .filter((e) => this.canStart(e))
      .sort((a, b) => a.job.createdAt - b.job.createdAt);
    for (const e of queued) {
      if (this.running.size + this.stoppingCount() >= this.max) break;
      this.startEntry(e);
    }
  }

  private stoppingCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.stopping) n++;
    return n;
  }

  /** Tears down an attempt's process and partial while the job keeps its slot and names. */
  private teardown(e: Entry, handle: RunHandle): Promise<void> {
    const p: Promise<void> = handle
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        if (e.stopping === p) e.stopping = null;
        this.pump();
      });
    e.stopping = p;
    return p;
  }

  private startEntry(e: Entry) {
    const attempt = ++e.attempt;
    const job = e.job;
    job.status = 'running';
    job.startedAt = this.now();
    job.transferredBytes = 0;
    job.bytesPerSec = 0;
    job.error = null;
    e.last = null;
    e.committing = false;
    e.deviceDone = false;
    this.running.add(job.id);
    this.emitJob(job.id);

    const finalPath = joinPosix(job.destDir, job.destName);
    const spec: TransferSpec = {
      direction: job.direction,
      srcPath: job.srcPath,
      isDir: job.isDir,
      partialPath: joinPosix(job.destDir, partialName(job.destName)),
      finalPath,
      replace: e.replace,
    };
    const live = () => e.attempt === attempt && job.status === 'running';
    let handle: RunHandle;
    try {
      handle = this.deps.runner.start(spec, {
        onTotal: (bytes, files) => {
          if (!live()) return;
          job.totalBytes = bytes;
          job.itemCount = files;
          this.emitJob(job.id);
        },
        onProgress: (bytes) => {
          if (!live()) return;
          this.applyProgress(e, bytes);
        },
        onCommit: () => {
          if (live()) e.committing = true;
        },
        onDeviceDone: () => {
          if (live()) e.deviceDone = true;
        },
      });
    } catch (err) {
      this.finish(job.id, attempt, 'failed', (err as Error).message);
      return;
    }
    e.handle = handle;
    handle.done.then(
      () => this.finish(job.id, attempt, 'done'),
      (err: unknown) => void this.attemptFailed(e, attempt, err),
    );
  }

  /**
   * A failure on a network volume that has gone away pauses the job instead of failing it;
   * the attempt check after the probe keeps a stale attempt from touching a newer one.
   */
  private async attemptFailed(e: Entry, attempt: number, err: unknown) {
    const message = (err as Error)?.message || 'Transfer failed';
    const vols = this.deps.volumes;
    const shared = macPathsOf(e.job).filter((p) => vols?.volumeOf(p));
    if (vols && shared.length && e.attempt === attempt) {
      const gone =
        isOfflineError(err) ||
        (await Promise.all(shared.map((p) => vols.check(p).catch(() => true)))).includes(false);
      if (e.attempt !== attempt || e.job.status !== 'running') return;
      if (gone) {
        this.pauseForVolume(e);
        return;
      }
    }
    this.finish(e.job.id, attempt, 'failed', message);
  }

  /** Back to queued until the volume returns; the next attempt starts the item over. */
  private pauseForVolume(e: Entry) {
    const job = e.job;
    // Results from the interrupted attempt must not finish or fail the job later.
    e.attempt++;
    e.handle = null;
    e.committing = false;
    e.deviceDone = false;
    e.last = null;
    job.status = 'queued';
    job.startedAt = null;
    job.transferredBytes = 0;
    job.bytesPerSec = 0;
    job.error = null;
    this.running.delete(job.id);
    this.emitJob(job.id);
    this.pump();
  }

  /**
   * Keeps a returning share's jobs waiting until onVolumeEvent(online) for it, so nothing
   * starts there before the app has put back originals parked by an interrupted Replace.
   */
  holdVolume(mountPoint: string) {
    this.held.add(mountPoint);
  }

  /** Routed from the volume monitor. */
  onVolumeEvent(ev: VolumeEvent) {
    if (ev.type === 'online') this.held.delete(ev.mountPoint);
    if (ev.type === 'offline') {
      for (const id of [...this.running]) {
        const e = this.entries.get(id);
        if (!e || e.committing || !macPathsOf(e.job).some((p) => under(p, ev.mountPoint))) {
          continue;
        }
        if (e.handle) void this.teardown(e, e.handle);
        this.pauseForVolume(e);
      }
    } else if (ev.type === 'moved') {
      const move = (p: string) => (under(p, ev.from) ? ev.to + p.slice(ev.from.length) : p);
      for (const e of this.entries.values()) {
        const j = e.job;
        if (TERMINAL.has(j.status) && !(j.status === 'failed' && j.retryable)) continue;
        // A copy has both ends on the Mac; a Finder copy's source is local staging.
        if (j.direction !== 'pull') j.srcPath = move(j.srcPath);
        if (j.direction !== 'push') j.destDir = move(j.destDir);
        this.emitJob(j.id);
      }
      for (const plan of this.plans.values()) {
        if (plan.direction !== 'push') plan.destDir = move(plan.destDir);
        for (const it of plan.items) if (plan.direction !== 'pull') it.srcPath = move(it.srcPath);
      }
    } else if (ev.type === 'gaveUp') {
      for (const e of this.entries.values()) {
        const onShare = macPathsOf(e.job).some((p) => under(p, ev.mountPoint));
        if (e.job.status === 'queued' && onShare) {
          this.finish(e.job.id, null, 'failed', `${ev.name} was offline for 30 minutes`);
        }
      }
    }
    this.pump();
  }

  private applyProgress(e: Entry, sample: number) {
    const job = e.job;
    // Stays below the total until finish(done): a full partial isn't a finished transfer.
    const cap = job.totalBytes > 0 ? job.totalBytes - 1 : sample;
    const bytes = Math.max(job.transferredBytes, Math.min(sample, cap));
    const t = this.now();
    if (e.last && t > e.last.t) {
      const inst = ((bytes - e.last.bytes) * 1000) / (t - e.last.t);
      job.bytesPerSec = job.bytesPerSec ? job.bytesPerSec * 0.6 + inst * 0.4 : inst;
    }
    e.last = { t, bytes };
    job.transferredBytes = bytes;
    this.emitJob(job.id);
  }

  /** The single place a job becomes terminal. No-op for stale attempts or terminal jobs. */
  private finish(
    id: string,
    attempt: number | null,
    outcome: 'done' | 'failed' | 'cancelled',
    error?: string,
  ) {
    const e = this.entries.get(id);
    if (!e) return;
    if (attempt !== null && e.attempt !== attempt) return;
    if (TERMINAL.has(e.job.status)) return;
    const job = e.job;
    let draining: Promise<unknown> | null = null;
    if (e.upload) {
      if (e.upload.idle) clearTimeout(e.upload.idle);
      const reqs = [...e.upload.requests];
      for (const [ac] of reqs) ac.abort();
      // An aborted request may still be closing its staged file; delete staging after it.
      if (reqs.length) draining = Promise.all(reqs.map(([, r]) => r.settled));
      e.upload = null;
    }
    job.status = outcome;
    job.waitingFor = null;
    job.finishedAt = this.now();
    job.error = outcome === 'failed' ? (error ?? 'Transfer failed') : null;
    job.bytesPerSec = 0;
    if (outcome === 'done') job.transferredBytes = job.totalBytes;
    // A cancelled Finder job's staged copy is deleted, so there's nothing left to retry.
    if (outcome === 'cancelled' && job.origin === 'finder') job.retryable = false;
    if (outcome !== 'failed' || !job.retryable) this.releaseStaging(e, draining);
    this.running.delete(id);
    this.emitJob(id);
    if (outcome === 'done') {
      this.deps.hub.emit({ type: 'fsChanged', side: destSideOf(job.direction), dir: job.destDir });
    }
    this.checkReveal(job);
    this.pump();
  }

  /** Deletes a Finder job's staged copy once no attempt can still be reading it. */
  private releaseStaging(e: Entry, draining: Promise<unknown> | null = null) {
    const staging = this.deps.staging;
    if (e.job.origin !== 'finder' || !staging) return;
    const id = e.job.id;
    const busy = [e.stopping, draining].filter((p): p is Promise<unknown> => !!p);
    if (busy.length) void Promise.all(busy).then(() => staging.remove(id));
    else void staging.remove(id);
  }

  private checkReveal(job: Job) {
    const batch = this.revealBatches.get(job.batchId);
    if (!batch || !batch.pending.delete(job.id)) return;
    if (job.status === 'done') batch.copied.push(joinPosix(job.destDir, job.destName));
    if (batch.pending.size) return;
    this.revealBatches.delete(job.batchId);
    if (batch.copied.length) this.deps.reveal?.(batch.copied);
  }

  cancel(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw notFound('That transfer no longer exists.');
    if (TERMINAL.has(e.job.status)) return Promise.resolve();
    const wasRunning = e.job.status === 'running';
    const handle = e.handle;
    // Past the point of no return: report what actually happened instead of "cancelled".
    if (wasRunning && e.committing && handle) return handle.done.then(noop, noop);
    // Start the teardown before finish() so its pump() can't hand this slot to another job.
    const stopped = wasRunning && handle ? this.teardown(e, handle) : Promise.resolve();
    this.finish(id, null, 'cancelled');
    return stopped;
  }

  retry(id: string) {
    const e = this.entries.get(id);
    if (!e) throw notFound('That transfer no longer exists.');
    if (e.job.status !== 'failed' && e.job.status !== 'cancelled') return;
    if (!e.job.retryable) {
      throw new HttpError(409, "This transfer can't be retried. Drop the files again.", 'CONFLICT');
    }
    const vols = this.deps.volumes;
    const offline = macPathsOf(e.job)
      .map((p) => vols?.offlineFor(p))
      .find((o) => o);
    if (offline) {
      throw new HttpError(
        409,
        `${offline.name} is still offline. Try again once it's back.`,
        'OFFLINE',
      );
    }
    if (usesDevice(e.job.direction) && !this.deps.isConnected()) throw noSession();
    if (usesDevice(e.job.direction) && e.sessionId !== this.deps.sessionId()) {
      throw new HttpError(
        409,
        'That transfer was for a previous session. Drag the files again.',
        'CONFLICT',
      );
    }
    if (e.stopping) {
      throw new HttpError(
        409,
        'That transfer is still stopping. Try again in a moment.',
        'CONFLICT',
      );
    }
    const destSide = destSideOf(e.job.direction);
    const holder = this.reservedNames(destSide, e.job.destDir).get(nameKey(e.job.destName));
    if (holder && holder.id !== id) {
      throw new HttpError(
        409,
        `“${e.job.destName}” is already being transferred to this folder.`,
        'CONFLICT',
      );
    }
    e.job.status = 'queued';
    e.job.error = null;
    e.job.transferredBytes = 0;
    e.job.finishedAt = null;
    e.job.startedAt = null;
    e.job.createdAt = this.now();
    e.handle = null;
    this.emitJob(id);
    this.pump();
  }

  clearFinished() {
    const cleared = [...this.entries.values()].filter(
      (e) => TERMINAL.has(e.job.status) && !e.stopping,
    );
    const ids = cleared.map((e) => e.job.id);
    for (const e of cleared) {
      this.releaseStaging(e);
      this.entries.delete(e.job.id);
    }
    if (ids.length) this.deps.hub.emit({ type: 'jobsRemoved', ids });
  }

  setMaxConcurrent(n: number) {
    this.max = n;
    this.pump();
  }

  /** Device dropped: running device jobs fail (retryable), queued ones wait. */
  onDeviceLost() {
    this.devicePaused = true;
    for (const id of [...this.running]) {
      const e = this.entries.get(id);
      if (!e || !usesDevice(e.job.direction) || e.committing || e.deviceDone) continue;
      if (e?.handle) void this.teardown(e, e.handle);
      this.finish(id, null, 'failed', DEVICE_LOST);
    }
  }

  onDeviceReady() {
    this.devicePaused = false;
    this.sessionLost = false;
    this.pump();
  }

  /** Reconnect gave up: device jobs still waiting fail. */
  onSessionLost() {
    this.devicePaused = true;
    this.sessionLost = true;
    for (const e of this.entries.values()) {
      if (e.job.status === 'queued' && usesDevice(e.job.direction)) {
        this.finish(e.job.id, null, 'failed', DEVICE_LOST);
      }
    }
  }

  /** End Session: cancel everything and wait for every adb process to exit. */
  cancelAll(timeoutMs = 8000, commitTimeoutMs = 90_000): Promise<void> {
    return this.cancelWhere(() => true, timeoutMs, commitTimeoutMs);
  }

  /**
   * A lost session making way for a new one: only work tied to the old device ends. Copy
   * jobs and Finder uploads into the Mac pane never needed it and carry on.
   */
  cancelDeviceJobs(): Promise<void> {
    return this.cancelWhere((e) => usesDevice(e.job.direction) && !e.deviceDone);
  }

  private async cancelWhere(
    pred: (e: Entry) => boolean,
    timeoutMs = 8000,
    commitTimeoutMs = 90_000,
  ): Promise<void> {
    this.devicePaused = true;
    const pending: Promise<void>[] = [];
    const committing: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (!pred(e)) continue;
      if (!TERMINAL.has(e.job.status)) {
        (e.committing ? committing : pending).push(this.cancel(e.job.id));
      } else if (e.stopping) pending.push(e.stopping);
    }
    const capped = (ps: Promise<unknown>[], ms: number) =>
      Promise.race([Promise.all(ps), new Promise((r) => setTimeout(r, ms).unref())]);
    // A final rename can't be interrupted, and disconnecting mid-rename could cut it off, so
    // it gets the full finalize timeout rather than the short cancel budget.
    await Promise.all([capped(pending, timeoutMs), capped(committing, commitTimeoutMs)]);
    this.deps.runner.stopBackground?.();
    // Failed Finder jobs keep their staged copy for a retry; End Session ends that chance.
    for (const e of this.entries.values()) {
      if (!pred(e)) continue;
      if (e.job.origin === 'finder' && e.job.status === 'failed' && e.job.retryable) {
        e.job.retryable = false;
        this.releaseStaging(e);
        this.emitJob(e.job.id);
      }
    }
  }

  // ------------------------------------------------------------ busy paths

  /** Throws BUSY_PATH if `p` on `side` overlaps any active transfer's source or destination. */
  assertNotBusy(side: Side, p: string) {
    for (const e of this.entries.values()) {
      if (!this.holdsPaths(e)) continue;
      const job = e.job;
      // A copy job has both ends on the Mac, so check each end separately.
      const touched: string[] = [];
      if (srcSideOf(job.direction) === side) touched.push(job.srcPath);
      if (destSideOf(job.direction) === side) {
        touched.push(
          joinPosix(job.destDir, job.destName),
          joinPosix(job.destDir, partialName(job.destName)),
        );
      }
      if (touched.some((t) => pathsOverlap(nameKey(t), nameKey(p)))) {
        throw busy(`Can't change “${baseName(p) || p}” while it is being transferred.`);
      }
    }
  }

  private reservedNames(destSide: Side, destDir: string): Map<string, Job> {
    const m = new Map<string, Job>();
    for (const e of this.entries.values()) {
      const j = e.job;
      if (!this.holdsPaths(e)) continue;
      if (destSideOf(j.direction) === destSide && nameKey(j.destDir) === nameKey(destDir)) {
        m.set(nameKey(j.destName), j);
      }
    }
    return m;
  }

  /** Active jobs, and finished ones whose teardown is still running, own their paths. */
  private holdsPaths(e: Entry) {
    return !TERMINAL.has(e.job.status) || e.stopping !== null;
  }

  private prunePlans() {
    const cutoff = this.now() - PLAN_TTL_MS;
    for (const [id, p] of this.plans) if (p.createdAt < cutoff) this.plans.delete(id);
  }

  private emitJob(id: string) {
    const e = this.entries.get(id);
    if (e) this.deps.hub.emit({ type: 'job', job: { ...e.job } });
  }
}
