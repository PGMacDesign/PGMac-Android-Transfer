import { describe, expect, it, vi } from 'vitest';
import { announceListening, startUp } from '../../src/server/readiness.ts';

describe('announceListening', () => {
  it('posts the listening message when a parent port exists', () => {
    const postMessage = vi.fn();
    expect(announceListening(51234, { postMessage })).toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'listening', port: 51234 });
  });

  it('does nothing in browser mode, where there is no parent port', () => {
    expect(announceListening(4848, undefined)).toBe(false);
  });
});

describe('startUp', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it('listens, then clears stale staging, then announces', async () => {
    const calls: string[] = [];
    await startUp({
      listen: async () => void calls.push('listen'),
      clearStaleStaging: async () => void calls.push('clear'),
      announce: () => void calls.push('announce'),
    });
    expect(calls).toEqual(['listen', 'clear', 'announce']);
  });

  it('does not clear or announce until listen has finished', async () => {
    const listen = deferred();
    const clearStaleStaging = vi.fn(async () => {});
    const announce = vi.fn();
    const started = startUp({ listen: () => listen.promise, clearStaleStaging, announce });
    await Promise.resolve();
    expect(clearStaleStaging).not.toHaveBeenCalled();
    listen.resolve();
    await started;
    expect(announce).toHaveBeenCalledOnce();
  });

  it('holds the announcement until a slow staging clear settles', async () => {
    const clear = deferred();
    const announce = vi.fn();
    const started = startUp({
      listen: async () => {},
      clearStaleStaging: () => clear.promise,
      announce,
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(announce).not.toHaveBeenCalled();
    clear.resolve();
    await started;
    expect(announce).toHaveBeenCalledOnce();
  });

  it('never announces before a failing staging clear settles, and rejects with its error', async () => {
    const clear = deferred();
    const announce = vi.fn();
    const started = startUp({
      listen: async () => {},
      clearStaleStaging: () => clear.promise,
      announce,
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(announce).not.toHaveBeenCalled();
    clear.reject(new Error('EACCES'));
    await expect(started).rejects.toThrow('EACCES');
    expect(announce).not.toHaveBeenCalled();
  });

  it('neither clears nor announces when listen fails', async () => {
    const clearStaleStaging = vi.fn(async () => {});
    const announce = vi.fn();
    await expect(
      startUp({
        listen: () => Promise.reject(new Error('EADDRINUSE')),
        clearStaleStaging,
        announce,
      }),
    ).rejects.toThrow('EADDRINUSE');
    expect(clearStaleStaging).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });
});
