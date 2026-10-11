import fs from 'node:fs';
import path from 'node:path';
import { redact } from './lib.ts';

export const LOG_FILE = 'main.log';
export const OLD_LOG_FILE = 'main.old.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export type LogSource = 'main' | 'server' | 'server:err';

/**
 * `~/Library/Logs/PGMac Android Transfer`. Electron names the default logs folder after
 * `app.name`, which comes from package.json's `name`. Renaming the app with `app.setName` would
 * fix that but also move `userData`, which Electron derives from the same name and which holds
 * the settings and window state, so only the logs folder is pointed at the display name.
 */
export function appLogsDir(home: string): string {
  return path.join(home, 'Library', 'Logs', 'PGMac Android Transfer');
}

/** Splits a stream's chunks into whole lines, holding a partial line until its newline. */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    const parts = (this.pending + chunk).split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    return parts;
  }

  /** The held partial line, if any, once the stream has ended. */
  end(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? [] : [rest];
  }
}

/**
 * Feeds a stream's output to `onLine` one redacted line at a time. Redacting whole lines rather
 * than chunks is what catches a token the pipe happened to split across two chunks.
 */
export function redactedLines(
  token: string,
  onLine: (line: string) => void,
): { write: (chunk: string) => void; end: () => void } {
  const splitter = new LineSplitter();
  const emit = (lines: string[]) => {
    for (const line of lines) onLine(redact(line, token));
  };
  return {
    write: (chunk) => emit(splitter.push(chunk)),
    end: () => emit(splitter.end()),
  };
}

export function logLine(at: Date, source: LogSource, text: string): string {
  return `${at.toISOString()} [${source}] ${text}\n`;
}

export interface FileLogOptions {
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Appends to `main.log` in `dir`, moving it to `main.old.log` once it passes `maxBytes`. Every
 * failure is swallowed: a Dock-launched app has nowhere to report a broken log, and the log
 * must never take the app down with it.
 */
export class FileLog {
  /** Null when the log folder couldn't be found; every call is then a no-op. */
  readonly file: string | null;
  private readonly oldFile: string | null;
  private readonly dir: string | null;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(dir: string | (() => string), opts: FileLogOptions = {}) {
    let resolved: string | null;
    try {
      resolved = typeof dir === 'function' ? dir() : dir;
    } catch {
      resolved = null;
    }
    this.dir = resolved;
    this.file = resolved === null ? null : path.join(resolved, LOG_FILE);
    this.oldFile = resolved === null ? null : path.join(resolved, OLD_LOG_FILE);
    this.maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  /** Writes `text`, one entry per line so a multi-line message keeps its prefix on each. */
  write(source: LogSource, text: string): void {
    this.writeLines(source, text.split(/\r?\n/));
  }

  writeLines(source: LogSource, lines: string[]): void {
    if (this.file === null || lines.length === 0) return;
    const at = this.now();
    try {
      this.rotateIfFull();
      this.makeDir();
      fs.appendFileSync(this.file, lines.map((l) => logLine(at, source, l)).join(''));
    } catch {
      // See the class comment.
    }
  }

  /** The log's path, created empty if it doesn't exist yet, for revealing in Finder. */
  ensureFile(): string | null {
    if (this.file === null) return null;
    try {
      this.makeDir();
      fs.appendFileSync(this.file, '');
    } catch {
      // Revealing a missing file just shows its folder, or nothing.
    }
    return this.file;
  }

  private makeDir(): void {
    if (this.dir !== null) fs.mkdirSync(this.dir, { recursive: true });
  }

  private rotateIfFull(): void {
    if (this.file === null || this.oldFile === null) return;
    try {
      if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, this.oldFile);
    } catch {
      // No file yet, or the rename failed: the line is still written, to the current file.
    }
  }
}
