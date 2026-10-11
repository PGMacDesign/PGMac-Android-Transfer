import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type SessionAdb, type SessionQueue } from '../src/server/session.ts';
import { StateStore } from '../src/server/stateStore.ts';
import type { AttachedDevice, MdnsService } from '../src/server/adb/parse.ts';
import { recordingHub } from './helpers.ts';

class FakeAdb implements SessionAdb {
  attached: AttachedDevice[] = [];
  services: MdnsService[] = [];
  /** serial -> state; missing means "not found" */
  states = new Map<string, string>();
  connectable = new Set<string>();
  connects: string[] = [];
  disconnects: string[] = [];
  async devices() {
    return this.attached;
  }
  async mdnsServices() {
    return this.services;
  }
  async connect(addr: string) {
    this.connects.push(addr);
    if (!this.connectable.has(addr)) return false;
    this.states.set(addr, 'device');
    return true;
  }
  async disconnect(serial: string) {
    this.disconnects.push(serial);
    this.states.delete(serial);
  }
  async getState(serial: string) {
    return this.states.get(serial) ?? null;
  }
  async getprop(_serial: string, key: string) {
    return key === 'ro.product.model' ? 'Pixel 8 Pro' : '15';
  }
  async battery() {
    return { level: 50, charging: false };
  }
  async storage() {
    return { freeBytes: 1, totalBytes: 2 };
  }
}

class FakeQueue implements SessionQueue {
  calls: string[] = [];
  onDeviceLost() {
    this.calls.push('lost');
  }
  onDeviceReady() {
    this.calls.push('ready');
  }
  onSessionLost() {
    this.calls.push('sessionLost');
  }
  async cancelAll() {
    this.calls.push('cancelAll');
  }
  async cancelDeviceJobs() {
    this.calls.push('cancelDeviceJobs');
  }
}

const tmpStore = () => new StateStore(path.join(os.tmpdir(), `pgmac-test-${Math.random()}.json`));
const timing = { healthMs: 100, statusMs: 1000, reconnectWindowMs: 5000, backoffMs: [200, 400] };

function setup(defaultIp: string | null = null) {
  const adb = new FakeAdb();
  const queue = new FakeQueue();
  const { hub, messages } = recordingHub();
  const session = new SessionManager({
    adb,
    hub,
    store: tmpStore(),
    defaultIp: () => defaultIp,
    timing,
  });
  session.attachQueue(queue);
  return { adb, queue, session, messages };
}

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-connects the only candidate', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    const r = await t.session.start();
    expect(r.result).toBe('connected');
    expect(t.queue.calls).toEqual(['ready']);
  });

  it('prefers DEFAULT_DEVICE_IP among several candidates and connects over mDNS', async () => {
    const t = setup('192.168.1.42');
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.services = [
      { instance: 'adb-A', kind: 'connect', host: '192.168.1.42', port: 40001 },
      { instance: 'adb-B', kind: 'connect', host: '192.168.1.44', port: 40002 },
    ];
    t.adb.connectable.add('192.168.1.42:40001');
    const r = await t.session.start();
    expect(r.result).toBe('connected');
    expect(t.session.snapshot().device?.serial).toBe('192.168.1.42:40001');
  });

  it('reads the default device IP at each Start Session', async () => {
    const adb = new FakeAdb();
    const { hub } = recordingHub();
    let ip: string | null = '10.0.0.7';
    const session = new SessionManager({
      adb,
      hub,
      store: tmpStore(),
      defaultIp: () => ip,
      timing,
    });
    session.attachQueue(new FakeQueue());
    expect((await session.start()).result).toBe('pair');
    ip = '10.0.0.8';
    expect((await session.start()).result).toBe('pair');
    ip = null;
    expect((await session.start()).result).toBe('pair');
    expect(adb.connects).toEqual(['10.0.0.7:5555', '10.0.0.8:5555']);
  });

  it('offers a picker for several devices and pairing for none', async () => {
    const t = setup();
    t.adb.services = [
      { instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 1 },
      { instance: 'adb-B', kind: 'connect', host: '10.0.0.3', port: 2 },
    ];
    expect((await t.session.start()).result).toBe('pick');
    t.adb.services = [];
    expect((await t.session.start()).result).toBe('pair');
  });

  it('deduplicates an attached WiFi device and its mDNS service', async () => {
    const t = setup();
    t.adb.attached = [{ serial: '10.0.0.2:5000', state: 'device', model: 'P', transport: 'wifi' }];
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 5000 }];
    expect(await t.session.discover()).toHaveLength(1);
  });

  it('rejects a second concurrent Start Session', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    const a = t.session.start();
    const b = t.session.start();
    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('reconnects after a drop, re-resolving a changed port via mDNS', async () => {
    const t = setup();
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 5000 }];
    t.adb.connectable.add('10.0.0.2:5000');
    await t.session.start();
    t.adb.states.delete('10.0.0.2:5000');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.session.snapshot().state).toBe('reconnecting');
    expect(t.queue.calls).toContain('lost');
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 6000 }];
    t.adb.connectable.add('10.0.0.2:6000');
    await vi.advanceTimersByTimeAsync(300);
    expect(t.session.snapshot().state).toBe('connected');
    expect(t.session.snapshot().device?.serial).toBe('10.0.0.2:6000');
    expect(t.queue.calls.at(-1)).toBe('ready');
  });

  it('gives up after the reconnect window and fails waiting work', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    await t.session.start();
    t.adb.states.clear();
    await vi.advanceTimersByTimeAsync(150);
    expect(t.session.snapshot().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(5100);
    expect(t.session.snapshot().state).toBe('lost');
    expect(t.queue.calls).toContain('sessionLost');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starting over from lost cancels only device work', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    await t.session.start();
    t.adb.states.clear();
    await vi.advanceTimersByTimeAsync(5300);
    expect(t.session.snapshot().state).toBe('lost');
    t.adb.attached = [];
    await t.session.start();
    expect(t.queue.calls).toContain('cancelDeviceJobs');
    expect(t.queue.calls).not.toContain('cancelAll');
  });

  it('end() during reconnect drops the stale attempt and leaves no timers', async () => {
    const t = setup();
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 5000 }];
    t.adb.connectable.add('10.0.0.2:5000');
    await t.session.start();
    t.adb.states.clear();
    await vi.advanceTimersByTimeAsync(150);
    expect(t.session.snapshot().state).toBe('reconnecting');
    await t.session.end();
    await vi.advanceTimersByTimeAsync(6000);
    expect(t.session.snapshot().state).toBe('idle');
    expect(t.queue.calls).toContain('cancelAll');
    expect(t.queue.calls).not.toContain('sessionLost');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('end() disconnects WiFi devices', async () => {
    const t = setup();
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 5000 }];
    t.adb.connectable.add('10.0.0.2:5000');
    await t.session.start();
    await t.session.end();
    expect(t.adb.disconnects).toEqual(['10.0.0.2:5000']);
    expect(t.session.snapshot()).toMatchObject({ state: 'idle', device: null });
  });

  it('manual reconnect from lost restarts the reconnect window', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    await t.session.start();
    t.adb.states.clear();
    await vi.advanceTimersByTimeAsync(5300);
    expect(t.session.snapshot().state).toBe('lost');
    t.session.reconnect();
    expect(t.session.snapshot().state).toBe('reconnecting');
    t.adb.states.set('emulator-5554', 'device');
    await vi.advanceTimersByTimeAsync(10);
    expect(t.session.snapshot().state).toBe('connected');
  });

  it('connectAfterPairing stops without connecting once the pairing attempt is abandoned', async () => {
    const t = setup();
    t.adb.services = [{ instance: 'adb-A', kind: 'connect', host: '10.0.0.2', port: 5000 }];
    t.adb.connectable.add('10.0.0.2:5000');
    await expect(t.session.connectAfterPairing('10.0.0.2', () => false)).rejects.toThrow(
      /cancelled/,
    );
    expect(t.adb.connects).toEqual([]);
    expect(t.session.snapshot().state).toBe('idle');
  });

  it('bumps the session id for a new connect but not for a reconnect', async () => {
    const t = setup();
    t.adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    t.adb.states.set('emulator-5554', 'device');
    await t.session.start();
    const first = t.session.sessionId;
    t.adb.states.clear();
    await vi.advanceTimersByTimeAsync(150);
    t.adb.states.set('emulator-5554', 'device');
    await vi.advanceTimersByTimeAsync(300);
    expect(t.session.snapshot().state).toBe('connected');
    expect(t.session.sessionId).toBe(first);
    await t.session.end();
    await t.session.start();
    expect(t.session.sessionId).toBe(first + 1);
  });

  it('runs exactly one status loop after a drop and reconnect', async () => {
    const adb = new FakeAdb();
    let batteryCalls = 0;
    let slow: (() => void) | null = null;
    let hung = false;
    adb.battery = async () => {
      batteryCalls++;
      // The first refresh hangs across the drop, like a dumpsys on a dying connection.
      if (!hung) {
        hung = true;
        await new Promise<void>((r) => (slow = r));
      }
      return { level: 50, charging: false };
    };
    const { hub } = recordingHub();
    const session = new SessionManager({
      adb,
      hub,
      store: tmpStore(),
      defaultIp: () => null,
      timing: { healthMs: 100, statusMs: 1000, reconnectWindowMs: 5000, backoffMs: [200] },
    });
    session.attachQueue(new FakeQueue());
    adb.attached = [
      { serial: 'emulator-5554', state: 'device', model: 'emu', transport: 'emulator' },
    ];
    adb.states.set('emulator-5554', 'device');
    await session.start();
    adb.states.clear();
    await vi.advanceTimersByTimeAsync(150);
    adb.states.set('emulator-5554', 'device');
    await vi.advanceTimersByTimeAsync(300);
    expect(session.snapshot().state).toBe('connected');
    slow!();
    batteryCalls = 0;
    await vi.advanceTimersByTimeAsync(5000);
    // One loop polls about 5 times in 5 s; a leaked second loop doubles that.
    expect(batteryCalls).toBeGreaterThanOrEqual(4);
    expect(batteryCalls).toBeLessThanOrEqual(6);
  });
});
