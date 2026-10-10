import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Density = 'compact' | 'comfortable';

// Per-browser conveniences only; storage can be unavailable (private mode, blocked site data).
function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function usePref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  const update = useCallback(
    (v: T) => {
      setValue(v);
      write(key, v);
    },
    [key],
  );
  return [value, update];
}

const THEMES = ['system', 'light', 'dark'] as const;
const DENSITIES = ['compact', 'comfortable'] as const;

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function subscribeScheme(cb: () => void): () => void {
  const mq = darkQuery();
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}

export function usePrefs() {
  const [theme, setTheme] = usePref<ThemePref>('pgmac.theme', THEMES, 'system');
  const [density, setDensity] = usePref<Density>('pgmac.density', DENSITIES, 'compact');
  const systemDark = useSyncExternalStore(subscribeScheme, () => darkQuery()?.matches ?? false);
  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.density = density;
  }, [resolved, density]);

  return { theme, setTheme, density, setDensity, resolved };
}

export function initialTheme(): 'light' | 'dark' {
  const pref = read<ThemePref>('pgmac.theme', THEMES, 'system');
  if (pref !== 'system') return pref;
  return darkQuery()?.matches ? 'dark' : 'light';
}

export function initialDensity(): Density {
  return read<Density>('pgmac.density', DENSITIES, 'compact');
}
