const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** Decimal units (1 KB = 1000 B), matching how Finder and Android report sizes. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '–';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1000;
    i++;
  } while (value >= 999.95 && i < units.length - 1);
  const text = value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text.replace(/\.0$/, '')} ${units[i]}`;
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/**
 * Long form: "Today, 14:05", "Yesterday, 09:12", "3 Oct 2026, 18:30".
 * Short form (narrow layouts): "Today 14:05", "3 Oct, 18:30", "3 Oct 2025".
 */
export function fmtDate(ms: number, now: number, short = false): string {
  const d = new Date(ms);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (short) {
    if (sameDay(d, n)) return `Today ${hm}`;
    const md = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() !== n.getFullYear() ? `${md} ${d.getFullYear()}` : `${md}, ${hm}`;
  }
  if (sameDay(d, n)) return `Today, ${hm}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `Yesterday, ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hm}`;
}

export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function fmtSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '–';
  return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
}

/** "m:ss" countdown from a remaining duration in ms. */
export function fmtCountdown(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

const EXT_ICONS: Record<string, string> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  heic: 'image',
  webp: 'image',
  mp4: 'movie',
  mov: 'movie',
  mkv: 'movie',
  m4a: 'music_note',
  mp3: 'music_note',
  wav: 'music_note',
  flac: 'music_note',
  pdf: 'picture_as_pdf',
  apk: 'android',
  iso: 'album',
  dmg: 'album',
  md: 'article',
  txt: 'article',
  numbers: 'table_chart',
  csv: 'table_chart',
  xlsx: 'table_chart',
  zip: 'folder_zip',
  gz: 'folder_zip',
  kml: 'map',
};

export function iconFor(name: string, isDir: boolean): string {
  if (isDir) return 'folder';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'draft';
  return EXT_ICONS[name.slice(dot + 1).toLowerCase()] ?? 'draft';
}

export const LOW_BATTERY = 15;

export function batteryIcon(level: number): string {
  if (level < LOW_BATTERY) return 'battery_alert';
  if (level >= 90) return 'battery_full';
  if (level >= 75) return 'battery_6_bar';
  if (level >= 60) return 'battery_5_bar';
  if (level >= 45) return 'battery_4_bar';
  if (level >= 30) return 'battery_3_bar';
  return 'battery_2_bar';
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
