import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appLogsDir,
  FileLog,
  LOG_FILE,
  LOG_MAX_BYTES,
  LineSplitter,
  OLD_LOG_FILE,
  logLine,
  redactedLines,
} from '../../electron/log.ts';

const TOKEN = 'tok_0123456789abcdef';
const AT = new Date('2026-10-11T12:00:00.000Z');

describe('LineSplitter', () => {
  it('returns whole lines and holds a partial one until its newline', () => {
    const s = new LineSplitter();
    expect(s.push('one\ntwo\r\nthr')).toEqual(['one', 'two']);
    expect(s.push('ee')).toEqual([]);
    expect(s.push('\nfour\n')).toEqual(['three', 'four']);
    expect(s.end()).toEqual([]);
  });

  it('flushes a trailing partial line when the stream ends', () => {
    const s = new LineSplitter();
    expect(s.push('done\nno newline')).toEqual(['done']);
    expect(s.end()).toEqual(['no newline']);
    expect(s.end()).toEqual([]);
  });
});

describe('redactedLines', () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, out: redactedLines(TOKEN, (l) => lines.push(l)) };
  };

  it('removes a token split across two chunks', () => {
    const { lines, out } = collect();
    out.write(`Open http://127.0.0.1:1/#token=${TOKEN.slice(0, 7)}`);
    out.write(`${TOKEN.slice(7)} in the window\n`);
    expect(lines).toEqual(['Open http://127.0.0.1:1/#token=[token] in the window']);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('handles several lines in one chunk and redacts each', () => {
    const { lines, out } = collect();
    out.write(`a ${TOKEN}\nb\nc ${TOKEN} ${TOKEN}\n`);
    expect(lines).toEqual(['a [token]', 'b', 'c [token] [token]']);
  });

  it('redacts a trailing partial line flushed at the end', () => {
    const { lines, out } = collect();
    out.write(`first\nlast ${TOKEN.slice(0, 3)}`);
    out.write(TOKEN.slice(3));
    expect(lines).toEqual(['first']);
    out.end();
    expect(lines).toEqual(['first', 'last [token]']);
  });
});

describe('FileLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgmac-log-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const read = (name = LOG_FILE) => fs.readFileSync(path.join(dir, name), 'utf8');

  it('prefixes each line with an ISO timestamp and its source', () => {
    expect(logLine(AT, 'server:err', 'boom')).toBe('2026-10-11T12:00:00.000Z [server:err] boom\n');
    const log = new FileLog(path.join(dir, 'Logs'), { now: () => AT });
    log.write('main', 'Starting');
    log.write('server', 'line one\nline two');
    expect(log.file).toBe(path.join(dir, 'Logs', LOG_FILE));
    expect(fs.readFileSync(log.file!, 'utf8')).toBe(
      '2026-10-11T12:00:00.000Z [main] Starting\n' +
        '2026-10-11T12:00:00.000Z [server] line one\n' +
        '2026-10-11T12:00:00.000Z [server] line two\n',
    );
  });

  it('keeps the token out of the file when fed through redactedLines', () => {
    const log = new FileLog(dir);
    const out = redactedLines(TOKEN, (l) => log.write('server', l));
    out.write(`token ${TOKEN.slice(0, 5)}`);
    out.write(`${TOKEN.slice(5)}\ntail ${TOKEN}`);
    out.end();
    expect(read()).not.toContain(TOKEN);
    expect(read()).toMatch(/\[server\] token \[token\]\n.*\[server\] tail \[token\]\n$/);
  });

  it('rotates to main.old.log once the file is over the limit, replacing an old one', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    fs.writeFileSync(path.join(dir, OLD_LOG_FILE), 'older\n');
    const log = new FileLog(dir, { maxBytes: 100, now: () => AT });
    const line = 'x'.repeat(40);
    log.write('main', line);
    // Over the limit now, but the check runs before a write, so nothing has moved yet.
    log.write('main', line);
    expect(fs.existsSync(path.join(dir, OLD_LOG_FILE))).toBe(true);
    expect(read(OLD_LOG_FILE)).toBe('older\n');
    log.write('main', 'after');
    expect(read(OLD_LOG_FILE)).toBe(logLine(AT, 'main', line).repeat(2));
    expect(read()).toBe(logLine(AT, 'main', 'after'));
  });

  it('does not rotate a file at exactly the limit', () => {
    const log = new FileLog(dir, { maxBytes: logLine(AT, 'main', 'a').length, now: () => AT });
    log.write('main', 'a');
    log.write('main', 'b');
    expect(fs.existsSync(path.join(dir, OLD_LOG_FILE))).toBe(false);
  });

  it('swallows write failures when the log folder sits under a file', () => {
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, '');
    const log = new FileLog(path.join(blocker, 'Logs'));
    expect(() => log.write('main', 'hello')).not.toThrow();
    expect(() => log.writeLines('server', ['a', 'b'])).not.toThrow();
    expect(() => log.ensureFile()).not.toThrow();
  });

  it('is a no-op when the log folder cannot be resolved', () => {
    const log = new FileLog(() => {
      throw new Error('no logs path');
    });
    expect(log.file).toBeNull();
    expect(() => log.write('main', 'hello')).not.toThrow();
    expect(log.ensureFile()).toBeNull();
  });

  it('creates an empty file to reveal, and leaves an existing one alone', () => {
    const log = new FileLog(path.join(dir, 'Logs'));
    const file = log.ensureFile();
    expect(file).toBe(path.join(dir, 'Logs', LOG_FILE));
    expect(fs.readFileSync(file!, 'utf8')).toBe('');
    log.write('main', 'kept');
    log.ensureFile();
    expect(fs.readFileSync(file!, 'utf8')).toMatch(/\[main\] kept\n$/);
  });
});

describe('log folder', () => {
  const main = () =>
    fs.readFileSync(path.join(import.meta.dirname, '../../electron/main.ts'), 'utf8');

  it('is named after the app, under ~/Library/Logs', () => {
    expect(appLogsDir('/Users/pat')).toBe('/Users/pat/Library/Logs/PGMac Android Transfer');
  });

  it('is set before the log first reads it', () => {
    const src = main();
    const set = src.indexOf("app.setAppLogsPath(appLogsDir(app.getPath('home')))");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(src.indexOf("new FileLog(() => app.getPath('logs'))"));
  });

  it('leaves the app name, and so the userData folder holding settings, as it was', () => {
    const src = main();
    expect(src).not.toMatch(/app\.setName\(|app\.name\s*=[^=]/);
    expect(src).not.toMatch(/setPath\(\s*'userData'/);
  });
});
