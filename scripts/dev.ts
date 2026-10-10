// Runs the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const env = { ...process.env, PGMAC_DEV: '1' };
const procs = [
  spawn(process.execPath, ['--watch', 'src/server/index.ts'], { stdio: 'inherit', env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGINT');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
