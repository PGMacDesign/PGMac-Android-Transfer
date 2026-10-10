import type { OfflineVolume } from '../shared/protocol.ts';

/** True when `p` is `root` or inside it; `/Volumes/A` does not contain `/Volumes/AB`. */
export const isUnder = (p: string, root: string): boolean =>
  p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Rewrites `p` from a volume's old mount point to its new one; other paths pass through. */
export function remapPath(p: string, from: string, to: string): string {
  if (!isUnder(p, from)) return p;
  return to + p.slice(from.length);
}

export function offlineVolumeFor(
  p: string,
  volumes: readonly OfflineVolume[],
): OfflineVolume | null {
  return volumes.find((v) => isUnder(p, v.mountPoint)) ?? null;
}

/**
 * Name for the offline banner when a listing failed with OFFLINE before the `volumes` event
 * arrived: the share's folder under /Volumes, or the last path segment elsewhere.
 */
export function volumeNameFromPath(p: string): string {
  const m = /^\/Volumes\/([^/]+)/.exec(p);
  if (m) return m[1]!;
  return p.split('/').filter(Boolean).pop() ?? p;
}

export const offlineBannerText = (name: string): string =>
  `${name} is offline, waiting for it to reconnect`;
