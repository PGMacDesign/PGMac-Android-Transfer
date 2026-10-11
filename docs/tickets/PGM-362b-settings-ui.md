---
id: PGM-362b
title: Settings dialog for device IP and adb path, and the desktop app's state folder
milestone: W1
deps: [PGM-358, PGM-362a]
size: M
---

## Goal

Users change the default device IP and the adb path from a Settings dialog instead of editing `.env`, and the desktop app keeps its state in macOS's Application Support folder.

## Context

- PGM-362a added `defaultDeviceIp` and `adbPath` to `Settings` and `POST /api/settings`, with server-side validation and the error messages, and `STATE_DIR` for the state folder.
- The app menu is built in `src/web/App.tsx` (items such as "Downloads folder…"); dialogs live in `src/web/components/modals.tsx`.
- PGM-358 added `electron/main.ts`, `electron/preload.cjs` exposing `window.pgmacDesktop`, and `src/web/desktop.ts`.

## Acceptance criteria

1. The app menu gains "Settings…" (icon `settings`), above "Downloads folder…", opening a dialog titled "Settings".
2. The dialog has two fields:
   - "Default device IP", helper text "Connect to this device automatically when it's found. Leave empty to choose each time."
   - "adb path", helper text "Leave empty to find adb automatically.", with the currently resolved adb path shown as the placeholder when nothing is saved.
3. "Save" posts both values; a 400 shows the server's message inline under the field it concerns and keeps the dialog open; success closes it. "Cancel" closes without saving.
4. In the desktop app only, a "Locate adb…" button next to the adb field opens a native file picker (`dialog.showOpenDialog`, files only) through a new preload function `pgmacDesktop.chooseFile()` that returns the chosen path or null. Main validates nothing beyond the dialog result; the server validates the path on Save. Browser mode shows no button.
5. Electron main passes `STATE_DIR=<app.getPath('userData')>` to the server.
6. Browser mode keeps its state path and `.env` behaviour.

## Test plan

- `test/web/`: the dialog's state logic (extract it from the component if needed): maps a 400 for each field to that field's error, clears errors on edit, sends empty strings for cleared fields.
- `test/electron/`: the env builder includes `STATE_DIR` from the userData path passed in.
- Existing tests stay green.

## Owner manual check

- In the app, set the adb path with "Locate adb…", restart, and the setting is still there and in use. A bad path shows the inline error.

## Sanctioned edits

- `src/web/App.tsx`, `src/web/components/modals.tsx` (or a new component file), `src/web/api.ts`, `src/web/desktop.ts`, `electron/main.ts`, `electron/preload.cjs`, the Electron helper module, tests, `README.md` (Settings).

## Out of scope

- Syncing settings between browser mode and the app after the first import.

## Size

M: one dialog, one preload function, one env value.
