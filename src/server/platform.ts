import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Platform } from '../shared/protocol.ts';

const run = promisify(execFile);

export const currentPlatform = (): Platform =>
  process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'other';

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * Where Show in Finder copies Android items unless the user picks another folder. On Linux
 * the desktop's own Downloads folder can be renamed or translated, so ask xdg-user-dir first.
 */
export async function defaultDownloadsDir(platform: Platform, home: string): Promise<string> {
  if (platform === 'linux') {
    const xdg = await run('xdg-user-dir', ['DOWNLOAD'], { timeout: 3000 }).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    // xdg-user-dir prints the home folder when DOWNLOAD isn't configured.
    if (xdg && xdg !== home && (await isDir(xdg))) return xdg;
  }
  const downloads = path.join(home, 'Downloads');
  return (await isDir(downloads)) ? downloads : home;
}

/** Private, per-user cache folder for staged Finder uploads. */
export function defaultStagingRoot(platform: Platform, env: NodeJS.ProcessEnv = process.env) {
  const home = os.homedir();
  const cache =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(cache, 'pgmac-transfer', 'staging');
}
