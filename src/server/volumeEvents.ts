import type { VolumeEvent } from './fs/volumes.ts';
import type { Hub } from './hub.ts';
import type { OfflineVolume } from '../shared/protocol.ts';

export interface VolumeEventDeps {
  mac: { noteMove(from: string, to: string): void; restoreParked(): Promise<void> };
  queue: { holdVolume(mountPoint: string): void; onVolumeEvent(ev: VolumeEvent): void };
  hub: Pick<Hub, 'emit'>;
  offlineList: () => OfflineVolume[];
  /** Settings that hold a path (the downloads folder) follow the share too. */
  onMoved?: (from: string, to: string) => void;
}

/** Routes volume monitor events to the Mac file system, the queue and the page. */
export function volumeEventHandler(d: VolumeEventDeps): (ev: VolumeEvent) => void {
  const announce = () => d.hub.emit({ type: 'volumes', offlineVolumes: d.offlineList() });
  return (ev) => {
    if (ev.type === 'moved') {
      // Comes just before its online event; the hold must already cover the new path.
      d.queue.holdVolume(ev.to);
      d.mac.noteMove(ev.from, ev.to);
      d.onMoved?.(ev.from, ev.to);
      d.hub.emit({ type: 'volumeMoved', from: ev.from, to: ev.to });
    }
    if (ev.type === 'online') {
      // Originals parked by an interrupted Replace go back before transfers restart.
      d.queue.holdVolume(ev.mountPoint);
      void d.mac.restoreParked().finally(() => {
        d.queue.onVolumeEvent(ev);
        announce();
      });
      return;
    }
    d.queue.onVolumeEvent(ev);
    announce();
  };
}
