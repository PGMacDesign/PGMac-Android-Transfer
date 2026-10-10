import type { FinderItem } from '../shared/protocol.ts';

/** macOS metadata that Finder drags along; it would only clutter the phone. */
export function isJunk(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._');
}

/** The subset of the File and Directory Entries API the walk needs (fakeable in tests). */
export interface EntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}
export interface FileEntryLike extends EntryLike {
  file(success: (f: File) => void, error?: (e: unknown) => void): void;
}
export interface DirEntryLike extends EntryLike {
  createReader(): ReaderLike;
}
export interface ReaderLike {
  readEntries(success: (batch: EntryLike[]) => void, error?: (e: unknown) => void): void;
}

/** What a drop handler captures synchronously, before the DataTransfer is cleared. */
export type DropSource = { kind: 'entry'; entry: EntryLike } | { kind: 'file'; file: File };

export interface FinderFile {
  /** Path inside the dropped item; "" when the item is the file itself. */
  rel: string;
  file: File;
}

export interface FinderDrop {
  item: FinderItem;
  files: FinderFile[];
  /** Folders (relative, "" for the item itself) that contain nothing to upload. */
  emptyDirs: string[];
}

export const isFinderDrag = (types: readonly string[]): boolean => types.includes('Files');

/**
 * Must run inside the drop event: browsers empty the DataTransfer as soon as the handler
 * returns, so every entry is taken before any await.
 */
export function captureDropSources(dt: DataTransfer): DropSource[] {
  const out: DropSource[] = [];
  for (const it of Array.from(dt.items)) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry() as EntryLike | null;
    if (entry) out.push({ kind: 'entry', entry });
    else {
      const file = it.getAsFile();
      if (file) out.push({ kind: 'file', file });
    }
  }
  return out;
}

const fileOf = (e: FileEntryLike) => new Promise<File>((res, rej) => e.file(res, rej));

/** Chrome hands out at most 100 entries per call, so read until an empty batch. */
export async function readAll(dir: DirEntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader();
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

async function walk(dir: DirEntryLike, rel: string, drop: FinderDrop): Promise<void> {
  let kept = 0;
  for (const child of await readAll(dir)) {
    if (isJunk(child.name)) continue;
    const childRel = joinRel(rel, child.name);
    if (child.isDirectory) {
      kept++;
      await walk(child as DirEntryLike, childRel, drop);
    } else if (child.isFile) {
      kept++;
      drop.files.push({ rel: childRel, file: await fileOf(child as FileEntryLike) });
    }
  }
  if (!kept) drop.emptyDirs.push(rel);
}

function summarize(drop: FinderDrop): FinderDrop {
  let size = 0;
  let newest = 0;
  for (const f of drop.files) {
    size += f.file.size;
    newest = Math.max(newest, f.file.lastModified);
  }
  drop.item.size = size;
  drop.item.files = drop.files.length;
  // Folder entries don't expose their own date; the newest file inside is the honest stand-in.
  drop.item.mtimeMs = newest || Date.now();
  return drop;
}

/** Turns dropped Finder items into one upload description per top-level item. */
export async function collectDrops(sources: DropSource[]): Promise<FinderDrop[]> {
  const drops: FinderDrop[] = [];
  for (const s of sources) {
    if (s.kind === 'file') {
      if (isJunk(s.file.name)) continue;
      drops.push(
        summarize({
          item: { name: s.file.name, isDir: false, size: 0, files: 0, mtimeMs: 0 },
          files: [{ rel: '', file: s.file }],
          emptyDirs: [],
        }),
      );
      continue;
    }
    const e = s.entry;
    if (isJunk(e.name)) continue;
    const drop: FinderDrop = {
      item: { name: e.name, isDir: e.isDirectory, size: 0, files: 0, mtimeMs: 0 },
      files: [],
      emptyDirs: [],
    };
    if (e.isDirectory) await walk(e as DirEntryLike, '', drop);
    else if (e.isFile) drop.files.push({ rel: '', file: await fileOf(e as FileEntryLike) });
    else continue;
    drops.push(summarize(drop));
  }
  return drops;
}
