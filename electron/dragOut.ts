import path from 'node:path';

/** More paths than anyone selects by hand; a page asking for more is not to be trusted. */
export const MAX_DRAG_OUT_PATHS = 1000;

/**
 * The paths from a `drag-out` message that may be handed to a native drag: absolute, no NUL
 * byte, at most MAX_DRAG_OUT_PATHS. Nothing here touches the filesystem, so a path on a share
 * that stopped answering can't hang main; a file deleted since the listing fails in the drag.
 */
export function dragOutPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const p of input.slice(0, MAX_DRAG_OUT_PATHS)) {
    if (typeof p === 'string' && p !== '' && !p.includes('\0') && path.isAbsolute(p)) out.push(p);
  }
  return out;
}

/**
 * A plain page outline as raw BGRA pixels, for `nativeImage.createFromBitmap` when the
 * checked-in icon can't be loaded. Built in memory: the page has already cancelled its own
 * drag by the time main sees the message, so a native drag without a usable icon would leave
 * the user with no drag at all.
 */
export function fallbackDragIcon(): { buffer: Buffer; width: number; height: number } {
  const width = 16;
  const height = 16;
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 2; x < width - 2; x++) {
      const edge = x === 2 || x === width - 3 || y === 0 || y === height - 1;
      const shade = edge ? 120 : 245;
      buffer.set([shade, shade, shade, 255], (y * width + x) * 4);
    }
  }
  return { buffer, width, height };
}

/** The parts of Electron's WebContents and IPC event the handler uses (fakeable in tests). */
export interface DragOutSender {
  startDrag(item: { file: string; files: string[]; icon: unknown }): void;
}
export interface DragOutEvent {
  sender: unknown;
}

/**
 * The `ipcMain.on('drag-out')` handler. `startDrag` only works while the page is still inside
 * its `dragstart` handler, so it runs synchronously with no await before it.
 */
export function dragOutHandler(opts: {
  /** The app window's webContents, or null while there is no window. */
  appContents: () => unknown;
  icon: unknown;
  log: (message: string, err: unknown) => void;
}): (event: DragOutEvent, paths: unknown) => void {
  return (event, paths) => {
    const contents = opts.appContents();
    if (!contents || event.sender !== contents) return;
    const files = dragOutPaths(paths);
    if (!files.length) return;
    try {
      (event.sender as DragOutSender).startDrag({ file: files[0]!, files, icon: opts.icon });
    } catch (err) {
      opts.log('Could not start the drag:', err);
    }
  };
}
