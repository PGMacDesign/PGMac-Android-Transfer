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
  const electron = {
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
    webUtils,
  };
  const src = readFileSync(path.join(import.meta.dirname, '../../electron/preload.cjs'), 'utf8');
  vm.runInNewContext(src, {
    require: (m: string) => {
      if (m !== 'electron') throw new Error(`preload required ${m}`);
      return electron;
    },
  });
  return { exposed, webUtils };
}

describe('preload', () => {
  it('exposes only getPathForFile, passed straight to webUtils', () => {
    const { exposed, webUtils } = loadPreload();
    const bridge = exposed.pgmacDesktop as Record<string, (f: unknown) => string>;
    expect(Object.keys(bridge)).toEqual(['getPathForFile']);
    expect(bridge.getPathForFile!({ name: 'a.txt' })).toBe('/real/a.txt');
    expect(webUtils.getPathForFile).toHaveBeenCalledTimes(1);
  });
});
