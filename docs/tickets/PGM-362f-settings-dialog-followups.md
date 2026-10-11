---
id: PGM-362f
title: Settings dialog follow-ups from review
milestone: F1
deps: [PGM-362b]
size: S
---

## Goal

Fix three small issues reviewers found in the Settings dialog: edits lost during Save, picker errors shown as Save errors, and helper text that ignores an environment default.

## Context

- The Settings dialog is in `src/web/components/modals.tsx`. Save posts both fields to `POST /api/settings`; validating an adb path can take a few seconds.
- "Locate adb…" calls `pgmacDesktop.chooseFile()` in the desktop app.
- The effective default device IP is the saved setting, then `DEFAULT_DEVICE_IP` from the environment, then none (`docs/DESIGN.md`, Configuration).

## Acceptance criteria

1. While a Save is in flight, both fields, "Locate adb…" and Save are disabled and Save reads "Saving…". Cancel stays enabled and closes the dialog; a response that arrives after Cancel is ignored.
2. If `chooseFile()` rejects, the dialog shows "Couldn't open the file picker." under the adb field and leaves the field unchanged. It never runs the Save error handling.
3. When nothing is saved for the device IP but the environment supplies one, the field's placeholder shows that IP and the helper text reads "Connect to this device automatically when it's found. Leave empty to use <IP> from the environment." Otherwise the helper text is unchanged. If the snapshot doesn't expose the environment value yet, add it to the settings payload as `envDefaultDeviceIp: string | null`.

## Test plan

- `test/web/`: the dialog state logic: fields disabled while saving, a late response after Cancel ignored, a picker rejection sets the picker error only, helper text with and without an environment IP.
- A server test that `envDefaultDeviceIp` reflects `DEFAULT_DEVICE_IP`, if it is added.

## Sanctioned edits

- `src/web/components/modals.tsx`, the dialog's state helper, `src/shared/protocol.ts` and `src/server/app.ts` (only for `envDefaultDeviceIp`), tests.

## Out of scope

- Any other Settings change.

## Size

S: three small UI fixes and their tests.
