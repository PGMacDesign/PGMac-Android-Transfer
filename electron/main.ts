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
  START_FAILED_HEADING,
  STOPPED_HEADING,
  chooseFileHandler,
  dataUrl,
  exitOutput,
  failurePage,
  isListeningMessage,
  pickFreePort,
  redact,
  SERVER_HOST,
  serverEnv,
  windowUrl,
} from './lib.ts';
import { resolveApiToken } from '../src/server/token.ts';
import { dragOutHandler, fallbackDragIcon } from './dragOut.ts';
import { isExternalUrl } from './links.ts';
import { FileLog, redactedLines } from './log.ts';
import { appMenuTemplate } from './menu.ts';
import { QuitController, quitPrompt, QUIT_BUTTON } from './quit.ts';
import { trashHandler } from './trash.ts';
import { loadWindowState, saveWindowState, windowStatePath } from './windowState.ts';

const serverEntry = path.join(import.meta.dirname, '..', 'src', 'server', 'index.ts');
const preload = path.join(import.meta.dirname, 'preload.cjs');
const dragIconPath = path.join(import.meta.dirname, 'drag-icon.png');

// Output written just before exit can still be in the pipe when `exit` fires.
const OUTPUT_DRAIN_MS = 500;
// Move and resize fire continuously during a drag; the final bounds are what matter.
const SAVE_STATE_DELAY_MS = 500;

// Launched from the Dock or Finder, stdout and stderr go nowhere; this file is what's left to
// diagnose a failure afterwards.
const log = new FileLog(() => app.getPath('logs'));
log.write(
  'main',
  `Starting ${app.name} ${app.getVersion()} (Electron ${process.versions.electron}, ` +
    `${app.isPackaged ? 'packaged' : 'development'})`,
);

let mainWindow: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let serverRunning = false;
// What the window shows: the server's page, or a failure page once there is no server. Kept so
// a window reopened from the Dock shows the same thing.
let pageUrl: string | null = null;

const quitter = new QuitController({
  server: () => {
    const child = server;
    if (!child) return null;
    return {
      running: () => serverRunning,
      post: (message) => child.postMessage(message),
      kill: () => {
        // SIGKILL rather than child.kill()'s SIGTERM: by now the server has had its forceStop
        // and still not exited, so its signal handler can't be relied on either.
        if (child.pid === undefined) return void child.kill();
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      },
    };
  },
  confirm: async (count, signal) => {
    const { response } = await dialog.showMessageBox({ ...quitPrompt(count), signal });
    return response === QUIT_BUTTON;
  },
  quit: () => app.quit(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
});
// Once the server is being shut down its exit is expected, not a failure to show, and the
// window isn't reopened on a server that is going away.
const quitting = () => quitter.shuttingDown;

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
  // Kept in memory only: handed to the server through its environment and to the window
  // through the URL fragment, never written to disk or printed.
  const token = resolveApiToken(process.env);
  const tail = new OutputTail();
  // Forked exactly once per launch. A server that dies is reported, never silently restarted.
  const child = utilityProcess.fork(serverEntry, [], {
    env: serverEnv(process.env, port, app.getPath('userData'), token),
    stdio: 'pipe',
    serviceName: 'PGMac Android Transfer server',
  });
  server = child;
  serverRunning = true;

  // Captured now because the child's stream properties go null once it exits.
  const streams: NodeJS.ReadableStream[] = [];
  for (const [name, source, stream, echo] of [
    ['stdout', 'server', child.stdout, process.stdout],
    ['stderr', 'server:err', child.stderr, process.stderr],
  ] as const) {
    if (!stream) continue;
    streams.push(stream);
    stream.setEncoding('utf8');
    const lines = redactedLines(token, (line) => {
      log.write(source, line);
      echo.write(`${line}\n`);
    });
    stream.on('data', (chunk: string) => {
      tail.write(name, chunk);
      lines.write(chunk);
    });
    stream.once('end', () => lines.end());
  }

  const onTrash = trashHandler({
    trashItem: (p) => shell.trashItem(p),
    reply: (message) => {
      // A server that exited mid-request has no one left to answer.
      if (server !== child || !serverRunning) return;
      child.postMessage(message);
    },
  });

  let listening = false;
  child.on('message', (message: unknown) => {
    if (onTrash(message)) return;
    quitter.onServerMessage(message);
    if (listening || !isListeningMessage(message, port)) return;
    listening = true;
    log.write('main', `Server listening on ${SERVER_HOST}:${port}`);
    showPage(windowUrl(port, token));
  });

  child.once('exit', (code) => {
    log.write('main', `Server exited with code ${code}`);
    serverRunning = false;
    quitter.onServerExit();
    if (quitting()) return;
    void drained(streams).then(() => {
      if (quitting()) return;
      const lines = exitOutput(
        tail.lines().map((l) => redact(l, token)),
        code,
        tail.limit,
      );
      if (!listening || mainWindow) {
        showFailure(listening ? STOPPED_HEADING : START_FAILED_HEADING, lines);
      } else {
        // The window is closed: show why when the Dock icon reopens it, without popping it up.
        pageUrl = dataUrl(failurePage(STOPPED_HEADING, lines));
      }
    });
  });
}

// Never lets the quit go ahead with the server running: the quit sequence asks the user,
// shuts the server down and calls app.quit() again once it has exited.
app.on('before-quit', (event) => {
  if (!quitter.allowQuit()) event.preventDefault();
});

app.on('will-quit', () => log.write('main', 'Quit'));

// The server and its transfers outlive the window, as Mac apps do; Quit ends them.
app.on('window-all-closed', () => {});

// The Dock icon reopens the window on the same server. The page loads afresh and takes the
// server's snapshot over its socket, so it picks up the session and transfers as they are now.
app.on('activate', () => {
  if (!app.isReady() || mainWindow || quitting() || !pageUrl) return;
  showPage(pageUrl);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => quitter.signal());
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
          showLogs: () => {
            const file = log.ensureFile();
            if (file) shell.showItemInFolder(file);
          },
        }),
      ),
    );
    return startServer();
  })
  .catch((err: unknown) => {
    const message = String(err instanceof Error ? (err.stack ?? err) : err);
    log.write('main', `Startup failed: ${message}`);
    showFailure(START_FAILED_HEADING, [message]);
  });
