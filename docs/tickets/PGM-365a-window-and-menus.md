---
id: PGM-365a
title: Desktop app window behaviour and macOS menu bar
milestone: W1
deps: [PGM-358]
size: M
---

## Goal

The desktop app behaves like a normal Mac app: a standard menu bar, closing the window keeps the app (and its transfers) running, the Dock icon brings the window back, and the window remembers its size and position. Browser-only controls are hidden in the app.

## Context

- PGM-358 added `electron/main.ts`, which forks the server and opens one window, and `window.pgmacDesktop` whose presence marks the desktop app (`src/web/desktop.ts`).
- The in-app menu in `src/web/App.tsx` has "Quit server", which stops the server and is meant for browser mode.

## Acceptance criteria

1. A macOS application menu built from roles: the app menu (About, Hide, Hide Others, Show All, Quit), Edit (undo, redo, cut, copy, paste, select all, so text fields work), View (reload, toggle developer tools only when the app is not packaged, actual size, zoom in, zoom out, toggle full screen), Window (minimize, zoom, close, front) and Help with "PGMac Android Transfer on GitHub" opening `https://github.com/PGMacDesign/PGMac-Android-Transfer#readme` in the default browser.
2. Closing the window doesn't quit the app or stop the server; the session and transfers keep running. Clicking the Dock icon (`activate`) reopens the window on the same server, and the page resyncs from the server snapshot.
3. Only one window is open at a time; reopening never forks a second server.
4. Window size and position are saved to `window-state.json` in `app.getPath('userData')` on move, resize and close, and restored at launch. A saved position that is off every current display is ignored (the window is centred instead).
5. In the desktop app, the in-app "Quit server" item is hidden. Browser mode still shows it.
6. Links the page opens with `target="_blank"` or `window.open` open in the default browser, not in a new Electron window (`setWindowOpenHandler` returning `deny` after `shell.openExternal` for `http(s)` URLs only).

## Test plan

- `test/electron/`: window-state load and save (missing file, corrupt file, off-screen bounds falling back to centred, bounds clamped to a display) in a module without an `electron` import, with the display list passed in.
- `test/electron/`: the open-handler URL filter allows only `http:` and `https:`.
- `test/web/`: the menu items list omits "Quit server" when the desktop bridge is present.

## Owner manual check

- Close the window during a transfer, click the Dock icon: the window returns with the transfer still running. Quit and relaunch: the window comes back at the same size and position. Copy and paste work in the pairing code field.

## Sanctioned edits

- `electron/main.ts`, new modules under `electron/`, `src/web/App.tsx`, `src/web/desktop.ts`, tests.

## Out of scope

- Quit while transfers are running (PGM-365b). A menu bar status item.

## Size

M: menu template, window lifecycle and a small persisted state file.
