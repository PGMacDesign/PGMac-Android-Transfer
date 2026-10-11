import { describe, expect, it } from 'vitest';
import { devEnv } from '../scripts/dev.ts';
import { resolveApiToken } from '../src/server/token.ts';

describe('devEnv', () => {
  it('gives the server child the token the printed link carries, in dev mode', () => {
    const token = 'abc123-dev-token-xyz';
    const env = devEnv({ PATH: '/usr/bin', API_TOKEN: '' }, token);
    expect(env.API_TOKEN).toBe(token);
    expect(env.PGMAC_DEV).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
    // Every --watch restart of the server resolves the same token from this env.
    expect(resolveApiToken(env)).toBe(token);
    expect(resolveApiToken(env)).toBe(token);
  });
});
