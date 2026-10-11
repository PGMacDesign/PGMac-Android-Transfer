import './threadpool.ts';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import {
  activeJobCount,
  listenForForceStop,
  listenForQuit,
  stopOnSignal,
  trashThroughParent,
  type QuitPort,
  type TrashPort,
} from './parentPort.ts';
import { announceListening, type ParentPortLike } from './readiness.ts';
import { openStateStore } from './stateStore.ts';
import { resolveApiToken, startupLine, tokenUrl } from './token.ts';
import { forceStop } from './transfers/children.ts';

// Every way out of this process, including process.exit with transfers running, passes here;
// only synchronous work is possible, which is all forceStop does.
process.on('exit', forceStop);
const parentPort = (process as { parentPort?: ParentPortLike & QuitPort & TrashPort }).parentPort;
listenForForceStop(parentPort, { forceStop, exit: (code) => process.exit(code) });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig(root);
const dev = process.env.PGMAC_DEV === '1';
// After loadConfig, so an API_TOKEN in .env counts. `npm run dev` and the desktop app pass
// their own in the environment, which .env never overrides.
let token: string;
try {
  token = resolveApiToken(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = await buildApp({
  config,
  home: os.homedir(),
  store: openStateStore(config.stateDir),
  webRoot: dev ? undefined : path.join(root, 'dist', 'web'),
  dev,
  token,
  trash: parentPort ? trashThroughParent(parentPort) : undefined,
  onQuit: () => process.exit(0),
});
listenForQuit(parentPort, {
  activeCount: () => activeJobCount(app.queue.jobs()),
  shutdown: app.shutdown,
  exit: (code) => process.exit(code),
});

try {
  await app.server.listen({ host: '127.0.0.1', port: config.port });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Is PGMac Android Transfer already running? ` +
        `Open the link it printed, or set PORT in .env.`,
    );
    process.exit(1);
  }
  throw err;
}

await app.clearStaleStaging();
// After the cleanup, like the browser open below: a page opened sooner could start an upload
// whose staging files the cleanup then deletes.
announceListening(config.port, parentPort);

const origin = `http://127.0.0.1:${dev ? 5173 : config.port}`;
const url = tokenUrl(origin, token);
console.log(startupLine(origin, token, parentPort !== undefined));
console.log('Press Ctrl+C to stop.');
if (config.openBrowser && !dev) {
  open(url).catch(() => console.log(`Open ${url} in your browser.`));
}

const stop = stopOnSignal({
  desktop: parentPort !== undefined,
  shutdown: app.shutdown,
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
