import type { AdbStatus, Settings } from '../shared/protocol.ts';
import { RequestError, errorMessage } from './api.ts';

export type SettingsField = 'defaultDeviceIp' | 'adbPath';

export interface SettingsForm {
  values: Record<SettingsField, string>;
  errors: Partial<Record<SettingsField, string>>;
  /** A failure that belongs to no one field (the server unreachable, an unknown 400). */
  error: string | null;
  /** Shown under the adb field; kept apart from `errors` since the path itself is not wrong. */
  pickerError: string | null;
  /** A Save is in flight: every input is disabled so nothing typed now is silently dropped. */
  saving: boolean;
}

// The server's 400 doesn't say which field it is about, so its messages do. A test posts bad
// values to the real server and checks they land here, so a reworded message fails there.
export const FIELD_MESSAGES: Record<SettingsField, string> = {
  defaultDeviceIp: 'Enter an IP address like 192.168.1.20.',
  adbPath: "That file isn't a working adb.",
};

export const PICKER_ERROR = "Couldn't open the file picker.";

export function initialSettingsForm(settings: Settings): SettingsForm {
  return {
    values: { defaultDeviceIp: settings.defaultDeviceIp ?? '', adbPath: settings.adbPath ?? '' },
    errors: {},
    error: null,
    pickerError: null,
    saving: false,
  };
}

/** Editing a field drops its error, and the general one, since both may no longer apply. */
export function editField(form: SettingsForm, field: SettingsField, value: string): SettingsForm {
  if (form.saving) return form;
  const errors = { ...form.errors };
  delete errors[field];
  const pickerError = field === 'adbPath' ? null : form.pickerError;
  return { ...form, values: { ...form.values, [field]: value }, errors, error: null, pickerError };
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
  const done = { ...form, saving: false };
  if (field) return { ...done, errors: { ...form.errors, [field]: errorMessage(err) } };
  return { ...done, error: errorMessage(err) };
}

export type FormUpdate = (change: (form: SettingsForm) => SettingsForm) => void;

/**
 * Runs the dialog's async actions. Once closed (Cancel, or the dialog going away), a Save or
 * picker result that arrives later changes nothing: the user has already moved on, and acting on
 * it could close or toast over whatever they opened next. The server may still apply that Save.
 */
export function settingsDialog(update: FormUpdate) {
  let open = true;
  // The form a handler sees is from the last render, so two quick Enters would both pass a
  // `form.saving` check; this flag doesn't wait for a render.
  let saving = false;
  return {
    /** Remounting (React StrictMode runs effects twice) makes a closed dialog live again. */
    reopen() {
      open = true;
    },
    close() {
      open = false;
    },
    async save(
      form: SettingsForm,
      request: (patch: Pick<Settings, SettingsField>) => Promise<unknown>,
      onSaved: () => void,
    ) {
      if (saving || !open) return;
      saving = true;
      update((f) => ({ ...f, saving: true }));
      try {
        await request(settingsPatch(form));
      } catch (e) {
        if (open) update((f) => saveFailed(f, e));
        return;
      } finally {
        saving = false;
      }
      if (!open) return;
      update((f) => ({ ...f, saving: false }));
      onSaved();
    },
    async locate(choose: () => Promise<string | null>) {
      if (saving || !open) return;
      let picked: string | null;
      try {
        picked = await choose();
      } catch {
        if (open) update((f) => ({ ...f, pickerError: PICKER_ERROR }));
        return;
      }
      if (open && picked) update((f) => editField(f, 'adbPath', picked));
    },
  };
}

/**
 * With no saved adb path, the field's placeholder shows the adb in use (found automatically or
 * from ADB_PATH), which is what leaving it empty keeps.
 */
/** With no saved IP, the field shows the one `DEFAULT_DEVICE_IP` supplies, which empty keeps. */
export function deviceIpPlaceholder(settings: Settings): string {
  return envDeviceIp(settings) ?? '192.168.1.20';
}

export function deviceIpHint(settings: Settings): string {
  const env = envDeviceIp(settings);
  const keep = env ? `use ${env} from the environment` : 'choose each time';
  return `Connect to this device automatically when it’s found. Leave empty to ${keep}.`;
}

function envDeviceIp(settings: Settings): string | null {
  return settings.defaultDeviceIp === null ? settings.envDefaultDeviceIp : null;
}

export function adbPlaceholder(settings: Settings, adb: AdbStatus): string {
  return settings.adbPath === null ? (adb.path ?? '') : '';
}
