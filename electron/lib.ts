// Sets process.env.UV_THREADPOOL_SIZE unless the user already did, so the value handed to the
// server below is exactly the one the server would choose for itself.
import '../src/server/threadpool.ts';
import net from 'node:net';
import type { ListeningMessage } from '../src/server/readiness.ts';
import { tokenUrl } from '../src/server/token.ts';

export const SERVER_HOST = '127.0.0.1';
export const OUTPUT_TAIL_LINES = 50;

/**
 * Asks the OS for a free loopback port. The server's config rejects PORT=0 and its Host check
 * keys on the configured port, so main has to hand it a concrete one.
 */
export function pickFreePort(host = SERVER_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen({ host, port: 0 }, () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not read the probe port'));
      });
    });
  });
}

/**
 * The server's environment: the parent's, plus the port, no browser, the wide libuv pool, the
 * app's own state folder (macOS's Application Support for the app, not the browser mode's) and
 * the API token the window will present.
 */
export function serverEnv(
  parent: NodeJS.ProcessEnv,
  port: number,
  stateDir: string,
  token: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) env[key] = value;
  }
  env.PORT = String(port);
  env.OPEN_BROWSER = '0';
  env.STATE_DIR = stateDir;
  env.API_TOKEN = token;
  // libuv reads the pool size once, on first use, which in a utilityProcess can come before
  // the server's own threadpool import runs.
  const poolSize = parent.UV_THREADPOOL_SIZE ?? process.env.UV_THREADPOOL_SIZE;
  if (!poolSize) throw new Error('UV_THREADPOOL_SIZE is not set');
  env.UV_THREADPOOL_SIZE = poolSize;
  return env;
}

/** The parts of Electron's open-dialog result the file chooser reads. */
export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/**
 * The `ipcMain.handle('choose-file')` handler: a native picker for one file, resolving to its
 * path or null. Only the app's own window may ask. The path is not checked here; whoever uses
 * it (the server, for an adb path) validates it.
 */
export function chooseFileHandler<W extends { webContents: unknown }>(opts: {
  /** The app window, or null while there is none. */
  appWindow: () => W | null;
  showOpenDialog: (win: W, options: { properties: ['openFile'] }) => Promise<OpenDialogResult>;
}): (event: { sender: unknown }) => Promise<string | null> {
  return async (event) => {
    const win = opts.appWindow();
    if (!win || event.sender !== win.webContents) return null;
    const result = await opts.showOpenDialog(win, { properties: ['openFile'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
}

/** What the window loads once the server is listening. */
export function windowUrl(port: number, token: string): string {
  return tokenUrl(`http://${SERVER_HOST}:${port}`, token);
}

/** Hides the token in server output that main echoes or shows on the failure page. */
export function redact(text: string, token: string): string {
  return token ? text.split(token).join('[token]') : text;
}

export function isListeningMessage(message: unknown, port: number): message is ListeningMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Partial<ListeningMessage>;
  return m.type === 'listening' && m.port === port;
}

/**
 * The last lines a process wrote across several streams, for the failure page. Partial lines
 * are kept per stream so interleaved stdout and stderr chunks don't splice into one line.
 */
export class OutputTail {
  readonly limit: number;
  private readonly done: string[] = [];
  private readonly pending = new Map<string, string>();

  constructor(limit = OUTPUT_TAIL_LINES) {
    this.limit = limit;
  }

  write(stream: string, chunk: string): void {
    const parts = ((this.pending.get(stream) ?? '') + chunk).split(/\r?\n/);
    this.pending.set(stream, parts.pop() ?? '');
    this.done.push(...parts);
    if (this.done.length > this.limit) this.done.splice(0, this.done.length - this.limit);
  }

  lines(): string[] {
    const partial = [...this.pending.values()].filter((p) => p !== '');
    return [...this.done, ...partial].slice(-this.limit);
  }
}

/**
 * What the failure page shows when the server exits: the last `limit` lines of its output, then
 * the exit code on a line of its own that doesn't take one of those places.
 */
export function exitOutput(lines: string[], code: number, limit = OUTPUT_TAIL_LINES): string[] {
  return [...lines.slice(-limit), `(exit code ${code})`];
}

export const START_FAILED_HEADING = "PGMac Android Transfer couldn't start its server.";
export const STOPPED_HEADING = "PGMac Android Transfer's server stopped.";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** A self-contained page showing why the server isn't there, loaded instead of a blank window. */
export function failurePage(heading: string, lines: string[]): string {
  const output = lines.length ? lines.map(escapeHtml).join('\n') : '(The server printed nothing.)';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 2rem; }
  h1 { font-size: 1.25rem; }
  pre { padding: 1rem; overflow: auto; white-space: pre-wrap; background: rgba(127, 127, 127, 0.12); border-radius: 6px; font-size: 12px; }
</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
<p>Last ${OUTPUT_TAIL_LINES} lines of its output:</p>
<pre>${output}</pre>
</body>
</html>
`;
}

export function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
