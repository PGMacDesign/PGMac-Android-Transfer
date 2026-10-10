import type { EntryMeta, FileEntry, StorageInfo } from '../../shared/protocol.ts';

/** File operations for one side (Mac or Android). All paths are absolute and normalized. */
export interface SideFs {
  list(dir: string): Promise<FileEntry[]>;
  /** Null when the path does not exist. */
  stat(p: string): Promise<EntryMeta | null>;
  /** Creates one folder; fails with EXISTS if anything is already at `p`. */
  mkdir(p: string): Promise<void>;
  /** Renames within the same folder; fails with EXISTS if the new name is taken. */
  rename(p: string, newName: string): Promise<void>;
  /** Mac: moves to Trash. Android: permanent recursive delete. */
  remove(paths: string[]): Promise<void>;
  /** Total bytes and file count under `p` (a file counts as 1). */
  measure(p: string): Promise<{ bytes: number; files: number }>;
  storage(): Promise<StorageInfo | null>;
}
