// A type-only import: erased at runtime, so this module loads without Electron for Vitest.
import type { MenuItemConstructorOptions } from 'electron';

export const HELP_URL = 'https://github.com/PGMacDesign/PGMac-Android-Transfer#readme';
export const HELP_LABEL = 'PGMac Android Transfer on GitHub';
export const SHOW_LOGS_LABEL = 'Show Logs';

export interface MenuOptions {
  appName: string;
  /** Developer tools are for development runs only, not the shipped app. */
  isPackaged: boolean;
  openExternal: (url: string) => void;
  /** Reveals the app's log file in Finder. */
  showLogs: () => void;
}

/** The macOS application menu, built from roles so the system supplies labels and shortcuts. */
export function appMenuTemplate(opts: MenuOptions): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [{ role: 'reload' }];
  if (!opts.isPackaged) view.push({ role: 'toggleDevTools' });
  view.push(
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  );
  return [
    {
      label: opts.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: view },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: HELP_LABEL, click: () => opts.openExternal(HELP_URL) },
        { type: 'separator' },
        { label: SHOW_LOGS_LABEL, click: () => opts.showLogs() },
      ],
    },
  ];
}
