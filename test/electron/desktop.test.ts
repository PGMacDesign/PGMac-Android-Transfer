import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopBridge, fileChooser } from '../../src/web/desktop.ts';

describe('desktopBridge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null outside a browser window', () => {
    expect(desktopBridge()).toBeNull();
  });

  it('is null in browser mode, where the preload has not run', () => {
    vi.stubGlobal('window', {});
    expect(desktopBridge()).toBeNull();
  });

  it('returns the object the preload exposed', () => {
    const bridge = {};
    vi.stubGlobal('window', { pgmacDesktop: bridge });
    expect(desktopBridge()).toBe(bridge);
  });
});

describe('fileChooser', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null in browser mode, so no Locate button shows', () => {
    vi.stubGlobal('window', {});
    expect(fileChooser()).toBeNull();
    vi.stubGlobal('window', { pgmacDesktop: {} });
    expect(fileChooser()).toBeNull();
  });

  it("calls the bridge's chooseFile on it", async () => {
    const bridge = {
      chosen: '/opt/adb',
      chooseFile(this: { chosen: string }) {
        return Promise.resolve(this.chosen);
      },
    };
    vi.stubGlobal('window', { pgmacDesktop: bridge });
    expect(await fileChooser()!()).toBe('/opt/adb');
  });
});
