import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Platform } from '../shared/protocol.ts';

const run = promisify(execFile);

// NSWorkspace selects several items in one Finder window and, unlike scripting Finder,
// needs no Automation permission. Paths arrive as argv, so nothing is interpolated.
const JXA_REVEAL = `function run(argv) {
  ObjC.import('AppKit');
  const urls = $.NSMutableArray.array;
  argv.forEach((p) => urls.addObject($.NSURL.fileURLWithPath(p)));
  $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs(urls);
}`;

/** GVariant text for an array of strings: single-quoted, with `\\` and `'` escaped. */
export function gvariantStrings(items: string[]): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `[${items.map(q).join(', ')}]`;
}

/** Opens the system file manager with `paths` selected. Best effort: failures are ignored. */
export async function reveal(platform: Platform, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    if (platform === 'darwin') {
      await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_REVEAL, ...paths], {
        timeout: 10_000,
      });
      return;
    }
    const uris = paths.map((p) => pathToFileURL(p).href);
    try {
      // Nautilus, Dolphin, Nemo, Thunar and others implement this freedesktop interface.
      await run(
        'gdbus',
        [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.FileManager1',
          '--object-path',
          '/org/freedesktop/FileManager1',
          '--method',
          'org.freedesktop.FileManager1.ShowItems',
          gvariantStrings(uris),
          "''",
        ],
        { timeout: 10_000 },
      );
    } catch {
      await run('xdg-open', [path.dirname(paths[0]!)], { timeout: 10_000 });
    }
  } catch {
    // Revealing is a convenience; the copy itself already succeeded.
  }
}
