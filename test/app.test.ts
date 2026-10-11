import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/server/app.ts';
import { StateStore } from '../src/server/stateStore.ts';
import { FakeRunner } from './helpers.ts';

let app: App;
let home: string;
const runner = new FakeRunner();
const revealed: string[][] = [];
const PORT = 4999;
const H = { host: `127.0.0.1:${PORT}` };

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pgmac-home-'));
  await mkdir(path.join(home, 'Docs'));
  await writeFile(path.join(home, 'Docs', 'a.txt'), 'hello');
  await writeFile(path.join(home, 'Docs', '.secret'), 'x');
  await writeFile(path.join(home, 'Docs', '.b.txt.pgmac-partial'), 'partial');
  app = await buildApp({
    config: {
      port: PORT,
      defaultDeviceIp: null,
      maxConcurrent: 3,
      adbPath: '/nonexistent/adb',
      openBrowser: false,
    },
    home,
    store: new StateStore(path.join(home, 'state.json')),
    runner,
    resolveAdb: async () => null,
    stagingRoot: path.join(home, 'staging'),
    reveal: (paths) => revealed.push(paths),
  });
});

afterAll(async () => {
  await app.shutdown();
});

describe('HTTP API', () => {
  it('rejects requests for other hosts (DNS rebinding) and cross-site origins', async () => {
    const rebinding = await app.server.inject({
      url: '/api/snapshot',
      headers: { host: 'evil.example:4999' },
    });
    expect(rebinding.statusCode).toBe(403);
    const crossSite = await app.server.inject({
      url: '/api/snapshot',
      headers: { ...H, origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
    const ok = await app.server.inject({
      url: '/api/snapshot',
      headers: { ...H, origin: `http://127.0.0.1:${PORT}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('serves a snapshot with Mac home and default settings', async () => {
    const r = await app.server.inject({ url: '/api/snapshot', headers: H });
    const body = r.json();
    expect(body.mac.home).toBe(home);
    expect(body.settings.maxConcurrent).toBe(3);
    expect(body.session.state).toBe('idle');
  });

  it('lists Mac folders, hiding transfer partials but not dotfiles', async () => {
    const r = await app.server.inject({
      url: `/api/fs/mac/list?path=${encodeURIComponent(path.join(home, 'Docs'))}`,
      headers: H,
    });
    expect(r.statusCode).toBe(200);
    expect(
      r
        .json()
        .entries.map((e: { name: string }) => e.name)
        .sort(),
    ).toEqual(['.secret', 'a.txt']);
  });

  it('validates paths and names', async () => {
    const rel = await app.server.inject({ url: '/api/fs/mac/list?path=Docs', headers: H });
    expect(rel.statusCode).toBe(400);
    const slash = await app.server.inject({
      method: 'POST',
      url: '/api/fs/mac/rename',
      headers: H,
      payload: { path: path.join(home, 'Docs', 'a.txt'), newName: '../escape.txt' },
    });
    expect(slash.statusCode).toBe(400);
    expect(await readdir(path.join(home, 'Docs'))).toContain('a.txt');
  });

  it('creates and renames Mac folders, refusing to clobber', async () => {
    const dir = path.join(home, 'Docs', 'New');
    const mk = await app.server.inject({
      method: 'POST',
      url: '/api/fs/mac/mkdir',
      headers: H,
      payload: { path: dir },
    });
    expect(mk.statusCode).toBe(200);
    const again = await app.server.inject({
      method: 'POST',
      url: '/api/fs/mac/mkdir',
      headers: H,
      payload: { path: dir },
    });
    expect(again.json().code).toBe('EXISTS');
    const clobber = await app.server.inject({
      method: 'POST',
      url: '/api/fs/mac/rename',
      headers: H,
      payload: { path: dir, newName: 'a.txt' },
    });
    expect(clobber.json().code).toBe('EXISTS');
  });

  it('refuses to delete root folders', async () => {
    const r = await app.server.inject({
      method: 'POST',
      url: '/api/fs/mac/delete',
      headers: H,
      payload: { paths: [home] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('requires a session for Android and transfer planning', async () => {
    const list = await app.server.inject({ url: '/api/fs/android/list?path=/sdcard', headers: H });
    expect(list.json().code).toBe('NO_SESSION');
    const plan = await app.server.inject({
      method: 'POST',
      url: '/api/transfers/plan',
      headers: H,
      payload: { from: 'mac', srcPaths: [path.join(home, 'Docs', 'a.txt')], destDir: '/sdcard' },
    });
    expect(plan.json().code).toBe('NO_SESSION');
  });

  it('reports missing adb instead of trying to start a session', async () => {
    const r = await app.server.inject({ method: 'POST', url: '/api/session/start', headers: H });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/adb was not found/);
  });

  it('clamps the concurrency setting', async () => {
    const r = await app.server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: H,
      payload: { maxConcurrent: 99 },
    });
    expect(r.json().maxConcurrent).toBe(6);
  });

  describe('Finder uploads', () => {
    const plan = async (items: object[], destDir = path.join(home, 'Docs')) =>
      app.server.inject({
        method: 'POST',
        url: '/api/transfers/plan',
        headers: H,
        payload: { from: 'finder', destSide: 'mac', destDir, items },
      });
    const commit = async (batchId: string) =>
      (
        await app.server.inject({
          method: 'POST',
          url: '/api/transfers/commit',
          headers: H,
          payload: { batchId, decisions: {} },
        })
      ).json() as { uploads: { name: string; jobId: string }[] };
    const put = (jobId: string, rel: string, body: string) =>
      app.server.inject({
        method: 'PUT',
        url: `/api/uploads/${jobId}/file?path=${encodeURIComponent(rel)}`,
        headers: { ...H, 'content-type': 'application/octet-stream' },
        payload: body,
      });

    it('stages a dropped folder and queues a copy without a session', async () => {
      const p = await plan([{ name: 'Pics', isDir: true, size: 7, files: 2, mtimeMs: 1 }]);
      expect(p.statusCode).toBe(200);
      const { uploads } = await commit(p.json().batchId);
      const jobId = uploads[0]!.jobId;
      expect((await put(jobId, 'sub/a.txt', 'hello')).statusCode).toBe(200);
      expect((await put(jobId, 'b.txt', 'hi')).statusCode).toBe(200);
      const dir = await app.server.inject({
        method: 'POST',
        url: `/api/uploads/${jobId}/dir?path=empty`,
        headers: H,
      });
      expect(dir.statusCode).toBe(200);
      const staged = path.join(home, 'staging', jobId, 'Pics');
      expect(await readFile(path.join(staged, 'sub', 'a.txt'), 'utf8')).toBe('hello');
      const done = await app.server.inject({
        method: 'POST',
        url: `/api/uploads/${jobId}/complete`,
        headers: H,
      });
      expect(done.statusCode).toBe(200);
      const run = runner.runs.at(-1)!;
      expect(run.spec).toMatchObject({ direction: 'copy', srcPath: staged });
      const job = app.queue.jobs().find((j) => j.id === jobId)!;
      expect(job).toMatchObject({ status: 'running', totalBytes: 7, itemCount: 2 });
      run.succeed();
    });

    it("gives a staged file the dropped file's modified date", async () => {
      const p = await plan([{ name: 'd.txt', isDir: false, size: 2, files: 1, mtimeMs: 1 }]);
      const { uploads } = await commit(p.json().batchId);
      const jobId = uploads[0]!.jobId;
      const mtime = Date.parse('2020-01-02T03:04:05Z');
      const res = await app.server.inject({
        method: 'PUT',
        url: `/api/uploads/${jobId}/file?path=&mtime=${mtime}`,
        headers: { ...H, 'content-type': 'application/octet-stream' },
        payload: 'hi',
      });
      expect(res.statusCode).toBe(200);
      const staged = path.join(home, 'staging', jobId, 'd.txt');
      expect((await stat(staged)).mtimeMs).toBe(mtime);

      // A date out of range still uploads; the file just keeps today's date.
      const p2 = await plan([{ name: 'e.txt', isDir: false, size: 2, files: 1, mtimeMs: 1 }]);
      const id2 = (await commit(p2.json().batchId)).uploads[0]!.jobId;
      const bad = await app.server.inject({
        method: 'PUT',
        url: `/api/uploads/${id2}/file?path=&mtime=1e20`,
        headers: { ...H, 'content-type': 'application/octet-stream' },
        payload: 'hi',
      });
      expect(bad.statusCode).toBe(200);
    });

    it('refuses upload paths that leave the item, failing that item', async () => {
      for (const [n, rel] of ['../escape.txt', '/etc/x', 'a//b'].entries()) {
        const p = await plan([{ name: `Bad${n}`, isDir: true, size: 1, files: 1, mtimeMs: 1 }]);
        const { uploads } = await commit(p.json().batchId);
        expect((await put(uploads[0]!.jobId, rel, 'x')).statusCode, rel).toBe(400);
        const job = app.queue.jobs().find((j) => j.id === uploads[0]!.jobId)!;
        expect(job.status, rel).toBe('failed');
      }
      expect(await readdir(path.join(home, 'staging'))).not.toContain('escape.txt');
    });

    it('refuses uploads for a cancelled job', async () => {
      const p = await plan([{ name: 'c.txt', isDir: false, size: 1, files: 1, mtimeMs: 1 }]);
      const { uploads } = await commit(p.json().batchId);
      const jobId = uploads[0]!.jobId;
      await app.server.inject({
        method: 'POST',
        url: `/api/transfers/${jobId}/cancel`,
        headers: H,
      });
      expect((await put(jobId, '', 'x')).statusCode).toBe(409);
    });
  });

  it('saves a downloads folder only if it exists', async () => {
    const bad = await app.server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: H,
      payload: { downloadsDir: path.join(home, 'nope') },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: H,
      payload: { downloadsDir: path.join(home, 'Docs') },
    });
    expect(good.json().downloadsDir).toBe(path.join(home, 'Docs'));
    const saved = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'));
    expect(saved.downloadsDir).toBe(path.join(home, 'Docs'));
  });

  it('reveals Mac items in place', async () => {
    const r = await app.server.inject({
      method: 'POST',
      url: '/api/reveal',
      headers: H,
      payload: { side: 'mac', paths: [path.join(home, 'Docs', 'a.txt')] },
    });
    expect(r.statusCode).toBe(200);
    expect(revealed.at(-1)).toEqual([path.join(home, 'Docs', 'a.txt')]);
  });

  describe('Finder drops with real paths (desktop app)', () => {
    let paths: App;
    const H3 = { host: `127.0.0.1:${PORT + 2}` };
    const pathsRunner = new FakeRunner();
    const stagingRoot = () => path.join(home, 'staging3');
    const plan = (payload: object) =>
      paths.server.inject({ method: 'POST', url: '/api/transfers/plan', headers: H3, payload });
    const commit = async (batchId: string, decisions = {}) =>
      (
        await paths.server.inject({
          method: 'POST',
          url: '/api/transfers/commit',
          headers: H3,
          payload: { batchId, decisions },
        })
      ).json() as { jobIds: string[]; uploads: unknown[] };
    const staged = () => readdir(stagingRoot()).catch(() => []);

    beforeAll(async () => {
      await mkdir(path.join(home, 'Drop', 'Album', 'empty'), { recursive: true });
      await writeFile(path.join(home, 'Drop', 'Album', '.DS_Store'), 'meta');
      await writeFile(path.join(home, 'Drop', 'note.txt'), 'note');
      await mkdir(path.join(home, 'Out'));
      await writeFile(path.join(home, 'Out', 'note.txt'), 'old');
      paths = await buildApp({
        config: {
          port: PORT + 2,
          defaultDeviceIp: null,
          maxConcurrent: 3,
          adbPath: '/nonexistent/adb',
          openBrowser: false,
        },
        home,
        store: new StateStore(path.join(home, 'state3.json')),
        runner: pathsRunner,
        resolveAdb: async () => null,
        stagingRoot: stagingRoot(),
        reveal: () => undefined,
      });
    });
    afterAll(() => paths.shutdown());

    it('copies a dropped folder from where it is, without a session or staging', async () => {
      const album = path.join(home, 'Drop', 'Album');
      const p = await plan({
        from: 'paths',
        destSide: 'mac',
        destDir: path.join(home, 'Out'),
        srcPaths: [album],
      });
      expect(p.statusCode).toBe(200);
      expect(p.json().conflicts).toEqual([]);
      const { jobIds, uploads } = await commit(p.json().batchId);
      expect(uploads).toEqual([]);
      const run = pathsRunner.runs.at(-1)!;
      expect(run.spec).toMatchObject({
        direction: 'copy',
        srcPath: album,
        isDir: true,
        partialPath: path.join(home, 'Out', '.Album.pgmac-partial'),
        finalPath: path.join(home, 'Out', 'Album'),
      });
      const job = paths.queue.jobs().find((j) => j.id === jobIds[0])!;
      expect(job).toMatchObject({ status: 'running', origin: 'pane', srcPath: album });

      // The source is busy while the copy runs.
      const del = await paths.server.inject({
        method: 'POST',
        url: '/api/fs/mac/delete',
        headers: H3,
        payload: { paths: [album] },
      });
      expect(del.json().code).toBe('BUSY_PATH');

      // A retry reads the source path again.
      run.fail('boom');
      await new Promise((r) => setImmediate(r));
      await paths.server.inject({
        method: 'POST',
        url: `/api/transfers/${jobIds[0]}/retry`,
        headers: H3,
      });
      expect(pathsRunner.runs.at(-1)!.spec.srcPath).toBe(album);
      pathsRunner.runs.at(-1)!.succeed();
      await new Promise((r) => setImmediate(r));
      expect(await staged()).toEqual([]);
    });

    it('asks about a name that already exists, and replaces when told to', async () => {
      const note = path.join(home, 'Drop', 'note.txt');
      const p = await plan({
        from: 'paths',
        destSide: 'mac',
        destDir: path.join(home, 'Out'),
        srcPaths: [note],
      });
      expect(p.json().conflicts.map((c: { name: string }) => c.name)).toEqual(['note.txt']);
      await commit(p.json().batchId, { 'note.txt': 'replace' });
      expect(pathsRunner.runs.at(-1)!.spec).toMatchObject({ srcPath: note, replace: true });
      pathsRunner.runs.at(-1)!.succeed();
      expect(await staged()).toEqual([]);
    });

    it('needs a session for drops onto the phone', async () => {
      const p = await plan({
        from: 'paths',
        destSide: 'android',
        destDir: '/sdcard',
        srcPaths: [path.join(home, 'Drop', 'note.txt')],
      });
      expect(p.json().code).toBe('NO_SESSION');
    });

    it('validates the dropped paths', async () => {
      for (const srcPaths of [['relative.txt'], ['/a\0b'], 'nope']) {
        const p = await plan({ from: 'paths', destSide: 'mac', destDir: home, srcPaths });
        expect(p.statusCode, JSON.stringify(srcPaths)).toBe(400);
      }
      const missing = await plan({
        from: 'paths',
        destSide: 'mac',
        destDir: home,
        srcPaths: [path.join(home, 'Drop', 'gone.txt')],
      });
      expect(missing.statusCode).toBe(404);
    });

    it('refuses to copy a folder into itself', async () => {
      const p = await plan({
        from: 'paths',
        destSide: 'mac',
        destDir: path.join(home, 'Drop', 'Album', 'empty'),
        srcPaths: [path.join(home, 'Drop', 'Album')],
      });
      expect(p.statusCode).toBe(400);
      expect(p.json().error).toMatch(/into itself/);
    });
  });

  it('cancels copy jobs and uploads on quit even without a device', async () => {
    const other = await buildApp({
      config: {
        port: PORT + 1,
        defaultDeviceIp: null,
        maxConcurrent: 3,
        adbPath: '/nonexistent/adb',
        openBrowser: false,
      },
      home,
      store: new StateStore(path.join(home, 'state2.json')),
      runner: new FakeRunner(),
      resolveAdb: async () => null,
      stagingRoot: path.join(home, 'staging2'),
      reveal: () => undefined,
    });
    const plan = await other.queue.plan({
      from: 'finder',
      destSide: 'mac',
      destDir: path.join(home, 'Docs'),
      items: [{ name: 'q.bin', isDir: false, size: 1, files: 1, mtimeMs: 1 }],
    });
    const { jobIds } = other.queue.commit({ batchId: plan.batchId, decisions: {} });
    await other.shutdown();
    expect(other.queue.jobs().find((j) => j.id === jobIds[0])!.status).toBe('cancelled');
  });
});
