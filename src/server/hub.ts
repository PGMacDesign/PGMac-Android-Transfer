import type { ServerMessage, ServerSnapshot } from '../shared/protocol.ts';

type Outgoing = ServerMessage extends infer M
  ? M extends { seq: number }
    ? Omit<M, 'seq'>
    : never
  : never;

export interface Client {
  send(data: string): void;
}

/**
 * Fan-out of server state to every open browser tab. Every message carries a strictly
 * increasing sequence number; a newly connected client gets a snapshot first so it can
 * discard anything older.
 */
export class Hub {
  private seq = 0;
  private readonly clients = new Set<Client>();
  private snapshotFn: () => ServerSnapshot = () => {
    throw new Error('Hub snapshot provider not set');
  };

  setSnapshotProvider(fn: () => ServerSnapshot) {
    this.snapshotFn = fn;
  }

  add(client: Client) {
    this.clients.add(client);
    this.sendTo(client, { type: 'snapshot', seq: ++this.seq, snapshot: this.snapshotFn() });
  }

  remove(client: Client) {
    this.clients.delete(client);
  }

  emit(msg: Outgoing) {
    const full = { ...msg, seq: ++this.seq } as ServerMessage;
    const data = JSON.stringify(full);
    for (const c of this.clients) {
      try {
        c.send(data);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  private sendTo(client: Client, msg: ServerMessage) {
    try {
      client.send(JSON.stringify(msg));
    } catch {
      this.clients.delete(client);
    }
  }
}
