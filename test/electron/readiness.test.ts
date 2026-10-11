import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { announceListening } from '../../src/server/readiness.ts';

describe('announceListening', () => {
  it('posts the listening message when a parent port exists', () => {
    const postMessage = vi.fn();
    expect(announceListening(51234, { postMessage })).toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'listening', port: 51234 });
  });

  it('does nothing in browser mode, where there is no parent port', () => {
    expect(announceListening(4848, undefined)).toBe(false);
  });

  it('is called by the server entry only after listen succeeds and stale staging is cleared', async () => {
    const src = await readFile(
      path.join(import.meta.dirname, '..', '..', 'src', 'server', 'index.ts'),
      'utf8',
    );
    const listen = src.indexOf('await app.server.listen(');
    const listenBlockEnd = src.indexOf('\n}\n', listen);
    const clear = src.indexOf('await app.clearStaleStaging();');
    const announce = src.indexOf('announceListening(config.port');
    expect(listen).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(listenBlockEnd);
    expect(announce).toBeGreaterThan(clear);
  });
});
