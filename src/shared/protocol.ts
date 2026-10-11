// Contract between the local server and the browser UI. The server is the single
// writer of session, pairing and job state; the UI only renders it and sends requests.

export type Side = 'android' | 'mac';

export interface FileEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Bytes. 0 for directories. */
  size: number;
  mtimeMs: number;
}

export interface ListResponse {
  /** Normalized absolute path that was listed. */
  path: string;
  entries: FileEntry[];
}

// ---------------------------------------------------------------- session

export type SessionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'ending';

export type Transport = 'wifi' | 'usb' | 'emulator';

export interface DeviceInfo {
  /** adb serial used for every command, e.g. "192.168.1.42:37115" or "emulator-5554". */
  serial: string;
  model: string;
  androidVersion: string;
  transport: Transport;
  /** "ip:port" for WiFi devices, null otherwise. */
  address: string | null;
}

export interface BatteryInfo {
  level: number;
  charging: boolean;
}

export interface StorageInfo {
  freeBytes: number;
  totalBytes: number;
}

export interface SessionSnapshot {
  state: SessionState;
  device: DeviceInfo | null;
  battery: BatteryInfo | null;
  storage: StorageInfo | null;
  /** Human-readable reason for `lost`, or the last connect failure. */
  error: string | null;
  /** Epoch ms when reconnecting gives up. Only set while `reconnecting`. */
  reconnectDeadline: number | null;
}

/** A device that Start Session can connect to. */
export interface Candidate {
  /** Opaque id passed back to `POST /api/session/connect`. */
  id: string;
  model: string | null;
  /** "ip:port", "USB" or the emulator serial. */
  address: string;
  transport: Transport;
  lastUsed: boolean;
}

export type StartSessionResponse =
  | { result: 'connected'; session: SessionSnapshot }
  | { result: 'pick'; candidates: Candidate[] }
  | { result: 'pair' };

// ---------------------------------------------------------------- pairing

export type PairingMode = 'qr' | 'code';
export type PairingStatus = 'waiting' | 'pairing' | 'success' | 'error' | 'timeout';

export interface PairingSnapshot {
  attemptId: string;
  mode: PairingMode;
  status: PairingStatus;
  /** SVG markup of the QR code (QR mode only). */
  qrSvg: string | null;
  /** Epoch ms when the attempt times out. */
  expiresAt: number;
  error: string | null;
  /** Shown on success, e.g. "Pixel 8 Pro". */
  deviceName: string | null;
}

export interface PairCodeRequest {
  host: string;
  port: number;
  code: string;
}

// ---------------------------------------------------------------- transfers

/** push = Mac to Android, pull = Android to Mac, copy = Mac to Mac (Finder drops on the Mac pane). */
export type Direction = 'push' | 'pull' | 'copy';

/**
 * `uploading`: a Finder drop whose bytes are still coming from the browser; it holds no
 * concurrency slot. The UI shows a queued push/pull job as "Waiting for device" while the
 * session is `reconnecting`; there is no separate status for that.
 */
export type JobStatus = 'uploading' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * pane = copied from a real path: dragged between the panes, or dropped from Finder in the
 * desktop app (which knows the dropped files' paths). finder = dropped from Finder in a
 * browser and uploaded by the page.
 */
export type JobOrigin = 'pane' | 'finder';

export interface Job {
  id: string;
  batchId: string;
  direction: Direction;
  origin: JobOrigin;
  /** Absolute source path on the source side. For Finder jobs, the server's staged copy. */
  srcPath: string;
  /** Absolute destination folder on the other side. */
  destDir: string;
  /** Final name in `destDir` (differs from the source name for Keep both). */
  destName: string;
  isDir: boolean;
  /** Number of files for directories, 1 for files. */
  itemCount: number;
  totalBytes: number;
  transferredBytes: number;
  bytesPerSec: number;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** False when Retry can't work: a Finder upload that never finished staging. */
  retryable: boolean;
  /**
   * Name of the offline network volume a queued job is waiting for (e.g. "Share"); null
   * otherwise. The job restarts from the beginning of its item when the volume returns.
   */
  waitingFor: string | null;
}

export type ConflictDecision = 'replace' | 'keep' | 'skip';

export interface EntryMeta {
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface Conflict {
  name: string;
  incoming: EntryMeta;
  existing: EntryMeta;
  /** The name Keep both would use. */
  keepBothName: string;
}

/** One top-level item dropped from Finder, described by the page before uploading. */
export interface FinderItem {
  name: string;
  isDir: boolean;
  /** Total bytes (all files under it for a folder). */
  size: number;
  /** File count (1 for a file). */
  files: number;
  mtimeMs: number;
}

export type PlanRequest =
  | {
      from: Side;
      srcPaths: string[];
      destDir: string;
      /** Show in Finder: reveal the copied items once every job in the batch has finished. */
      reveal?: boolean;
    }
  | { from: 'finder'; destSide: Side; destDir: string; items: FinderItem[] }
  /**
   * A Finder drop in the desktop app: the dropped items' real Mac paths. Runs like a drag
   * from the Mac pane (a push, or a copy onto the Mac pane), with nothing uploaded or staged.
   */
  | { from: 'paths'; destSide: Side; destDir: string; srcPaths: string[] };

export interface PlanResponse {
  batchId: string;
  /** Total top-level items in the batch. */
  itemCount: number;
  conflicts: Conflict[];
}

export interface CommitRequest {
  batchId: string;
  /** Keyed by conflicting name. Names absent from the map default to `skip`. */
  decisions: Record<string, ConflictDecision>;
  /**
   * Finder batches: a random id for this page load. An item waiting its turn stays alive
   * while uploads from the same page are moving; a reloaded page's leftovers don't.
   */
  pageId?: string;
}

export interface CommitResponse {
  jobIds: string[];
  /** Finder batches: which job each dropped item (by its original name) uploads into. */
  uploads: { name: string; jobId: string }[];
}

// ---------------------------------------------------------------- misc

export interface Settings {
  maxConcurrent: number;
  /** Where Show in Finder copies Android items. */
  downloadsDir: string;
}

export interface AdbStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export type Platform = 'darwin' | 'linux' | 'other';

export interface MacInfo {
  home: string;
  /** Picks UI wording: "Show in Finder" on macOS, "Show in Files" elsewhere. */
  platform: Platform;
  storage: StorageInfo | null;
}

/** A network volume (NAS share) that stopped answering. Only offline volumes are listed. */
export interface OfflineVolume {
  /** Where it was mounted, e.g. "/Volumes/Share". */
  mountPoint: string;
  /** Display name, e.g. "Share". */
  name: string;
  /** Epoch ms when it went offline. */
  since: number;
  /** Epoch ms when jobs waiting for it fail. */
  giveUpAt: number;
}

export interface ServerSnapshot {
  adb: AdbStatus;
  session: SessionSnapshot;
  pairing: PairingSnapshot | null;
  jobs: Job[];
  settings: Settings;
  mac: MacInfo;
  offlineVolumes: OfflineVolume[];
}

export interface ApiError {
  error: string;
  code?:
    | 'BUSY_PATH'
    | 'EXISTS'
    | 'NOT_FOUND'
    | 'NO_SESSION'
    | 'INVALID'
    | 'ADB'
    | 'CONFLICT'
    | 'NO_SPACE'
    /** The path is on a network volume that is offline; the message names it. */
    | 'OFFLINE'
    /** Moving to the Trash failed on a volume that has none; the UI offers a permanent delete. */
    | 'NO_TRASH';
}

// ---------------------------------------------------------------- websocket (server to client only)

export type ServerMessage =
  | { type: 'snapshot'; seq: number; snapshot: ServerSnapshot }
  | { type: 'adb'; seq: number; adb: AdbStatus }
  | { type: 'session'; seq: number; session: SessionSnapshot }
  | { type: 'pairing'; seq: number; pairing: PairingSnapshot | null }
  | { type: 'job'; seq: number; job: Job }
  | { type: 'jobsRemoved'; seq: number; ids: string[] }
  | { type: 'settings'; seq: number; settings: Settings }
  | { type: 'mac'; seq: number; mac: MacInfo }
  | { type: 'volumes'; seq: number; offlineVolumes: OfflineVolume[] }
  /** A volume came back at a different mount point; paths under `from` now live under `to`. */
  | { type: 'volumeMoved'; seq: number; from: string; to: string }
  /** A folder's contents changed (transfer finished, file op); refresh it if shown. */
  | { type: 'fsChanged'; seq: number; side: Side; dir: string };

// ---------------------------------------------------------------- HTTP routes
//
// GET  /api/snapshot                      -> ServerSnapshot
// POST /api/adb/recheck                   -> AdbStatus
// POST /api/session/start                 -> StartSessionResponse
// POST /api/session/connect  {id}         -> SessionSnapshot
// POST /api/session/reconnect             -> SessionSnapshot
// POST /api/session/end                   -> SessionSnapshot
// POST /api/pair/qr                       -> PairingSnapshot   (starts a new QR attempt)
// POST /api/pair/code  PairCodeRequest    -> PairingSnapshot
// POST /api/pair/cancel                   -> { ok: true }
// GET  /api/fs/:side/list?path=           -> ListResponse
// POST /api/fs/:side/mkdir   {path}       -> { ok: true }   (path = full new folder path)
// POST /api/fs/:side/rename  {path, newName} -> { ok: true }
// POST /api/fs/:side/delete  {paths, permanent?} -> { ok: true }
//      Mac deletes go to the Trash; `permanent: true` (Mac only) skips it, for NO_TRASH.
// POST /api/transfers/plan   PlanRequest  -> PlanResponse
//      (Finder and paths batches need a session only when destSide is android)
// POST /api/transfers/commit CommitRequest -> CommitResponse
// POST /api/transfers/:id/cancel          -> { ok: true }
// POST /api/transfers/:id/retry           -> { ok: true }
// POST /api/transfers/clear               -> { ok: true }  (removes terminal jobs)
// PUT  /api/uploads/:jobId/file?path=REL&mtime=MS  raw bytes (application/octet-stream)
//      -> { ok: true }. MS is the file's lastModified, applied to the staged copy.
//      REL is the file's path inside the dropped item: "" for a dropped file itself,
//      "sub/a.txt" inside a dropped folder. Files of one job are sent one at a time.
// POST /api/uploads/:jobId/dir?path=REL   -> { ok: true }  (creates an empty folder)
// POST /api/uploads/:jobId/complete       -> { ok: true }  (all files sent; job is queued)
// POST /api/reveal  {side: 'mac', paths}  -> { ok: true }  (reveal Mac items in place)
// POST /api/settings  Partial<Settings>   -> Settings  (downloadsDir must be an existing folder)
// POST /api/quit                          -> { ok: true }  (server exits)
//
// Errors use HTTP 4xx/5xx with an ApiError body.
// WebSocket: GET /ws. The first message is always `snapshot`; later messages carry a
// strictly increasing `seq`, and the client ignores any message with seq <= its snapshot's.

export const ANDROID_ROOT = '/sdcard';
export const ANDROID_SHORTCUTS: { label: string; path: string; icon: string }[] = [
  { label: 'Internal storage', path: '/sdcard', icon: 'smartphone' },
  { label: 'DCIM', path: '/sdcard/DCIM', icon: 'photo_camera' },
  { label: 'Download', path: '/sdcard/Download', icon: 'download' },
  { label: 'Documents', path: '/sdcard/Documents', icon: 'description' },
  { label: 'Pictures', path: '/sdcard/Pictures', icon: 'image' },
  { label: 'Movies', path: '/sdcard/Movies', icon: 'movie' },
  { label: 'Music', path: '/sdcard/Music', icon: 'music_note' },
];
export const MAC_SHORTCUTS: { label: string; rel: string; icon: string }[] = [
  { label: 'Home', rel: '', icon: 'home' },
  { label: 'Desktop', rel: 'Desktop', icon: 'desktop_mac' },
  { label: 'Downloads', rel: 'Downloads', icon: 'download' },
  { label: 'Documents', rel: 'Documents', icon: 'description' },
];
export const PARTIAL_SUFFIX = '.pgmac-partial';
export const MAX_CONCURRENT_LIMIT = 6;
