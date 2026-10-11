import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../electron-builder.config.ts';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  main?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const patterns = (config.files ?? []) as string[];
const includes = patterns.filter((p) => !p.startsWith('!'));
const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

// electron-builder's file filter: a path ships if some positive pattern matches it and no
// negation does. Real paths also include the dist/web build output, so those are listed below.
const ships = (file: string) =>
  includes.some((p) => path.matchesGlob(file, p)) &&
  !excludes.some((p) => path.matchesGlob(file, p));

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

describe('packaging config', () => {
  it('names the app and its bundle', () => {
    expect(config.productName).toBe('PGMac Android Transfer');
    expect(config.appId).toBe('com.pgmacdesign.androidtransfer');
    expect(config.mac?.category).toBe('public.app-category.utilities');
  });

  it('takes the version from package.json only', () => {
    expect(config.buildVersion).toBeUndefined();
    expect(config.extraMetadata).toBeUndefined();
  });

  it('starts the app at the Electron main entry, which ships', () => {
    expect(pkg.main).toBe('electron/main.ts');
    expect(ships(pkg.main!)).toBe(true);
  });

  it('allowlists only the runtime directories', () => {
    expect(includes.sort()).toEqual(
      [
        'dist/web/**/*',
        'electron/**/*',
        'package.json',
        'src/server/**/*',
        'src/shared/**/*',
      ].sort(),
    );
    expect(excludes).toEqual(expect.arrayContaining(['**/*.map', '**/.env', '**/.env.*']));
  });

  it('ships the server, shared and Electron sources and the built UI', () => {
    for (const file of [
      'electron/main.ts',
      'electron/lib.ts',
      'electron/preload.cjs',
      'src/server/index.ts',
      'src/server/threadpool.ts',
      'src/shared/protocol.ts',
      'dist/web/index.html',
      'dist/web/assets/index-abc123.js',
    ]) {
      expect(ships(file), file).toBe(true);
    }
  });

  it('leaves out every tracked file outside the runtime directories', () => {
    const shipped = tracked.filter(ships);
    const outside = shipped.filter(
      (f) =>
        f !== 'package.json' &&
        !['electron/', 'src/server/', 'src/shared/', 'dist/web/'].some((d) => f.startsWith(d)),
    );
    expect(outside).toEqual([]);
    for (const dir of ['test/', 'docs/', 'src/web/', 'scripts/', 'factory/', 'build/']) {
      expect(
        shipped.filter((f) => f.startsWith(dir)),
        dir,
      ).toEqual([]);
    }
  });

  it('leaves out source maps and .env files, even inside the runtime directories', () => {
    for (const file of [
      'dist/web/assets/index-abc123.js.map',
      'src/server/app.ts.map',
      'src/server/.env',
      'electron/.env.local',
      '.env',
    ]) {
      expect(ships(file), file).toBe(false);
    }
  });

  it("strips dependencies' docs, tests and benchmarks but not their code", () => {
    // Dependency files skip the allowlist (electron-builder adds them), so only negations apply.
    const stripped = (file: string) => excludes.some((p) => path.matchesGlob(file, p));
    for (const file of [
      'node_modules/fastify/docs/Guides/Getting-Started.md',
      'node_modules/@fastify/proxy-addr/benchmark/index.js',
      'node_modules/ajv/node_modules/fast-uri/test/uri.test.js',
      'node_modules/qrcode/lib/browser.js.map',
    ]) {
      expect(stripped(file), file).toBe(true);
    }
    for (const file of [
      'node_modules/fastify/fastify.js',
      'node_modules/fastify/lib/route.js',
      'node_modules/@fastify/static/index.js',
      'node_modules/qrcode/package.json',
    ]) {
      expect(stripped(file), file).toBe(false);
    }
  });

  it('adds no files beyond the allowlist and production dependencies', () => {
    // electron-builder copies production dependencies itself and prunes devDependencies;
    // any of these would add files around that.
    expect(includes.some((p) => p.includes('node_modules'))).toBe(false);
    expect(config.extraResources).toBeUndefined();
    expect(config.extraFiles).toBeUndefined();
    expect(config.mac?.extraResources).toBeUndefined();
    expect(config.mac?.extraFiles).toBeUndefined();
    // electron-builder refuses to package when electron is a production dependency, and it
    // must not be one anyway: it would ship a second copy of Electron inside the app.
    expect(pkg.dependencies).not.toHaveProperty('electron');
    expect(pkg.dependencies).not.toHaveProperty('electron-builder');
    expect(pkg.devDependencies).toHaveProperty('electron');
  });

  it('builds an unsigned universal DMG into release/', () => {
    expect(config.directories?.output).toBe('release');
    expect(config.mac?.target).toEqual([{ target: 'dmg', arch: ['universal'] }]);
    expect(config.mac?.identity).toBeNull();
    expect(config.mac?.icon).toBe('build/icon.png');
  });
});
