import type { Side } from '../shared/protocol.ts';
import { joinPath, parentOf } from './paths.ts';

/**
 * Functions the desktop app's preload exposes on `window.pgmacDesktop`. Its presence alone
 * means the page is running inside the desktop app rather than a browser.
 */
export interface PgmacDesktop {
  /** A dropped file's or folder's real path; "" when it has none (dragged from some apps). */
  getPathForFile(file: File): string;
  /** Starts a native drag of these Mac paths out of the window. Must run inside `dragstart`. */
  startDrag(paths: string[]): void;
}

declare global {
  interface Window {
    pgmacDesktop?: PgmacDesktop;
  }
}

/** The desktop bridge, or null in browser mode. */
export function desktopBridge(): PgmacDesktop | null {
  if (typeof window === 'undefined') return null;
  return window.pgmacDesktop ?? null;
}

/**
 * Reads dropped files' real paths, or null in browser mode, where drops are uploaded instead.
 * Bound here so callers never pass the bridge's function around detached from it.
 */
export function filePathReader(): ((file: File) => string) | null {
  const bridge = desktopBridge();
  if (typeof bridge?.getPathForFile !== 'function') return null;
  return (file) => bridge.getPathForFile(file);
}

/** What an in-app drag between the panes carries. */
export interface DragInfo {
  from: Side;
  dir: string;
  names: string[];
}

/**
 * Starts a pane drag from inside its `dragstart` event; returns whether it's an in-app drag
 * (the caller then sets up the HTML drag). In the desktop app a Mac-pane drag is a native drag
 * of the real files instead, and leaves the in-app drag state unset: native drags don't
 * reliably report back how they ended, so that state would go stale and a later Finder drop
 * could be taken for it. A drop back into the window arrives as a Finder drop with real paths.
 */
export function beginPaneDrag(
  d: DragInfo,
  e: { preventDefault(): void },
  setDrag: (d: DragInfo) => void,
  bridge: PgmacDesktop | null = desktopBridge(),
): boolean {
  if (d.from === 'mac' && typeof bridge?.startDrag === 'function') {
    e.preventDefault();
    bridge.startDrag(d.names.map((n) => joinPath(d.dir, n)));
    return false;
  }
  setDrag(d);
  return true;
}

/**
 * Whether a real-path drop onto the Mac pane showing `paneDir` is the pane's own drag-out
 * dropped back where the items already are (onto the folder or one of its rows), which is
 * ignored as a same-pane in-app drop is. The drop arrives like any Finder drop, so the items'
 * folder is what tells; drops of items from anywhere else still copy.
 */
export function isDropInPlace(paths: readonly string[], paneDir: string): boolean {
  return paths.length > 0 && paths.every((p) => parentOf(p) === paneDir);
}
