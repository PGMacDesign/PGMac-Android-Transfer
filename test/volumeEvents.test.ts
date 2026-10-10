import { describe, expect, it } from 'vitest';
import { volumeEventHandler } from '../src/server/volumeEvents.ts';

function setup() {
  const log: string[] = [];
  let finishRestore = () => {};
  const handler = volumeEventHandler({
    mac: {
      noteMove: (from, to) => log.push(`noteMove ${from} ${to}`),
      restoreParked: () => {
        log.push('restore');
        return new Promise<void>((r) => (finishRestore = r));
      },
    },
    queue: {
      holdVolume: (mp) => log.push(`hold ${mp}`),
      onVolumeEvent: (ev) => log.push(`queue ${ev.type}`),
    },
    hub: { emit: (m) => log.push(`emit ${m.type}`) },
    offlineList: () => [],
    onMoved: (from, to) => log.push(`settings ${from} ${to}`),
  });
  return { log, handler, finishRestore: () => finishRestore() };
}

describe('volume event routing', () => {
  it('holds a share that came back until its parked originals are restored', async () => {
    const t = setup();
    t.handler({ type: 'moved', from: '/Volumes/NAS', to: '/Volumes/NAS-1' });
    t.handler({ type: 'online', mountPoint: '/Volumes/NAS-1' });
    expect(t.log).toEqual([
      'hold /Volumes/NAS-1',
      'noteMove /Volumes/NAS /Volumes/NAS-1',
      'settings /Volumes/NAS /Volumes/NAS-1',
      'emit volumeMoved',
      'queue moved',
      'emit volumes',
      'hold /Volumes/NAS-1',
      'restore',
    ]);
    t.finishRestore();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.log.slice(-2)).toEqual(['queue online', 'emit volumes']);
  });

  it('passes other events straight to the queue', () => {
    const t = setup();
    t.handler({ type: 'offline', mountPoint: '/Volumes/NAS' });
    expect(t.log).toEqual(['queue offline', 'emit volumes']);
  });
});
