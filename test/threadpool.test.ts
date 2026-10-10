import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const server = path.join(import.meta.dirname, '..', 'src', 'server');

describe('libuv thread pool', () => {
  it('is widened by the first import of the server entry point', async () => {
    const src = await readFile(path.join(server, 'index.ts'), 'utf8');
    const firstImport = src.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './threadpool.ts';");
  });

  it('keeps file calls moving while four calls are stuck', async () => {
    // Opening a FIFO with no writer blocks a pool thread, like a call on a dead share.
    // With the default 4 threads the stat below would never run.
    const d = await mkdtemp(path.join(os.tmpdir(), 'pgmac-pool-'));
    const script = path.join(d, 'probe.mjs');
    await writeFile(
      script,
      `import ${JSON.stringify(path.join(server, 'threadpool.ts'))};
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const fifos = [0, 1, 2, 3].map((i) => ${JSON.stringify(d)} + '/fifo' + i);
for (const f of fifos) {
  execFileSync('mkfifo', [f]);
  fs.open(f, 'r', () => {});
}
const finish = (msg) => {
  console.log(msg);
  for (const f of fifos) {
    try {
      fs.closeSync(fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    } catch {}
  }
  setTimeout(() => process.exit(0), 50);
};
const t = setTimeout(() => finish('blocked'), 1500);
fs.stat(${JSON.stringify(d)}, () => {
  clearTimeout(t);
  finish('ok');
});
`,
    );
    const env = { ...process.env };
    delete env.UV_THREADPOOL_SIZE;
    const { stdout } = await run(process.execPath, [script], { env, timeout: 10_000 });
    expect(stdout.trim()).toBe('ok');
  });
});
