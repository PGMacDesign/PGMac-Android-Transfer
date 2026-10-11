import type { MenuEntry } from './components/ui.tsx';
import type { Density, ThemePref } from './prefs.ts';

export const QUIT_SERVER_LABEL = 'Quit server';

/** What a menu item does, passed back through MenuList's `onSelect`. */
export type AppMenuAction =
  `theme:${ThemePref}` | `density:${Density}` | 'settings' | 'downloads' | 'pair' | 'quitServer';

export interface AppMenuState {
  theme: ThemePref;
  density: Density;
  adbFound: boolean;
  /** In the desktop app the app's own Quit stops the server, so the page offers no stop. */
  desktop: boolean;
}

const item = (id: AppMenuAction, label: string, icon: string, disabled = false): MenuEntry => ({
  id,
  label,
  icon,
  disabled,
});

/**
 * The app bar's overflow menu. Items carry action ids rather than callbacks so the list is
 * plain data, built and tested without the component.
 */
export function appMenuItems(s: AppMenuState): MenuEntry[] {
  const check = (on: boolean) => (on ? 'check' : '');
  const items: MenuEntry[] = [
    { kind: 'header', label: 'Appearance' },
    item('theme:system', 'Match system', check(s.theme === 'system')),
    item('theme:light', 'Light', check(s.theme === 'light')),
    item('theme:dark', 'Dark', check(s.theme === 'dark')),
    { kind: 'sep' },
    { kind: 'header', label: 'Density' },
    item('density:compact', 'Compact', check(s.density === 'compact')),
    item('density:comfortable', 'Comfortable', check(s.density === 'comfortable')),
    { kind: 'sep' },
    item('settings', 'Settings…', 'settings'),
    item('downloads', 'Downloads folder…', 'download'),
    item('pair', 'Pair a new device…', 'qr_code_2', !s.adbFound),
  ];
  if (!s.desktop) {
    items.push({ kind: 'sep' }, item('quitServer', QUIT_SERVER_LABEL, 'power_settings_new'));
  }
  return items;
}
