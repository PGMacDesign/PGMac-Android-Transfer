import type { AdbStatus, Settings } from '../shared/protocol.ts';
import { RequestError, errorMessage } from './api.ts';

export type SettingsField = 'defaultDeviceIp' | 'adbPath';

export interface SettingsForm {
  values: Record<SettingsField, string>;
  errors: Partial<Record<SettingsField, string>>;
  /** A failure that belongs to no one field (the server unreachable, an unknown 400). */
  error: string | null;
}

// The server's 400 doesn't say which field it is about, so its messages do. A test posts bad
// values to the real server and checks they land here, so a reworded message fails there.
export const FIELD_MESSAGES: Record<SettingsField, string> = {
  defaultDeviceIp: 'Enter an IP address like 192.168.1.20.',
  adbPath: "That file isn't a working adb.",
};

export function initialSettingsForm(settings: Settings): SettingsForm {
  return {
    values: { defaultDeviceIp: settings.defaultDeviceIp ?? '', adbPath: settings.adbPath ?? '' },
    errors: {},
    error: null,
  };
}

/** Editing a field drops its error, and the general one, since both may no longer apply. */
export function editField(form: SettingsForm, field: SettingsField, value: string): SettingsForm {
  const errors = { ...form.errors };
  delete errors[field];
  return { values: { ...form.values, [field]: value }, errors, error: null };
}

/** Both values, always: an empty field posts "" so the server clears the saved value. */
export function settingsPatch(form: SettingsForm): Pick<Settings, SettingsField> {
  return {
    defaultDeviceIp: form.values.defaultDeviceIp.trim(),
    adbPath: form.values.adbPath.trim(),
  };
}

export function fieldForError(err: unknown): SettingsField | null {
  if (!(err instanceof RequestError) || err.status !== 400) return null;
  for (const field of Object.keys(FIELD_MESSAGES) as SettingsField[]) {
    if (FIELD_MESSAGES[field] === err.message) return field;
  }
  return null;
}

/** The form after a failed Save: the message under its field, or as the general error. */
export function saveFailed(form: SettingsForm, err: unknown): SettingsForm {
  const field = fieldForError(err);
  if (field) return { ...form, errors: { ...form.errors, [field]: errorMessage(err) } };
  return { ...form, error: errorMessage(err) };
}

/**
 * With no saved adb path, the field's placeholder shows the adb in use (found automatically or
 * from ADB_PATH), which is what leaving it empty keeps.
 */
export function adbPlaceholder(settings: Settings, adb: AdbStatus): string {
  return settings.adbPath === null ? (adb.path ?? '') : '';
}
