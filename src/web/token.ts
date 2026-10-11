export const NO_TOKEN_MESSAGE =
  'Open PGMac Android Transfer from the link printed in your terminal.';
export const EXPIRED_TOKEN_MESSAGE = `This page's link has expired. ${NO_TOKEN_MESSAGE}`;

import { encodeWireToken } from '../shared/token.ts';

/** Where the token is kept for this tab, so a reload works after the fragment is gone. */
export const TOKEN_KEY = 'pgmac.apiToken';

export interface TokenEnv {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * Takes the token from a `#token=` link, keeps it for the tab and takes it out of the address
 * bar (so it isn't left on screen or in a bookmark); without one, falls back to the token this
 * tab stored earlier. Null when the page was opened without a link.
 */
export function readToken(env: TokenEnv): string | null {
  const params = new URLSearchParams(env.location.hash.replace(/^#/, ''));
  const fromLink = params.get('token');
  if (fromLink !== null) {
    env.history.replaceState(null, '', env.location.pathname + env.location.search);
  }
  if (fromLink) {
    try {
      env.storage.setItem(TOKEN_KEY, fromLink);
    } catch {
      // Storage can be disabled; the token still works until the tab reloads.
    }
    return fromLink;
  }
  try {
    return env.storage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

let token: string | null | undefined;

/** The page's token, read once on first use. */
export function apiToken(): string | null {
  if (token === undefined) {
    // Through functions because merely touching `sessionStorage` throws where it is disabled,
    // and readToken catches only what happens inside its calls.
    const storage = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
    };
    token = readToken({ location, history, storage });
  }
  return token;
}

/** Headers for an API request; empty when the page has no token. */
export function authHeaders(): Record<string, string> {
  const t = apiToken();
  return t ? { authorization: `Bearer ${encodeWireToken(t)}` } : {};
}
