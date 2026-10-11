import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/server/app.ts';
import { StateStore } from '../src/server/stateStore.ts';
import {
  API_TOKEN_FORMAT_MESSAGE,
  resolveApiToken,
  startupLine,
  tokenMatches,
  tokenUrl,
} from '../src/server/token.ts';
import { decodeWireToken, encodeWireToken } from '../src/shared/token.ts';
import { FakeRunner } from './helpers.ts';

describe('resolveApiToken', () => {
  it('generates 32 random bytes as hex when API_TOKEN is unset, empty or blank', () => {
    for (const env of [{}, { API_TOKEN: '' }, { API_TOKEN: '   ' }]) {
      const t = resolveApiToken(env);
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(resolveApiToken(env)).not.toBe(t);
    }
  });

  it('keeps a set API_TOKEN, trimmed', () => {
    expect(resolveApiToken({ API_TOKEN: 'abc123-DEF_456xyz' })).toBe('abc123-DEF_456xyz');
    expect(resolveApiToken({ API_TOKEN: ' abc123-DEF_456xyz\n' })).toBe('abc123-DEF_456xyz');
    expect(resolveApiToken({ API_TOKEN: 'a'.repeat(16) })).toBe('a'.repeat(16));
  });

  it('refuses a set API_TOKEN that is too short or outside letters, digits, - and _', () => {
    for (const bad of [
      'a'.repeat(15),
      'abc/def-ghijklmnop',
      'abc def-ghijklmnop',
      'abcdefghijklmnop=',
    ]) {
      expect(() => resolveApiToken({ API_TOKEN: bad }), bad).toThrow(API_TOKEN_FORMAT_MESSAGE);
    }
  });
});

describe('tokenMatches', () => {
  it('accepts only the exact token', () => {
    expect(tokenMatches('abcd', 'abcd')).toBe(true);
    expect(tokenMatches('abce', 'abcd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abcde', 'abcd')).toBe(false);
    expect(tokenMatches('', 'abcd')).toBe(false);
    expect(tokenMatches(undefined, 'abcd')).toBe(false);
  });
});

describe('startupLine', () => {
  const origin = 'http://127.0.0.1:4848';
  const token = 'a'.repeat(64);

  it('prints the token link in browser and dev mode', () => {
    expect(startupLine(origin, token, false)).toBe(
      `PGMac Android Transfer is running at ${origin}/#token=${token}`,
    );
  });

  it('leaves the token out under Electron', () => {
    const line = startupLine(origin, token, true);
    expect(line).toBe(`PGMac Android Transfer is running at ${origin}`);
    expect(line).not.toContain(token);
  });
});

describe('tokenUrl', () => {
  it('puts the token in the fragment', () => {
    expect(tokenUrl('http://127.0.0.1:4848', 'ab12')).toBe('http://127.0.0.1:4848/#token=ab12');
  });
});

// RFC 7230 tchar: what a WebSocket subprotocol may contain.
const TCHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ODD_TOKEN = 'abc/def (x) é,"q";%41';

describe('wire token encoding', () => {
  it('leaves a generated hex token unchanged', () => {
    const t = resolveApiToken({});
    expect(encodeWireToken(t)).toBe(t);
  });

  it('makes any configured token subprotocol-safe and round-trips it', () => {
    for (const t of [ODD_TOKEN, 'a b', '()', '日本', 'x%y']) {
      const wire = encodeWireToken(t);
      expect(wire, t).toMatch(TCHARS);
      expect(decodeWireToken(wire)).toBe(t);
    }
  });

  it('rejects malformed percent-encoding', () => {
    expect(decodeWireToken('%zz')).toBeUndefined();
  });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ host: '127.0.0.1', port: 0 }, () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });

async function startApp(token: string) {
  const port = await freePort();
  const home = await mkdtemp(path.join(os.tmpdir(), 'pgmac-token-'));
  const webRoot = path.join(home, 'web');
  await mkdir(path.join(webRoot, 'assets'), { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  await mkdir(path.join(home, 'Docs'));
  const app = await buildApp({
    config: {
      port,
      defaultDeviceIp: null,
      maxConcurrent: 3,
      adbPath: '/nonexistent/adb',
      openBrowser: false,
      stateDir: null,
    },
    home,
    webRoot,
    store: new StateStore(path.join(home, 'state.json')),
    runner: new FakeRunner(),
    resolveAdb: async () => null,
    stagingRoot: path.join(home, 'staging'),
    reveal: () => undefined,
    token,
  });
  await app.server.listen({ host: '127.0.0.1', port });
  return { app, port, home };
}

/** Opens a real socket; resolves with the first message, or the HTTP status it was refused with. */
const openWs = (port: number, protocols?: string[], headers: Record<string, string> = {}) =>
  new Promise<{ status: number; protocol?: string; first?: { type: string } }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.once('message', (d) => {
      resolve({ status: 101, protocol: ws.protocol, first: JSON.parse(String(d)) });
      ws.close();
    });
    ws.once('error', () => resolve({ status: -1 }));
  });

describe('API with a token', () => {
  const TOKEN = 'a'.repeat(64);
  const WRONG_SAME_LENGTH = 'b'.repeat(64);
  const WRONG_SHORT = 'a'.repeat(10);
  let app: App;
  let port: number;
  let home: string;
  let H: { host: string };
  const bearer = (t: string) => ({ ...H, authorization: `Bearer ${t}` });

  beforeAll(async () => {
    ({ app, port, home } = await startApp(TOKEN));
    H = { host: `127.0.0.1:${port}` };
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it('refuses GET and POST without the right token, without echoing it', async () => {
    const mkdirUrl = '/api/fs/mac/mkdir';
    const payload = { path: path.join(home, 'Docs', 'New') };
    for (const headers of [H, bearer(WRONG_SAME_LENGTH), bearer(WRONG_SHORT), bearer('')]) {
      const get = await app.server.inject({ url: '/api/snapshot', headers });
      expect(get.statusCode).toBe(401);
      expect(get.json()).toEqual({ error: 'Unauthorized' });
      const post = await app.server.inject({ method: 'POST', url: mkdirUrl, headers, payload });
      expect(post.statusCode).toBe(401);
      expect(post.body).not.toContain(TOKEN);
    }
    // The refused POST did nothing.
    const list = await app.server.inject({
      url: `/api/fs/mac/list?path=${encodeURIComponent(path.join(home, 'Docs'))}`,
      headers: bearer(TOKEN),
    });
    expect(list.json().entries).toEqual([]);
  });

  it('answers with the right token', async () => {
    const r = await app.server.inject({ url: '/api/snapshot', headers: bearer(TOKEN) });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(TOKEN);
    const post = await app.server.inject({
      method: 'POST',
      url: '/api/transfers/clear',
      headers: bearer(TOKEN),
      payload: {},
    });
    expect(post.statusCode).toBe(200);
  });

  it('guards unknown /api paths and percent-encoded spellings of API routes', async () => {
    expect((await app.server.inject({ url: '/api/nope', headers: H })).statusCode).toBe(401);
    expect((await app.server.inject({ url: '/%61pi/snapshot', headers: H })).statusCode).toBe(401);
  });

  it('keeps the page itself public so it can load and show its message', async () => {
    for (const url of ['/', '/index.html', '/assets/app.js']) {
      const r = await app.server.inject({ url, headers: H });
      expect(r.statusCode, url).toBe(200);
    }
  });

  it('checks Host and Origin before the token', async () => {
    const forged = await app.server.inject({
      url: '/api/snapshot',
      headers: { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(forged.statusCode).toBe(403);
    const foreign = await app.server.inject({
      url: '/api/snapshot',
      headers: { ...bearer(TOKEN), origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    const forgedNoToken = await app.server.inject({
      url: '/',
      headers: { host: `evil.example:${port}` },
    });
    expect(forgedNoToken.statusCode).toBe(403);
  });

  it('refuses a WebSocket upgrade without the right token', async () => {
    expect((await openWs(port)).status).toBe(401);
    expect((await openWs(port, ['pgmac'])).status).toBe(401);
    expect((await openWs(port, ['pgmac', `token.${WRONG_SAME_LENGTH}`])).status).toBe(401);
    expect((await openWs(port, ['pgmac', `token.${WRONG_SHORT}`])).status).toBe(401);
  });

  it('accepts the token as a second subprotocol and selects pgmac', async () => {
    const r = await openWs(port, ['pgmac', `token.${TOKEN}`]);
    expect(r.status).toBe(101);
    expect(r.protocol).toBe('pgmac');
    expect(r.first?.type).toBe('snapshot');
  });

  it('refuses a WebSocket upgrade with a forged Host even with the right token', async () => {
    const r = await openWs(port, ['pgmac', `token.${TOKEN}`], { host: `evil.example:${port}` });
    expect(r.status).toBe(403);
  });
});

describe('API with a configured token outside the subprotocol alphabet', () => {
  let app: App;
  let port: number;

  beforeAll(async () => {
    ({ app, port } = await startApp(ODD_TOKEN));
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it('accepts it encoded over HTTP and the WebSocket, and refuses it raw-mangled', async () => {
    const H = { host: `127.0.0.1:${port}` };
    const ok = await app.server.inject({
      url: '/api/snapshot',
      headers: { ...H, authorization: `Bearer ${encodeWireToken(ODD_TOKEN)}` },
    });
    expect(ok.statusCode).toBe(200);
    const r = await openWs(port, ['pgmac', `token.${encodeWireToken(ODD_TOKEN)}`]);
    expect(r.status).toBe(101);
    expect(r.protocol).toBe('pgmac');
    const wrong = await app.server.inject({
      url: '/api/snapshot',
      headers: { ...H, authorization: `Bearer ${encodeWireToken(ODD_TOKEN + 'x')}` },
    });
    expect(wrong.statusCode).toBe(401);
  });
});
