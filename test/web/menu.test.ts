import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopBridge } from '../../src/web/desktop.ts';
import { QUIT_SERVER_LABEL, appMenuItems } from '../../src/web/menu.ts';

const items = () =>
  appMenuItems({
    theme: 'system',
    density: 'compact',
    adbFound: true,
    desktop: desktopBridge() !== null,
  });
const shape = () => items().map((i) => [i.kind, i.label]);

describe('appMenuItems', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers Quit server in browser mode', () => {
    vi.stubGlobal('window', {});
    expect(items().find((i) => i.label === QUIT_SERVER_LABEL)?.id).toBe('quitServer');
  });

  it('omits Quit server when the desktop bridge is present', () => {
    vi.stubGlobal('window', { pgmacDesktop: {} });
    expect(items().map((i) => i.label)).not.toContain(QUIT_SERVER_LABEL);
    expect(items().map((i) => i.id)).not.toContain('quitServer');
  });

  it('keeps every other item in the desktop app, without a dangling separator', () => {
    vi.stubGlobal('window', {});
    const browser = shape();
    expect(browser.slice(-2)).toEqual([
      ['sep', undefined],
      [undefined, QUIT_SERVER_LABEL],
    ]);
    vi.stubGlobal('window', { pgmacDesktop: {} });
    expect(shape()).toEqual(browser.slice(0, -2));
  });

  it('checks the current theme and density and disables pairing without adb', () => {
    const list = appMenuItems({
      theme: 'dark',
      density: 'comfortable',
      adbFound: false,
      desktop: false,
    });
    const byId = (id: string) => list.find((i) => i.id === id);
    expect(byId('theme:dark')?.icon).toBe('check');
    expect(byId('theme:system')?.icon).toBe('');
    expect(byId('density:comfortable')?.icon).toBe('check');
    expect(byId('density:compact')?.icon).toBe('');
    expect(byId('pair')?.disabled).toBe(true);
    expect(byId('downloads')?.disabled).toBe(false);
  });

  it('offers Settings, opening the settings dialog, just above Downloads folder', () => {
    const list = items();
    const at = list.findIndex((i) => i.id === 'settings');
    expect(list[at]).toMatchObject({ label: 'Settings…', icon: 'settings', disabled: false });
    expect(list[at + 1]?.id).toBe('downloads');
  });
});
