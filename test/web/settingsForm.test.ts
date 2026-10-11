import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/shared/protocol.ts';
import { RequestError } from '../../src/web/api.ts';
import {
  FIELD_MESSAGES,
  PICKER_ERROR,
  adbPlaceholder,
  deviceIpHint,
  deviceIpPlaceholder,
  editField,
  initialSettingsForm,
  saveFailed,
  settingsDialog,
  settingsPatch,
  type SettingsForm,
} from '../../src/web/settingsForm.ts';

const settings = (over: Partial<Settings> = {}): Settings => ({
  maxConcurrent: 3,
  downloadsDir: '/Users/me/Downloads',
  defaultDeviceIp: null,
  adbPath: null,
  envDefaultDeviceIp: null,
  ...over,
});
const bad = (message: string) => new RequestError(message, 400, 'INVALID');

describe('settings form', () => {
  it('starts from the saved values, empty where nothing is saved', () => {
    expect(initialSettingsForm(settings()).values).toEqual({ defaultDeviceIp: '', adbPath: '' });
    const saved = initialSettingsForm(settings({ defaultDeviceIp: '10.0.0.2', adbPath: '/a/adb' }));
    expect(saved).toEqual({
      values: { defaultDeviceIp: '10.0.0.2', adbPath: '/a/adb' },
      errors: {},
      error: null,
      pickerError: null,
      saving: false,
    });
  });

  it.each([
    ['defaultDeviceIp', FIELD_MESSAGES.defaultDeviceIp],
    ['adbPath', FIELD_MESSAGES.adbPath],
  ] as const)('puts a 400 about %s under that field and nowhere else', (field, message) => {
    const form = saveFailed(initialSettingsForm(settings()), bad(message));
    expect(form.errors).toEqual({ [field]: message });
    expect(form.error).toBeNull();
  });

  it('shows other failures as the general error', () => {
    const base = initialSettingsForm(settings());
    expect(saveFailed(base, bad('Something else.'))).toMatchObject({
      errors: {},
      error: 'Something else.',
    });
    const offline = new RequestError('Can’t reach the local server. Is it still running?', 0);
    expect(saveFailed(base, offline)).toMatchObject({ errors: {}, error: offline.message });
    // A field's message with a non-400 status is not a validation error.
    const server = new RequestError(FIELD_MESSAGES.adbPath, 500);
    expect(saveFailed(base, server)).toMatchObject({ errors: {}, error: FIELD_MESSAGES.adbPath });
  });

  it("clears the edited field's error and the general error, keeping the other field's", () => {
    let form = initialSettingsForm(settings());
    form = saveFailed(form, bad(FIELD_MESSAGES.defaultDeviceIp));
    form = saveFailed(form, bad(FIELD_MESSAGES.adbPath));
    form = saveFailed(form, bad('Something else.'));
    form = editField(form, 'adbPath', '/opt/adb');
    expect(form).toMatchObject({
      values: { defaultDeviceIp: '', adbPath: '/opt/adb' },
      errors: { defaultDeviceIp: FIELD_MESSAGES.defaultDeviceIp },
      error: null,
    });
    expect(editField(form, 'defaultDeviceIp', '1').errors).toEqual({});
  });

  it('sends both values, trimmed, with empty strings for cleared fields', () => {
    let form = initialSettingsForm(settings({ defaultDeviceIp: '10.0.0.2', adbPath: '/a/adb' }));
    expect(settingsPatch(form)).toEqual({ defaultDeviceIp: '10.0.0.2', adbPath: '/a/adb' });
    form = editField(form, 'defaultDeviceIp', '');
    form = editField(form, 'adbPath', '   ');
    expect(settingsPatch(form)).toEqual({ defaultDeviceIp: '', adbPath: '' });
    form = editField(form, 'defaultDeviceIp', ' pixel.local ');
    expect(settingsPatch(form)).toEqual({ defaultDeviceIp: 'pixel.local', adbPath: '' });
  });

  it('shows the adb in use as the placeholder only when no path is saved', () => {
    const adb = { found: true, path: '/opt/homebrew/bin/adb', version: '35.0.2' };
    expect(adbPlaceholder(settings(), adb)).toBe('/opt/homebrew/bin/adb');
    expect(adbPlaceholder(settings({ adbPath: '/a/adb' }), adb)).toBe('');
    expect(adbPlaceholder(settings(), { found: false, path: null, version: null })).toBe('');
  });

  it('shows the environment IP as placeholder and in the hint only when no IP is saved', () => {
    const env = settings({ envDefaultDeviceIp: '10.0.0.2' });
    expect(deviceIpPlaceholder(env)).toBe('10.0.0.2');
    expect(deviceIpHint(env)).toBe(
      'Connect to this device automatically when it’s found. Leave empty to use 10.0.0.2 from the environment.',
    );
    const unchanged =
      'Connect to this device automatically when it’s found. Leave empty to choose each time.';
    for (const s of [
      settings(),
      settings({ defaultDeviceIp: '10.0.0.9', envDefaultDeviceIp: '10.0.0.2' }),
    ]) {
      expect(deviceIpPlaceholder(s)).toBe('192.168.1.20');
      expect(deviceIpHint(s)).toBe(unchanged);
    }
  });
});

/** A dialog driven the way the component drives it, with React's state replaced by a variable. */
function harness(initial = initialSettingsForm(settings())) {
  const state = { form: initial };
  const dialog = settingsDialog((change) => {
    state.form = change(state.form);
  });
  return { state, dialog };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('settings dialog', () => {
  it('locks the form while a Save is in flight and unlocks it when the Save fails', async () => {
    const { state, dialog } = harness();
    const request = deferred<void>();
    const sent: unknown[] = [];
    const saved = vi.fn();
    state.form = editField(state.form, 'adbPath', '/opt/adb');
    const run = dialog.save(state.form, (p) => (sent.push(p), request.promise), saved);
    expect(state.form.saving).toBe(true);
    // Typing while saving changes nothing, so no edit is silently lost when the dialog closes.
    expect(editField(state.form, 'adbPath', '/other')).toBe(state.form);
    // A second Save (Enter again) sends nothing more.
    await dialog.save(state.form, () => Promise.reject(new Error('second')), saved);
    expect(sent).toEqual([{ defaultDeviceIp: '', adbPath: '/opt/adb' }]);

    request.reject(new RequestError(FIELD_MESSAGES.adbPath, 400, 'INVALID'));
    await run;
    expect(state.form).toMatchObject({
      saving: false,
      errors: { adbPath: FIELD_MESSAGES.adbPath },
    });
    expect(saved).not.toHaveBeenCalled();
    expect(editField(state.form, 'adbPath', '/other').values.adbPath).toBe('/other');
    // And Save works again.
    await dialog.save(state.form, async (p) => void sent.push(p), saved);
    expect(sent).toHaveLength(2);
    expect(saved).toHaveBeenCalledOnce();
  });

  it('reports a successful Save while open', async () => {
    const { state, dialog } = harness();
    const saved = vi.fn();
    await dialog.save(state.form, async () => undefined, saved);
    expect(saved).toHaveBeenCalledOnce();
    expect(state.form.saving).toBe(false);
  });

  it.each([
    ['success', (d: ReturnType<typeof deferred<void>>) => d.resolve()],
    ['failure', (d: ReturnType<typeof deferred<void>>) => d.reject(new Error('late'))],
  ])('ignores a Save %s that arrives after Cancel', async (_name, settle) => {
    const { state, dialog } = harness();
    const request = deferred<void>();
    const saved = vi.fn();
    const run = dialog.save(state.form, () => request.promise, saved);
    const before: SettingsForm = state.form;
    dialog.close();
    settle(request);
    await run;
    expect(saved).not.toHaveBeenCalled();
    expect(state.form).toBe(before);
  });

  it('shows a picker failure under the adb field without touching anything else', async () => {
    const base = editField(initialSettingsForm(settings()), 'adbPath', '/typed/adb');
    const { state, dialog } = harness(base);
    await dialog.locate(() => Promise.reject(new Error('no window')));
    expect(state.form).toEqual({ ...base, pickerError: PICKER_ERROR });
    expect(state.form.errors).toEqual({});
    expect(state.form.error).toBeNull();

    // Picking a file, or typing in the field, clears it.
    await dialog.locate(async () => '/picked/adb');
    expect(state.form).toMatchObject({ values: { adbPath: '/picked/adb' }, pickerError: null });
  });

  it('keeps the field when the picker is dismissed, and ignores a pick after Cancel', async () => {
    const { state, dialog } = harness();
    await dialog.locate(async () => null);
    expect(state.form.values.adbPath).toBe('');
    const pick = deferred<string | null>();
    const run = dialog.locate(() => pick.promise);
    dialog.close();
    pick.resolve('/late/adb');
    await run;
    expect(state.form.values.adbPath).toBe('');
  });

  it('does not open the picker while saving', async () => {
    const { state, dialog } = harness();
    void dialog.save(
      state.form,
      () => new Promise(() => undefined),
      () => undefined,
    );
    const choose = vi.fn(async () => '/picked/adb');
    await dialog.locate(choose);
    expect(choose).not.toHaveBeenCalled();
  });
});
