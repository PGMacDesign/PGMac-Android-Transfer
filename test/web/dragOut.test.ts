import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPaneDrag,
  finderDropDest,
  isDropInPlace,
  type DragInfo,
  type PgmacDesktop,
} from '../../src/web/desktop.ts';

const bridge = (): PgmacDesktop => ({
  getPathForFile: vi.fn(() => ''),
  startDrag: vi.fn(),
  chooseFile: vi.fn(async () => null),
});
const event = () => ({ preventDefault: vi.fn() });
const mac: DragInfo = { from: 'mac', dir: '/Users/me/Pics', names: ['a.jpg', 'Album'] };
const phone: DragInfo = { from: 'android', dir: '/sdcard/DCIM', names: ['b.jpg'] };

describe('beginPaneDrag', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts a native drag of the full Mac paths and never sets the in-app drag', () => {
    const b = bridge();
    const e = event();
    const setDrag = vi.fn();
    expect(beginPaneDrag(mac, e, setDrag, b)).toBe(false);
    expect(b.startDrag).toHaveBeenCalledExactlyOnceWith([
      '/Users/me/Pics/a.jpg',
      '/Users/me/Pics/Album',
    ]);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(setDrag).not.toHaveBeenCalled();
  });

  it('joins at the root without doubling the slash', () => {
    const b = bridge();
    beginPaneDrag({ from: 'mac', dir: '/', names: ['tmp'] }, event(), vi.fn(), b);
    expect(b.startDrag).toHaveBeenCalledWith(['/tmp']);
  });

  it('reads the bridge the preload exposed when none is passed', () => {
    const b = bridge();
    vi.stubGlobal('window', { pgmacDesktop: b });
    const setDrag = vi.fn();
    expect(beginPaneDrag(mac, event(), setDrag)).toBe(false);
    expect(b.startDrag).toHaveBeenCalledTimes(1);
    expect(setDrag).not.toHaveBeenCalled();
  });

  it('keeps phone-pane drags in-app, even in the desktop app', () => {
    const b = bridge();
    const e = event();
    const setDrag = vi.fn();
    expect(beginPaneDrag(phone, e, setDrag, b)).toBe(true);
    expect(b.startDrag).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(setDrag).toHaveBeenCalledExactlyOnceWith(phone);
  });

  it('keeps browser mode as it was: an in-app drag for either pane', () => {
    vi.stubGlobal('window', {});
    for (const d of [mac, phone]) {
      const e = event();
      const setDrag = vi.fn();
      expect(beginPaneDrag(d, e, setDrag)).toBe(true);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(setDrag).toHaveBeenCalledExactlyOnceWith(d);
    }
  });

  it('falls back to the in-app drag when the bridge has no startDrag', () => {
    const e = event();
    const setDrag = vi.fn();
    const old = { getPathForFile: () => '' } as unknown as PgmacDesktop;
    expect(beginPaneDrag(mac, e, setDrag, old)).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(setDrag).toHaveBeenCalledExactlyOnceWith(mac);
  });
});

describe('isDropInPlace', () => {
  it('is true when every dropped item already sits in the pane folder', () => {
    expect(isDropInPlace(['/Users/me/Pics/a.jpg', '/Users/me/Pics/Album'], '/Users/me/Pics')).toBe(
      true,
    );
    expect(isDropInPlace(['/tmp'], '/')).toBe(true);
  });

  it('is false when any item comes from another folder', () => {
    expect(isDropInPlace(['/Users/me/Pics/a.jpg', '/Users/me/b.jpg'], '/Users/me/Pics')).toBe(
      false,
    );
    expect(isDropInPlace(['/Users/me/Pics/Album/c.jpg'], '/Users/me/Pics')).toBe(false);
    expect(isDropInPlace(['/Users/me/Pics'], '/Users/me/Pics')).toBe(false);
    expect(isDropInPlace(['/Users/me/Picsx/a.jpg'], '/Users/me/Pics')).toBe(false);
  });

  it('is false for an empty drop', () => {
    expect(isDropInPlace([], '/Users/me')).toBe(false);
  });
});

describe('finderDropDest', () => {
  const paths = (...p: string[]) => ({ kind: 'paths' as const, paths: p });
  const pics = '/Users/me/Pics';

  it('ignores a background drop of items already in the pane folder', () => {
    expect(finderDropDest('mac', pics, null, paths(`${pics}/a.jpg`, `${pics}/b.jpg`))).toBeNull();
  });

  it('copies same-folder items dropped on a folder row into that folder', () => {
    expect(finderDropDest('mac', pics, 'Album', paths(`${pics}/a.jpg`))).toBe(`${pics}/Album`);
  });

  it('copies a Finder drop from another folder, on the background or a row', () => {
    expect(finderDropDest('mac', pics, null, paths('/Users/me/Desktop/c.jpg'))).toBe(pics);
    expect(finderDropDest('mac', pics, 'Album', paths('/Users/me/Desktop/c.jpg'))).toBe(
      `${pics}/Album`,
    );
  });

  it('ignores items dropped on the row of the folder they already sit in', () => {
    expect(finderDropDest('mac', pics, 'Album', paths(`${pics}/Album/c.jpg`))).toBeNull();
  });

  it('never ignores uploads or Android pane drops', () => {
    expect(finderDropDest('mac', pics, null, { kind: 'upload', sources: [] })).toBe(pics);
    expect(finderDropDest('android', '/sdcard/DCIM', null, paths('/sdcard/DCIM/a.jpg'))).toBe(
      '/sdcard/DCIM',
    );
  });
});
