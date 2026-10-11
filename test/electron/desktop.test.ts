import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopBridge } from '../../src/web/desktop.ts';

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
