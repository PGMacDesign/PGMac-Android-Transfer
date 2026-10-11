import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import path from 'node:path';
import {
  OutputTail,
  SERVER_HOST,
  START_FAILED_HEADING,
  STOPPED_HEADING,
  chooseFileHandler,
  dataUrl,
  failurePage,
  isListeningMessage,
  pickFreePort,
  serverEnv,
} from './lib.ts';
import { dragOutHandler, fallbackDragIcon } from './dragOut.ts';
import { isExternalUrl } from './links.ts';
import { appMenuTemplate } from './menu.ts';
import { loadWindowState, saveWindowState, windowStatePath } from './windowState.ts';

const serverEntry = path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts');
const preload = path.join(import.meta.dirname, 'preload.cjs');
const dragIconPath = path.join(import.meta.dirname, 'drag-icon.png');

// How long the server gets to cancel transfers and disconnect before it is killed outright.
const STOP_GRACE_MS = 5000;
// Output written just before exit can still be in the pipe when `exit` fires.
const OUTPUT_DRAIN_MS = 500;
// Move and resize fire continuously during a drag; the final bounds are what matter.
const SAVE_STATE_DELAY_MS = 500;

let mainWindow: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let serverRunning = false;
let quitting = false;
let stopAttempted = false;
// What the window shows: the server's page, or a failure page once there is no server. Kept so
// a window reopened from the Dock shows the same thing.
let pageUrl: string | null = null;

function saveBounds(win: BrowserWindow): void {
  try {
    saveWindowState(windowStatePath(app.getPath('userData')), win.getNormalBounds());
  } catch (err) {
    console.error('Could not save the window state:', err);
  }
}

function createWindow(): BrowserWindow {
  const bounds = loadWindowState(
    windowStatePath(app.getPath('userData')),
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    ...bounds,
    center: bounds.x === undefined,
    title: 'PGMac Android Transfer',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveBounds(win), SAVE_STATE_DELAY_MS);
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveBounds(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/** Shows `url` in the one window, opening it if it was closed. */
function showPage(url: string): void {
  pageUrl = url;
  mainWindow ??= createWindow();
  void mainWindow.loadURL(url);
}

function showFailure(heading: string, lines: string[]): void {
  showPage(dataUrl(failurePage(heading, lines)));
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
    env: serverEnv(process.env, port, app.getPath('userData')),
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
    showPage(`http://${SERVER_HOST}:${port}`);
  });

  child.once('exit', (code) => {
    serverRunning = false;
    if (quitting) return;
    void drained(streams).then(() => {
      if (quitting) return;
      const lines = [...tail.lines(), `(exit code ${code})`].slice(-tail.limit);
      if (!listening || mainWindow) {
        showFailure(listening ? STOPPED_HEADING : START_FAILED_HEADING, lines);
      } else {
        // The window is closed: show why when the Dock icon reopens it, without popping it up.
        pageUrl = dataUrl(failurePage(STOPPED_HEADING, lines));
      }
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

// The server and its transfers outlive the window, as Mac apps do; Quit ends them.
app.on('window-all-closed', () => {});

// The Dock icon reopens the window on the same server. The page loads afresh and takes the
// server's snapshot over its socket, so it picks up the session and transfers as they are now.
app.on('activate', () => {
  if (!app.isReady() || mainWindow || quitting || !pageUrl) return;
  showPage(pageUrl);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    quitting = true;
    app.quit();
  });
}

app
  .whenReady()
  .then(() => {
    // Read once here: macOS refuses a native drag without a non-empty icon, and the drag
    // handler itself must not touch the disk.
    let dragIcon = nativeImage.createFromPath(dragIconPath);
    if (dragIcon.isEmpty()) {
      console.error('Could not load the drag icon; using a built-in one.');
      const { buffer, width, height } = fallbackDragIcon();
      dragIcon = nativeImage.createFromBitmap(buffer, { width, height });
    }
    // Synchronous, with no reply: the page is still inside its dragstart handler, and the drag
    // only starts if startDrag runs before that handler returns.
    ipcMain.on(
      'drag-out',
      dragOutHandler({
        appContents: () => mainWindow?.webContents ?? null,
        icon: dragIcon,
        log: (message, err) => console.error(message, err),
      }),
    );
    ipcMain.handle(
      'choose-file',
      chooseFileHandler({
        appWindow: () => mainWindow,
        showOpenDialog: (win, options) => dialog.showOpenDialog(win, options),
      }),
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate({
          appName: app.name,
          isPackaged: app.isPackaged,
          openExternal: (url) => void shell.openExternal(url),
        }),
      ),
    );
    return startServer();
  })
  .catch((err: unknown) => {
    showFailure(START_FAILED_HEADING, [String(err instanceof Error ? (err.stack ?? err) : err)]);
  });
