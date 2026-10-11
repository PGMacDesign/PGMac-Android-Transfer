import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_STATE_FILE = 'window-state.json';
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;
export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 360;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the window is created with. No position means "centre it". */
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseRect(raw: unknown): Rect | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (!isInt(x) || !isInt(y) || !isInt(width) || !isInt(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Fits saved bounds to the displays connected now (their work areas). A window that overlaps
 * no display, say one left on an unplugged monitor, keeps its size but loses its position so
 * it opens centred. Otherwise it is moved and shrunk to sit wholly on the display it overlaps
 * most, so no edge or title bar is out of reach.
 */
export function fitToDisplays(saved: Rect, displays: Rect[]): WindowBounds {
  const size = {
    width: Math.max(saved.width, MIN_WIDTH),
    height: Math.max(saved.height, MIN_HEIGHT),
  };
  let best: Rect | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = overlapArea(saved, d);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  if (!best) {
    const largest = displays.reduce<Rect | null>(
      (a, d) => (!a || d.width * d.height > a.width * a.height ? d : a),
      null,
    );
    if (!largest) return size;
    return {
      width: Math.min(size.width, largest.width),
      height: Math.min(size.height, largest.height),
    };
  }
  const width = Math.min(size.width, best.width);
  const height = Math.min(size.height, best.height);
  return {
    width,
    height,
    x: clamp(saved.x, best.x, best.x + best.width - width),
    y: clamp(saved.y, best.y, best.y + best.height - height),
  };
}

export function windowStatePath(userData: string): string {
  return path.join(userData, WINDOW_STATE_FILE);
}

/** The bounds to open with: the saved ones fitted to `displays`, or the default, centred. */
export function loadWindowState(file: string, displays: Rect[]): WindowBounds {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing on first launch, or corrupt: either way the default is the right answer.
    return { ...DEFAULT_BOUNDS };
  }
  const saved = parseRect(raw);
  return saved ? fitToDisplays(saved, displays) : { ...DEFAULT_BOUNDS };
}

/**
 * Written through a temporary file and a rename, so a quit in the middle of a write leaves the
 * previous state rather than a truncated file.
 */
export function saveWindowState(file: string, bounds: Rect): void {
  const rect = parseRect(bounds);
  if (!rect) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rect) + '\n');
  fs.renameSync(tmp, file);
}
