import { useSyncExternalStore } from 'react';
import type { ServerMessage } from '../shared/protocol.ts';
import { applyMessage, initialServerState, type ServerState } from './reducer.ts';
import { apiToken } from './token.ts';

/**
 * `missing`: the page was opened without a token link. `rejected`: the server refused this
 * page's token (it was restarted with a new one), so retrying can never succeed.
 */
export type AuthState = 'ok' | 'missing' | 'rejected';

export interface StoreState extends ServerState {
  /** True while the WebSocket to the local server is open. */
  online: boolean;
  auth: AuthState;
}

let state: StoreState = { ...initialServerState, online: false, auth: 'ok' };
const listeners = new Set<() => void>();

function set(next: StoreState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

/** What the connection loop hears from one socket. */
export interface SocketEvents {
  open: () => void;
  message: (data: string) => void;
  close: () => void;
}

export interface ConnectionDeps {
  /** Opens one socket and reports its events; may throw instead of opening. */
  openSocket: (on: SocketEvents) => void;
  /** Status of an authenticated `GET /api/snapshot`; null when the server didn't answer. */
  probe: () => Promise<number | null>;
  schedule: (fn: () => void, ms: number) => void;
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
  /** The token was refused; nothing more is attempted after this. */
  onRejected: () => void;
}

/**
 * Keeps one socket open, reconnecting with backoff. A browser hides why an upgrade failed, so
 * after each close an HTTP request with the same token tells "server away" (retry) apart from
 * "token refused" (stop, instead of retrying forever without saying why).
 */
export function runConnection(deps: ConnectionDeps): void {
  let retryMs = 500;
  const connect = () => {
    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      deps.onClose();
      void deps
        .probe()
        .catch(() => null)
        .then((status) => {
          if (status === 401) return deps.onRejected();
          deps.schedule(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 5000);
        });
    };
    try {
      deps.openSocket({
        open: () => {
          retryMs = 500;
          deps.onOpen();
        },
        message: (data) => deps.onMessage(data),
        close: onClose,
      });
    } catch {
      // A malformed token makes the WebSocket constructor throw; the probe explains it.
      onClose();
    }
  };
  connect();
}

let started = false;

export function startStore(): void {
  if (started) return;
  started = true;
  const token = apiToken();
  if (!token) {
    set({ ...state, auth: 'missing' });
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  runConnection({
    openSocket: (on) => {
      const ws = new WebSocket(`${proto}://${location.host}/ws`, ['pgmac', `token.${token}`]);
      ws.onopen = on.open;
      ws.onmessage = (ev: MessageEvent<string>) => on.message(ev.data);
      ws.onclose = on.close;
    },
    probe: async () => {
      try {
        const res = await fetch('/api/snapshot', {
          headers: { authorization: `Bearer ${token}` },
        });
        return res.status;
      } catch {
        return null;
      }
    },
    schedule: (fn, ms) => void setTimeout(fn, ms),
    onOpen: () => set({ ...state, online: true }),
    onMessage: (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }
      const applied = applyMessage(state, msg);
      if (applied !== state) set({ ...applied, online: state.online, auth: state.auth });
    },
    // Keep the last snapshot on screen; a fresh one replaces it on reconnect.
    onClose: () => set({ ...state, online: false }),
    onRejected: () => set({ ...state, auth: 'rejected' }),
  });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getState = (): StoreState => state;

/** For code outside React (the uploader) that needs the latest state, not a render's copy. */
export const getStoreState = getState;

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getState);
}
