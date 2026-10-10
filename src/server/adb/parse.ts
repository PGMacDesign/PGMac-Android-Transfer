import type { BatteryInfo, FileEntry, StorageInfo, Transport } from '../../shared/protocol.ts';

export interface MdnsService {
  instance: string;
  kind: 'connect' | 'pairing' | 'legacy';
  host: string;
  port: number;
}

/**
 * Parses `adb mdns services`. Rows are tab-separated:
 * `adb-XXXX-yyyy\t_adb-tls-connect._tcp\t192.168.1.42:37115`
 * (older adb versions add a trailing dot to the service type).
 */
export function parseMdnsServices(out: string): MdnsService[] {
  const services: MdnsService[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('List of')) continue;
    const parts = line.split(/\t+|\s{2,}/).map((p) => p.trim());
    if (parts.length < 3) continue;
    const [instance, type, addr] = parts as [string, string, string];
    const kind = type.includes('adb-tls-connect')
      ? 'connect'
      : type.includes('adb-tls-pairing')
        ? 'pairing'
        : type.includes('_adb._tcp')
          ? 'legacy'
          : null;
    if (!kind) continue;
    const hp = splitHostPort(addr);
    if (!hp) continue;
    services.push({ instance, kind, host: hp.host, port: hp.port });
  }
  return services;
}

export function splitHostPort(addr: string): { host: string; port: number } | null {
  const i = addr.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: addr.slice(0, i), port };
}

export interface AttachedDevice {
  serial: string;
  state: string;
  model: string | null;
  transport: Transport;
}

/** Parses `adb devices -l`. */
export function parseDevices(out: string): AttachedDevice[] {
  const devices: AttachedDevice[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('List of') || line.startsWith('*')) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const modelTok = rest.find((t) => t.startsWith('model:'));
    devices.push({
      serial,
      state,
      model: modelTok ? modelTok.slice('model:'.length).replace(/_/g, ' ') : null,
      transport: transportOf(serial),
    });
  }
  return devices;
}

export function transportOf(serial: string): Transport {
  if (/^emulator-\d+$/.test(serial)) return 'emulator';
  if (serial.includes(':') || serial.includes('._adb-tls-connect.')) return 'wifi';
  return 'usb';
}

/** Parses `dumpsys battery`. Returns null when the level is missing. */
export function parseBattery(out: string): BatteryInfo | null {
  const field = (name: string): string | null => {
    const m = new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(out);
    return m?.[1]?.trim() ?? null;
  };
  const rawLevel = field('level');
  const level = Number(rawLevel);
  const scale = Number(field('scale') ?? 100) || 100;
  if (rawLevel === null || !Number.isFinite(level)) return null;
  const powered = ['AC powered', 'USB powered', 'Wireless powered', 'Dock powered'].some(
    (k) => field(k) === 'true',
  );
  // BatteryManager.BATTERY_STATUS_CHARGING = 2, FULL = 5
  const status = Number(field('status'));
  return {
    level: Math.round((level / scale) * 100),
    charging: powered || status === 2,
  };
}

/** Parses `stat -f -c '%a %b %S' <path>` (available blocks, total blocks, block size). */
export function parseStatfs(out: string): StorageInfo | null {
  const [avail, total, bsize] = out.trim().split(/\s+/).map(Number);
  if (![avail, total, bsize].every((n) => Number.isFinite(n))) return null;
  return { freeBytes: avail! * bsize!, totalBytes: total! * bsize! };
}

/**
 * Parses NUL-terminated records from
 * `find -H DIR -mindepth 1 -maxdepth 1 -printf '%M\t%s\t%T@\t%f\0'`.
 * `%M` is the ls-style mode string; its first character is the file type.
 */
export function parseFindListing(out: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const t1 = rec.indexOf('\t');
    const t2 = rec.indexOf('\t', t1 + 1);
    const t3 = rec.indexOf('\t', t2 + 1);
    if (t1 < 0 || t2 < 0 || t3 < 0) continue;
    const mode = rec.slice(0, t1).replace(/^\n+/, '');
    const size = Number(rec.slice(t1 + 1, t2));
    const mtime = Number(rec.slice(t2 + 1, t3));
    const name = rec.slice(t3 + 1);
    if (!name || name === '.' || name === '..') continue;
    const type = mode[0];
    entries.push({
      name,
      isDir: type === 'd',
      isSymlink: type === 'l',
      size: type === 'd' ? 0 : Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0,
    });
  }
  return entries;
}

/** Parses `find -printf '%T@\t%P\0'`: each entry's mtime and path relative to the start. */
export function parseFindTimes(out: string): { rel: string; mtimeMs: number }[] {
  const times: { rel: string; mtimeMs: number }[] = [];
  // Every record ends in NUL, so the last piece is empty, or cut off by a timeout: drop it.
  const recs = out.split('\0');
  recs.pop();
  for (const rec of recs) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const mtime = Number(rec.slice(0, tab).replace(/^\n+/, ''));
    if (Number.isFinite(mtime) && mtime > 0) {
      times.push({ rel: rec.slice(tab + 1), mtimeMs: Math.round(mtime * 1000) });
    }
  }
  return times;
}

/** Sums newline-separated byte counts, as printed by `find ... -type f -printf '%s\n'`. */
export function sumSizes(out: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isFinite(n)) {
      bytes += n;
      files += 1;
    }
  }
  return { bytes, files };
}

/** `adb pair` exits 0 even on failure; success is only visible in its output. */
export function parsePairResult(out: string): { ok: true } | { ok: false; error: string } {
  if (/Successfully paired/i.test(out)) return { ok: true };
  const failed = /Failed:\s*(.+)/i.exec(out)?.[1]?.trim();
  if (failed && /password|wrong/i.test(failed)) {
    return {
      ok: false,
      error:
        'Wrong pairing code. Check the 6-digit code on your phone and try again. Codes change each time you open the pairing screen.',
    };
  }
  if (/unable to connect|connection refused|no route|timed out|protocol fault/i.test(out)) {
    return {
      ok: false,
      error:
        'Could not reach the phone at that address. Check the IP and port on the pairing screen.',
    };
  }
  return { ok: false, error: failed ?? (out.trim() || 'Pairing failed.') };
}

/** `adb connect` also exits 0 on failure. */
export function parseConnectResult(out: string): boolean {
  return /connected to|already connected/i.test(out) && !/failed|cannot|unable/i.test(out);
}

/**
 * Instance names still present in `dns-sd -B` output. Rows look like
 * `12:34:59.687  Add  2  25 local.  _adb-tls-pairing._tcp.  studio-abc` and the name may
 * contain spaces, so it is everything after the service type.
 */
export function parseDnsSdBrowse(out: string): string[] {
  const names = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = /^\S+\s+(Add|Rmv)\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[2]!;
    // One Add per interface the service is seen on; it is gone once every Add is removed.
    names.set(name, (names.get(name) ?? 0) + (m[1] === 'Add' ? 1 : -1));
  }
  return [...names].filter(([, n]) => n > 0).map(([name]) => name);
}

/** Host and port from `dns-sd -L`: `... can be reached at Android.local.:35231 (interface 10)`. */
export function parseDnsSdResolve(out: string): { host: string; port: number } | null {
  const m = /can be reached at (\S+):(\d+)/.exec(out);
  return m ? { host: m[1]!, port: Number(m[2]) } : null;
}

/** First IPv4 address from `dns-sd -G v4`: `... Add  40000003  10  Android.local.  192.168.1.42  120`. */
export function parseDnsSdAddress(out: string): string | null {
  const m = /\sAdd\s+\S+\s+\d+\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s/.exec(out);
  return m ? m[1]! : null;
}
