import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Runs the preload with a fake `electron` module and returns what it exposed. */
function loadPreload() {
  const exposed: Record<string, unknown> = {};
  const webUtils = new Proxy(
    { getPathForFile: vi.fn((f: { name: string }) => `/real/${f.name}`) },
    {
      get(target, key) {
        if (key !== 'getPathForFile') throw new Error(`webUtils.${String(key)} was used`);
        return target.getPathForFile;
      },
    },
  );
  const ipcRenderer = new Proxy(
    { send: vi.fn(), invoke: vi.fn(async () => '/opt/homebrew/bin/adb') },
    {
      get(target, key) {
        if (key !== 'send' && key !== 'invoke') {
          throw new Error(`ipcRenderer.${String(key)} was used`);
        }
        return target[key];
      },
    },
  );
  const electron = {
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
    ipcRenderer,
    webUtils,
  };
  const src = readFileSync(path.join(import.meta.dirname, '../../electron/preload.cjs'), 'utf8');
  vm.runInNewContext(src, {
    require: (m: string) => {
      if (m !== 'electron') throw new Error(`preload required ${m}`);
      return electron;
    },
  });
  return { exposed, ipcRenderer, webUtils };
}

describe('preload', () => {
  it('exposes only getPathForFile, startDrag and chooseFile', () => {
    const { exposed } = loadPreload();
    expect(Object.keys(exposed)).toEqual(['pgmacDesktop']);
    expect(Object.keys(exposed.pgmacDesktop as object)).toEqual([
      'getPathForFile',
      'startDrag',
      'chooseFile',
    ]);
  });

  it('passes getPathForFile straight to webUtils', () => {
    const { exposed, webUtils } = loadPreload();
    const bridge = exposed.pgmacDesktop as Record<string, (f: unknown) => string>;
    expect(bridge.getPathForFile!({ name: 'a.txt' })).toBe('/real/a.txt');
    expect(webUtils.getPathForFile).toHaveBeenCalledTimes(1);
  });

  it('sends startDrag to main on drag-out and returns nothing to wait on', () => {
    const { exposed, ipcRenderer } = loadPreload();
    const bridge = exposed.pgmacDesktop as Record<string, (p: unknown) => unknown>;
    const paths = ['/Users/me/a.txt', '/Users/me/b'];
    expect(bridge.startDrag!(paths)).toBeUndefined();
    expect(ipcRenderer.send).toHaveBeenCalledExactlyOnceWith('drag-out', paths);
  });

  it('asks main for a file with choose-file, passing nothing from the page', async () => {
    const { exposed, ipcRenderer } = loadPreload();
    const bridge = exposed.pgmacDesktop as Record<string, (...a: unknown[]) => Promise<unknown>>;
    expect(await bridge.chooseFile!('/etc/passwd', { properties: ['openDirectory'] })).toBe(
      '/opt/homebrew/bin/adb',
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('choose-file');
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });
});
