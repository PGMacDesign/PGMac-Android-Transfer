import { app, BrowserWindow, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import {
  OutputTail,
  SERVER_HOST,
  START_FAILED_HEADING,
  STOPPED_HEADING,
  dataUrl,
  failurePage,
  isListeningMessage,
  pickFreePort,
  serverEnv,
} from './lib.ts';

const serverEntry = path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts');
const preload = path.join(import.meta.dirname, 'preload.cjs');

// How long the server gets to cancel transfers and disconnect before it is killed outright.
const STOP_GRACE_MS = 5000;
// Output written just before exit can still be in the pipe when `exit` fires.
const OUTPUT_DRAIN_MS = 500;

let mainWindow: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let serverRunning = false;
let quitting = false;
let stopAttempted = false;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'PGMac Android Transfer',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload,
    },
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function showFailure(heading: string, lines: string[]): void {
  mainWindow ??= createWindow();
  void mainWindow.loadURL(dataUrl(failurePage(heading, lines)));
}

function drained(streams: NodeJS.ReadableStream[]): Promise<void> {
  const ended = streams.map((s) => new Promise<void>((resolve) => s.once('end', resolve)));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, OUTPUT_DRAIN_MS));
  return Promise.race([Promise.all(ended).then(() => {}), timeout]);
}

async function startServer(): Promise<void> {
  const port = await pickFreePort();
  const tail = new OutputTail();
  // Forked exactly once per launch. A server that dies is reported, never silently restarted.
  const child = utilityProcess.fork(serverEntry, [], {
    env: serverEnv(process.env, port),
    stdio: 'pipe',
    serviceName: 'PGMac Android Transfer server',
  });
  server = child;
  serverRunning = true;

  // Captured now because the child's stream properties go null once it exits.
  const streams: NodeJS.ReadableStream[] = [];
  for (const [name, stream, echo] of [
    ['stdout', child.stdout, process.stdout],
    ['stderr', child.stderr, process.stderr],
  ] as const) {
    if (!stream) continue;
    streams.push(stream);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      tail.write(name, chunk);
      echo.write(chunk);
    });
  }

  let listening = false;
  child.on('message', (message: unknown) => {
    if (listening || !isListeningMessage(message, port)) return;
    listening = true;
    mainWindow = createWindow();
    void mainWindow.loadURL(`http://${SERVER_HOST}:${port}`);
  });

  child.once('exit', (code) => {
    serverRunning = false;
    if (quitting) return;
    void drained(streams).then(() => {
      if (quitting) return;
      const lines = [...tail.lines(), `(exit code ${code})`].slice(-tail.limit);
      if (!listening) showFailure(START_FAILED_HEADING, lines);
      else if (mainWindow) showFailure(STOPPED_HEADING, lines);
    });
  });
}

function stopServer(child: UtilityProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!serverRunning) return resolve();
    const giveUp = setTimeout(resolve, STOP_GRACE_MS * 2);
    const kill = setTimeout(() => {
      // The graceful stop hung (a stuck adb call, say); don't leave a listener behind.
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(kill);
      clearTimeout(giveUp);
      resolve();
    });
    // SIGTERM, which the server handles by cancelling transfers and disconnecting first.
    child.kill();
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  if (!server || !serverRunning || stopAttempted) return;
  stopAttempted = true;
  event.preventDefault();
  void stopServer(server).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    quitting = true;
    app.quit();
  });
}

app
  .whenReady()
  .then(startServer)
  .catch((err: unknown) => {
    showFailure(START_FAILED_HEADING, [String(err instanceof Error ? (err.stack ?? err) : err)]);
  });
