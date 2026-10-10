import { describe, expect, it } from 'vitest';
import { RequestError } from '../../src/web/api.ts';
import { isNoTrash, noTrashConfirm } from '../../src/web/deletes.ts';
import { waitingLabel } from '../../src/web/jobs.ts';
import {
  isUnder,
  offlineBannerText,
  offlineVolumeFor,
  remapPath,
  volumeNameFromPath,
} from '../../src/web/volumes.ts';

describe('remapPath', () => {
  it('moves paths under the old mount point and nothing else', () => {
    expect(remapPath('/Volumes/A', '/Volumes/A', '/Volumes/A-1')).toBe('/Volumes/A-1');
    expect(remapPath('/Volumes/A/x/y', '/Volumes/A', '/Volumes/A-1')).toBe('/Volumes/A-1/x/y');
    expect(remapPath('/Volumes/AB/x', '/Volumes/A', '/Volumes/A-1')).toBe('/Volumes/AB/x');
    expect(remapPath('/Users/pat', '/Volumes/A', '/Volumes/A-1')).toBe('/Users/pat');
  });

  it('isUnder is segment-aware', () => {
    expect(isUnder('/Volumes/A', '/Volumes/A')).toBe(true);
    expect(isUnder('/Volumes/A/b', '/Volumes/A')).toBe(true);
    expect(isUnder('/Volumes/AB', '/Volumes/A')).toBe(false);
  });
});

describe('offline banner', () => {
  const vols = [{ mountPoint: '/Volumes/Share', name: 'Share', since: 1, giveUpAt: 2 }];

  it('finds the offline volume a path is on', () => {
    expect(offlineVolumeFor('/Volumes/Share/Photos', vols)?.name).toBe('Share');
    expect(offlineVolumeFor('/Volumes/Share2', vols)).toBeNull();
    expect(offlineVolumeFor('/Users/pat', vols)).toBeNull();
  });

  it('names a share from its path when the volumes event has not arrived', () => {
    expect(volumeNameFromPath('/Volumes/Share/Photos/2024')).toBe('Share');
    expect(volumeNameFromPath('/mnt/nas/share')).toBe('share');
  });

  it('reads as a waiting state, not an error', () => {
    expect(offlineBannerText('Share')).toBe('Share is offline, waiting for it to reconnect');
  });
});

describe('waitingLabel', () => {
  it('names the volume a queued job waits for', () => {
    expect(
      waitingLabel({ status: 'queued', direction: 'pull', waitingFor: 'Share' }, 'connected'),
    ).toBe('Waiting for Share');
  });

  it('waits for the device only for jobs that need it, while reconnecting', () => {
    expect(
      waitingLabel({ status: 'queued', direction: 'push', waitingFor: null }, 'reconnecting'),
    ).toBe('Waiting for device');
    expect(
      waitingLabel({ status: 'queued', direction: 'copy', waitingFor: null }, 'reconnecting'),
    ).toBeNull();
    expect(
      waitingLabel({ status: 'queued', direction: 'push', waitingFor: null }, 'connected'),
    ).toBeNull();
    expect(
      waitingLabel({ status: 'running', direction: 'pull', waitingFor: 'Share' }, 'connected'),
    ).toBeNull();
  });
});

describe('NO_TRASH', () => {
  it('recognizes only the NO_TRASH error', () => {
    expect(isNoTrash(new RequestError('no trash', 409, 'NO_TRASH'))).toBe(true);
    expect(isNoTrash(new RequestError('busy', 409, 'BUSY_PATH'))).toBe(false);
    expect(isNoTrash(new Error('x'))).toBe(false);
  });

  it('asks for a permanent delete with Cancel focused', () => {
    const spec = noTrashConfirm('“a.txt”');
    expect(spec.title).toBe(
      "“a.txt” can't be moved to the Trash on this volume. Delete permanently?",
    );
    expect(spec).toMatchObject({ danger: true, destructiveButton: true });
  });
});
