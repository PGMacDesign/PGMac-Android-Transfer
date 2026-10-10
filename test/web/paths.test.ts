import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../src/shared/protocol.ts';
import {
  activeShortcut,
  crumbsFor,
  folderLabel,
  isAtRoot,
  joinPath,
  parentOf,
  sortEntries,
  validateName,
} from '../../src/web/paths.ts';

const f = (name: string, size: number, mtimeMs: number, isDir = false): FileEntry => ({
  name,
  size,
  mtimeMs,
  isDir,
  isSymlink: false,
});

describe('path helpers', () => {
  it('joins and splits', () => {
    expect(joinPath('/sdcard', 'DCIM')).toBe('/sdcard/DCIM');
    expect(joinPath('/', 'Users')).toBe('/Users');
    expect(parentOf('/sdcard/DCIM')).toBe('/sdcard');
    expect(parentOf('/Users')).toBe('/');
    expect(parentOf('/')).toBe('/');
  });
  it('stops Up at the pane root', () => {
    expect(isAtRoot('android', '/sdcard')).toBe(true);
    expect(isAtRoot('android', '/sdcard/DCIM')).toBe(false);
    expect(isAtRoot('mac', '/Users/pat')).toBe(false);
    expect(isAtRoot('mac', '/')).toBe(true);
  });
  it('builds crumbs relative to the pane root', () => {
    expect(crumbsFor('android', '/sdcard/DCIM/Camera', '/Users/pat')).toEqual([
      { label: 'Internal storage', path: '/sdcard' },
      { label: 'DCIM', path: '/sdcard/DCIM' },
      { label: 'Camera', path: '/sdcard/DCIM/Camera' },
    ]);
    expect(crumbsFor('mac', '/Users/pat/Downloads', '/Users/pat')).toEqual([
      { label: 'pat', path: '/Users/pat' },
      { label: 'Downloads', path: '/Users/pat/Downloads' },
    ]);
    expect(crumbsFor('mac', '/Volumes/USB', '/Users/pat')).toEqual([
      { label: 'Macintosh HD', path: '/' },
      { label: 'Volumes', path: '/Volumes' },
      { label: 'USB', path: '/Volumes/USB' },
    ]);
  });
  it('does not treat a sibling with a shared prefix as inside home', () => {
    expect(crumbsFor('mac', '/Users/patrick', '/Users/pat')[0]).toEqual({
      label: 'Macintosh HD',
      path: '/',
    });
  });
  it('labels folders for messages', () => {
    expect(folderLabel('android', '/sdcard', '/Users/pat')).toBe('Internal storage');
    expect(folderLabel('mac', '/Users/pat', '/Users/pat')).toBe('Home');
    expect(folderLabel('mac', '/Users/pat/Downloads', '/Users/pat')).toBe('Downloads');
  });
  it('picks the most specific shortcut', () => {
    const s = ['/Users/pat', '/Users/pat/Downloads'];
    expect(activeShortcut(s, '/Users/pat/Downloads/x')).toBe('/Users/pat/Downloads');
    expect(activeShortcut(s, '/Users/pat/Music')).toBe('/Users/pat');
    expect(activeShortcut(s, '/tmp')).toBeNull();
  });
});

describe('sortEntries', () => {
  const entries = [
    f('b.txt', 10, 3),
    f('A', 0, 1, true),
    f('a10.txt', 5, 2),
    f('a2.txt', 20, 4),
    f('.hidden', 1, 9),
  ];
  it('puts folders first and sorts names naturally', () => {
    expect(sortEntries(entries, { key: 'name', asc: true }, false).map((e) => e.name)).toEqual([
      'A',
      'a2.txt',
      'a10.txt',
      'b.txt',
    ]);
  });
  it('keeps folders first when descending', () => {
    expect(sortEntries(entries, { key: 'mtime', asc: false }, false).map((e) => e.name)).toEqual([
      'A',
      'a2.txt',
      'b.txt',
      'a10.txt',
    ]);
  });
  it('shows hidden files only when asked', () => {
    expect(sortEntries(entries, { key: 'size', asc: true }, true).map((e) => e.name)).toEqual([
      'A',
      '.hidden',
      'a10.txt',
      'b.txt',
      'a2.txt',
    ]);
  });
});

describe('validateName', () => {
  it('rejects empty, slashes, dot names and duplicates', () => {
    expect(validateName('', [])).not.toBeNull();
    expect(validateName('a/b', [])).not.toBeNull();
    expect(validateName('..', [])).not.toBeNull();
    expect(validateName('x', ['x'])).not.toBeNull();
    expect(validateName('new', ['x'])).toBeNull();
  });
});
