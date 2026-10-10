import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VolumeMonitor,
  isOfflineError,
  makeProbe,
  parseDarwinMounts,
  parseLinuxMounts,
  sourceKey,
  type Mount,
  type VolumeEvent,
} from '../src/server/fs/volumes.ts';

const DARWIN = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
//Alex@nas.local/Share on /Volumes/Share (smbfs, nodev, nosuid, mounted by me)
nas.local:/volume1/Share on /opt/nas (nfs, nodev, nosuid, read-only, automounted)
//me@host/My Share on /Volumes/My Share (smbfs, nodev)`;

describe('mount table parsing', () => {
  it('reads macOS mount output, including spaces', () => {
    const m = parseDarwinMounts(DARWIN);
    expect(m.find((x) => x.mountPoint === '/Volumes/Share')).toEqual({
      source: '//Alex@nas.local/Share',
      mountPoint: '/Volumes/Share',
      type: 'smbfs',
    });
    expect(m.find((x) => x.type === 'nfs')!.mountPoint).toBe('/opt/nas');
    expect(m.find((x) => x.source === '//me@host/My Share')!.mountPoint).toBe('/Volumes/My Share');
  });

  it('reads /proc/self/mounts with octal escapes', () => {
    const m = parseLinuxMounts(
      '//nas/share /mnt/my\\040nas cifs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n',
    );
    expect(m[0]).toEqual({ source: '//nas/share', mountPoint: '/mnt/my nas', type: 'cifs' });
  });

  it('identifies a share across remounts regardless of the user part', () => {
    expect(sourceKey('//Alex@nas.local/Share')).toBe(sourceKey('//alex@nas.local/Share'));
    expect(sourceKey('//NAS.local/Share')).toBe('//nas.local/Share');
    expect(sourceKey('Host:/volume1/x')).toBe('host:/volume1/x');
  });
});

const NAS: Mount = { source: '//me@nas/Share', mountPoint: '/Volumes/Share', type: 'smbfs' };

function monitor(opts: { mounts?: Mount[]; probe?: boolean } = {}) {
  let mounts = opts.mounts ?? [NAS];
  let probeOk = opts.probe ?? true;
  const events: VolumeEvent[] = [];
  const m = new VolumeMonitor({
    readMounts: async () => mounts,
    probe: async () => probeOk,
    probeEveryMs: 5000,
    callTimeoutMs: 1000,
  });
  m.onEvent((e) => events.push(e));
  return {
    m,
    events,
    setMounts: (x: Mount[]) => (mounts = x),
    setProbe: (ok: boolean) => (probeOk = ok),
  };
}

const never = () => new Promise<never>(() => undefined);
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('VolumeMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves local paths alone', async () => {
    const t = monitor();
    await t.m.start();
    await expect(t.m.guard('/Users/me/a', async () => 1)).resolves.toBe(1);
    expect(t.m.volumeOf('/Volumes/ShareX/a')).toBeNull();
    t.m.stop();
  });

  it('lets a slow call finish while the share still answers', async () => {
    const t = monitor();
    await t.m.start();
    const slow = t.m.guard(
      '/Volumes/Share/huge',
      () => new Promise<string>((r) => setTimeout(() => r('listed'), 3500)),
    );
    await vi.advanceTimersByTimeAsync(3500);
    await expect(slow).resolves.toBe('listed');
    expect(t.m.offlineList()).toEqual([]);
    t.m.stop();
  });

  it('prefers the new mount point over a stale one still in the table', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    await t.m.check('/Volumes/Share/a');
    const fresh = { ...NAS, mountPoint: '/Volumes/Share-1' };
    t.setMounts([NAS, fresh]);
    const probed: string[] = [];
    // Only the fresh mount answers; the stale one would hang.
    (t.m as unknown as { deps: { probe: (mp: string) => Promise<boolean> } }).deps.probe = async (
      mp: string,
    ) => {
      probed.push(mp);
      return mp === '/Volumes/Share-1';
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(probed[0]).toBe('/Volumes/Share-1');
    expect(t.events.at(-1)).toEqual({ type: 'online', mountPoint: '/Volumes/Share-1' });
    t.m.stop();
  });

  it('marks a volume offline when a call hangs, then fails fast without calling', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    const hung = t.m.guard('/Volumes/Share/a', never);
    const settled = expect(hung).rejects.toSatisfy(isOfflineError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(t.events).toEqual([{ type: 'offline', mountPoint: '/Volumes/Share' }]);
    const fn = vi.fn(never);
    await expect(t.m.guard('/Volumes/Share/b', fn)).rejects.toSatisfy(isOfflineError);
    expect(fn).not.toHaveBeenCalled();
    expect(t.m.offlineFor('/Volumes/Share/b')!.name).toBe('Share');
    t.m.stop();
  });

  it('treats network errors as offline but ordinary errors as errors', async () => {
    const t = monitor();
    await t.m.start();
    await expect(
      t.m.guard('/Volumes/Share/a', async () => Promise.reject(errno('EACCES'))),
    ).rejects.toThrow('EACCES');
    await expect(
      t.m.guard('/Volumes/Share/a', async () => Promise.reject(errno('ENOENT'))),
    ).rejects.toThrow('ENOENT');
    expect(t.m.offlineList()).toEqual([]);
    await expect(
      t.m.guard('/Volumes/Share/a', async () => Promise.reject(errno('EHOSTDOWN'))),
    ).rejects.toSatisfy(isOfflineError);
    t.m.stop();
  });

  it('treats a missing file as offline when the share was unmounted', async () => {
    const t = monitor();
    await t.m.start();
    t.setMounts([]);
    await expect(
      t.m.guard('/Volumes/Share/a', async () => Promise.reject(errno('ENOENT'))),
    ).rejects.toSatisfy(isOfflineError);
    t.m.stop();
  });

  it('treats a share that vanished from the mount table as offline, not local', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    t.setMounts([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.events).toContainEqual({ type: 'offline', mountPoint: '/Volumes/Share' });
    await expect(t.m.guard('/Volumes/Share/a', async () => 1)).rejects.toSatisfy(isOfflineError);
    t.m.stop();
  });

  it('comes back online when the probe answers', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    expect(await t.m.check('/Volumes/Share/a')).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.m.offlineList()).toHaveLength(1);
    t.setProbe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.m.offlineList()).toEqual([]);
    expect(t.events.at(-1)).toEqual({ type: 'online', mountPoint: '/Volumes/Share' });
    t.m.stop();
  });

  it('follows a share that comes back at a new mount point', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    await t.m.check('/Volumes/Share/a');
    t.setMounts([{ ...NAS, source: '//ME@nas/Share', mountPoint: '/Volumes/Share-1' }]);
    t.setProbe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.events.slice(1)).toEqual([
      { type: 'moved', from: '/Volumes/Share', to: '/Volumes/Share-1' },
      { type: 'online', mountPoint: '/Volumes/Share-1' },
    ]);
    t.m.stop();
  });

  // After Share drops and returns as Share-1, with the dead Share still in the table.
  const remounted = async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    await t.m.check('/Volumes/Share/a');
    const live = { ...NAS, mountPoint: '/Volumes/Share-1' };
    t.setMounts([NAS, live]);
    t.setProbe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.events.at(-1)).toEqual({ type: 'online', mountPoint: '/Volumes/Share-1' });
    t.events.length = 0;
    return { ...t, live };
  };

  it('never lets the stale mount leaving the table take the live one offline', async () => {
    const t = await remounted();
    t.setMounts([t.live]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.events).toEqual([]);
    expect(await t.m.guard('/Volumes/Share-1/big.mov', async () => 'ok')).toBe('ok');
    t.m.stop();
  });

  it('fails calls on the stale path fast, without touching it or the live mount', async () => {
    const t = await remounted();
    let called = false;
    const stale = t.m.guard('/Volumes/Share/Downloads', async () => {
      called = true;
      return never();
    });
    await expect(stale).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(called).toBe(false);
    expect(t.events).toEqual([]);
    expect(await t.m.guard('/Volumes/Share-1/big.mov', async () => 'ok')).toBe('ok');
    // Gone from the table, the old path still doesn't count as local.
    t.setMounts([t.live]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(t.m.guard('/Volumes/Share/x', async () => 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    t.m.stop();
  });

  it('treats a fresh mount at a retired mount point as live', async () => {
    const t = await remounted();
    t.setMounts([t.live, { source: '//nas/Other', mountPoint: '/Volumes/Share', type: 'smbfs' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await t.m.guard('/Volumes/Share/a', async () => 'ok')).toBe('ok');
    t.m.stop();
  });

  // Both mounts of one share in the table; `alive` says which answer.
  const twoMounts = (start: Mount[], alive: Set<string>) => {
    let mounts = start;
    const events: VolumeEvent[] = [];
    const m = new VolumeMonitor({
      readMounts: async () => mounts,
      probe: async (mp) => alive.has(mp),
      probeEveryMs: 5000,
      callTimeoutMs: 1000,
    });
    m.onEvent((e) => events.push(e));
    return { m, events, setMounts: (x: Mount[]) => (mounts = x) };
  };
  const LIVE: Mount = { ...NAS, mountPoint: '/Volumes/Share-1' };

  for (const [name, start] of [
    ['reconnected in Finder while the app was idle', [NAS]],
    ['already doubled when the app started', [NAS, LIVE]],
  ] as const) {
    it(`a stale mount leaving the table moves the share instead (${name})`, async () => {
      const t = twoMounts([...start], new Set([LIVE.mountPoint]));
      await t.m.start();
      t.setMounts([NAS, LIVE]);
      await vi.advanceTimersByTimeAsync(10_000);
      t.setMounts([LIVE]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.events).toEqual([
        { type: 'moved', from: '/Volumes/Share', to: '/Volumes/Share-1' },
        { type: 'online', mountPoint: '/Volumes/Share-1' },
      ]);
      expect(await t.m.guard('/Volumes/Share-1/big.mov', async () => 'ok')).toBe('ok');
      t.m.stop();
    });
  }

  it('a hung call on the stale mount moves the share when the other mount answers', async () => {
    const t = twoMounts([NAS, LIVE], new Set([LIVE.mountPoint]));
    await t.m.start();
    const stale = t.m.guard('/Volumes/Share/Downloads', never);
    const settled = expect(stale).rejects.toSatisfy(isOfflineError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(t.events).toEqual([
      { type: 'moved', from: '/Volumes/Share', to: '/Volumes/Share-1' },
      { type: 'online', mountPoint: '/Volumes/Share-1' },
    ]);
    expect(await t.m.guard('/Volumes/Share-1/big.mov', async () => 'ok')).toBe('ok');
    t.m.stop();
  });

  it('a hung call takes the share offline when its other mount is dead too', async () => {
    const t = twoMounts([NAS, LIVE], new Set());
    await t.m.start();
    const call = t.m.guard('/Volumes/Share-1/big.mov', never);
    const settled = expect(call).rejects.toSatisfy(isOfflineError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(t.events).toEqual([{ type: 'offline', mountPoint: '/Volumes/Share-1' }]);
    t.m.stop();
  });

  it("points a twice-moved share's oldest path at where it is now", async () => {
    const t = twoMounts([NAS], new Set(['/Volumes/Share-2']));
    await t.m.start();
    t.setMounts([NAS, LIVE]);
    await vi.advanceTimersByTimeAsync(10_000);
    t.setMounts([LIVE]);
    await vi.advanceTimersByTimeAsync(10_000);
    t.setMounts([LIVE, { ...NAS, mountPoint: '/Volumes/Share-2' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    t.setMounts([{ ...NAS, mountPoint: '/Volumes/Share-2' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(t.m.guard('/Volumes/Share/x', async () => 1)).rejects.toThrow('/Volumes/Share-2');
    t.m.stop();
  });

  it('wakes an automounted share that left the table while idle', async () => {
    const share: Mount = {
      source: 'nas.local:/volume1/Share',
      mountPoint: '/opt/nas',
      type: 'nfs',
    };
    let mounts: Mount[] = [share];
    const probed: string[] = [];
    const events: VolumeEvent[] = [];
    const m = new VolumeMonitor({
      readMounts: async () => mounts,
      // Touching the path is what makes autofs mount it again.
      probe: async (mp) => {
        probed.push(mp);
        mounts = [share];
        return true;
      },
      probeEveryMs: 5000,
    });
    m.onEvent((e) => events.push(e));
    await m.start();
    mounts = [];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([{ type: 'offline', mountPoint: '/opt/nas' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(probed).toContain('/opt/nas');
    expect(events.at(-1)).toEqual({ type: 'online', mountPoint: '/opt/nas' });
    expect(await m.guard('/opt/nas/photos', async () => 'ok')).toBe('ok');
    m.stop();
  });

  it('gives up once after 30 minutes and keeps probing (liveness)', async () => {
    const t = monitor({ probe: false });
    await t.m.start();
    await t.m.check('/Volumes/Share/a');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(t.events.some((e) => e.type === 'gaveUp')).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.events.filter((e) => e.type === 'gaveUp')).toHaveLength(1);
    t.setProbe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.events.at(-1)!.type).toBe('online');
    t.m.stop();
  });
});

describe('makeProbe', () => {
  it('answers for a real folder and refuses a missing one', async () => {
    const probe = makeProbe();
    expect(await probe(os.tmpdir(), 5000)).toBe(true);
    expect(await probe('/nonexistent-pgmac-probe', 5000)).toBe(false);
  });

  it('shares one in-flight probe between callers', async () => {
    const probe = makeProbe();
    const a = probe(os.tmpdir(), 5000);
    expect(probe(os.tmpdir(), 5000)).toBe(a);
    await a;
  });
});
