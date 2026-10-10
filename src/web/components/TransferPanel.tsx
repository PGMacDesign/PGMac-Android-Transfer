import { useState } from 'react';
import type { Job, SessionState } from '../../shared/protocol.ts';
import { MAX_CONCURRENT_LIMIT } from '../../shared/protocol.ts';
import { fmtBytes, fmtEta, fmtSpeed, iconFor, plural } from '../format.ts';
import { canRetry, jobDetail, routeLabel, sourceTitle, waitingLabel } from '../jobs.ts';
import { baseName } from '../paths.ts';
import { Icon, Spinner } from './ui.tsx';

export interface TransferPanelProps {
  jobs: Job[];
  sessionState: SessionState;
  maxConcurrent: number;
  onSetParallel: (n: number) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClear: () => void;
}

/** Copy jobs never touch the phone, so a reconnect doesn't hold them up. */
export const waitsForDevice = (j: Job, sessionState: SessionState): boolean =>
  j.status === 'queued' && j.direction !== 'copy' && sessionState === 'reconnecting';

const isTerminal = (j: Job): boolean =>
  j.status === 'done' || j.status === 'failed' || j.status === 'cancelled';

export function summarize(jobs: Job[], sessionState: SessionState) {
  const reconnecting = sessionState === 'reconnecting';
  let running = 0;
  let preparing = 0;
  let queued = 0;
  let waiting = 0;
  let failed = 0;
  let done = 0;
  let total = 0;
  for (const j of jobs) {
    if (j.status === 'running') running++;
    else if (j.status === 'uploading') preparing++;
    else if (j.status === 'queued') {
      if (j.waitingFor || (reconnecting && j.direction !== 'copy')) waiting++;
      else queued++;
    } else if (j.status === 'failed') failed++;
    if (j.status !== 'failed' && j.status !== 'cancelled') {
      // Bytes read from Finder haven't reached the destination yet, and the transfer that
      // follows counts again from zero, so only its total counts here.
      if (j.status !== 'uploading') done += j.transferredBytes;
      total += j.totalBytes;
    }
  }
  let text: string;
  if (!jobs.length) text = 'No transfers';
  else if (running || queued || preparing) {
    const counts = `${running} active, ${queued} queued`;
    text = `${preparing ? `${preparing} reading from Finder, ` : ''}${counts} · ${fmtBytes(done)} of ${fmtBytes(total)}`;
  } else if (waiting) text = `${fmtBytes(done)} of ${fmtBytes(total)}`;
  else text = 'All transfers finished';
  return {
    running,
    preparing,
    queued,
    waiting,
    failed,
    text,
    pct: total ? (done / total) * 100 : 0,
  };
}

const RANK: Record<Job['status'], number> = {
  running: 0,
  uploading: 0,
  queued: 1,
  failed: 2,
  done: 3,
  cancelled: 3,
};

/** Active work first (in queue order), then failures, then finished jobs newest first. */
export function orderJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r) return r;
    if (RANK[a.status] < 2) return a.createdAt - b.createdAt;
    return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
  });
}

export function TransferPanel(props: TransferPanelProps) {
  const { jobs, sessionState } = props;
  const [open, setOpen] = useState(() => window.innerHeight >= 700);
  const [draft, setDraft] = useState<number | null>(null);
  const sum = summarize(jobs, sessionState);
  const parallel = draft ?? props.maxConcurrent;
  const hasTerminal = jobs.some(isTerminal);

  return (
    <div className="transfers" role="region" aria-label="Transfers">
      <div className="tp-head">
        <button className="tp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'expand_more' : 'chevron_right'} />
          Transfers
        </button>
        <div className="tp-summary">
          <span>{sum.text}</span>
          {sum.waiting ? <span className="waiting">· {sum.waiting} waiting for device</span> : null}
          {sum.failed ? <span className="failed">· {sum.failed} failed</span> : null}
        </div>
        <div className="bar tp-overall">
          <div style={{ width: `${sum.pct.toFixed(1)}%` }} />
        </div>
        <div className="spacer" />
        {open ? (
          <>
            <label className="tp-parallel">
              Parallel transfers
              <input
                type="range"
                min={1}
                max={MAX_CONCURRENT_LIMIT}
                step={1}
                value={parallel}
                aria-label="Parallel transfers"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setDraft(n);
                  props.onSetParallel(n);
                }}
                onPointerUp={() => setDraft(null)}
                onBlur={() => setDraft(null)}
              />
              <b>{parallel}</b>
            </label>
            <div className="tp-sep" />
            <button className="btn link" onClick={props.onClear} disabled={!hasTerminal}>
              Clear completed
            </button>
          </>
        ) : null}
      </div>
      {open ? (
        <div className="tp-list">
          {orderJobs(jobs).map((j) => (
            <JobRow
              key={j.id}
              job={j}
              waiting={waitsForDevice(j, sessionState)}
              waitText={waitingLabel(j, sessionState)}
              detail={jobDetail(j, sessionState)}
              onCancel={props.onCancel}
              onRetry={props.onRetry}
            />
          ))}
          {!jobs.length ? (
            <div className="tp-empty">
              No transfers yet. Drag files between the panes or in from Finder, or select them and
              press ⌘→ / ⌘←.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JobRow({
  job: j,
  waiting,
  waitText,
  detail,
  onCancel,
  onRetry,
}: {
  job: Job;
  /** Waiting for the device: nothing to cancel into, the job resumes on reconnect. */
  waiting: boolean;
  /** Why a queued job isn't starting (device or an offline network volume), if it isn't. */
  waitText: string | null;
  detail: string;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const pull = j.direction === 'pull';
  const copy = j.direction === 'copy';
  const route = routeLabel(j);
  const uploading = j.status === 'uploading';
  const pct = j.totalBytes
    ? Math.min(1, j.transferredBytes / j.totalBytes)
    : j.status === 'done'
      ? 1
      : 0;
  const statusCls = waitText ? 'waiting' : j.status;
  const name = j.destName || baseName(j.srcPath);
  const running = j.status === 'running';
  const moving = running || uploading;
  return (
    <div className={`job ${statusCls}`}>
      <div
        className={`job-dir${pull || copy ? ' pull' : ''}`}
        title={route.replace('→', 'to')}
        aria-label={route.replace('→', 'to')}
      >
        <Icon name={copy ? 'arrow_downward' : pull ? 'arrow_forward' : 'arrow_back'} />
      </div>
      <div className="job-name">
        <div className="line">
          <Icon
            name={iconFor(name, j.isDir)}
            fill={j.isDir}
            className={j.isDir ? 'folder-icon' : ''}
          />
          <span className="n" title={sourceTitle(j)}>
            {name}
          </span>
          {j.isDir ? <span className="items">{plural(j.itemCount, 'item')}</span> : null}
        </div>
        <div className={`sub${j.status === 'failed' ? ' err' : ''}`} title={j.error ?? j.destDir}>
          {j.status === 'failed' ? (j.error ?? 'Failed') : detail}
        </div>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${(pct * 100).toFixed(1)}%` }} />
      </div>
      <div className="stat">
        {j.status === 'queued'
          ? fmtBytes(j.totalBytes)
          : `${fmtBytes(j.transferredBytes)} / ${fmtBytes(j.totalBytes)}`}
      </div>
      <div className="stat speed">
        {moving && j.bytesPerSec > 0 ? fmtSpeed(j.bytesPerSec) : '–'}
      </div>
      <div className="stat eta">
        {uploading
          ? 'Reading'
          : running
            ? j.bytesPerSec > 0
              ? fmtEta((j.totalBytes - j.transferredBytes) / j.bytesPerSec)
              : '–'
            : j.status === 'queued' && !waitText
              ? 'Queued'
              : '–'}
      </div>
      <div className="job-actions">
        {waitText ? (
          <span className="waiting-label">
            <Spinner />
            {waitText}
          </span>
        ) : null}
        {!waiting && (moving || j.status === 'queued') ? (
          <button className="btn xs" aria-label={`Cancel ${name}`} onClick={() => onCancel(j.id)}>
            Cancel
          </button>
        ) : null}
        {canRetry(j) ? (
          <button className="btn primary xs" onClick={() => onRetry(j.id)}>
            <Icon name="replay" />
            Retry
          </button>
        ) : null}
        {j.status === 'done' ? (
          <span className="done-label">
            <Icon name="check_circle" fill />
            Done
          </span>
        ) : null}
        {j.status === 'cancelled' ? <span className="muted">Cancelled</span> : null}
      </div>
    </div>
  );
}
