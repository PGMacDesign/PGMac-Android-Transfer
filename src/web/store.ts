import { useSyncExternalStore } from 'react';
import type { ServerMessage } from '../shared/protocol.ts';
import { applyMessage, initialServerState, type ServerState } from './reducer.ts';

export interface StoreState extends ServerState {
  /** True while the WebSocket to the local server is open. */
  online: boolean;
}

let state: StoreState = { ...initialServerState, online: false };
const listeners = new Set<() => void>();

function set(next: StoreState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

let socket: WebSocket | null = null;
let retryMs = 500;
let started = false;

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 500;
    set({ ...state, online: true });
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    const applied = applyMessage(state, msg);
    if (applied !== state) set({ ...applied, online: state.online });
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    // Keep the last snapshot on screen; a fresh one replaces it on reconnect.
    set({ ...state, online: false });
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

export function startStore(): void {
  if (started) return;
  started = true;
  connect();
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
