import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_KEY, readToken, type TokenEnv } from '../../src/web/token.ts';

function fakeEnv(hash: string, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const replaced: string[] = [];
  const env: TokenEnv = {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_d, _t, url) => void replaced.push(String(url)) },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
  };
  return { env, store, replaced };
}

describe('readToken', () => {
  it('takes the token from the link, stores it for the tab and clears the address bar', () => {
    const { env, store, replaced } = fakeEnv('#token=abc123');
    expect(readToken(env)).toBe('abc123');
    expect(store.get(TOKEN_KEY)).toBe('abc123');
    expect(replaced).toEqual(['/']);
  });

  it('falls back to the stored token on reload, when the fragment is gone', () => {
    const { env, replaced } = fakeEnv('', { [TOKEN_KEY]: 'abc123' });
    expect(readToken(env)).toBe('abc123');
    expect(replaced).toEqual([]);
  });

  it('prefers a new link over an older stored token', () => {
    const { env, store } = fakeEnv('#token=new', { [TOKEN_KEY]: 'old' });
    expect(readToken(env)).toBe('new');
    expect(store.get(TOKEN_KEY)).toBe('new');
  });

  it('is null for a page opened without a link', () => {
    expect(readToken(fakeEnv('').env)).toBeNull();
    expect(readToken(fakeEnv('#token=').env)).toBeNull();
  });

  it('still returns the token when storage refuses it', () => {
    const { env } = fakeEnv('#token=abc123');
    env.storage.setItem = () => {
      throw new Error('disabled');
    };
    expect(readToken(env)).toBe('abc123');
  });
});

describe('api requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('send the page token as a Bearer header', async () => {
    const { env } = fakeEnv('#token=abc123');
    vi.stubGlobal('location', env.location);
    vi.stubGlobal('history', env.history);
    vi.stubGlobal('sessionStorage', env.storage);
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response('{}', { status: 200 });
    });
    const { api } = await import('../../src/web/api.ts');
    await api.list('mac', '/Users');
    await api.mkdir('mac', '/Users/x');
    expect(calls.map((c) => (c.headers as Record<string, string>).authorization)).toEqual([
      'Bearer abc123',
      'Bearer abc123',
    ]);
    expect((calls[1]?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
