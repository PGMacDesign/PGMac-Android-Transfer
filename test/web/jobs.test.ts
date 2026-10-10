import { describe, expect, it } from 'vitest';
import {
  canRetry,
  downloadRevealLabel,
  isActive,
  jobDetail,
  revealLabel,
  routeLabel,
  sourceTitle,
} from '../../src/web/jobs.ts';

describe('job labels', () => {
  it('names the route for every direction and origin', () => {
    expect(routeLabel({ direction: 'push', origin: 'pane' })).toBe('Mac → phone');
    expect(routeLabel({ direction: 'pull', origin: 'pane' })).toBe('Phone → Mac');
    expect(routeLabel({ direction: 'copy', origin: 'pane' })).toBe('Mac → Mac');
    expect(routeLabel({ direction: 'push', origin: 'finder' })).toBe('Finder → phone');
    expect(routeLabel({ direction: 'copy', origin: 'finder' })).toBe('Finder → Mac');
  });

  it('never shows the staging path of a Finder job', () => {
    expect(sourceTitle({ origin: 'finder', srcPath: '/Users/x/Library/Caches/s/1/a' })).toBe(
      'From Finder',
    );
    expect(sourceTitle({ origin: 'pane', srcPath: '/sdcard/a' })).toBe('/sdcard/a');
  });

  it('labels reveal by platform', () => {
    expect(revealLabel('darwin')).toBe('Show in Finder');
    expect(revealLabel('linux')).toBe('Show in Files');
    expect(revealLabel('other')).toBe('Show in Files');
    expect(downloadRevealLabel('darwin')).toBe('Download & Show in Finder');
    expect(downloadRevealLabel('linux')).toBe('Download & Show in Files');
  });

  it('says a Finder job is still reading from Finder, and that it waits for the phone', () => {
    const finder = { direction: 'push', origin: 'finder', destDir: '/sdcard/Download' } as const;
    expect(jobDetail({ ...finder, status: 'uploading' }, 'connected')).toBe(
      'Finder → phone · Reading from Finder',
    );
    expect(jobDetail({ ...finder, status: 'uploading' }, 'reconnecting')).toBe(
      'Finder → phone · Reading from Finder; sends when the phone is back',
    );
    // A Mac-to-Mac drop never needs the phone.
    expect(
      jobDetail(
        { ...finder, direction: 'copy', destDir: '/x', status: 'uploading' },
        'reconnecting',
      ),
    ).toBe('Finder → Mac · Reading from Finder');
    expect(jobDetail({ ...finder, status: 'running' }, 'connected')).toBe(
      'Finder → phone · /sdcard/Download',
    );
  });

  it('offers retry only for retryable failures', () => {
    expect(canRetry({ status: 'failed', retryable: true })).toBe(true);
    expect(canRetry({ status: 'failed', retryable: false })).toBe(false);
    expect(canRetry({ status: 'cancelled', retryable: true })).toBe(false);
  });

  it('counts uploading as active', () => {
    expect(isActive({ status: 'uploading' })).toBe(true);
    expect(isActive({ status: 'done' })).toBe(false);
  });
});
