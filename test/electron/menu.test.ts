import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { HELP_LABEL, HELP_URL, SHOW_LOGS_LABEL, appMenuTemplate } from '../../electron/menu.ts';

const submenu = (menu: MenuItemConstructorOptions[], label: string) => {
  const top = menu.find((m) => m.label === label);
  return (top?.submenu ?? []) as MenuItemConstructorOptions[];
};
const roles = (items: MenuItemConstructorOptions[]) =>
  items.filter((i) => i.type !== 'separator').map((i) => i.role);

const build = (isPackaged: boolean, openExternal = vi.fn(), showLogs = vi.fn()) =>
  appMenuTemplate({ appName: 'PGMac Android Transfer', isPackaged, openExternal, showLogs });

describe('appMenuTemplate', () => {
  it('has the app, Edit, View, Window and Help menus in order', () => {
    expect(build(true).map((m) => m.label)).toEqual([
      'PGMac Android Transfer',
      'Edit',
      'View',
      'Window',
      'Help',
    ]);
  });

  it('builds the app, Edit and Window menus from roles', () => {
    const menu = build(true);
    expect(roles(submenu(menu, 'PGMac Android Transfer'))).toEqual([
      'about',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ]);
    expect(roles(submenu(menu, 'Edit'))).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    expect(roles(submenu(menu, 'Window'))).toEqual(['minimize', 'zoom', 'close', 'front']);
  });

  it('offers developer tools only when not packaged', () => {
    const rest = ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'];
    expect(roles(submenu(build(false), 'View'))).toEqual(['reload', 'toggleDevTools', ...rest]);
    expect(roles(submenu(build(true), 'View'))).toEqual(['reload', ...rest]);
  });

  it('opens the README on GitHub from Help', () => {
    const openExternal = vi.fn();
    const [item] = submenu(build(true, openExternal), 'Help');
    expect(item?.label).toBe(HELP_LABEL);
    (item?.click as () => void)();
    expect(openExternal).toHaveBeenCalledWith(HELP_URL);
    expect(HELP_URL).toBe('https://github.com/PGMacDesign/PGMac-Android-Transfer#readme');
  });

  it('shows the log file from Help', () => {
    const showLogs = vi.fn();
    const items = submenu(build(true, vi.fn(), showLogs), 'Help');
    const item = items.find((i) => i.label === SHOW_LOGS_LABEL);
    expect(SHOW_LOGS_LABEL).toBe('Show Logs');
    (item?.click as () => void)();
    expect(showLogs).toHaveBeenCalledOnce();
  });
});
