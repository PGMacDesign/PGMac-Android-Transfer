import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The token every API request and WebSocket upgrade must carry. Each launcher (browser mode,
 * `npm run dev`, the desktop app) calls this once and hands the result to both the server and
 * its page, so an empty `API_TOKEN` means "generate one" everywhere.
 */
export function resolveApiToken(env: NodeJS.ProcessEnv): string {
  const set = env.API_TOKEN?.trim();
  return set ? set : randomBytes(32).toString('hex');
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
