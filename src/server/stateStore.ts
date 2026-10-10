import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
}

/** Small JSON file for remembering the last device and user settings across restarts. */
export class StateStore {
  private readonly file: string;
  private state: PersistedState = {};
  constructor(file = path.join(os.homedir(), '.config', 'pgmac-transfer', 'state.json')) {
    this.file = file;
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as PersistedState;
    } catch {
      this.state = {};
    }
  }

  get lastUsed(): LastUsedDevice | null {
    return this.state.lastUsed ?? null;
  }

  get downloadsDir(): string | null {
    return typeof this.state.downloadsDir === 'string' ? this.state.downloadsDir : null;
  }

  async setLastUsed(d: LastUsedDevice) {
    this.state.lastUsed = d;
    await this.save();
  }

  async setDownloadsDir(dir: string) {
    this.state.downloadsDir = dir;
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
