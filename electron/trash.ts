import path from 'node:path';
import type { TrashReply, TrashRequest } from '../src/server/parentPort.ts';

/** Only absolute paths with no NUL byte reach `shell.trashItem`. */
export function isTrashablePath(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0');
}

export interface TrashHandlerDeps {
  /** `shell.trashItem`. */
  trashItem(p: string): Promise<void>;
  reply(message: TrashReply): void;
}

/**
 * Handles the server's `trash` requests: trashes each path in order, stopping at the first
 * failure, and replies once with that failure's message or with none. Returns false for any
 * other message. A request with any unacceptable path trashes nothing.
 */
export function trashHandler(deps: TrashHandlerDeps): (message: unknown) => boolean {
  return (message) => {
    const m = message as Partial<TrashRequest> | null;
    if (typeof m !== 'object' || m === null || m.type !== 'trash') return false;
    // Without a usable id there is no one to answer; the server's own timeout ends the wait.
    if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id)) return true;
    const id = m.id;
    const paths: unknown = m.paths;
    if (!Array.isArray(paths) || !paths.every(isTrashablePath)) {
      deps.reply({
        type: 'trashResult',
        id,
        error: 'Refused a path that is not absolute or has a NUL byte.',
      });
      return true;
    }
    void (async () => {
      for (const p of paths) {
        try {
          await deps.trashItem(p);
        } catch (err) {
          deps.reply({
            type: 'trashResult',
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
      deps.reply({ type: 'trashResult', id });
    })();
    return true;
  };
}
