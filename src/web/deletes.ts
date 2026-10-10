import { RequestError } from './api.ts';
import type { ConfirmSpec } from './components/modals.tsx';

/** The server couldn't move these to the Trash because their volume has none (often a NAS). */
export const isNoTrash = (err: unknown): boolean =>
  err instanceof RequestError && err.code === 'NO_TRASH';

/** Second confirm after NO_TRASH: the only way left to delete is permanently. */
export function noTrashConfirm(what: string): ConfirmSpec {
  return {
    title: `${what} can't be moved to the Trash on this volume. Delete permanently?`,
    body: 'This volume has no Trash, so the items will be gone for good.',
    danger: true,
    icon: 'delete_forever',
    tone: 'red',
    confirm: 'Delete permanently',
    cancel: 'Cancel',
    // Cancel gets focus, as in every destructive confirm.
    destructiveButton: true,
  };
}
