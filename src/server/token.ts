import { randomBytes, timingSafeEqual } from 'node:crypto';

// Letters, digits, '-' and '_' are valid in a WebSocket subprotocol, a header value and a URL
// fragment as they are, and 16 of them leave a hand-set token hard to guess.
const API_TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,}$/;

export const API_TOKEN_FORMAT_MESSAGE =
  "API_TOKEN must be at least 16 characters of letters, digits, '-' or '_'.";

/**
 * The token every API request and WebSocket upgrade must carry. Each launcher (browser mode,
 * `npm run dev`, the desktop app) calls this once and hands the result to both the server and
 * its page, so an empty `API_TOKEN` means "generate one" everywhere. Throws with
 * `API_TOKEN_FORMAT_MESSAGE` for a set token outside `API_TOKEN_FORMAT`.
 */
export function resolveApiToken(env: NodeJS.ProcessEnv): string {
  const set = env.API_TOKEN?.trim();
  if (!set) return randomBytes(32).toString('hex');
  if (!API_TOKEN_FORMAT.test(set)) throw new Error(API_TOKEN_FORMAT_MESSAGE);
  return set;
}

/** Constant-time comparison, so response timing doesn't reveal how much of a guess matched. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The address a launcher opens or prints. The fragment never reaches the server. */
export function tokenUrl(origin: string, token: string): string {
  return `${origin}/#token=${encodeURIComponent(token)}`;
}

/**
 * The line the server prints once it listens. Under Electron (`desktop`) it leaves the token
 * out: main gets the token another way, and echoing it would put it in front of main's
 * per-chunk redaction, which misses a token split across two chunks.
 */
export function startupLine(origin: string, token: string, desktop: boolean): string {
  return `PGMac Android Transfer is running at ${desktop ? origin : tokenUrl(origin, token)}`;
}
