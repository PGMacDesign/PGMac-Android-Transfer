import type { Job } from '../shared/protocol.ts';

/** What the desktop app sends when a graceful shutdown ran out of time. */
export interface ForceStopMessage {
  type: 'forceStop';
}

/** The desktop app's quit requests, answered by `listenForQuit`. */
export type QuitRequest = { type: 'countActive' } | { type: 'shutdown' };

/** The server's replies to a `QuitRequest`. */
export type QuitReply = { type: 'activeCount'; count: number } | { type: 'shutdownDone' };

/** The receiving half of Electron's `process.parentPort` in a `utilityProcess`. */
export interface ParentPortReceiver {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

/** Electron's `process.parentPort` as the quit handler uses it: it receives and replies. */
export interface QuitPort extends ParentPortReceiver {
  postMessage(message: QuitReply): void;
}

/**
 * Jobs a quit would cancel: running, queued (including those waiting for a volume) and
 * uploading. A failed job isn't counted even if it could be retried; nothing of it is running.
 */
export function activeJobCount(jobs: readonly Job[]): number {
  return jobs.filter(
    (j) => j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled',
  ).length;
}

const typeOf = (event: { data: unknown } | undefined): unknown =>
  (event?.data as { type?: unknown } | null | undefined)?.type;

/**
 * Lets the desktop app end the server immediately: kill every transfer process, then exit.
 * In browser mode there is no parent port and nothing is installed. Returns whether it listened.
 */
export function listenForForceStop(
  parentPort: ParentPortReceiver | undefined,
  actions: { forceStop: () => void; exit: (code: number) => void },
): boolean {
  if (!parentPort) return false;
  parentPort.on('message', (event) => {
    if (typeOf(event) !== 'forceStop') return;
    actions.forceStop();
    actions.exit(1);
  });
  return true;
}

/**
 * Answers the desktop app's quit sequence: how many jobs a quit would cancel, and a graceful
 * shutdown that replies `shutdownDone` once `shutdown` resolves and only then exits. In browser
 * mode there is no parent port and nothing is installed. Returns whether it listened.
 */
export function listenForQuit(
  parentPort: QuitPort | undefined,
  actions: {
    activeCount: () => number;
    shutdown: () => Promise<void>;
    exit: (code: number) => void;
    log?: (message: string, err: unknown) => void;
  },
): boolean {
  if (!parentPort) return false;
  parentPort.on('message', (event) => {
    const type = typeOf(event);
    if (type === 'countActive') {
      parentPort.postMessage({ type: 'activeCount', count: actions.activeCount() });
    } else if (type === 'shutdown') {
      void actions.shutdown().then(
        () => {
          parentPort.postMessage({ type: 'shutdownDone' });
          actions.exit(0);
        },
        (err: unknown) => {
          // Not a clean shutdown, so no shutdownDone. Exiting still runs the exit hook, and the
          // desktop app quits on the exit itself.
          (actions.log ?? console.error)('Shutdown failed:', err);
          actions.exit(1);
        },
      );
    }
  });
  return true;
}

/**
 * The server's SIGINT/SIGTERM handler. Every signal waits for the shared `shutdown` before
 * exiting. In browser mode a second signal while it runs exits at once, as Ctrl+C twice always
 * has (the exit hook still kills transfer processes). Under the desktop app there is no such
 * escape: a terminal's second Ctrl+C reaches this process too, and the app's own quit timeline
 * already bounds how long the shutdown can take.
 */
export function stopOnSignal(opts: {
  desktop: boolean;
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  log?: (message: string) => void;
}): () => Promise<void> {
  let stopping = false;
  return async () => {
    if (stopping) {
      if (!opts.desktop) opts.exit(1);
      return;
    }
    stopping = true;
    (opts.log ?? console.log)('\nStopping: cancelling transfers and disconnecting…');
    await opts.shutdown();
    opts.exit(0);
  };
}

/** The server asks the desktop app to move `paths` to the Trash, in order. */
export interface TrashRequest {
  type: 'trash';
  id: number;
  paths: string[];
}

/** The desktop app's answer to a `TrashRequest`; `error` is set when a path failed. */
export interface TrashReply {
  type: 'trashResult';
  id: number;
  error?: string;
}

/** How long a trash request waits for its reply, as long as the trash CLI gets. */
export const TRASH_TIMEOUT_MS = 60_000;

/** Electron's `process.parentPort` as the trash requests use it. */
export interface TrashPort extends ParentPortReceiver {
  postMessage(message: TrashRequest): void;
}

/**
 * A trash function that has the desktop app's main process do the work (with
 * `shell.trashItem`), for MacFs to use when there is no `/usr/bin/trash`. Each call settles
 * once: on its reply, or rejected at `TRASH_TIMEOUT_MS`, after which a late reply is ignored.
 */
export function trashThroughParent(parentPort: TrashPort): (paths: string[]) => Promise<void> {
  const pending = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  parentPort.on('message', (event) => {
    if (typeOf(event) !== 'trashResult') return;
    const reply = event.data as Partial<TrashReply>;
    const entry = typeof reply.id === 'number' ? pending.get(reply.id) : undefined;
    if (!entry) return;
    pending.delete(reply.id!);
    clearTimeout(entry.timer);
    if (reply.error === undefined) entry.resolve();
    else entry.reject(new Error(String(reply.error)));
  });
  return (paths) =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The app did not finish moving the items to the Trash in time.'));
      }, TRASH_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        parentPort.postMessage({ type: 'trash', id, paths });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
}
