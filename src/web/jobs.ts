import type { Job, Platform, SessionState } from '../shared/protocol.ts';

/** "Show in Finder" on macOS; Linux file managers aren't called Finder. */
export const revealLabel = (platform: Platform): string =>
  platform === 'darwin' ? 'Show in Finder' : 'Show in Files';

/** Phone items have to be copied to the downloads folder before they can be shown. */
export const downloadRevealLabel = (platform: Platform): string =>
  `Download & ${revealLabel(platform)}`;

/** Where a job's bytes come from and go to, e.g. "Finder → phone". */
export function routeLabel(job: Pick<Job, 'direction' | 'origin'>): string {
  const to = job.direction === 'push' ? 'phone' : 'Mac';
  if (job.origin === 'finder') return `Finder → ${to}`;
  if (job.direction === 'pull') return 'Phone → Mac';
  return job.direction === 'copy' ? 'Mac → Mac' : 'Mac → phone';
}

/**
 * Second line of a job row. A Finder job first reads the dropped files onto this Mac, which
 * needs no device, so that phase says so instead of looking like bytes reaching the phone.
 */
export function jobDetail(
  job: Pick<Job, 'direction' | 'origin' | 'status' | 'destDir'>,
  sessionState: SessionState,
): string {
  const route = routeLabel(job);
  if (job.status !== 'uploading') return `${route} · ${job.destDir}`;
  if (job.direction !== 'copy' && sessionState === 'reconnecting') {
    return `${route} · Reading from Finder; sends when the phone is back`;
  }
  return `${route} · Reading from Finder`;
}

/** Hover text for a job's name. A Finder job's srcPath is the server's staging copy. */
export const sourceTitle = (job: Pick<Job, 'origin' | 'srcPath'>): string =>
  job.origin === 'finder' ? 'From Finder' : job.srcPath;

export const isActive = (job: Pick<Job, 'status'>): boolean =>
  job.status === 'running' || job.status === 'queued' || job.status === 'uploading';

export const canRetry = (job: Pick<Job, 'status' | 'retryable'>): boolean =>
  job.status === 'failed' && job.retryable;

/**
 * Why a queued job isn't starting, or null. A network volume wait names the share; a device
 * wait applies only to jobs that need the phone while the session reconnects.
 */
export function waitingLabel(
  job: Pick<Job, 'status' | 'direction' | 'waitingFor'>,
  sessionState: SessionState,
): string | null {
  if (job.status !== 'queued') return null;
  if (job.waitingFor) return `Waiting for ${job.waitingFor}`;
  if (job.direction !== 'copy' && sessionState === 'reconnecting') return 'Waiting for device';
  return null;
}
