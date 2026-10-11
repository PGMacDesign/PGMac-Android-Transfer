import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  WINDOW_STATE_FILE,
  fitToDisplays,
  loadWindowState,
  saveWindowState,
  windowStatePath,
  type Rect,
} from '../../electron/windowState.ts';

// A laptop screen below the menu bar, and an external monitor to its right.
const laptop: Rect = { x: 0, y: 25, width: 1512, height: 920 };
const external: Rect = { x: 1512, y: 0, width: 2560, height: 1415 };
const displays = [laptop, external];
const centred = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgmac-window-state-'));
  file = windowStatePath(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('windowStatePath', () => {
  it('names window-state.json in the userData folder', () => {
    expect(windowStatePath('/u/data')).toBe(path.join('/u/data', WINDOW_STATE_FILE));
    expect(WINDOW_STATE_FILE).toBe('window-state.json');
  });
});

describe('loadWindowState', () => {
  it('opens at the default size, centred, when nothing was saved', () => {
    expect(loadWindowState(file, displays)).toEqual(centred);
  });

  it('opens at the default size, centred, when the file is corrupt', () => {
    fs.writeFileSync(file, '{"x": 10, "y"');
    expect(loadWindowState(file, displays)).toEqual(centred);
  });

  it('ignores a file with the wrong shape', () => {
    for (const body of [
      'null',
      '[]',
      '"bounds"',
      '{"x": 10, "y": 10, "width": 900}',
      '{"x": "10", "y": 10, "width": 900, "height": 600}',
      '{"x": 10, "y": 10, "width": 0, "height": 600}',
      '{"x": 10.5, "y": 10, "width": 900, "height": 600}',
    ]) {
      fs.writeFileSync(file, body);
      expect(loadWindowState(file, displays), body).toEqual(centred);
    }
  });

  it('restores what was saved', () => {
    const bounds = { x: 1700, y: 120, width: 1100, height: 700 };
    saveWindowState(file, bounds);
    expect(loadWindowState(file, displays)).toEqual(bounds);
  });

  it('centres a window left on a display that is no longer connected', () => {
    saveWindowState(file, { x: 1700, y: 120, width: 1100, height: 700 });
    expect(loadWindowState(file, [laptop])).toEqual({ width: 1100, height: 700 });
  });
});

describe('fitToDisplays', () => {
  it('ignores a position that is off every display', () => {
    expect(fitToDisplays({ x: -3000, y: 200, width: 900, height: 600 }, displays)).toEqual({
      width: 900,
      height: 600,
    });
    expect(fitToDisplays({ x: 200, y: 5000, width: 900, height: 600 }, displays)).toEqual({
      width: 900,
      height: 600,
    });
  });

  it('shrinks an off-screen window that would not fit on any display', () => {
    expect(fitToDisplays({ x: 9000, y: 0, width: 4000, height: 3000 }, displays)).toEqual({
      width: external.width,
      height: external.height,
    });
  });

  it('pulls a window hanging off an edge back onto its display', () => {
    expect(fitToDisplays({ x: -200, y: 0, width: 900, height: 600 }, displays)).toEqual({
      x: 0,
      y: 25,
      width: 900,
      height: 600,
    });
    expect(fitToDisplays({ x: 3800, y: 1200, width: 900, height: 600 }, displays)).toEqual({
      x: external.x + external.width - 900,
      y: external.height - 600,
      width: 900,
      height: 600,
    });
  });

  it('clamps a window larger than its display to that display', () => {
    expect(fitToDisplays({ x: 100, y: 100, width: 3000, height: 2000 }, [laptop])).toEqual(laptop);
  });

  it('moves a window straddling two displays onto the one it overlaps most', () => {
    // 988px on the external monitor, 212px on the laptop.
    expect(fitToDisplays({ x: 1300, y: 100, width: 1200, height: 700 }, displays)).toEqual({
      x: external.x,
      y: 100,
      width: 1200,
      height: 700,
    });
    // 812px on the laptop, 388px on the external monitor.
    expect(fitToDisplays({ x: 700, y: 100, width: 1200, height: 700 }, displays)).toEqual({
      x: laptop.width - 1200,
      y: 100,
      width: 1200,
      height: 700,
    });
  });

  it('enforces the minimum size', () => {
    expect(fitToDisplays({ x: 100, y: 100, width: 10, height: 10 }, displays)).toEqual({
      x: 100,
      y: 100,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it('keeps the size and drops the position when there are no displays', () => {
    expect(fitToDisplays({ x: 100, y: 100, width: 900, height: 600 }, [])).toEqual({
      width: 900,
      height: 600,
    });
  });
});

describe('saveWindowState', () => {
  it('creates the folder and writes the bounds as JSON, leaving no temporary file', () => {
    const nested = path.join(dir, 'missing', WINDOW_STATE_FILE);
    saveWindowState(nested, { x: 1, y: 2, width: 900, height: 600 });
    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({
      x: 1,
      y: 2,
      width: 900,
      height: 600,
    });
    expect(fs.readdirSync(path.dirname(nested))).toEqual([WINDOW_STATE_FILE]);
  });

  it('replaces the previous state', () => {
    saveWindowState(file, { x: 1, y: 2, width: 900, height: 600 });
    saveWindowState(file, { x: 5, y: 60, width: 1000, height: 700 });
    expect(loadWindowState(file, displays)).toEqual({ x: 5, y: 60, width: 1000, height: 700 });
  });

  it('writes nothing for invalid bounds', () => {
    saveWindowState(file, { x: 1, y: 2, width: 0, height: 600 });
    expect(fs.existsSync(file)).toBe(false);
  });
});
