/**
 * Comparison key for names in one folder. macOS volumes are case- and normalization-
 * insensitive by default (`Photo.jpg` and `photo.jpg` are the same file), so conflict
 * detection and name reservations compare keys. On a case-sensitive volume this only
 * produces an extra Keep-both prompt, never a collision.
 */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

/** Splits "photo.tar.gz" as ("photo.tar", ".gz"); dotfiles and folders keep their whole name. */
function splitExt(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ''];
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/**
 * Finder-style "Keep both" name: `name (1).ext`, `name (2).ext`, ... skipping any name whose
 * key is in `takenKeys` (the destination listing, names reserved by active transfers, and
 * the rest of the batch).
 */
export function keepBothName(name: string, isDir: boolean, takenKeys: ReadonlySet<string>): string {
  const [base, ext] = splitExt(name, isDir);
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
}
