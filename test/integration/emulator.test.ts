// End-to-end against a real device or emulator. Run with `npm run test:emulator` while
// exactly one device is attached to adb (an emulator is fine).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/server/app.ts';
import { StateStore } from '../../src/server/stateStore.ts';
import type { Job } from '../../src/shared/protocol.ts';

const enabled = process.env.PGMAC_EMULATOR_TEST === '1';
const PORT = 4998;
const H = { host: `127.0.0.1:${PORT}` };
const REMOTE = `/sdcard/Download/pgmac-it-${Date.now()}`;

let app: App;
let local: string;

async function api<T = unknown>(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<T> {
  const r = await app.server.inject({
    method,
    url,
    headers: H,
    ...(payload ? { payload: payload as object } : {}),
  });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return r.json() as T;
}

async function waitJobs(ids: string[], timeoutMs = 60_000): Promise<Job[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const jobs = app.queue.jobs().filter((j) => ids.includes(j.id));
    if (jobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.status))) return jobs;
    if (Date.now() > until) throw new Error('Timed out waiting for transfers');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function transfer(
  from: 'mac' | 'android',
  srcPaths: string[],
  destDir: string,
  decisions = {},
) {
  const plan = await api<{ batchId: string; conflicts: { name: string }[] }>(
    'POST',
    '/api/transfers/plan',
    {
      from,
      srcPaths,
      destDir,
    },
  );
  const { jobIds } = await api<{ jobIds: string[] }>('POST', '/api/transfers/commit', {
    batchId: plan.batchId,
    decisions,
  });
  return { plan, jobIds };
}

const adbChildren = () => {
  try {
    return execFileSync('pgrep', ['-f', 'adb -s .* (push|pull)'])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
};

describe.skipIf(!enabled)('emulator end-to-end', () => {
  beforeAll(async () => {
    local = await mkdtemp(path.join(os.tmpdir(), 'pgmac-it-'));
    await mkdir(path.join(local, 'src', 'folder with spaces', 'nested'), { recursive: true });
    await writeFile(path.join(local, 'src', "it's a file.txt"), 'hello android');
    await writeFile(
      path.join(local, 'src', 'folder with spaces', 'nested', 'deep.bin'),
      randomBytes(200_000),
    );
    await writeFile(path.join(local, 'src', 'big.bin'), randomBytes(400_000_000));
    await mkdir(path.join(local, 'back'));
    app = await buildApp({
      config: {
        port: PORT,
        defaultDeviceIp: null,
        maxConcurrent: 3,
        adbPath: undefined,
        openBrowser: false,
        stateDir: null,
      },
      home: local,
      store: new StateStore(path.join(local, 'state.json')),
    });
    const start = await api<{ result: string }>('POST', '/api/session/start');
    expect(start.result).toBe('connected');
    await api('POST', '/api/fs/android/mkdir', { path: REMOTE });
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    if (app.session.isConnected()) {
      await api('POST', '/api/fs/android/delete', { paths: [REMOTE] }).catch(() => undefined);
    }
    await app.shutdown();
  });

  it('pushes a file and a folder, then pulls them back byte-identical, dates kept', async () => {
    const old = new Date('2020-01-02T03:04:05Z');
    const srcFile = path.join(local, 'src', "it's a file.txt");
    const srcDeep = path.join(local, 'src', 'folder with spaces', 'nested', 'deep.bin');
    for (const p of [srcFile, srcDeep]) await utimes(p, old, old);
    const { jobIds } = await transfer(
      'mac',
      [path.join(local, 'src', "it's a file.txt"), path.join(local, 'src', 'folder with spaces')],
      REMOTE,
    );
    const pushed = await waitJobs(jobIds);
    expect(pushed.map((j) => j.status)).toEqual(['done', 'done']);
    expect(pushed.find((j) => j.isDir)?.itemCount).toBe(1);

    const listing = await api<{ entries: { name: string }[] }>(
      'GET',
      `/api/fs/android/list?path=${encodeURIComponent(REMOTE)}`,
    );
    expect(listing.entries.map((e) => e.name).sort()).toEqual([
      'folder with spaces',
      "it's a file.txt",
    ]);

    const back = path.join(local, 'back');
    const pulled = await waitJobs(
      (
        await transfer(
          'android',
          [`${REMOTE}/it's a file.txt`, `${REMOTE}/folder with spaces`],
          back,
        )
      ).jobIds,
    );
    expect(pulled.map((j) => j.status)).toEqual(['done', 'done']);
    expect(await readFile(path.join(back, "it's a file.txt"), 'utf8')).toBe('hello android');
    expect(await readFile(path.join(back, 'folder with spaces', 'nested', 'deep.bin'))).toEqual(
      await readFile(path.join(local, 'src', 'folder with spaces', 'nested', 'deep.bin')),
    );
    for (const p of [
      path.join(back, "it's a file.txt"),
      path.join(back, 'folder with spaces', 'nested', 'deep.bin'),
    ]) {
      expect((await stat(p)).mtimeMs, p).toBe(old.getTime());
    }
  }, 120_000);

  it('Keep both writes a numbered copy; Replace overwrites', async () => {
    const src = path.join(local, 'src', "it's a file.txt");
    const keep = await transfer('mac', [src], REMOTE, { "it's a file.txt": 'keep' });
    expect(keep.plan.conflicts.map((c) => c.name)).toEqual(["it's a file.txt"]);
    await waitJobs(keep.jobIds);
    await writeFile(src, 'replaced');
    await waitJobs((await transfer('mac', [src], REMOTE, { "it's a file.txt": 'replace' })).jobIds);
    const back = path.join(local, 'back2');
    await mkdir(back);
    await waitJobs(
      (
        await transfer(
          'android',
          [`${REMOTE}/it's a file.txt`, `${REMOTE}/it's a file (1).txt`],
          back,
        )
      ).jobIds,
    );
    expect(await readFile(path.join(back, "it's a file.txt"), 'utf8')).toBe('replaced');
    expect(await readFile(path.join(back, "it's a file (1).txt"), 'utf8')).toBe('hello android');
  }, 120_000);

  it('Replace swaps a whole folder and leaves no backup behind', async () => {
    const folder = path.join(local, 'src', 'folder with spaces');
    await writeFile(path.join(folder, 'added.txt'), 'second version');
    const r = await transfer('mac', [folder], REMOTE, { 'folder with spaces': 'replace' });
    expect(r.plan.conflicts.map((c) => c.name)).toEqual(['folder with spaces']);
    expect((await waitJobs(r.jobIds)).map((j) => j.status)).toEqual(['done']);
    const inner = await api<{ entries: { name: string }[] }>(
      'GET',
      `/api/fs/android/list?path=${encodeURIComponent(`${REMOTE}/folder with spaces`)}`,
    );
    expect(inner.entries.map((e) => e.name).sort()).toEqual(['added.txt', 'nested']);
    const raw = execFileSync('adb', ['shell', `ls -a '${REMOTE}'`], {
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:${os.homedir()}/Library/Android/sdk/platform-tools`,
      },
    }).toString();
    expect(raw).not.toContain('pgmac-partial');
  }, 120_000);

  it('cancel mid-transfer removes the partial and leaves the original untouched', async () => {
    const { jobIds } = await transfer('mac', [path.join(local, 'src', 'big.bin')], REMOTE);
    const id = jobIds[0]!;
    const until = Date.now() + 30_000;
    while (app.queue.jobs().find((j) => j.id === id)?.status !== 'running' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await api('POST', `/api/transfers/${id}/cancel`);
    expect(app.queue.jobs().find((j) => j.id === id)?.status).toBe('cancelled');
    const listing = await api<{ entries: { name: string }[] }>(
      'GET',
      `/api/fs/android/list?path=${encodeURIComponent(REMOTE)}`,
    );
    expect(listing.entries.map((e) => e.name)).not.toContain('big.bin');
    const raw = execFileSync('adb', ['shell', `ls -a '${REMOTE}'`], {
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:${os.homedir()}/Library/Android/sdk/platform-tools`,
      },
    }).toString();
    expect(raw).not.toContain('pgmac-partial');
    expect(adbChildren()).toBe(0);
  }, 120_000);

  it('End Session leaves no adb transfer processes running', async () => {
    await transfer('mac', [path.join(local, 'src', 'big.bin')], REMOTE, { 'big.bin': 'replace' });
    await api('POST', '/api/session/end');
    expect(app.queue.jobs().every((j) => ['done', 'failed', 'cancelled'].includes(j.status))).toBe(
      true,
    );
    expect(adbChildren()).toBe(0);
    expect(await readdir(local)).toBeTruthy();
    // Reconnect so afterAll can clean up the remote folder.
    await api('POST', '/api/session/start');
  }, 120_000);
});
