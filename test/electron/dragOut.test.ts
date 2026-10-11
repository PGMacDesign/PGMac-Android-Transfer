import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every fs function the handler module could reach throws and is recorded, so a test passing
// proves the drag path never touches the disk (a dead network share would hang main there).
const { fsCalls, throwingFs } = vi.hoisted(() => {
  const fsCalls: string[] = [];
  const throwingFs = async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    const fake: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(actual)) {
      fake[key] =
        typeof value === 'function'
          ? () => {
              fsCalls.push(key);
              throw new Error(`fs.${key} was called`);
            }
          : value;
    }
    return { ...fake, default: fake };
  };
  return { fsCalls, throwingFs };
});
vi.mock('node:fs', throwingFs);
vi.mock('node:fs/promises', throwingFs);
vi.mock('fs', throwingFs);
vi.mock('fs/promises', throwingFs);

const { MAX_DRAG_OUT_PATHS, dragOutHandler, dragOutPaths, fallbackDragIcon } =
  await import('../../electron/dragOut.ts');
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const electronFile = (name: string) => path.join(import.meta.dirname, '../../electron', name);

beforeEach(() => {
  fsCalls.length = 0;
});

describe('fake fs', () => {
  it('records and throws on any call, so the no-fs assertions below can fail', async () => {
    const fs = await import('node:fs');
    expect(() => fs.existsSync('/')).toThrow();
    expect(fsCalls).toEqual(['existsSync']);
  });
});

describe('dragOutPaths', () => {
  it('keeps absolute string paths, in order', () => {
    expect(dragOutPaths(['/Users/me/a.txt', '/Volumes/NAS/b'])).toEqual([
      '/Users/me/a.txt',
      '/Volumes/NAS/b',
    ]);
    expect(fsCalls).toEqual([]);
  });

  it('drops relative, empty, NUL-containing and non-string entries', () => {
    expect(
      dragOutPaths([
        'a.txt',
        './a.txt',
        '../etc/passwd',
        '',
        '/Users/me/a\0.txt',
        42,
        null,
        undefined,
        { path: '/x' },
        ['/y'],
        '/ok',
      ]),
    ).toEqual(['/ok']);
    expect(fsCalls).toEqual([]);
  });

  it('accepts only an array', () => {
    for (const input of ['/Users/me/a.txt', null, undefined, 5, { 0: '/a', length: 1 }]) {
      expect(dragOutPaths(input)).toEqual([]);
    }
  });

  it(`caps the list at ${MAX_DRAG_OUT_PATHS} paths`, () => {
    const many = Array.from({ length: MAX_DRAG_OUT_PATHS + 5 }, (_, i) => `/f/${i}`);
    const out = dragOutPaths(many);
    expect(out).toHaveLength(MAX_DRAG_OUT_PATHS);
    expect(out.at(-1)).toBe(`/f/${MAX_DRAG_OUT_PATHS - 1}`);
  });
});

describe('dragOutHandler', () => {
  const icon = { kind: 'icon' };
  const setup = () => {
    const contents = { startDrag: vi.fn() };
    const log = vi.fn();
    const handler = dragOutHandler({ appContents: () => contents, icon, log });
    return { contents, log, handler };
  };

  it("starts the drag on the app window's own contents with the filtered paths", () => {
    const { contents, handler } = setup();
    handler({ sender: contents }, ['/a/1.txt', 'rel', '/a/2.txt']);
    expect(contents.startDrag).toHaveBeenCalledExactlyOnceWith({
      file: '/a/1.txt',
      files: ['/a/1.txt', '/a/2.txt'],
      icon,
    });
    expect(fsCalls).toEqual([]);
  });

  it('starts it synchronously, before the handler returns', () => {
    const { contents, handler } = setup();
    const result: unknown = handler({ sender: contents }, ['/a']);
    expect(result).toBeUndefined();
    expect(contents.startDrag).toHaveBeenCalledTimes(1);
  });

  it('ignores a message from any other sender', () => {
    const { contents, handler } = setup();
    const other = { startDrag: vi.fn() };
    handler({ sender: other }, ['/a']);
    expect(other.startDrag).not.toHaveBeenCalled();
    expect(contents.startDrag).not.toHaveBeenCalled();
  });

  it('ignores every sender while there is no window', () => {
    const sender = { startDrag: vi.fn() };
    const handler = dragOutHandler({ appContents: () => null, icon, log: vi.fn() });
    handler({ sender }, ['/a']);
    expect(sender.startDrag).not.toHaveBeenCalled();
  });

  it('starts nothing when no path survives the filter', () => {
    const { contents, handler } = setup();
    handler({ sender: contents }, ['rel', 7]);
    handler({ sender: contents }, 'not an array');
    expect(contents.startDrag).not.toHaveBeenCalled();
  });

  it('logs and swallows a startDrag that throws', () => {
    const { contents, log, handler } = setup();
    const err = new Error('drag failed');
    contents.startDrag.mockImplementation(() => {
      throw err;
    });
    expect(() => handler({ sender: contents }, ['/gone.txt'])).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.any(String), err);
    expect(fsCalls).toEqual([]);
  });
});

describe('drag icon', () => {
  it('is a non-empty PNG checked in next to main', () => {
    const png = realFs.readFileSync(electronFile('drag-icon.png'));
    expect(png.length).toBeGreaterThan(8);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // IHDR width and height.
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(20)).toBeGreaterThan(0);
  });

  it('has a built-in fallback bitmap that is non-empty and visible, with no fs access', () => {
    const { buffer, width, height } = fallbackDragIcon();
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(buffer).toHaveLength(width * height * 4);
    const opaque = Array.from({ length: width * height }, (_, i) => buffer[i * 4 + 3]).filter(
      (a) => a === 255,
    );
    expect(opaque.length).toBeGreaterThan(0);
    expect(fsCalls).toEqual([]);
  });

  it('falls back to the built-in bitmap when the PNG loads empty', () => {
    const main = realFs.readFileSync(electronFile('main.ts'), 'utf8');
    expect(main).toMatch(
      /if \(dragIcon\.isEmpty\(\)\) \{[\s\S]*?fallbackDragIcon\(\)[\s\S]*?nativeImage\.createFromBitmap\(/,
    );
  });

  it('is loaded with nativeImage, and drag-out is a one-way ipcMain.on message', () => {
    const main = realFs.readFileSync(electronFile('main.ts'), 'utf8');
    expect(main).toMatch(/nativeImage\.createFromPath\(dragIconPath\)/);
    expect(main).toMatch(/'drag-icon\.png'/);
    expect(main).toMatch(/ipcMain\.on\(\s*'drag-out'/);
    expect(main).not.toMatch(/ipcMain\.handle\(\s*'drag-out'/);
  });
});
