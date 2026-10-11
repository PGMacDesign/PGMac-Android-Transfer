import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bonjourAvailable, bonjourServices } from './bonjour.ts';
import {
  parseBattery,
  parseConnectResult,
  parseDevices,
  parseMdnsServices,
  parsePairResult,
  parseStatfs,
  type AttachedDevice,
  type MdnsService,
} from './parse.ts';
import type { BatteryInfo, StorageInfo } from '../../shared/protocol.ts';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class AdbError extends Error {
  readonly result: ExecResult | null;
  constructor(message: string, result: ExecResult | null = null) {
    super(message);
    this.name = 'AdbError';
    this.result = result;
  }
}

/** Quotes a string for a POSIX shell (the device's `sh`). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where to look for adb. Injectable so the search order can be tested without the real filesystem. */
export interface AdbSearch {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Fixed install folders holding `adb`, checked after PATH. */
  fixedBins?: string[];
}

// A Dock or Finder launch gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which misses
// Homebrew, so its bin folders (Apple silicon, then Intel) are checked explicitly.
export const HOMEBREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * Lists adb candidates in priority order: the explicit path, PATH, Homebrew, $ANDROID_HOME and
 * $ANDROID_SDK_ROOT, then the default SDK locations.
 */
export function adbCandidates(explicit: string | undefined, search: AdbSearch = {}): string[] {
  const env = search.env ?? process.env;
  const home = search.home ?? os.homedir();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'adb'));
  }
  for (const dir of search.fixedBins ?? HOMEBREW_BINS) candidates.push(path.join(dir, 'adb'));
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const v = env[name];
    if (v) candidates.push(path.join(v, 'platform-tools', 'adb'));
  }
  candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  candidates.push(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));
  return candidates;
}

/** Returns the first executable candidate from `adbCandidates`, or null. */
export async function resolveAdbPath(
  explicit: string | undefined,
  search: AdbSearch = {},
): Promise<string | null> {
  for (const c of adbCandidates(explicit, search)) {
    if (await isExecutable(c)) return c;
  }
  return null;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Kills the adb client when aborted. */
  signal?: AbortSignal;
}

/**
 * Thin wrapper over the adb CLI. Arguments are passed as an argv array (never through a
 * local shell); commands that run on the device go through `shell()` with explicit quoting.
 */
export class Adb {
  /** Null until adb is found; `POST /api/adb/recheck` can set it later. */
  bin: string | null;
  constructor(bin: string | null) {
    this.bin = bin;
  }

  private requireBin(): string {
    if (!this.bin) throw new AdbError('adb was not found. Install Android platform tools.');
    return this.bin;
  }

  exec(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    let bin: string;
    try {
      bin = this.requireBin();
    } catch (err) {
      return Promise.reject(err);
    }
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
      } catch (err) {
        reject(new AdbError(`Could not run adb: ${(err as Error).message}`));
        return;
      }
      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        size += d.length;
        if (size > maxBuffer) child.kill('SIGKILL');
        else out.push(d);
      });
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new AdbError(`Could not run adb: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          timedOut,
        });
      });
    });
  }

  /** Spawns a long-running adb command (push/pull). */
  spawn(args: string[]): ChildProcess {
    return spawn(this.requireBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.exec(['version'], { timeoutMs: 5000 });
      return /Version\s+(\S+)/.exec(r.stdout)?.[1] ?? /version\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async devices(): Promise<AttachedDevice[]> {
    const r = await this.exec(['devices', '-l'], { timeoutMs: 8000 });
    return parseDevices(r.stdout);
  }

  async mdnsServices(): Promise<MdnsService[]> {
    const [fromAdb, fromBonjour] = await Promise.all([
      this.exec(['mdns', 'services'], { timeoutMs: 8000 }).then((r) => parseMdnsServices(r.stdout)),
      bonjourAvailable() ? bonjourServices().catch(() => []) : [],
    ]);
    const seen = new Set(fromAdb.map((s) => `${s.kind}:${s.instance}`));
    return [...fromAdb, ...fromBonjour.filter((s) => !seen.has(`${s.kind}:${s.instance}`))];
  }

  async connect(addr: string, timeoutMs = 15_000): Promise<boolean> {
    const r = await this.exec(['connect', addr], { timeoutMs });
    return parseConnectResult(r.stdout + r.stderr);
  }

  async disconnect(serial: string): Promise<void> {
    await this.exec(['disconnect', serial], { timeoutMs: 5000 }).catch(() => undefined);
  }

  async pair(addr: string, code: string) {
    const r = await this.exec(['pair', addr, code], { timeoutMs: 30_000 });
    return parsePairResult(r.stdout + '\n' + r.stderr);
  }

  async getState(serial: string, timeoutMs = 2500): Promise<string | null> {
    try {
      const r = await this.exec(['-s', serial, 'get-state'], { timeoutMs });
      if (r.code !== 0 || r.timedOut) return null;
      return r.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Runs `cmd` with the device's shell. Callers quote paths with `shQuote`. */
  shell(serial: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.exec(['-s', serial, 'shell', cmd], opts);
  }

  async getprop(serial: string, key: string): Promise<string> {
    const r = await this.shell(serial, `getprop ${shQuote(key)}`, { timeoutMs: 5000 });
    return r.stdout.trim();
  }

  async battery(serial: string): Promise<BatteryInfo | null> {
    const r = await this.shell(serial, 'dumpsys battery', { timeoutMs: 8000 });
    return r.code === 0 ? parseBattery(r.stdout) : null;
  }

  async storage(serial: string, dir = '/sdcard/'): Promise<StorageInfo | null> {
    const r = await this.shell(serial, `stat -f -c '%a %b %S' ${shQuote(dir)}`, {
      timeoutMs: 8000,
    });
    return r.code === 0 ? parseStatfs(r.stdout) : null;
  }
}
