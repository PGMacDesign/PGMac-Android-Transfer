import type { Side } from '../shared/protocol.ts';
import type { CapturedDrop } from './finder.ts';
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
  /** Opens a native picker for one file: its path, or null when cancelled. */
  chooseFile(): Promise<string | null>;
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

/** Opens the native file picker, or null in browser mode, which has no way to get a real path. */
export function fileChooser(): (() => Promise<string | null>) | null {
  const bridge = desktopBridge();
  if (typeof bridge?.chooseFile !== 'function') return null;
  return () => bridge.chooseFile();
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
 * Whether a real-path drop would put every item back in `dest`, the folder it already sits in
 * (the pane's own drag-out dropped where it came from). That is ignored as a same-pane in-app
 * drop is. The drop arrives like any Finder drop, so the items' folder is what tells; anything
 * from another folder still copies.
 */
export function isDropInPlace(paths: readonly string[], dest: string): boolean {
  return paths.length > 0 && paths.every((p) => parentOf(p) === dest);
}

/**
 * Where a Finder or drag-out drop onto a pane showing `paneDir` lands: the row's folder for a
 * drop on folder row `folder`, else `paneDir`. Null when the drop is ignored, which is only a
 * real-path drop onto the Mac pane that `isDropInPlace` against that destination. A row drop of
 * items from the pane's own folder therefore copies them into the row's folder.
 */
export function finderDropDest(
  side: Side,
  paneDir: string,
  folder: string | null,
  drop: CapturedDrop,
): string | null {
  const dest = folder ? joinPath(paneDir, folder) : paneDir;
  if (side === 'mac' && drop.kind === 'paths' && isDropInPlace(drop.paths, dest)) return null;
  return dest;
}
