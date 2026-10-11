import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adbCandidates, HOMEBREW_BINS, resolveAdbPath } from '../src/server/adb/adb.ts';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('adbCandidates', () => {
  it('orders explicit, PATH, Homebrew, ANDROID_HOME, ANDROID_SDK_ROOT, then the SDK folders', () => {
    const list = adbCandidates('/explicit/adb', {
      env: { PATH: '/p1:/p2', ANDROID_HOME: '/ah', ANDROID_SDK_ROOT: '/asr' },
      home: '/home/u',
      fixedBins: ['/brew1', '/brew2'],
    });
    expect(list).toEqual([
      '/explicit/adb',
      '/p1/adb',
      '/p2/adb',
      '/brew1/adb',
      '/brew2/adb',
      '/ah/platform-tools/adb',
      '/asr/platform-tools/adb',
      '/home/u/Library/Android/sdk/platform-tools/adb',
      '/home/u/Android/Sdk/platform-tools/adb',
    ]);
  });

  it('checks the Homebrew bin folders by default', () => {
    expect(HOMEBREW_BINS).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
    const list = adbCandidates(undefined, { env: { PATH: LAUNCHD_PATH }, home: '/home/u' });
    expect(list).toContain('/opt/homebrew/bin/adb');
    expect(list).toContain('/usr/local/bin/adb');
    expect(list.indexOf('/opt/homebrew/bin/adb')).toBeLessThan(list.indexOf('/usr/local/bin/adb'));
    expect(list.indexOf('/usr/local/bin/adb')).toBeLessThan(
      list.indexOf('/home/u/Library/Android/sdk/platform-tools/adb'),
    );
  });
});

describe('resolveAdbPath', () => {
  let root: string;
  let brew: string;
  let home: string;

  async function fakeAdb(dir: string, mode = 0o755): Promise<string> {
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'adb');
    await writeFile(p, '#!/bin/sh\n');
    await chmod(p, mode);
    return p;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'adbpath-'));
    brew = path.join(root, 'homebrew', 'bin');
    home = path.join(root, 'home');
    await mkdir(home);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds Homebrew's adb with launchd's PATH and no ANDROID_HOME", async () => {
    const brewAdb = await fakeAdb(brew);
    const found = await resolveAdbPath(undefined, {
      env: { PATH: LAUNCHD_PATH },
      home,
      fixedBins: [brew],
    });
    expect(found).toBe(brewAdb);
  });

  it('prefers the explicit path over the Homebrew candidate', async () => {
    await fakeAdb(brew);
    const explicit = await fakeAdb(path.join(root, 'explicit'));
    const found = await resolveAdbPath(explicit, {
      env: { PATH: LAUNCHD_PATH },
      home,
      fixedBins: [brew],
    });
    expect(found).toBe(explicit);
  });

  it('prefers an adb on PATH over the Homebrew candidate', async () => {
    await fakeAdb(brew);
    const onPath = await fakeAdb(path.join(root, 'onpath'));
    const found = await resolveAdbPath(undefined, {
      env: { PATH: `${path.dirname(onPath)}:${LAUNCHD_PATH}` },
      home,
      fixedBins: [brew],
    });
    expect(found).toBe(onPath);
  });

  it('prefers the Homebrew candidate over ANDROID_HOME', async () => {
    const brewAdb = await fakeAdb(brew);
    const sdk = path.join(root, 'sdk');
    await fakeAdb(path.join(sdk, 'platform-tools'));
    const found = await resolveAdbPath(undefined, {
      env: { PATH: LAUNCHD_PATH, ANDROID_HOME: sdk },
      home,
      fixedBins: [brew],
    });
    expect(found).toBe(brewAdb);
  });

  it('skips a non-executable file and falls through to the next candidate', async () => {
    await fakeAdb(brew, 0o644);
    const sdkAdb = await fakeAdb(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
    const found = await resolveAdbPath(undefined, {
      env: { PATH: LAUNCHD_PATH },
      home,
      fixedBins: [brew],
    });
    expect(found).toBe(sdkAdb);
  });

  it('returns null when no candidate is executable', async () => {
    await fakeAdb(brew, 0o644);
    const found = await resolveAdbPath(path.join(root, 'missing', 'adb'), {
      env: { PATH: '' },
      home,
      fixedBins: [brew],
    });
    expect(found).toBeNull();
  });
});
