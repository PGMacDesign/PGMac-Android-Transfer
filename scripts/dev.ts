// Runs the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiToken, tokenUrl } from '../src/server/token.ts';

export const DEV_ORIGIN = 'http://127.0.0.1:5173';

/**
 * The environment for both children. The token is resolved here, once, rather than by the
 * server: `--watch` restarts the server on every change, and a token it generated itself would
 * change with each restart and lock out the open tab.
 */
export function devEnv(parent: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...parent, PGMAC_DEV: '1', API_TOKEN: token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Read here too so an API_TOKEN set in .env is the one the server and the printed link share.
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const token = resolveApiToken(process.env);
  const env = devEnv(process.env, token);
  const procs = [
    spawn(process.execPath, ['--watch', 'src/server/index.ts'], { stdio: 'inherit', env }),
    spawn('npx', ['vite'], { stdio: 'inherit', env }),
  ];
  console.log(`Open ${tokenUrl(DEV_ORIGIN, token)}`);

  const stop = () => {
    for (const p of procs) p.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const p of procs) p.on('exit', (code) => code && stop());
}
