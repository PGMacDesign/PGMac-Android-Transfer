import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  'runs-on': string;
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

const file = path.resolve(import.meta.dirname, '../.github/workflows/release.yml');
const source = readFileSync(file, 'utf8');
const workflow = parse(source) as Workflow;
const job = workflow.jobs.release!;
const steps = job.steps;
const hasSecret = (value: unknown) => JSON.stringify(value ?? null).includes('secrets.');
const indexOf = (match: (step: Step) => boolean) => {
  const index = steps.findIndex(match);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
};
const find = (match: (step: Step) => boolean) => steps[indexOf(match)]!;

describe('release workflow triggers', () => {
  it('starts only from a v* tag push or a manual dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push).toEqual({ tags: ['v*'] });
  });

  it('takes a publish input that defaults to off', () => {
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        publish: expect.objectContaining({ type: 'boolean', default: false }),
      },
    });
  });

  it('never names a trigger that runs with secrets for someone else, even in a comment', () => {
    for (const trigger of ['pull_request_target', 'workflow_run']) {
      const lines = source.split('\n').filter((line) => line.includes(trigger));
      expect(lines.every((line) => line.trimStart().startsWith('#'))).toBe(true);
    }
  });
});

describe('release workflow permissions and environment', () => {
  it('reads by default and writes only in the release job', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['release']);
    expect(job.permissions).toEqual({ contents: 'write' });
    expect(job['runs-on']).toBe('macos-latest');
  });

  it('waits on the release environment before any step runs', () => {
    expect(job.environment).toBe('release');
  });

  it('references secrets only inside the release job', () => {
    const { jobs, ...rest } = workflow;
    expect(hasSecret(rest)).toBe(false);
    for (const [name, other] of Object.entries(jobs)) {
      if (name !== 'release') expect(hasSecret(other)).toBe(false);
    }
    // Job-level env would hand them to every step, including npm ci and the tests.
    expect(hasSecret(job.env)).toBe(false);
  });

  it('passes secrets only through env on the key and build steps', () => {
    const withSecrets = steps.filter(hasSecret);
    expect(withSecrets.map((step) => step.name)).toEqual([
      'Write the App Store Connect API key',
      'Build, sign and notarize',
    ]);
    for (const step of withSecrets) {
      const { env, ...rest } = step;
      expect(hasSecret(rest)).toBe(false);
      expect(hasSecret(env)).toBe(true);
    }
  });

  it('gives the build step every signing and notarization variable', () => {
    const build = find((step) => step.run?.includes('make:signed') ?? false);
    expect(build.env).toMatchObject({
      CSC_LINK: '${{ secrets.MAC_CERT_P12_BASE64 }}',
      CSC_KEY_PASSWORD: '${{ secrets.MAC_CERT_PASSWORD }}',
      APPLE_API_KEY: '${{ runner.temp }}/AuthKey.p8',
      APPLE_API_KEY_ID: '${{ secrets.APPLE_API_KEY_ID }}',
      APPLE_API_ISSUER: '${{ secrets.APPLE_API_ISSUER }}',
    });
  });
});

describe('release workflow steps', () => {
  it('pins every action to a full commit SHA with its version noted', () => {
    const uses = steps.filter((step) => step.uses).map((step) => step.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    for (const line of source.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    }
  });

  it('runs the checks before any secret is in reach, then builds, verifies and publishes', () => {
    const order = [
      indexOf((step) => step.uses?.startsWith('actions/checkout@') ?? false),
      indexOf((step) => step.uses?.startsWith('actions/setup-node@') ?? false),
      indexOf((step) => step.run === 'npm ci'),
      indexOf((step) => step.run === 'npm run typecheck'),
      indexOf((step) => step.run === 'npm run lint'),
      indexOf((step) => step.run === 'npm test'),
      indexOf((step) => step.run?.includes('AuthKey.p8') ?? false),
      indexOf((step) => step.run?.includes('make:signed') ?? false),
      indexOf((step) => step.run?.includes('xcrun stapler validate') ?? false),
      indexOf((step) => step.run?.includes('shasum -a 256') ?? false),
      indexOf((step) => step.uses?.startsWith('actions/upload-artifact@') ?? false),
      indexOf((step) => step.run?.includes('gh release upload') ?? false),
      steps.length - 1,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    expect(steps.slice(0, order[6]).some(hasSecret)).toBe(false);
  });

  it('uses Node 22 with the npm cache', () => {
    const node = find((step) => step.uses?.startsWith('actions/setup-node@') ?? false);
    expect(node.with).toMatchObject({ 'node-version': 22, cache: 'npm' });
  });

  it('keeps the write token out of the checkout', () => {
    const checkout = find((step) => step.uses?.startsWith('actions/checkout@') ?? false);
    expect(checkout.with).toMatchObject({ 'persist-credentials': false });
  });

  it('writes the API key with owner-only permissions', () => {
    const key = find((step) => step.run?.includes('AuthKey.p8') ?? false);
    expect(key.run).toContain('chmod 600 "$RUNNER_TEMP/AuthKey.p8"');
    expect(key.env).toEqual({ APPLE_API_KEY_P8: '${{ secrets.APPLE_API_KEY_P8 }}' });
  });

  it('keeps electron-builder from publishing on its own', () => {
    const build = find((step) => step.run?.includes('make:signed') ?? false);
    expect(build.run).toBe('npm run make:signed -- -- --publish never');
  });

  it('checks the signature, Gatekeeper and the stapled ticket', () => {
    const verify = find((step) => step.run?.includes('xcrun stapler validate') ?? false);
    expect(verify.run).toContain('codesign --verify --deep --strict --verbose=2');
    expect(verify.run).toContain('spctl --assess --type execute -vv');
  });

  it('publishes on a tag push, or on dispatch only when asked', () => {
    const publish = find((step) => step.run?.includes('gh release upload') ?? false);
    expect(publish.if).toBe("github.event_name == 'push' || inputs.publish");
    expect(publish.run).toContain('--clobber');
    expect(publish.run).toContain('gh release create');
    expect(publish.env).toMatchObject({ SHA256: '${{ steps.dmg.outputs.sha256 }}' });
  });

  it('always removes the API key and the signing keychain last', () => {
    const cleanup = steps.at(-1)!;
    expect(cleanup.if).toMatch(/^always\(\)$/);
    expect(cleanup.run).toContain('rm -f "$RUNNER_TEMP/AuthKey.p8"');
    expect(cleanup.run).toContain('security delete-keychain');
    expect(steps.filter((step) => step.if?.includes('always()'))).toEqual([cleanup]);
  });
});
