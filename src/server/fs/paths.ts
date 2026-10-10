import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PARTIAL_SUFFIX } from '../../shared/protocol.ts';
import { invalid } from '../errors.ts';

/** Validates and normalizes an absolute POSIX path supplied by the client. */
export function normalizeAbs(p: unknown): string {
  if (typeof p !== 'string' || !p) throw invalid('Path is required.');
  if (p.includes('\0')) throw invalid('Path contains a NUL byte.');
  if (!p.startsWith('/')) throw invalid(`Path must be absolute: ${p}`);
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** Validates a single path segment (a file or folder name). */
export function validateName(name: unknown): string {
  if (typeof name !== 'string') throw invalid('Name is required.');
  const n = name.trim();
  if (!n) throw invalid('Name is required.');
  if (n === '.' || n === '..') throw invalid('That name is reserved.');
  if (n.includes('/')) throw invalid('Names can’t contain “/”.');
  if (n.includes('\0')) throw invalid('Name contains a NUL byte.');
  if (Buffer.byteLength(n) > 255) throw invalid('Name is too long.');
  return n;
}

export const joinPosix = (dir: string, name: string) => path.posix.join(dir, name);
export const baseName = (p: string) => path.posix.basename(p);
export const dirName = (p: string) => path.posix.dirname(p);

/** True when a and b are the same path or one contains the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const within = (inner: string, outer: string) =>
    inner.startsWith(outer === '/' ? '/' : outer + '/');
  return within(a, b) || within(b, a);
}

/**
 * Where Replace parks the existing item while the new one is moved in. The suffix keeps it
 * out of listings; the random part keeps it from colliding with any job's partial path.
 */
export function replaceBackupPath(finalPath: string): string {
  const name = path.posix.basename(finalPath);
  const tag = randomBytes(4).toString('hex');
  return path.posix.join(path.posix.dirname(finalPath), `.${name}.${tag}${PARTIAL_SUFFIX}`);
}
