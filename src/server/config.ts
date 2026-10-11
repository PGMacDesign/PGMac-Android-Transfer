import { existsSync } from 'node:fs';
import path from 'node:path';
import { MAX_CONCURRENT_LIMIT } from '../shared/protocol.ts';

export interface Config {
  port: number;
  /** From `DEFAULT_DEVICE_IP`; a saved setting overrides it (see `effectiveSettings`). */
  defaultDeviceIp: string | null;
  maxConcurrent: number;
  /** From `ADB_PATH`; a saved setting overrides it (see `effectiveSettings`). */
  adbPath: string | undefined;
  openBrowser: boolean;
  /** Folder holding `state.json`; null keeps the default location. */
  stateDir: string | null;
}

/** Loads `.env` from the project root (if present) and reads config from the environment. */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = path.join(root, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const port = Number(env.PORT || 4848);
  const max = Number(env.MAX_CONCURRENT_TRANSFERS || 3);
  const stateDir = env.STATE_DIR?.trim();
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4848,
    defaultDeviceIp: env.DEFAULT_DEVICE_IP?.trim() || null,
    maxConcurrent: clampConcurrency(Number.isFinite(max) ? max : 3),
    adbPath: env.ADB_PATH?.trim() || undefined,
    openBrowser: !/^(0|false|no|off)$/i.test(env.OPEN_BROWSER?.trim() ?? ''),
    stateDir: stateDir ? path.resolve(stateDir) : null,
  };
}

export function clampConcurrency(n: number): number {
  return Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(n)));
}

export interface SavedSettings {
  defaultDeviceIp: string | null;
  adbPath: string | null;
}

export interface EffectiveSettings {
  defaultDeviceIp: string | null;
  /** Undefined lets adb discovery search PATH and the SDK locations. */
  adbPath: string | undefined;
}

/**
 * The desktop app can't edit `.env`, so a value saved through the settings API wins over the
 * environment, which wins over the built-in default.
 */
export function effectiveSettings(
  saved: SavedSettings,
  env: Pick<Config, 'defaultDeviceIp' | 'adbPath'>,
): EffectiveSettings {
  return {
    defaultDeviceIp: saved.defaultDeviceIp ?? env.defaultDeviceIp ?? null,
    adbPath: saved.adbPath ?? env.adbPath ?? undefined,
  };
}
