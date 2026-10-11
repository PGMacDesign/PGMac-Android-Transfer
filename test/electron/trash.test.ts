import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TrashReply } from '../../src/server/parentPort.ts';
import { isTrashablePath, trashHandler } from '../../electron/trash.ts';

function harness(fail: Record<string, string> = {}) {
  const trashed: string[] = [];
  const replies: TrashReply[] = [];
  const handle = trashHandler({
    trashItem: async (p) => {
      if (fail[p]) throw new Error(fail[p]);
      trashed.push(p);
    },
    reply: (m) => void replies.push(m),
  });
  return { handle, trashed, replies };
}

describe('isTrashablePath', () => {
  it('accepts only absolute paths with no NUL byte', () => {
    expect(isTrashablePath('/Users/me/a.txt')).toBe(true);
    expect(isTrashablePath('a.txt')).toBe(false);
    expect(isTrashablePath('')).toBe(false);
    expect(isTrashablePath('/Users/me/a\0.txt')).toBe(false);
    expect(isTrashablePath(42)).toBe(false);
  });
});

describe('trashHandler', () => {
  it('trashes each path in order and replies once without an error', async () => {
    const h = harness();
    expect(h.handle({ type: 'trash', id: 3, paths: ['/a', '/b'] })).toBe(true);
    await vi.waitFor(() => expect(h.replies).toEqual([{ type: 'trashResult', id: 3 }]));
    expect(h.trashed).toEqual(['/a', '/b']);
  });

  it('stops at the first failure and replies with its message', async () => {
    const h = harness({ '/b': 'No Trash on this volume' });
    h.handle({ type: 'trash', id: 4, paths: ['/a', '/b', '/c'] });
    await vi.waitFor(() =>
      expect(h.replies).toEqual([{ type: 'trashResult', id: 4, error: 'No Trash on this volume' }]),
    );
    expect(h.trashed).toEqual(['/a']);
  });

  it('trashes nothing when any path is unacceptable, and says so', () => {
    for (const paths of [['/a', 'relative'], ['/a', '/b\0c'], '/a', [1]]) {
      const h = harness();
      h.handle({ type: 'trash', id: 5, paths });
      expect(h.trashed).toEqual([]);
      expect(h.replies).toEqual([{ type: 'trashResult', id: 5, error: expect.any(String) }]);
    }
  });

  it('leaves other messages alone, and has no one to answer without an id', () => {
    const h = harness();
    expect(h.handle({ type: 'activeCount', count: 0 })).toBe(false);
    expect(h.handle(null)).toBe(false);
    expect(h.handle('trash')).toBe(false);
    expect(h.handle({ type: 'trash', paths: ['/a'] })).toBe(true);
    expect(h.handle({ type: 'trash', id: 1.5, paths: ['/a'] })).toBe(true);
    expect(h.trashed).toEqual([]);
    expect(h.replies).toEqual([]);
  });

  it('runs in main on shell.trashItem, before the quit sequence sees the message', () => {
    const main = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'electron', 'main.ts'),
      'utf8',
    );
    expect(main).toMatch(/trashItem: \(p\) => shell\.trashItem\(p\)/);
    expect(main).toMatch(
      /if \(onTrash\(message\)\) return;\s*quitter\.onServerMessage\(message\);/,
    );
    expect(main).not.toContain('osascript');
  });
});
