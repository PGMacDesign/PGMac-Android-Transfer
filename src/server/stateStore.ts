import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LastUsedDevice {
  serial: string;
  host: string | null;
  model: string;
}

interface PersistedState {
  lastUsed?: LastUsedDevice;
  downloadsDir?: string;
  defaultDeviceIp?: string;
  adbPath?: string;
}

export const defaultStateFile = (home = os.homedir()) =>
  path.join(home, '.config', 'pgmac-transfer', 'state.json');

/**
 * The store for a `STATE_DIR` (or the default location when null). A store in a new folder
 * starts from the default location's file, so moving the folder keeps earlier settings.
 */
export function openStateStore(stateDir: string | null, home = os.homedir()): StateStore {
  const legacy = defaultStateFile(home);
  if (!stateDir) return new StateStore(legacy);
  return new StateStore(path.join(stateDir, 'state.json'), legacy);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Small JSON file for remembering the last device and user settings across restarts. */
export class StateStore {
  private readonly file: string;
  private readonly importFrom: string | undefined;
  private state: PersistedState = {};
  constructor(file = defaultStateFile(), importFrom?: string) {
    this.file = file;
    this.importFrom = importFrom;
  }

  async load() {
    if (this.importFrom && this.importFrom !== this.file) await this.importOnce(this.importFrom);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      this.state = parsed && typeof parsed === 'object' ? (parsed as PersistedState) : {};
    } catch {
      this.state = {};
    }
  }

  private async importOnce(from: string) {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      // EXCL: an existing file in the new folder is newer than the old one and must win.
      await copyFile(from, this.file, constants.COPYFILE_EXCL);
    } catch {
      // No old file, or the new one already exists: nothing to import.
    }
  }

  get lastUsed(): LastUsedDevice | null {
    return this.state.lastUsed ?? null;
  }

  get downloadsDir(): string | null {
    return str(this.state.downloadsDir);
  }

  get defaultDeviceIp(): string | null {
    return str(this.state.defaultDeviceIp);
  }

  get adbPath(): string | null {
    return str(this.state.adbPath);
  }

  async setLastUsed(d: LastUsedDevice) {
    this.state.lastUsed = d;
    await this.save();
  }

  async setDownloadsDir(dir: string) {
    this.state.downloadsDir = dir;
    await this.save();
  }

  /** Null forgets the saved value, so the environment or default applies again. */
  async setDefaultDeviceIp(ip: string | null) {
    if (ip === null) delete this.state.defaultDeviceIp;
    else this.state.defaultDeviceIp = ip;
    await this.save();
  }

  /** Null forgets the saved value, so the environment or default applies again. */
  async setAdbPath(p: string | null) {
    if (p === null) delete this.state.adbPath;
    else this.state.adbPath = p;
    await this.save();
  }

  private async save() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      // Persisting is a convenience; never fail a connect or a settings change over it.
    }
  }
}
