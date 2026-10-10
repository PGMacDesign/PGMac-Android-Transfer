import { existsSync } from 'node:fs';
import path from 'node:path';
import { MAX_CONCURRENT_LIMIT } from '../shared/protocol.ts';

export interface Config {
  port: number;
  defaultDeviceIp: string | null;
  maxConcurrent: number;
  adbPath: string | undefined;
  openBrowser: boolean;
}

/** Loads `.env` from the project root (if present) and reads config from the environment. */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = path.join(root, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const port = Number(env.PORT || 4848);
  const max = Number(env.MAX_CONCURRENT_TRANSFERS || 3);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4848,
    defaultDeviceIp: env.DEFAULT_DEVICE_IP?.trim() || null,
    maxConcurrent: clampConcurrency(Number.isFinite(max) ? max : 3),
    adbPath: env.ADB_PATH?.trim() || undefined,
    openBrowser: !/^(0|false|no|off)$/i.test(env.OPEN_BROWSER?.trim() ?? ''),
  };
}

export function clampConcurrency(n: number): number {
  return Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(n)));
}
