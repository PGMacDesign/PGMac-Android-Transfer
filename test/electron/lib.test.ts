import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_TAIL_LINES,
  OutputTail,
  START_FAILED_HEADING,
  chooseFileHandler,
  failurePage,
  isListeningMessage,
  pickFreePort,
  redact,
  serverEnv,
  windowUrl,
  type OpenDialogResult,
} from '../../electron/lib.ts';
import { resolveApiToken } from '../../src/server/token.ts';

const listenOn = (port: number) =>
  new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ host: '127.0.0.1', port }, () => resolve(s));
  });

describe('pickFreePort', () => {
  it('returns a port in range that can be bound on 127.0.0.1', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    const s = await listenOn(port);
    await new Promise((r) => s.close(r));
  });
});

describe('serverEnv', () => {
  it('adds the port, disables the browser and forwards the pool size the server would use', async () => {
    const env = serverEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/me' }, 51234, '/data', 'tok');
    expect(env.PORT).toBe('51234');
    expect(env.OPEN_BROWSER).toBe('0');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/me');
    // lib.ts imports threadpool.ts, so this process carries the value the server would set.
    expect(env.UV_THREADPOOL_SIZE).toBe(process.env.UV_THREADPOOL_SIZE);
    expect(Number(env.UV_THREADPOOL_SIZE)).toBeGreaterThan(4);
  });

  it("keeps the user's own UV_THREADPOOL_SIZE, as threadpool.ts does", () => {
    expect(serverEnv({ UV_THREADPOOL_SIZE: '12' }, 1, '/data', 'tok').UV_THREADPOOL_SIZE).toBe(
      '12',
    );
  });

  it("overrides the parent's PORT and OPEN_BROWSER", () => {
    const env = serverEnv({ PORT: '4848', OPEN_BROWSER: '1' }, 50000, '/data', 'tok');
    expect(env.PORT).toBe('50000');
    expect(env.OPEN_BROWSER).toBe('0');
  });

  it("passes the launch's token as API_TOKEN, over the parent's", () => {
    expect(serverEnv({}, 1, '/data', 'abc123').API_TOKEN).toBe('abc123');
    expect(serverEnv({ API_TOKEN: 'old' }, 1, '/data', 'abc123').API_TOKEN).toBe('abc123');
  });

  it("points STATE_DIR at the userData folder it is given, over the parent's", () => {
    const userData = '/Users/me/Library/Application Support/PGMac Android Transfer';
    expect(serverEnv({}, 1, userData, 'tok').STATE_DIR).toBe(userData);
    expect(serverEnv({ STATE_DIR: '/elsewhere' }, 1, userData, 'tok').STATE_DIR).toBe(userData);
  });
});

describe('chooseFileHandler', () => {
  const win = { webContents: { id: 1 } };
  const handler = (result: OpenDialogResult, appWindow: typeof win | null = win) => {
    const showOpenDialog = vi.fn(async () => result);
    return {
      showOpenDialog,
      handle: chooseFileHandler({ appWindow: () => appWindow, showOpenDialog }),
    };
  };

  it('opens a files-only picker on the app window and returns the chosen path', async () => {
    const h = handler({ canceled: false, filePaths: ['/opt/homebrew/bin/adb'] });
    expect(await h.handle({ sender: win.webContents })).toBe('/opt/homebrew/bin/adb');
    expect(h.showOpenDialog).toHaveBeenCalledExactlyOnceWith(win, { properties: ['openFile'] });
  });

  it('returns null when cancelled or nothing was chosen', async () => {
    expect(
      await handler({ canceled: true, filePaths: ['/x'] }).handle({ sender: win.webContents }),
    ).toBeNull();
    expect(
      await handler({ canceled: false, filePaths: [] }).handle({ sender: win.webContents }),
    ).toBeNull();
  });

  it('opens nothing for another sender or with no window', async () => {
    const other = handler({ canceled: false, filePaths: ['/x'] });
    expect(await other.handle({ sender: {} })).toBeNull();
    expect(other.showOpenDialog).not.toHaveBeenCalled();
    const closed = handler({ canceled: false, filePaths: ['/x'] }, null);
    expect(await closed.handle({ sender: win.webContents })).toBeNull();
    expect(closed.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('isListeningMessage', () => {
  it('accepts only a listening message for the chosen port', () => {
    expect(isListeningMessage({ type: 'listening', port: 5000 }, 5000)).toBe(true);
    expect(isListeningMessage({ type: 'listening', port: 5001 }, 5000)).toBe(false);
    expect(isListeningMessage({ type: 'other', port: 5000 }, 5000)).toBe(false);
    expect(isListeningMessage(null, 5000)).toBe(false);
    expect(isListeningMessage('listening', 5000)).toBe(false);
  });
});

describe('OutputTail', () => {
  it('keeps only the last 50 lines', () => {
    const tail = new OutputTail();
    expect(tail.limit).toBe(OUTPUT_TAIL_LINES);
    expect(OUTPUT_TAIL_LINES).toBe(50);
    for (let i = 1; i <= 120; i++) tail.write('stdout', `line ${i}\n`);
    const lines = tail.lines();
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 71');
    expect(lines.at(-1)).toBe('line 120');
  });

  it('joins lines split across chunks and keeps streams apart', () => {
    const tail = new OutputTail(10);
    tail.write('stdout', 'hel');
    tail.write('stderr', 'Error: ');
    tail.write('stdout', 'lo\r\nwor');
    tail.write('stderr', 'boom\n');
    expect(tail.lines()).toEqual(['hello', 'Error: boom', 'wor']);
  });

  it('caps a single chunk with many lines', () => {
    const tail = new OutputTail(3);
    tail.write('stderr', 'a\nb\nc\nd\ne\n');
    expect(tail.lines()).toEqual(['c', 'd', 'e']);
  });
});

describe('failurePage', () => {
  it('shows the heading and escaped output', () => {
    const html = failurePage(START_FAILED_HEADING, ['<script>alert(1)</script>', 'Port in use']);
    expect(html).toContain('<h1>PGMac Android Transfer couldn&#39;t start its server.</h1>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;\nPort in use');
    expect(html).not.toContain('<script>');
  });
});

describe('windowUrl', () => {
  it('loads the server with the token the server was given in the fragment', () => {
    const token = resolveApiToken({});
    const env = serverEnv({}, 51234, '/data', token);
    expect(windowUrl(51234, token)).toBe(`http://127.0.0.1:51234/#token=${env.API_TOKEN}`);
  });
});

describe('redact', () => {
  it('hides every copy of the token', () => {
    expect(redact('a tok b tok', 'tok')).toBe('a [token] b [token]');
    expect(redact('nothing here', 'tok')).toBe('nothing here');
  });
});
