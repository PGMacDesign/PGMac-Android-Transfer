import { describe, expect, it } from 'vitest';
import { runConnection, type SocketEvents } from '../../src/web/store.ts';
import { flush } from '../helpers.ts';

function harness(probeResults: (number | null | Error)[]) {
  const sockets: SocketEvents[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const log: string[] = [];
  let probes = 0;
  runConnection({
    openSocket: (on) => void sockets.push(on),
    probe: async () => {
      const r = probeResults[probes++] ?? 200;
      if (r instanceof Error) throw r;
      return r;
    },
    schedule: (fn, ms) => void timers.push({ fn, ms }),
    onOpen: () => log.push('open'),
    onMessage: (d) => log.push(`msg:${d}`),
    onClose: () => log.push('close'),
    onRejected: () => log.push('rejected'),
  });
  /** Runs every pending reconnect timer. */
  const tick = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { sockets, timers, log, tick, probes: () => probes };
}

describe('runConnection', () => {
  it('stops for good when the server refuses the token', async () => {
    const h = harness([401]);
    h.sockets[0]!.close();
    await flush();
    expect(h.log).toEqual(['close', 'rejected']);
    expect(h.timers).toEqual([]);
    h.tick();
    expect(h.sockets).toHaveLength(1);
  });

  it('reconnects with backoff while the server is away or answers anything else', async () => {
    const h = harness([null, new Error('network'), 500, 200]);
    for (const expected of [500, 1000, 2000, 4000]) {
      h.sockets.at(-1)!.close();
      await flush();
      expect(h.timers.map((t) => t.ms)).toEqual([expected]);
      h.tick();
    }
    expect(h.sockets).toHaveLength(5);
    expect(h.log).not.toContain('rejected');
  });

  it('resets the backoff once a socket opens, and passes messages through', async () => {
    const h = harness([null, null]);
    h.sockets[0]!.close();
    await flush();
    h.tick();
    h.sockets[1]!.open();
    h.sockets[1]!.message('hi');
    h.sockets[1]!.close();
    await flush();
    expect(h.timers.map((t) => t.ms)).toEqual([500]);
    expect(h.log).toEqual(['close', 'open', 'msg:hi', 'close']);
  });

  it('probes once per closed socket even if close is reported twice', async () => {
    const h = harness([200]);
    h.sockets[0]!.close();
    h.sockets[0]!.close();
    await flush();
    expect(h.probes()).toBe(1);
    expect(h.timers).toHaveLength(1);
  });

  it('treats a socket that could not be created as closed', async () => {
    const timers: (() => void)[] = [];
    const log: string[] = [];
    let opened = 0;
    runConnection({
      openSocket: () => {
        opened++;
        throw new SyntaxError('bad protocol');
      },
      probe: async () => 401,
      schedule: (fn) => void timers.push(fn),
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => log.push('close'),
      onRejected: () => log.push('rejected'),
    });
    await flush();
    expect(log).toEqual(['close', 'rejected']);
    expect(opened).toBe(1);
    expect(timers).toEqual([]);
  });
});
