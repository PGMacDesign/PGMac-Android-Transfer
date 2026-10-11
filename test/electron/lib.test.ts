import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_TAIL_LINES,
  OutputTail,
  START_FAILED_HEADING,
  failurePage,
  isListeningMessage,
  pickFreePort,
  serverEnv,
} from '../../electron/lib.ts';

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
    const env = serverEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/me' }, 51234);
    expect(env.PORT).toBe('51234');
    expect(env.OPEN_BROWSER).toBe('0');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/me');
    // lib.ts imports threadpool.ts, so this process carries the value the server would set.
    expect(env.UV_THREADPOOL_SIZE).toBe(process.env.UV_THREADPOOL_SIZE);
    expect(Number(env.UV_THREADPOOL_SIZE)).toBeGreaterThan(4);
  });

  it("keeps the user's own UV_THREADPOOL_SIZE, as threadpool.ts does", () => {
    expect(serverEnv({ UV_THREADPOOL_SIZE: '12' }, 1).UV_THREADPOOL_SIZE).toBe('12');
  });

  it("overrides the parent's PORT and OPEN_BROWSER", () => {
    const env = serverEnv({ PORT: '4848', OPEN_BROWSER: '1' }, 50000);
    expect(env.PORT).toBe('50000');
    expect(env.OPEN_BROWSER).toBe('0');
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
