import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// The same minimatch copy and options electron-builder filters with: dot files match `*`, and
// matching is case-sensitive, unlike path.matchesGlob on macOS.
const { Minimatch } = createRequire(path.join(root, 'node_modules/app-builder-lib/package.json'))(
  'minimatch',
) as typeof import('minimatch');
const matches = (file: string, pattern: string) =>
  new Minimatch(pattern, { dot: true }).match(file);

// electron-builder's file filter: a path ships if some positive pattern matches it and no
// negation does. Real paths also include the dist/web build output, so those are listed below.
const ships = (file: string) =>
  includes.some((p) => matches(file, p)) && !excludes.some((p) => matches(file, p));
// Dependency files skip the allowlist (electron-builder adds them), so only negations apply.
const stripped = (file: string) => excludes.some((p) => matches(file, p));

type Manifest = {
  main?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const readManifest = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;

// Node's lookup: the nearest node_modules/<name> walking up from the dependent's folder.
function findPackage(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) return undefined;
  }
}

// Every file a `require` or `import` of the package can land on: `main` (with Node's extension
// and index fallbacks) and each `exports` target. `types` conditions are skipped: they point at
// declarations the compiler reads, never at runtime code.
function entryFiles(dir: string, manifest: Manifest): string[] {
  const found = new Set<string>();
  const main = manifest.main ?? 'index.js';
  const mainFile = [main, `${main}.js`, `${main}.json`, `${main}.node`, `${main}/index.js`]
    .map((f) => path.join(dir, f))
    .find((f) => statSync(f, { throwIfNoEntry: false })?.isFile());
  if (mainFile) found.add(mainFile);
  const visit = (target: unknown) => {
    if (typeof target === 'string') {
      // A subpath pattern (`./lib/*.js`) stands for every file it can expand to.
      const files = target.includes('*')
        ? globSync(target.replaceAll('*', '**/*'), { cwd: dir }).map((f) => path.join(dir, f))
        : [path.join(dir, target)];
      for (const f of files) found.add(f);
    } else if (Array.isArray(target)) {
      target.forEach(visit);
    } else if (target && typeof target === 'object') {
      for (const [key, value] of Object.entries(target)) {
        if (key !== 'types' && key !== 'typings') visit(value);
      }
    }
  };
  visit(manifest.exports);
  return [...found].map((f) => path.relative(root, f));
}

// The production dependencies and everything they depend on, as electron-builder collects them.
function productionPackages(): Map<string, Manifest> {
  const seen = new Map<string, Manifest>();
  const queue: [string, string][] = Object.keys(pkg.dependencies).map((n) => [n, root]);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [name, fromDir] = next;
    const dir = findPackage(name, fromDir);
    // Optional dependencies for another platform aren't installed and don't ship.
    if (!dir || seen.has(dir)) continue;
    const manifest = readManifest(dir);
    seen.set(dir, manifest);
    for (const dep of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      queue.push([dep, dir]);
    }
  }
  return seen;
}

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

  it("strips dependencies' docs, tests, examples and declarations but not their code", () => {
    for (const file of [
      'node_modules/fastify/docs/Guides/Getting-Started.md',
      'node_modules/@fastify/proxy-addr/benchmark/index.js',
      'node_modules/ajv/node_modules/fast-uri/test/uri.test.js',
      'node_modules/qrcode/lib/browser.js.map',
      // Test, spec and example folders nested below a package's top level.
      'node_modules/sonic-boom/types/tests/test.ts',
      'node_modules/json-schema-traverse/spec/index.spec.js',
      'node_modules/json-schema-traverse/spec/fixtures/schema.js',
      'node_modules/pino/lib/tests/x.test.js',
      'node_modules/@fastify/static/lib/__tests__/static.js',
      'node_modules/ws/lib/examples/server.js',
      'node_modules/qrcode/helper/example/index.js',
      // The folders themselves, which electron-builder tests before descending into them.
      'node_modules/sonic-boom/types/tests',
      'node_modules/json-schema-traverse/spec',
      // Test, spec, Markdown and declaration files anywhere in a package.
      'node_modules/fastify/lib/route.test.js',
      'node_modules/avvio/lib/plugin.spec.mjs',
      'node_modules/fastify/README.md',
      'node_modules/pino/docs-site/api.md',
      'node_modules/fastify/types/instance.d.ts',
      'node_modules/open/index.d.ts',
      'node_modules/glob/dist/esm/index.d.mts',
    ]) {
      expect(stripped(file), file).toBe(true);
    }
    for (const file of [
      'node_modules/fastify/fastify.js',
      'node_modules/fastify/lib/route.js',
      'node_modules/@fastify/static/index.js',
      'node_modules/qrcode/package.json',
      'node_modules/fastify/LICENSE',
      'node_modules/pino/LICENSE.md',
      'node_modules/fastify/license.md',
      // Packages whose own name is one of the stripped folder names.
      'node_modules/test/index.js',
      'node_modules/examples/lib/index.js',
      'node_modules/@scope/spec/index.js',
    ]) {
      expect(stripped(file), file).toBe(false);
    }
  });

  it('keeps every entry file of the production dependencies and their dependencies', () => {
    const packages = productionPackages();
    // Every direct production dependency is installed and walked.
    for (const name of Object.keys(pkg.dependencies)) {
      expect(packages.has(path.join(root, 'node_modules', name)), name).toBe(true);
    }
    const entries: string[] = [];
    for (const [dir, manifest] of packages) {
      // Some packages export targets they don't publish (lru-cache's react-native build), so
      // only files that exist count, and each package must still have one.
      const files = entryFiles(dir, manifest).filter((f) => existsSync(path.join(root, f)));
      expect(files.length, path.relative(root, dir)).toBeGreaterThan(0);
      entries.push(...files);
    }
    expect(entries.filter(stripped)).toEqual([]);
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
