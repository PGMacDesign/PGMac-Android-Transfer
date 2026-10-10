import { useSyncExternalStore } from 'react';

const NARROW_QUERY = '(max-width: 1100px)';

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Matches the CSS breakpoint where sidebars collapse and dates shorten. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_QUERY).matches);
}
