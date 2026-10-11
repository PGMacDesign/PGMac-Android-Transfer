import { afterEach, describe, expect, it, vi } from 'vitest';
import { filePathReader } from '../../src/web/desktop.ts';
import { captureDrop, type DropItemLike, type EntryLike } from '../../src/web/finder.ts';

/** A DataTransfer item for a Finder item; the fake path lookup is keyed by the File's name. */
const item = (name: string, isDirectory = false): DropItemLike => ({
  kind: 'file',
  getAsFile: () => new File([], name),
  webkitGetAsEntry: (): EntryLike => ({ name, isFile: !isDirectory, isDirectory }),
});
const dt = (...items: DropItemLike[]) => ({ items });
const pathsByName =
  (paths: Record<string, string>) =>
  (f: File): string =>
    paths[f.name] ?? '';

describe('captureDrop', () => {
  it('uses the real paths when the desktop bridge returns them, one per top-level item', () => {
    const lookup = vi.fn(pathsByName({ Album: '/Users/me/Album', 'a.txt': '/Users/me/a.txt' }));
    const drop = captureDrop(dt(item('Album', true), item('a.txt')), lookup);
    expect(drop).toEqual({ kind: 'paths', paths: ['/Users/me/Album', '/Users/me/a.txt'] });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps junk-named items, like a drag from the Mac pane', () => {
    const drop = captureDrop(dt(item('.DS_Store')), () => '/Users/me/.DS_Store');
    expect(drop).toEqual({ kind: 'paths', paths: ['/Users/me/.DS_Store'] });
  });

  it('ignores non-file items such as dragged text', () => {
    const text: DropItemLike = {
      kind: 'string',
      getAsFile: () => null,
      webkitGetAsEntry: () => null,
    };
    expect(captureDrop(dt(text, item('a.txt')), () => '/a.txt')).toEqual({
      kind: 'paths',
      paths: ['/a.txt'],
    });
  });

  it('uploads the whole drop when any item has no path', () => {
    const drop = captureDrop(
      dt(item('a.txt'), item('clip.png')),
      pathsByName({ 'a.txt': '/Users/me/a.txt' }),
    );
    expect(drop.kind).toBe('upload');
    if (drop.kind !== 'upload') return;
    expect(drop.sources.map((s) => s.kind === 'entry' && s.entry.name)).toEqual([
      'a.txt',
      'clip.png',
    ]);
  });

  it('uploads when the path lookup throws or the item has no file', () => {
    expect(
      captureDrop(dt(item('a.txt')), () => {
        throw new Error('not a file');
      }).kind,
    ).toBe('upload');
    const noFile: DropItemLike = { ...item('a.txt'), getAsFile: () => null };
    expect(captureDrop(dt(noFile), () => '/a.txt').kind).toBe('upload');
  });

  it('uploads in browser mode, where there is no path lookup', () => {
    const drop = captureDrop(dt(item('a.txt')), null);
    expect(drop.kind).toBe('upload');
  });

  it('treats a drop with nothing in it as an (empty) upload', () => {
    expect(captureDrop(dt(), () => '/x')).toEqual({ kind: 'upload', sources: [] });
  });
});

describe('filePathReader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null in browser mode', () => {
    expect(filePathReader()).toBeNull();
    vi.stubGlobal('window', {});
    expect(filePathReader()).toBeNull();
  });

  it('is null for a bridge without getPathForFile', () => {
    vi.stubGlobal('window', { pgmacDesktop: {} });
    expect(filePathReader()).toBeNull();
  });

  it("calls the bridge's getPathForFile", () => {
    const getPathForFile = vi.fn(() => '/Users/me/a.txt');
    vi.stubGlobal('window', { pgmacDesktop: { getPathForFile } });
    const f = new File([], 'a.txt');
    expect(filePathReader()!(f)).toBe('/Users/me/a.txt');
    expect(getPathForFile).toHaveBeenCalledWith(f);
  });
});
