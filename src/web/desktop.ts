/**
 * Functions the desktop app's preload exposes on `window.pgmacDesktop`. Its presence alone
 * means the page is running inside the desktop app rather than a browser.
 */
export interface PgmacDesktop {
  /** A dropped file's or folder's real path; "" when it has none (dragged from some apps). */
  getPathForFile(file: File): string;
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
