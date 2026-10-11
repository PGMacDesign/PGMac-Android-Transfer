import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { buildApp, type App } from '../src/server/app.ts';
import { effectiveSettings, loadConfig, type Config } from '../src/server/config.ts';
import { StateStore, defaultStateFile, openStateStore } from '../src/server/stateStore.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';
import { RequestError } from '../src/web/api.ts';
import { fieldForError } from '../src/web/settingsForm.ts';
import { FakeRunner } from './helpers.ts';

const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

describe('effectiveSettings', () => {
  const env = { defaultDeviceIp: '10.0.0.2', adbPath: '/env/adb' };
  const none = { defaultDeviceIp: null, adbPath: undefined };
  const saved = { defaultDeviceIp: '10.0.0.9', adbPath: '/saved/adb' };
  const unsaved = { defaultDeviceIp: null, adbPath: null };

  it.each([
    ['saved beats env', saved, env, { defaultDeviceIp: '10.0.0.9', adbPath: '/saved/adb' }],
    ['saved without env', saved, none, { defaultDeviceIp: '10.0.0.9', adbPath: '/saved/adb' }],
    ['env without saved', unsaved, env, { defaultDeviceIp: '10.0.0.2', adbPath: '/env/adb' }],
    ['default without either', unsaved, none, { defaultDeviceIp: null, adbPath: undefined }],
  ])('%s', (_name, s, e, expected) => {
    expect(effectiveSettings(s, e)).toEqual(expected);
  });

  it('decides each field on its own', () => {
    expect(effectiveSettings({ defaultDeviceIp: '10.0.0.9', adbPath: null }, env)).toEqual({
      defaultDeviceIp: '10.0.0.9',
      adbPath: '/env/adb',
    });
    expect(effectiveSettings({ defaultDeviceIp: null, adbPath: '/saved/adb' }, none)).toEqual({
      defaultDeviceIp: null,
      adbPath: '/saved/adb',
    });
  });
});

describe('loadConfig', () => {
  const root = path.join(os.tmpdir(), 'pgmac-no-such-root');

  it('reads .env-style values as before, with no state folder', () => {
    const env = {
      PORT: '5000',
      DEFAULT_DEVICE_IP: ' 192.168.1.20 ',
      MAX_CONCURRENT_TRANSFERS: '2',
      ADB_PATH: '/opt/adb',
      OPEN_BROWSER: 'false',
    };
    expect(loadConfig(root, env)).toEqual({
      port: 5000,
      defaultDeviceIp: '192.168.1.20',
      maxConcurrent: 2,
      adbPath: '/opt/adb',
      openBrowser: false,
      stateDir: null,
    });
    const config = loadConfig(root, env);
    // No saved settings: the effective values are exactly the environment's.
    expect(effectiveSettings({ defaultDeviceIp: null, adbPath: null }, config)).toEqual({
      defaultDeviceIp: '192.168.1.20',
      adbPath: '/opt/adb',
    });
  });

  it('resolves STATE_DIR to an absolute folder', () => {
    expect(loadConfig(root, { STATE_DIR: '/data/state' }).stateDir).toBe('/data/state');
    expect(loadConfig(root, { STATE_DIR: 'rel' }).stateDir).toBe(path.resolve('rel'));
    expect(loadConfig(root, { STATE_DIR: '  ' }).stateDir).toBeNull();
  });
});

describe('StateStore', () => {
  it('uses the default file without STATE_DIR and <STATE_DIR>/state.json with it', async () => {
    const home = await tmp('pgmac-home-');
    const dir = await tmp('pgmac-state-');
    const store = openStateStore(null, home);
    await store.setAdbPath('/a/adb');
    expect(JSON.parse(await readFile(defaultStateFile(home), 'utf8')).adbPath).toBe('/a/adb');
    const moved = openStateStore(dir, home);
    await moved.load();
    await moved.setDefaultDeviceIp('10.0.0.3');
    expect(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))).toMatchObject({
      adbPath: '/a/adb',
      defaultDeviceIp: '10.0.0.3',
    });
  });

  it('saves and reloads both fields, and forgets them when cleared', async () => {
    const dir = await tmp('pgmac-state-');
    const home = await tmp('pgmac-home-');
    const store = openStateStore(dir, home);
    await store.load();
    expect(store.defaultDeviceIp).toBeNull();
    expect(store.adbPath).toBeNull();
    await store.setDefaultDeviceIp('pixel.local');
    await store.setAdbPath('/opt/adb');
    const again = openStateStore(dir, home);
    await again.load();
    expect(again.defaultDeviceIp).toBe('pixel.local');
    expect(again.adbPath).toBe('/opt/adb');
    await again.setDefaultDeviceIp(null);
    await again.setAdbPath(null);
    const third = openStateStore(dir, home);
    await third.load();
    expect(third.defaultDeviceIp).toBeNull();
    expect(third.adbPath).toBeNull();
  });

  it('imports the old state file once, leaving it untouched', async () => {
    const home = await tmp('pgmac-home-');
    const dir = path.join(await tmp('pgmac-state-'), 'nested');
    const old = defaultStateFile(home);
    const oldText = JSON.stringify({
      downloadsDir: '/Users/x/Downloads',
      lastUsed: { serial: 'a:1', host: 'a', model: 'Pixel' },
    });
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, oldText);

    const store = openStateStore(dir, home);
    await store.load();
    expect(store.downloadsDir).toBe('/Users/x/Downloads');
    expect(store.lastUsed?.model).toBe('Pixel');
    await store.setDownloadsDir('/new');
    expect(await readFile(old, 'utf8')).toBe(oldText);

    // The new file now exists, so a later start keeps it rather than importing again.
    const later = openStateStore(dir, home);
    await later.load();
    expect(later.downloadsDir).toBe('/new');
  });

  it('never overwrites an existing file in STATE_DIR', async () => {
    const home = await tmp('pgmac-home-');
    const dir = await tmp('pgmac-state-');
    await mkdir(path.dirname(defaultStateFile(home)), { recursive: true });
    await writeFile(defaultStateFile(home), JSON.stringify({ downloadsDir: '/old' }));
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ downloadsDir: '/mine' }));
    const store = openStateStore(dir, home);
    await store.load();
    expect(store.downloadsDir).toBe('/mine');
  });

  it('starts empty when there is nothing to import', async () => {
    const store = openStateStore(await tmp('pgmac-state-'), await tmp('pgmac-home-'));
    await store.load();
    expect(store.downloadsDir).toBeNull();
    expect(store.lastUsed).toBeNull();
  });
});

describe('POST /api/settings', () => {
  const PORT = 4996;
  const H = { host: `127.0.0.1:${PORT}` };
  let app: App | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const script = async (dir: string, name: string, body: string, mode = 0o755) => {
    const p = path.join(dir, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`);
    await chmod(p, mode);
    return p;
  };

  /** A started app whose adb discovery returns the effective path as-is. */
  async function start(env: Partial<Config> = {}, store?: StateStore) {
    const home = await tmp('pgmac-home-');
    const resolved: (string | undefined)[] = [];
    app = await buildApp({
      config: {
        port: PORT,
        defaultDeviceIp: null,
        maxConcurrent: 3,
        adbPath: undefined,
        openBrowser: false,
        stateDir: null,
        ...env,
      },
      home,
      store: store ?? new StateStore(path.join(home, 'state.json')),
      runner: new FakeRunner(),
      resolveAdb: async (explicit) => {
        resolved.push(explicit);
        return explicit ?? null;
      },
      stagingRoot: path.join(home, 'staging'),
      reveal: () => undefined,
    });
    const messages: ServerMessage[] = [];
    // injectWS never answers until the server's plugins are loaded.
    await app.server.ready();
    const ws: WebSocket = await app.server.injectWS('/ws', { headers: H });
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    const adbs = {
      good: await script(
        home,
        'adb',
        'echo "Android Debug Bridge version 1.0.41"\necho "Version 35.0.2"',
      ),
      failing: await script(home, 'adb-fail', 'exit 1'),
      plain: await script(home, 'adb-plain', 'exit 0', 0o644),
    };
    const post = (payload: object) =>
      app!.server.inject({ method: 'POST', url: '/api/settings', headers: H, payload });
    const snapshot = async () =>
      (await app!.server.inject({ url: '/api/snapshot', headers: H })).json();
    // The session reads it at each Start Session; checking the getter avoids a real discovery.
    const sessionIp = () =>
      (Reflect.get(app!.session, 'deps') as { defaultIp: () => string | null }).defaultIp();
    const settled = () => new Promise((r) => setTimeout(r, 20));
    return { home, store, resolved, messages, adbs, post, snapshot, sessionIp, settled, ws };
  }

  it('saves, applies and clears the default device IP', async () => {
    const t = await start({ defaultDeviceIp: '10.0.0.2' });
    expect(t.sessionIp()).toBe('10.0.0.2');
    expect((await t.snapshot()).settings.defaultDeviceIp).toBeNull();

    const r = await t.post({ defaultDeviceIp: ' 192.168.1.20 ' });
    expect(r.statusCode).toBe(200);
    expect(r.json().defaultDeviceIp).toBe('192.168.1.20');
    expect(t.sessionIp()).toBe('192.168.1.20');
    await t.settled();
    const last = t.messages.filter((m) => m.type === 'settings').at(-1);
    expect(last).toMatchObject({ settings: { defaultDeviceIp: '192.168.1.20' } });

    expect((await t.post({ defaultDeviceIp: 'pixel-7.local' })).json().defaultDeviceIp).toBe(
      'pixel-7.local',
    );

    const cleared = await t.post({ defaultDeviceIp: '' });
    expect(cleared.json().defaultDeviceIp).toBeNull();
    expect(t.sessionIp()).toBe('10.0.0.2');
  });

  it.each(['999.1.1.1', 'not an ip', '192.168.1.20:5555', 'a..b', '-x.local', 42])(
    'rejects %j as a device IP without changing it',
    async (bad) => {
      const t = await start();
      await t.post({ defaultDeviceIp: '10.0.0.5' });
      const r = await t.post({ defaultDeviceIp: bad, maxConcurrent: 1 });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('Enter an IP address like 192.168.1.20.');
      const s = (await t.snapshot()).settings;
      expect(s.defaultDeviceIp).toBe('10.0.0.5');
      expect(s.maxConcurrent).toBe(3);
      expect(t.sessionIp()).toBe('10.0.0.5');
    },
  );

  it('uses a working adb at once and broadcasts it, and falls back to ADB_PATH when cleared', async () => {
    const t = await start({ adbPath: '/env/adb' });
    expect(t.resolved).toEqual(['/env/adb']);
    expect((await t.snapshot()).adb.path).toBe('/env/adb');

    const r = await t.post({ adbPath: t.adbs.good });
    expect(r.statusCode).toBe(200);
    expect(r.json().adbPath).toBe(t.adbs.good);
    await t.settled();
    const adbEvent = t.messages.filter((m) => m.type === 'adb').at(-1);
    expect(adbEvent).toMatchObject({
      adb: { found: true, path: t.adbs.good, version: '35.0.2' },
    });
    expect(t.messages.some((m) => m.type === 'settings')).toBe(true);
    expect((await t.snapshot()).adb.path).toBe(t.adbs.good);
    const saved = JSON.parse(await readFile(path.join(t.home, 'state.json'), 'utf8'));
    expect(saved.adbPath).toBe(t.adbs.good);

    const cleared = await t.post({ adbPath: '' });
    expect(cleared.json().adbPath).toBeNull();
    expect(t.resolved.at(-1)).toBe('/env/adb');
    expect((await t.snapshot()).adb.path).toBe('/env/adb');
  });

  it('prefers a saved adb path and default IP over the environment at startup', async () => {
    const home = await tmp('pgmac-home-');
    const store = new StateStore(path.join(home, 'state.json'));
    await store.setAdbPath('/saved/adb');
    await store.setDefaultDeviceIp('10.0.0.9');
    const t = await start({ adbPath: '/env/adb', defaultDeviceIp: '10.0.0.2' }, store);
    expect(t.resolved).toEqual(['/saved/adb']);
    expect(t.sessionIp()).toBe('10.0.0.9');
    const s = (await t.snapshot()).settings;
    expect(s).toMatchObject({ adbPath: '/saved/adb', defaultDeviceIp: '10.0.0.9' });
  });

  it('uses the defaults with neither saved nor environment values', async () => {
    const t = await start();
    expect(t.resolved).toEqual([undefined]);
    expect(t.sessionIp()).toBeNull();
  });

  it('names a field the Settings dialog can show each 400 under', async () => {
    const t = await start();
    const fieldOf = async (payload: object) => {
      const r = await t.post(payload);
      expect(r.statusCode).toBe(400);
      return fieldForError(new RequestError(r.json().error, r.statusCode, r.json().code));
    };
    expect(await fieldOf({ defaultDeviceIp: '999.1.1.1', adbPath: '' })).toBe('defaultDeviceIp');
    expect(await fieldOf({ defaultDeviceIp: '', adbPath: t.adbs.failing })).toBe('adbPath');
    expect(await fieldOf({ defaultDeviceIp: '', adbPath: 'relative/adb' })).toBe('adbPath');
  });

  it.each([
    ['a relative path', () => 'bin/adb'],
    ['a missing file', (a: Record<string, string>) => a.good + '-missing'],
    ['a non-executable file', (a: Record<string, string>) => a.plain],
    ['a script that exits 1', (a: Record<string, string>) => a.failing],
    ['a folder', (a: Record<string, string>) => path.dirname(a.good!)],
  ])('rejects %s and changes nothing', async (_name, pick) => {
    const t = await start({ adbPath: '/env/adb' });
    await t.post({ adbPath: t.adbs.good });
    await t.settled();
    const before = await t.snapshot();
    const fileBefore = await readFile(path.join(t.home, 'state.json'), 'utf8');
    const resolvedBefore = t.resolved.length;
    const sent = t.messages.length;

    const r = await t.post({ adbPath: pick(t.adbs), downloadsDir: t.home });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("That file isn't a working adb.");
    await t.settled();
    expect(await t.snapshot()).toEqual(before);
    expect(await readFile(path.join(t.home, 'state.json'), 'utf8')).toBe(fileBefore);
    expect(t.resolved.length).toBe(resolvedBefore);
    expect(t.messages.length).toBe(sent);
  });
});
