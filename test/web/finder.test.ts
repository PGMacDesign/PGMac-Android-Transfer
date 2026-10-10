import { describe, expect, it } from 'vitest';
import {
  collectDrops,
  isFinderDrag,
  isJunk,
  readAll,
  type DirEntryLike,
  type EntryLike,
  type FileEntryLike,
} from '../../src/web/finder.ts';

const file = (name: string, size: number, lastModified = 1000): FileEntryLike => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (ok) => ok(new File([new Uint8Array(size)], name, { lastModified })),
});

/** A directory whose reader hands out its children `perBatch` at a time, like Chrome's. */
const dir = (name: string, children: EntryLike[], perBatch = 100): DirEntryLike => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let i = 0;
    return {
      readEntries: (ok) => {
        const batch = children.slice(i, i + perBatch);
        i += batch.length;
        ok(batch);
      },
    };
  },
});

describe('isJunk', () => {
  it('drops Finder metadata only', () => {
    expect(isJunk('.DS_Store')).toBe(true);
    expect(isJunk('._photo.jpg')).toBe(true);
    expect(isJunk('.gitignore')).toBe(false);
    expect(isJunk('photo.jpg')).toBe(false);
    expect(isJunk('_notes')).toBe(false);
  });
});

describe('isFinderDrag', () => {
  it('recognises file drags and ignores the internal pane drag', () => {
    expect(isFinderDrag(['Files'])).toBe(true);
    expect(isFinderDrag(['text/plain'])).toBe(false);
  });
});

describe('readAll', () => {
  it('keeps reading until the reader returns an empty batch', async () => {
    const kids = Array.from({ length: 250 }, (_, i) => file(`f${i}`, 1));
    const all = await readAll(dir('big', kids, 100));
    expect(all).toHaveLength(250);
  });
});

describe('collectDrops', () => {
  it('describes a dropped file', async () => {
    const [d] = await collectDrops([{ kind: 'entry', entry: file('a.txt', 5, 42) }]);
    expect(d!.item).toEqual({ name: 'a.txt', isDir: false, size: 5, files: 1, mtimeMs: 42 });
    expect(d!.files.map((f) => f.rel)).toEqual(['']);
    expect(d!.emptyDirs).toEqual([]);
  });

  it('walks a folder, skipping junk and recording empty folders', async () => {
    const tree = dir('pics', [
      file('.DS_Store', 9),
      file('a.jpg', 10, 100),
      dir('trip', [file('b.jpg', 20, 300), file('._b.jpg', 4)], 1),
      dir('empty', []),
      dir('only-junk', [file('.DS_Store', 1)]),
    ]);
    const [d] = await collectDrops([{ kind: 'entry', entry: tree }]);
    expect(d!.item).toEqual({ name: 'pics', isDir: true, size: 30, files: 2, mtimeMs: 300 });
    expect(d!.files.map((f) => f.rel).sort()).toEqual(['a.jpg', 'trip/b.jpg']);
    expect(d!.emptyDirs.sort()).toEqual(['empty', 'only-junk']);
  });

  it('marks an empty dropped folder itself for creation', async () => {
    const [d] = await collectDrops([{ kind: 'entry', entry: dir('blank', []) }]);
    expect(d!.item.isDir).toBe(true);
    expect(d!.item.files).toBe(0);
    expect(d!.emptyDirs).toEqual(['']);
  });

  it('skips dropped junk and takes plain files when no entry is available', async () => {
    const drops = await collectDrops([
      { kind: 'entry', entry: file('.DS_Store', 1) },
      { kind: 'file', file: new File(['xy'], 'plain.bin', { lastModified: 7 }) },
    ]);
    expect(drops.map((d) => d.item)).toEqual([
      { name: 'plain.bin', isDir: false, size: 2, files: 1, mtimeMs: 7 },
    ]);
  });
});
