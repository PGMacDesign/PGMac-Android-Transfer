import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Staging } from '../src/server/transfers/staging.ts';

async function staging() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pgmac-staging-'));
  return new Staging(root);
}

describe('Staging.resolve', () => {
  it('keeps every upload path inside its item', async () => {
    const s = await staging();
    const item = s.itemPath('job1', 'Photos');
    expect(s.resolve(item, '')).toBe(item);
    expect(s.resolve(item, 'a/b c.jpg')).toBe(path.join(item, 'a', 'b c.jpg'));
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a//b', 'a/', './a', ' a', 'a\0b']) {
      expect(() => s.resolve(item, bad), bad).toThrow(/Invalid upload path/);
    }
  });
});

describe('Staging.measure', () => {
  it('measures staged files and folders, creating an empty folder item', async () => {
    const s = await staging();
    const file = s.itemPath('j1', 'a.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'hello');
    expect(await s.measure(file, false)).toEqual({ bytes: 5, files: 1 });
    const dir = s.itemPath('j2', 'Pics');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'x'), 'abc');
    await writeFile(path.join(dir, 'y'), 'de');
    expect(await s.measure(dir, true)).toEqual({ bytes: 5, files: 2 });
    expect(await s.measure(s.itemPath('j3', 'Empty'), true)).toEqual({ bytes: 0, files: 0 });
    expect(await s.measure(s.itemPath('j4', 'missing.txt'), false)).toBeNull();
  });

  it('clears everything at startup and removes one job', async () => {
    const s = await staging();
    await mkdir(s.itemPath('j1', 'a'), { recursive: true });
    await mkdir(s.itemPath('j2', 'b'), { recursive: true });
    await s.remove('j1');
    expect(await readdir(s.root)).toEqual(['j2']);
    await s.clearAll();
    expect(await readdir(s.root)).toEqual([]);
    // Staged copies of private files must not be readable by other local users.
    expect((await stat(s.root)).mode & 0o777).toBe(0o700);
  });
});
