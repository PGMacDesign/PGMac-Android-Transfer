import { describe, expect, it } from 'vitest';
import type { Settings } from '../../src/shared/protocol.ts';
import { RequestError } from '../../src/web/api.ts';
import {
  FIELD_MESSAGES,
  adbPlaceholder,
  editField,
  initialSettingsForm,
  saveFailed,
  settingsPatch,
} from '../../src/web/settingsForm.ts';

const settings = (over: Partial<Settings> = {}): Settings => ({
  maxConcurrent: 3,
  downloadsDir: '/Users/me/Downloads',
  defaultDeviceIp: null,
  adbPath: null,
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
    expect(form).toEqual({
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
});
