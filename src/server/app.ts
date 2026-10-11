import { constants, createWriteStream, existsSync } from 'node:fs';
import { access, mkdir, stat, utimes } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { Adb, resolveAdbPath } from './adb/adb.ts';
import { clampConcurrency, effectiveSettings, type Config } from './config.ts';
import { HttpError, invalid, noSession } from './errors.ts';
import { AndroidFs } from './fs/android.ts';
import { MacFs, type TrashFn } from './fs/mac.ts';
import { VolumeMonitor, makeProbe, readSystemMounts } from './fs/volumes.ts';
import { joinPosix, normalizeAbs, dirName } from './fs/paths.ts';
import type { SideFs } from './fs/types.ts';
import { Hub } from './hub.ts';
import { PairingManager } from './pairing.ts';
import { SessionManager } from './session.ts';
import { currentPlatform, defaultDownloadsDir, defaultStagingRoot } from './platform.ts';
import { reveal } from './reveal.ts';
import { volumeEventHandler } from './volumeEvents.ts';
import { StateStore } from './stateStore.ts';
import { tokenMatches } from './token.ts';
import { decodeWireToken } from '../shared/token.ts';
import { AdbRunner } from './transfers/adbRunner.ts';
import { forceStop } from './transfers/children.ts';
import { NO_STAGING_SPACE, TransferQueue, type TransferRunner } from './transfers/queue.ts';
import { Staging } from './transfers/staging.ts';
import type {
  AdbStatus,
  CommitRequest,
  FinderItem,
  PairCodeRequest,
  PlanRequest,
  ServerSnapshot,
  Settings,
  Side,
} from '../shared/protocol.ts';

export interface AppOptions {
  config: Config;
  home: string;
  /** Built UI to serve; omitted in tests and when running the Vite dev server. */
  webRoot?: string;
  store?: StateStore;
  runner?: TransferRunner;
  /** Overrides adb discovery (tests); gets the effective adb path setting. */
  resolveAdb?: (explicit: string | undefined) => Promise<string | null>;
  /** Also accept requests proxied from the Vite dev server on port 5173. */
  dev?: boolean;
  /** Where Finder uploads are staged (tests); defaults to the user's cache folder. */
  stagingRoot?: string;
  /** Replaces opening the file manager (tests). */
  reveal?: (paths: string[]) => void;
  /** Replaces the network volume monitor (tests). */
  volumes?: VolumeMonitor;
  /** Moves Mac paths to the Trash when there is no `/usr/bin/trash` (the desktop app's). */
  trash?: TrashFn;
  onQuit?: () => void;
  /**
   * When set, every `/api/*` request and the `/ws` upgrade must present it (see
   * `resolveApiToken`). Off by default so tests can call the API without one.
   */
  token?: string;
}

export interface App {
  server: FastifyInstance;
  session: SessionManager;
  queue: TransferQueue;
  /**
   * Deletes uploads staged by a previous run. Call only after `listen` succeeds: until then
   * another running copy of the app may own them.
   */
  clearStaleStaging(): Promise<void>;
  shutdown(): Promise<void>;
}

const sideParam = (s: unknown): Side => {
  if (s === 'android' || s === 'mac') return s;
  throw invalid('Unknown side.');
};

const WS_PROTOCOL = 'pgmac';
const TOKEN_PROTOCOL_PREFIX = 'token.';

const isGuardedPath = (p: string) => p === '/ws' || p.startsWith('/api/');

/**
 * Checks the matched route as well as the raw path: the router decodes percent-escapes, so a
 * raw `/%61pi/snapshot` still reaches the `/api/snapshot` handler.
 */
function needsToken(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  return isGuardedPath(req.url.split('?')[0] ?? '') || (!!route && isGuardedPath(route));
}

function presentedToken(req: FastifyRequest): string | undefined {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) return decodeWireToken(bearer);
  const protocols = req.headers['sec-websocket-protocol'];
  if (typeof protocols !== 'string') return undefined;
  const wire = protocols
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))
    ?.slice(TOKEN_PROTOCOL_PREFIX.length);
  return wire === undefined ? undefined : decodeWireToken(wire);
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address or a hostname; null for a cleared value. */
function deviceIpParam(v: unknown): string | null {
  if (v === null) return null;
  const s = typeof v === 'string' ? v.trim() : undefined;
  if (s === '') return null;
  const labels = s?.split('.') ?? [];
  const ok =
    s !== undefined &&
    (isIPv4(s) ||
      (s.length <= 253 &&
        labels.every((l) => HOST_LABEL.test(l)) &&
        // All digits is a mistyped address (999.1.1.1), not a hostname.
        !labels.every((l) => /^\d+$/.test(l))));
  if (!ok) throw invalid('Enter an IP address like 192.168.1.20.');
  return s;
}

/** True when `p` is an absolute path to an executable whose `adb version` succeeds. */
async function isWorkingAdb(p: string): Promise<boolean> {
  if (!path.isAbsolute(p) || p.includes('\0')) return false;
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    const r = await new Adb(p).exec(['version'], { timeoutMs: 5000 });
    return r.code === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const { config } = opts;
  const hub = new Hub();
  const store = opts.store ?? new StateStore();
  await store.load();

  const effective = () =>
    effectiveSettings({ defaultDeviceIp: store.defaultDeviceIp, adbPath: store.adbPath }, config);
  const findAdb = () => (opts.resolveAdb ?? resolveAdbPath)(effective().adbPath);
  const adb = new Adb(await findAdb());
  let adbStatus: AdbStatus = {
    found: !!adb.bin,
    path: adb.bin,
    version: adb.bin ? await adb.version() : null,
  };
  const refreshAdb = async () => {
    adb.bin = await findAdb();
    adbStatus = { found: !!adb.bin, path: adb.bin, version: adb.bin ? await adb.version() : null };
    hub.emit({ type: 'adb', adb: adbStatus });
    return adbStatus;
  };

  const session = new SessionManager({
    adb,
    hub,
    store,
    defaultIp: () => effective().defaultDeviceIp,
  });
  const requireSerial = () => {
    const s = session.serial;
    if (!s) throw noSession();
    return s;
  };
  const platform = currentPlatform();
  const volumes =
    opts.volumes ?? new VolumeMonitor({ readMounts: readSystemMounts, probe: makeProbe() });
  await volumes.start();
  const mac = new MacFs(opts.home, volumes, { trash: opts.trash });
  // One folder per port: another copy of the app on a different port clears only its own.
  const staging = new Staging(
    opts.stagingRoot ?? path.join(defaultStagingRoot(platform), String(config.port)),
  );
  const revealPaths = opts.reveal ?? ((paths: string[]) => void reveal(platform, paths));
  let downloadsDir = store.downloadsDir ?? (await defaultDownloadsDir(platform, opts.home));
  const android = new AndroidFs(adb, requireSerial);
  const fs: Record<Side, SideFs> = { android, mac };
  const runner =
    opts.runner ?? new AdbRunner({ adb, serial: requireSerial, android, mac, volumes });
  const queue = new TransferQueue({
    hub,
    fs,
    runner,
    isConnected: () => session.isConnected(),
    sessionId: () => session.sessionId,
    maxConcurrent: config.maxConcurrent,
    staging,
    reveal: revealPaths,
    volumes,
  });
  const settings = (): Settings => ({
    maxConcurrent: queue.maxConcurrent,
    downloadsDir,
    defaultDeviceIp: store.defaultDeviceIp,
    adbPath: store.adbPath,
    envDefaultDeviceIp: config.defaultDeviceIp,
  });
  volumes.onEvent(
    volumeEventHandler({
      mac,
      queue,
      hub,
      offlineList: () => volumes.offlineList(),
      // A downloads folder on the share would otherwise keep pointing at the dead mount.
      onMoved: (from, to) => {
        if (downloadsDir !== from && !downloadsDir.startsWith(from + '/')) return;
        downloadsDir = to + downloadsDir.slice(from.length);
        void store.setDownloadsDir(downloadsDir).catch(() => undefined);
        hub.emit({ type: 'settings', settings: settings() });
      },
    }),
  );
  session.attachQueue(queue);
  const pairing = new PairingManager({ adb, hub, session });

  let macStorage = await mac.storage();
  const macInfo = () => ({ home: opts.home, platform, storage: macStorage });
  const snapshot = (): ServerSnapshot => ({
    adb: adbStatus,
    session: session.snapshot(),
    pairing: pairing.snapshot(),
    jobs: queue.jobs(),
    settings: settings(),
    mac: macInfo(),
    offlineVolumes: volumes.offlineList(),
  });
  hub.setSnapshotProvider(snapshot);
  let readingStorage = false;
  const macTimer = setInterval(async () => {
    // Home can be on a network share; a hung statfs must not be joined by another.
    if (readingStorage) return;
    readingStorage = true;
    macStorage = await mac.storage().finally(() => (readingStorage = false));
    hub.emit({ type: 'mac', mac: macInfo() });
  }, 30_000);
  macTimer.unref();

  const server = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  // Registered before the checks below: its own onRequest hook marks upgrade requests, and
  // only marked ones get their socket closed after a refusal; otherwise it stays open and
  // server.close() never finishes.
  await server.register(fastifyWebsocket, {
    // The page offers `pgmac` plus its token as a second subprotocol (a browser WebSocket can't
    // set headers). Selecting `pgmac` lets the browser accept the connection without the token
    // ever being echoed back in the response.
    options: { handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false) },
  });

  // The API can read and delete local files, so only answer requests addressed to this
  // loopback server. Checking Host blocks DNS rebinding; checking Origin blocks other sites.
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (opts.dev) hosts.push('127.0.0.1:5173', 'localhost:5173');
  const allowedHosts = new Set(hosts);
  server.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const hostOk = allowedHosts.has(req.headers.host ?? '');
    const originOk = !origin || allowedHosts.has(origin.replace(/^https?:\/\//, ''));
    if (!hostOk || !originOk) {
      reply.code(403).send({ error: 'Forbidden' });
      return reply;
    }
    // Loopback is shared by every process and every user account on the Mac, and a request
    // with no Origin passes the check above, so the API also needs a secret only our page has.
    const token = opts.token;
    if (token === undefined || !needsToken(req)) return;
    if (!tokenMatches(presentedToken(req), token)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return reply;
    }
  });

  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ error: err.message, code: err.code });
      return;
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err.message || 'Internal error' });
  });

  server.get('/ws', { websocket: true }, (socket) => {
    const client = { send: (d: string) => socket.send(d) };
    hub.add(client);
    socket.on('close', () => hub.remove(client));
    socket.on('error', () => hub.remove(client));
  });

  type Req<B = unknown, Q = unknown, P = unknown> = FastifyRequest<{
    Body: B;
    Querystring: Q;
    Params: P;
  }>;
  const body = <T>(req: FastifyRequest): Partial<T> =>
    (req.body && typeof req.body === 'object' ? req.body : {}) as Partial<T>;

  server.get('/api/snapshot', async () => snapshot());

  server.post('/api/adb/recheck', refreshAdb);

  const requireAdb = () => {
    if (!adb.bin)
      throw new HttpError(409, 'adb was not found. Install Android platform tools.', 'ADB');
  };

  server.post('/api/session/start', async () => {
    requireAdb();
    return session.start();
  });
  server.post('/api/session/connect', async (req) => {
    requireAdb();
    const id = body<{ id: string }>(req).id;
    if (typeof id !== 'string') throw invalid('Device id is required.');
    return session.connect(id);
  });
  server.post('/api/session/reconnect', async () => session.reconnect());
  server.post('/api/session/end', async () => session.end());

  server.post('/api/pair/qr', async () => {
    requireAdb();
    return pairing.startQr();
  });
  server.post('/api/pair/code', async (req) => {
    requireAdb();
    return pairing.pairWithCode(body<PairCodeRequest>(req) as PairCodeRequest);
  });
  server.post('/api/pair/cancel', async () => {
    pairing.cancel();
    return { ok: true };
  });

  server.get(
    '/api/fs/:side/list',
    async (req: Req<unknown, { path?: string }, { side: string }>) => {
      const side = sideParam(req.params.side);
      const p = normalizeAbs(req.query.path);
      return { path: p, entries: await fs[side].list(p) };
    },
  );
  server.post('/api/fs/:side/mkdir', async (req: Req<unknown, unknown, { side: string }>) => {
    const side = sideParam(req.params.side);
    const p = normalizeAbs(body<{ path: string }>(req).path);
    queue.assertNotBusy(side, p);
    await fs[side].mkdir(p);
    hub.emit({ type: 'fsChanged', side, dir: dirName(p) });
    return { ok: true };
  });
  server.post('/api/fs/:side/rename', async (req: Req<unknown, unknown, { side: string }>) => {
    const side = sideParam(req.params.side);
    const b = body<{ path: string; newName: string }>(req);
    const p = normalizeAbs(b.path);
    queue.assertNotBusy(side, p);
    if (typeof b.newName === 'string') queue.assertNotBusy(side, joinPosix(dirName(p), b.newName));
    await fs[side].rename(p, b.newName as string);
    hub.emit({ type: 'fsChanged', side, dir: dirName(p) });
    return { ok: true };
  });
  server.post('/api/fs/:side/delete', async (req: Req<unknown, unknown, { side: string }>) => {
    const side = sideParam(req.params.side);
    const b = body<{ paths: string[]; permanent: boolean }>(req);
    const raw = b.paths;
    if (!Array.isArray(raw) || !raw.length) throw invalid('Nothing to delete.');
    const paths = raw.map(normalizeAbs);
    for (const p of paths) {
      if (
        p === '/' ||
        (side === 'mac' && p === opts.home) ||
        (side === 'android' && p === '/sdcard')
      ) {
        throw invalid('Refusing to delete a root folder.');
      }
      queue.assertNotBusy(side, p);
    }
    if (b.permanent === true) {
      if (side !== 'mac') throw invalid('Android deletes are already permanent.');
      await mac.removePermanently(paths);
    } else {
      await fs[side].remove(paths);
    }
    for (const d of new Set(paths.map(dirName))) hub.emit({ type: 'fsChanged', side, dir: d });
    return { ok: true };
  });

  server.post('/api/transfers/plan', async (req) => {
    const b = body<PlanRequest>(req) as Record<string, unknown>;
    if (b.from === 'finder') {
      if (!Array.isArray(b.items)) throw invalid('items must be a list.');
      return queue.plan({
        from: 'finder',
        destSide: sideParam(b.destSide),
        destDir: normalizeAbs(b.destDir),
        items: b.items as FinderItem[],
      });
    }
    if (b.from === 'paths') {
      if (!Array.isArray(b.srcPaths)) throw invalid('srcPaths must be a list.');
      return queue.plan({
        from: 'paths',
        destSide: sideParam(b.destSide),
        destDir: normalizeAbs(b.destDir),
        srcPaths: b.srcPaths.map(normalizeAbs),
      });
    }
    const from = sideParam(b.from);
    if (!Array.isArray(b.srcPaths)) throw invalid('srcPaths must be a list.');
    return queue.plan({
      from,
      srcPaths: b.srcPaths.map(normalizeAbs),
      destDir: normalizeAbs(b.destDir),
      reveal: b.reveal === true,
    });
  });
  server.post('/api/transfers/commit', async (req) => {
    const b = body<CommitRequest>(req);
    if (typeof b.batchId !== 'string') throw invalid('batchId is required.');
    const decisions = b.decisions && typeof b.decisions === 'object' ? b.decisions : {};
    for (const v of Object.values(decisions)) {
      if (v !== 'replace' && v !== 'keep' && v !== 'skip')
        throw invalid('Unknown conflict decision.');
    }
    const pageId = typeof b.pageId === 'string' ? b.pageId.slice(0, 100) : undefined;
    return queue.commit({ batchId: b.batchId, decisions, pageId });
  });
  server.post('/api/transfers/:id/cancel', async (req: Req<unknown, unknown, { id: string }>) => {
    await queue.cancel(req.params.id);
    return { ok: true };
  });
  server.post('/api/transfers/:id/retry', async (req: Req<unknown, unknown, { id: string }>) => {
    queue.retry(req.params.id);
    return { ok: true };
  });
  server.post('/api/transfers/clear', async () => {
    queue.clearFinished();
    return { ok: true };
  });

  // Finder uploads stream straight to the staging folder; the 1 MB JSON limit doesn't apply.
  server.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: Number.MAX_SAFE_INTEGER },
    (_req, payload, done) => done(null, payload),
  );
  type UploadReq = Req<unknown, { path?: string; mtime?: string }, { jobId: string }>;
  server.put('/api/uploads/:jobId/file', async (req: UploadReq) => {
    const { jobId } = req.params;
    const target = queue.uploadTarget(jobId, String(req.query.path ?? ''), 'file');
    const ac = queue.beginUpload(jobId);
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        queue.uploadProgress(jobId, chunk.length);
        cb(null, chunk);
      },
    });
    let failure: string | undefined;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const source = (req.body as Readable | undefined) ?? [];
      await pipeline(source, count, createWriteStream(target), { signal: ac.signal });
      // A freshly written file is dated now; give it the original's date so adb push and
      // the Mac copy carry the real one forward. A bad date isn't worth failing the upload.
      const mtime = Number(req.query.mtime);
      if (Number.isFinite(mtime) && mtime > 0) {
        await utimes(target, new Date(), new Date(mtime)).catch(() => undefined);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      failure = code === 'ENOSPC' ? NO_STAGING_SPACE : undefined;
      queue.endUpload(jobId, ac, false, failure);
      if (failure) throw new HttpError(507, failure, 'NO_SPACE');
      throw new HttpError(409, 'The upload was interrupted.', 'CONFLICT');
    }
    queue.endUpload(jobId, ac, true);
    return { ok: true };
  });
  server.post('/api/uploads/:jobId/dir', async (req: UploadReq) => {
    const { jobId } = req.params;
    const target = queue.uploadTarget(jobId, String(req.query.path ?? ''), 'dir');
    // Tracked like a file request: it is upload activity, and cancel must wait for it.
    const ac = queue.beginUpload(jobId);
    try {
      await mkdir(target, { recursive: true });
    } catch (err) {
      queue.endUpload(jobId, ac, false, `Could not create a folder: ${(err as Error).message}`);
      throw err;
    }
    queue.endUpload(jobId, ac, true);
    return { ok: true };
  });
  server.post('/api/uploads/:jobId/complete', async (req: UploadReq) => {
    await queue.completeUpload(req.params.jobId);
    return { ok: true };
  });

  server.post('/api/reveal', async (req) => {
    const b = body<{ side: Side; paths: string[] }>(req);
    if (b.side !== 'mac') throw invalid('Only Mac items can be revealed in place.');
    if (!Array.isArray(b.paths) || !b.paths.length) throw invalid('Nothing to show.');
    revealPaths(b.paths.map(normalizeAbs));
    return { ok: true };
  });

  server.post('/api/settings', async (req) => {
    const b = body<Settings>(req);
    // Every field is checked before any is applied, so a 400 leaves all settings as they were.
    let dir: string | undefined;
    if (b.downloadsDir !== undefined) {
      dir = normalizeAbs(b.downloadsDir);
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) throw invalid('That folder does not exist.');
    }
    const max = b.maxConcurrent;
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
      throw invalid('maxConcurrent must be a number.');
    }
    const ip = b.defaultDeviceIp === undefined ? undefined : deviceIpParam(b.defaultDeviceIp);
    let adbPath: string | null | undefined;
    if (b.adbPath !== undefined) {
      adbPath = typeof b.adbPath === 'string' ? b.adbPath.trim() || null : b.adbPath;
      if (adbPath !== null && (typeof adbPath !== 'string' || !(await isWorkingAdb(adbPath)))) {
        throw invalid("That file isn't a working adb.");
      }
    }

    if (dir !== undefined) {
      downloadsDir = dir;
      await store.setDownloadsDir(dir);
    }
    if (max !== undefined) queue.setMaxConcurrent(clampConcurrency(max));
    if (ip !== undefined) await store.setDefaultDeviceIp(ip);
    if (adbPath !== undefined) await store.setAdbPath(adbPath);
    if ([dir, max, ip, adbPath].some((v) => v !== undefined)) {
      hub.emit({ type: 'settings', settings: settings() });
    }
    if (adbPath !== undefined) await refreshAdb();
    return settings();
  });

  // Shared so every quit path (POST /api/quit, a signal, the desktop app) waits for the same
  // cleanup: a caller that got an early return could exit while transfers are still cancelling.
  let stopped: Promise<void> | undefined;
  const stop = async () => {
    clearInterval(macTimer);
    pairing.cancel();
    await session.end().catch(() => undefined);
    // session.end() is a no-op without a device, but copy jobs and uploads run without one.
    await queue.cancelAll().catch(() => undefined);
    // cancelAll gives up on a child after its timeout (one stuck on a dead share, say); kill
    // whatever is left so shutdown never resolves with a transfer still running.
    forceStop();
    session.dispose();
    volumes.stop();
    await server.close();
  };
  const shutdown = () => (stopped ??= stop());

  server.post('/api/quit', async (_req, reply: FastifyReply) => {
    reply.send({ ok: true });
    setImmediate(() => void shutdown().then(() => opts.onQuit?.()));
    return reply;
  });

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await server.register(fastifyStatic, { root: opts.webRoot, prefix: '/' });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) reply.code(404).send({ error: 'Not found' });
      else reply.sendFile('index.html');
    });
  }

  return { server, session, queue, shutdown, clearStaleStaging: () => staging.clearAll() };
}
