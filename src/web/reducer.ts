import type { Job, ServerMessage, ServerSnapshot, Side } from '../shared/protocol.ts';

/** Client mirror of server state. Only `applyMessage` writes to it. */
export interface ServerState {
  snapshot: ServerSnapshot | null;
  /** seq of the last applied message; messages at or below it are stale. */
  seq: number;
  /** Bumped per `${side}:${dir}` on fsChanged so panes showing that folder refetch. */
  fsVersions: Record<string, number>;
  /**
   * Bumped on every snapshot. fsChanged events sent while the socket was down are lost, so
   * every listing refetches after a (re)connect.
   */
  listEpoch: number;
  /**
   * The latest remount: Mac panes showing a path under `from` move it under `to`. `n`
   * increases per move so a pane can tell a new move from one it already applied.
   */
  volumeMove: { from: string; to: string; n: number } | null;
}

export const initialServerState: ServerState = {
  snapshot: null,
  seq: -1,
  fsVersions: {},
  listEpoch: 0,
  volumeMove: null,
};

export const fsKey = (side: Side, dir: string): string => `${side}:${dir}`;

function upsertJob(jobs: Job[], job: Job): Job[] {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i === -1) return [...jobs, job];
  const next = jobs.slice();
  next[i] = job;
  return next;
}

export function applyMessage(state: ServerState, msg: ServerMessage): ServerState {
  if (msg.type === 'snapshot') {
    return {
      ...state,
      snapshot: msg.snapshot,
      seq: msg.seq,
      listEpoch: state.listEpoch + 1,
    };
  }
  // Incremental messages are meaningless without a snapshot, and stale if not newer.
  const snap = state.snapshot;
  if (!snap || msg.seq <= state.seq) return state;
  const base = { ...state, seq: msg.seq };
  switch (msg.type) {
    case 'adb':
      return { ...base, snapshot: { ...snap, adb: msg.adb } };
    case 'session':
      return { ...base, snapshot: { ...snap, session: msg.session } };
    case 'pairing':
      return { ...base, snapshot: { ...snap, pairing: msg.pairing } };
    case 'job':
      return { ...base, snapshot: { ...snap, jobs: upsertJob(snap.jobs, msg.job) } };
    case 'jobsRemoved': {
      const gone = new Set(msg.ids);
      return { ...base, snapshot: { ...snap, jobs: snap.jobs.filter((j) => !gone.has(j.id)) } };
    }
    case 'settings':
      return { ...base, snapshot: { ...snap, settings: msg.settings } };
    case 'mac':
      return { ...base, snapshot: { ...snap, mac: msg.mac } };
    case 'volumes': {
      const now = new Set(msg.offlineVolumes.map((v) => v.mountPoint));
      // A volume that came back needs every pane under it to refetch; listings are cheap
      // enough that refetching all of them once is simpler than tracking which pane is where.
      const returned = (snap.offlineVolumes ?? []).some((v) => !now.has(v.mountPoint));
      return {
        ...base,
        snapshot: { ...snap, offlineVolumes: msg.offlineVolumes },
        listEpoch: returned ? state.listEpoch + 1 : state.listEpoch,
      };
    }
    case 'volumeMoved':
      return {
        ...base,
        volumeMove: { from: msg.from, to: msg.to, n: (state.volumeMove?.n ?? 0) + 1 },
        listEpoch: state.listEpoch + 1,
      };
    case 'fsChanged': {
      const key = fsKey(msg.side, msg.dir);
      return {
        ...base,
        fsVersions: { ...state.fsVersions, [key]: (state.fsVersions[key] ?? 0) + 1 },
      };
    }
    default:
      return state;
  }
}
