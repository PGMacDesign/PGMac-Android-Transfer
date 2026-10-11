/**
 * Functions the desktop app's preload exposes on `window.pgmacDesktop`. Empty for now; its
 * presence alone means the page is running inside the desktop app rather than a browser.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended as the bridge grows
export interface PgmacDesktop {}

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
