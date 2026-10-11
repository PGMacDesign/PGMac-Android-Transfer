import type {
  AdbStatus,
  ApiError,
  CommitRequest,
  CommitResponse,
  ListResponse,
  PairCodeRequest,
  PairingSnapshot,
  PlanRequest,
  PlanResponse,
  SessionSnapshot,
  Settings,
  Side,
  StartSessionResponse,
} from '../shared/protocol.ts';
import { authHeaders } from './token.ts';

export class RequestError extends Error {
  readonly code: ApiError['code'] | undefined;
  readonly status: number;
  constructor(message: string, status: number, code?: ApiError['code']) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

type Ok = { ok: true };

async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = authHeaders();
  const init: RequestInit = { method, headers };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new RequestError('Can’t reach the local server. Is it still running?', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiError>;
    throw new RequestError(e.error || `Request failed (${res.status})`, res.status, e.code);
  }
  return data as T;
}

const post = <T>(url: string, body?: unknown): Promise<T> => request<T>('POST', url, body ?? {});

/** Identifies this page load to the server's upload liveness check (see CommitRequest). */
const PAGE_ID = crypto.randomUUID();

export const api = {
  recheckAdb: () => post<AdbStatus>('/api/adb/recheck'),

  startSession: () => post<StartSessionResponse>('/api/session/start'),
  connect: (id: string) => post<SessionSnapshot>('/api/session/connect', { id }),
  reconnect: () => post<SessionSnapshot>('/api/session/reconnect'),
  endSession: () => post<SessionSnapshot>('/api/session/end'),

  pairQr: () => post<PairingSnapshot>('/api/pair/qr'),
  pairCode: (body: PairCodeRequest) => post<PairingSnapshot>('/api/pair/code', body),
  pairCancel: () => post<Ok>('/api/pair/cancel'),

  list: (side: Side, path: string, signal?: AbortSignal) =>
    request<ListResponse>(
      'GET',
      `/api/fs/${side}/list?path=${encodeURIComponent(path)}`,
      undefined,
      signal,
    ),
  mkdir: (side: Side, path: string) => post<Ok>(`/api/fs/${side}/mkdir`, { path }),
  rename: (side: Side, path: string, newName: string) =>
    post<Ok>(`/api/fs/${side}/rename`, { path, newName }),
  /** `permanent` skips the Trash (Mac only), after the server reported NO_TRASH. */
  remove: (side: Side, paths: string[], permanent = false) =>
    post<Ok>(`/api/fs/${side}/delete`, permanent ? { paths, permanent } : { paths }),

  plan: (body: PlanRequest) => post<PlanResponse>('/api/transfers/plan', body),
  commit: (body: CommitRequest) =>
    post<CommitResponse>('/api/transfers/commit', { ...body, pageId: PAGE_ID }),
  cancelJob: (id: string) => post<Ok>(`/api/transfers/${encodeURIComponent(id)}/cancel`),
  retryJob: (id: string) => post<Ok>(`/api/transfers/${encodeURIComponent(id)}/retry`),
  clearJobs: () => post<Ok>('/api/transfers/clear'),

  reveal: (paths: string[]) => post<Ok>('/api/reveal', { side: 'mac', paths }),

  settings: (patch: Partial<Settings>) => post<Settings>('/api/settings', patch),
  quit: () => post<Ok>('/api/quit'),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
