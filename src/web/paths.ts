import type { FileEntry, Side } from '../shared/protocol.ts';
import { ANDROID_ROOT } from '../shared/protocol.ts';

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function baseName(path: string): string {
  if (path === '/') return '/';
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** The top of navigation for a pane: Up is disabled here. */
export function isAtRoot(side: Side, path: string): boolean {
  if (side === 'android') return path === ANDROID_ROOT || path === '/';
  return path === '/';
}

export interface Crumb {
  label: string;
  path: string;
}

export function crumbsFor(side: Side, path: string, home: string): Crumb[] {
  let root: Crumb;
  if (side === 'android' && isUnder(path, ANDROID_ROOT)) {
    root = { label: 'Internal storage', path: ANDROID_ROOT };
  } else if (side === 'mac' && home && isUnder(path, home)) {
    root = { label: baseName(home), path: home };
  } else {
    root = { label: side === 'mac' ? 'Macintosh HD' : '/', path: '/' };
  }
  const rest = path.slice(root.path.length).split('/').filter(Boolean);
  const crumbs = [root];
  let acc = root.path;
  for (const part of rest) {
    acc = joinPath(acc, part);
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Short folder name for messages ("Copy 3 items to Download"). */
export function folderLabel(side: Side, dir: string, home: string): string {
  if (side === 'android' && dir === ANDROID_ROOT) return 'Internal storage';
  if (side === 'mac' && dir === home) return 'Home';
  return baseName(dir);
}

export type SortKey = 'name' | 'size' | 'mtime';

export interface SortSpec {
  key: SortKey;
  asc: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then the chosen key; ties fall back to name. */
export function sortEntries(
  entries: FileEntry[],
  sort: SortSpec,
  showHidden: boolean,
): FileEntry[] {
  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
  const byName = (a: FileEntry, b: FileEntry): number => collator.compare(a.name, b.name);
  return [...visible].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r: number;
    if (sort.key === 'name') r = byName(a, b);
    else if (sort.key === 'size') r = a.size - b.size || byName(a, b);
    else r = a.mtimeMs - b.mtimeMs || byName(a, b);
    return sort.asc ? r : -r;
  });
}

/** The shortcut that best contains `path` (longest prefix), or null. */
export function activeShortcut(paths: string[], path: string): string | null {
  let best: string | null = null;
  for (const p of paths) {
    if (isUnder(path, p) && (best === null || p.length > best.length)) best = p;
  }
  return best;
}

/** Validation for new folder and rename input. Returns an error message or null. */
export function validateName(name: string, existing: string[]): string | null {
  if (!name) return 'Enter a name.';
  if (name.includes('/')) return 'Names can’t contain “/”.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (existing.includes(name)) return `“${name}” already exists here.`;
  return null;
}
