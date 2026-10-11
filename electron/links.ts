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
