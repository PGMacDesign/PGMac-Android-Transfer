/**
 * Whether a URL the page tries to open in a new window may go to the default browser. Only web
 * links qualify: `file:`, custom schemes and the like could launch local apps or files.
 */
export function isExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * What to do when the page tries to navigate its own window to `url`. Only the server's origin
 * may load in the window: anything else would run with the preload bridge, so a web link goes to
 * the default browser instead and every other scheme goes nowhere. `appOrigin` is null until the
 * server is listening, and then nothing loads in the window.
 */
export function navigationDecision(url: string, appOrigin: string | null): NavigationDecision {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return 'block';
  }
  // `origin` is the string "null" for opaque origins (data:, file:, javascript:), which must never
  // count as a match.
  if (origin !== 'null' && origin === appOrigin) return 'allow';
  return isExternalUrl(url) ? 'external' : 'block';
}
