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
  const pairing = new PairingManager({ adb, hub, session, timeoutMs: 3000, pollMs: 100 });
  return { adb, session, pairing };
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
});
