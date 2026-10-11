import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingManager, type PairingAdb, type PairingSession } from '../src/server/pairing.ts';
import type { MdnsService } from '../src/server/adb/parse.ts';
import type { SessionSnapshot } from '../src/shared/protocol.ts';
import { recordingHub } from './helpers.ts';

class FakeAdb implements PairingAdb {
  services: MdnsService[] = [];
  pairs: string[] = [];
  result: { ok: true } | { ok: false; error: string } = { ok: true };
  async mdnsServices() {
    return this.services;
  }
  async pair(addr: string, code: string) {
    this.pairs.push(`${addr} ${code}`);
    return this.result;
  }
}

class FakeSession implements PairingSession {
  connected = false;
  hosts: string[] = [];
  stillWanted: (() => boolean) | null = null;
  isConnected() {
    return this.connected;
  }
  async connectAfterPairing(host: string, stillWanted: () => boolean) {
    this.stillWanted = stillWanted;
    this.hosts.push(host);
    return { device: { model: 'Pixel 8 Pro' } } as SessionSnapshot;
  }
}

function setup() {
  const adb = new FakeAdb();
  const session = new FakeSession();
  const { hub } = recordingHub();
  const logs: string[] = [];
  const pairing = new PairingManager({
    adb,
    hub,
    session,
    timeoutMs: 3000,
    pollMs: 100,
    log: (line) => logs.push(line),
  });
  return { adb, session, pairing, logs };
}

const nameFromSvgRequest = (p: PairingManager) =>
  // The service name is private; recover it by asking what the poll is matching against.
  (p as unknown as { current: { serviceName: string; password: string } }).current;

describe('PairingManager', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('pairs only with the service it advertised in the QR code, then connects', async () => {
    const t = setup();
    const snap = await t.pairing.startQr();
    expect(snap.qrSvg).toContain('<svg');
    const { serviceName, password } = nameFromSvgRequest(t.pairing);
    t.adb.services = [
      { instance: 'studio-someone-else', kind: 'pairing', host: '10.0.0.9', port: 1 },
    ];
    await vi.advanceTimersByTimeAsync(250);
    expect(t.adb.pairs).toEqual([]);
    t.adb.services.push({ instance: serviceName, kind: 'pairing', host: '10.0.0.2', port: 41827 });
    await vi.advanceTimersByTimeAsync(150);
    expect(t.adb.pairs).toEqual([`10.0.0.2:41827 ${password}`]);
    expect(t.session.hosts).toEqual(['10.0.0.2']);
    expect(t.pairing.snapshot()).toMatchObject({ status: 'success', deviceName: 'Pixel 8 Pro' });
  });

  it('stops polling at the deadline and reports a timeout', async () => {
    const t = setup();
    await t.pairing.startQr();
    await vi.advanceTimersByTimeAsync(3300);
    expect(t.pairing.snapshot()?.status).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new attempt cancels the old one and ignores its late results', async () => {
    const t = setup();
    await t.pairing.startQr();
    const first = nameFromSvgRequest(t.pairing).serviceName;
    await t.pairing.startQr();
    t.adb.services = [{ instance: first, kind: 'pairing', host: '10.0.0.2', port: 1 }];
    await vi.advanceTimersByTimeAsync(500);
    expect(t.adb.pairs).toEqual([]);
    expect(t.pairing.snapshot()?.status).toBe('waiting');
  });

  it('pairs with a code and surfaces a wrong-code error', async () => {
    const t = setup();
    t.adb.result = { ok: false, error: 'Wrong pairing code.' };
    await t.pairing.pairWithCode({ host: '10.0.0.2', port: 41827, code: '123456' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pairing.snapshot()).toMatchObject({ status: 'error', error: 'Wrong pairing code.' });
    expect(t.session.hosts).toEqual([]);
  });

  it('validates code input before running adb', async () => {
    const t = setup();
    await expect(
      t.pairing.pairWithCode({ host: '10.0.0.2', port: 41827, code: '12' }),
    ).rejects.toThrow(/6 digits/);
    await expect(
      t.pairing.pairWithCode({ host: '10.0.0.2; rm -rf /', port: 1, code: '123456' }),
    ).rejects.toThrow();
    expect(t.adb.pairs).toEqual([]);
  });

  it('does not hijack an active session after pairing another device', async () => {
    const t = setup();
    t.session.connected = true;
    await t.pairing.pairWithCode({ host: '10.0.0.2', port: 41827, code: '123456' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pairing.snapshot()?.status).toBe('success');
    expect(t.session.hosts).toEqual([]);
  });

  it('tells the session to stop connecting once the attempt is cancelled', async () => {
    const t = setup();
    await t.pairing.pairWithCode({ host: '10.0.0.2', port: 41827, code: '123456' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.stillWanted?.()).toBe(true);
    t.pairing.cancel();
    expect(t.session.stillWanted?.()).toBe(false);
  });

  describe('logging', () => {
    const svc = (instance: string, host = '10.0.0.9') =>
      ({ instance, kind: 'pairing', host, port: 41827 }) as MdnsService;

    it('logs a QR attempt from start through a pair failure, never with the password', async () => {
      const t = setup();
      await t.pairing.startQr();
      const { serviceName, password } = nameFromSvgRequest(t.pairing);
      await vi.advanceTimersByTimeAsync(250);
      t.adb.services = [svc('studio-someone-else')];
      await vi.advanceTimersByTimeAsync(200);
      t.adb.services = [
        svc('studio-someone-else'),
        { instance: serviceName, kind: 'connect', host: '10.0.0.2', port: 1 },
        svc(serviceName, '10.0.0.2'),
      ];
      // adb's error text can include the command line, password and all.
      t.adb.result = { ok: false, error: `Failed: adb pair 10.0.0.2:41827 ${password}` };
      await vi.advanceTimersByTimeAsync(100);

      expect(t.logs.map((l) => l.replace(/^\[pairing qr \w+\] /, ''))).toEqual([
        `QR attempt started, waiting for _adb-tls-pairing service ${serviceName}`,
        'Seeing 1 _adb-tls-pairing service(s): studio-someone-else',
        `Seeing 2 _adb-tls-pairing service(s): studio-someone-else, ${serviceName}`,
        `Found ${serviceName} at 10.0.0.2:41827`,
        'adb pair 10.0.0.2:41827 failed: Failed: adb pair 10.0.0.2:41827 [password]',
      ]);
      expect(t.logs.join('\n')).not.toContain(password);
    });

    it('logs the pair and connect results of a match', async () => {
      const t = setup();
      await t.pairing.startQr();
      const { serviceName, password } = nameFromSvgRequest(t.pairing);
      t.adb.services = [svc(serviceName, '10.0.0.2')];
      await vi.advanceTimersByTimeAsync(100);
      expect(t.logs.slice(-2)).toEqual([
        expect.stringMatching(/adb pair 10\.0\.0\.2:41827 succeeded$/),
        expect.stringMatching(/Connected to Pixel 8 Pro at 10\.0\.0\.2$/),
      ]);
      expect(t.logs.join('\n')).not.toContain(password);
    });

    it('logs a timeout and a cancel', async () => {
      const t = setup();
      await t.pairing.startQr();
      const { serviceName } = nameFromSvgRequest(t.pairing);
      await vi.advanceTimersByTimeAsync(3300);
      t.pairing.cancel();
      expect(t.logs.slice(-2)).toEqual([
        expect.stringMatching(new RegExp(`Timed out after 3000 ms without seeing ${serviceName}$`)),
        expect.stringMatching(/Cancelled \(was timeout\)$/),
      ]);
    });

    it('logs the cancel of a QR attempt replaced by a new one', async () => {
      const t = setup();
      await t.pairing.startQr();
      await t.pairing.startQr();
      expect(t.logs.map((l) => l.replace(/^\[pairing qr \w+\] /, ''))).toEqual([
        expect.stringMatching(/^QR attempt started/),
        'Cancelled (was waiting)',
        expect.stringMatching(/^QR attempt started/),
      ]);
    });

    it('logs nothing more while polling sees the same services', async () => {
      const t = setup();
      await t.pairing.startQr();
      t.adb.services = [svc('studio-someone-else')];
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.logs).toHaveLength(2);
    });

    it('keeps the typed code out of a code attempt log', async () => {
      const t = setup();
      t.adb.result = { ok: false, error: 'Failed: adb pair 10.0.0.2:41827 123456' };
      await t.pairing.pairWithCode({ host: '10.0.0.2', port: 41827, code: '123456' });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.logs.map((l) => l.replace(/^\[pairing code \w+\] /, ''))).toEqual([
        'Code attempt started for 10.0.0.2:41827',
        'adb pair 10.0.0.2:41827 failed: Failed: adb pair 10.0.0.2:41827 [password]',
      ]);
    });
  });
});
