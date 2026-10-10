import type { ApiError } from '../shared/protocol.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiError['code'];
  constructor(status: number, message: string, code?: ApiError['code']) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const invalid = (msg: string) => new HttpError(400, msg, 'INVALID');
export const notFound = (msg: string) => new HttpError(404, msg, 'NOT_FOUND');
export const exists = (msg: string) => new HttpError(409, msg, 'EXISTS');
export const busy = (msg: string) => new HttpError(409, msg, 'BUSY_PATH');
export const noSession = () => new HttpError(409, 'No device is connected.', 'NO_SESSION');
