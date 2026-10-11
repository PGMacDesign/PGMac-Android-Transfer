import './threadpool.ts';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { announceListening, type ParentPortLike } from './readiness.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig(root);
const dev = process.env.PGMAC_DEV === '1';

const app = await buildApp({
  config,
  home: os.homedir(),
  webRoot: dev ? undefined : path.join(root, 'dist', 'web'),
  dev,
  onQuit: () => process.exit(0),
});

try {
  await app.server.listen({ host: '127.0.0.1', port: config.port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Is PGMac Android Transfer already running? ` +
        `Open http://127.0.0.1:${config.port} or set PORT in .env.`,
    );
    process.exit(1);
  }
  throw err;
}

await app.clearStaleStaging();
// After the cleanup, like the browser open below: a page opened sooner could start an upload
// whose staging files the cleanup then deletes.
announceListening(config.port, (process as { parentPort?: ParentPortLike }).parentPort);

const url = `http://127.0.0.1:${dev ? 5173 : config.port}`;
console.log(`PGMac Android Transfer is running at ${url}`);
console.log('Press Ctrl+C to stop.');
if (config.openBrowser && !dev) {
  open(url).catch(() => console.log(`Open ${url} in your browser.`));
}

let stopping = false;
const stop = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nStopping: cancelling transfers and disconnecting…');
  await app.shutdown();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
