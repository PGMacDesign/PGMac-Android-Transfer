---
id: PGM-364
title: Drag Mac-pane items out to Finder and other apps in the desktop app
milestone: W1
deps: [PGM-358]
size: M
---

## Goal

In the desktop app, dragging selected Mac-pane items out of the window drops them as real files in Finder, on the Desktop or in another app. Drags inside the window keep working as they do now.

## Context

- `webContents.startDrag({ file, files, icon })` starts a native drag of files that already exist on disk. It must be called while the page is handling `dragstart`, and on macOS the icon must be a non-empty image.
- Pane drags start in `dragStart` in `src/web/components/Pane.tsx` and drop through `drop` there; the in-app drag is tracked in React state (`drag`, `setDrag`).
- PGM-358 added `electron/preload.cjs` exposing `window.pgmacDesktop`, `src/web/desktop.ts`, and the rule that logic main uses lives in a module without an `electron` import.

## Acceptance criteria

1. The preload adds `pgmacDesktop.startDrag(paths: string[])`, which sends the paths to main over one IPC channel (`ipcRenderer.send`).
2. Main accepts that message only from the app's own window, keeps only paths that are absolute, contain no NUL byte and exist (`fs.existsSync`), and calls `event.sender.startDrag({ file: first, files: all, icon })` with a bundled non-empty icon (a small PNG checked in under `electron/`). If no path survives, it does nothing.
3. In the desktop app, dragging one or more selected Mac-pane items calls `startDrag` with their full paths in addition to the existing in-app drag. Dropping them on the phone pane still starts a push; it doesn't also copy anywhere.
4. Phone-pane items never call `startDrag`; they keep the in-app drag only.
5. If main dropped some paths because they no longer exist, the Mac pane refreshes (an `fsChanged`-style refresh of the current folder is enough).
6. Browser mode drag behaviour is unchanged.

## Test plan

- `test/electron/`: the path filter keeps absolute existing paths and drops relative, NUL-containing and missing ones, and reports whether any were dropped.
- `test/web/`: the drag-start helper calls the bridge only for Mac-pane items, only when the bridge exists, and with full paths.

## Owner manual check

- In the app, drag 3 selected Mac-pane files onto the Desktop: all 3 are copied. Drag a Mac-pane item onto the phone pane: a push starts and nothing lands in Finder.

## Sanctioned edits

- `electron/main.ts`, `electron/preload.cjs`, the Electron helper module, a new icon under `electron/`, `src/web/desktop.ts`, `src/web/components/Pane.tsx`, tests, `README.md` and `docs/DESIGN.md` (one line each on drag-out in the app).

## Out of scope

- Dragging phone files out (file promises; a later spike). Phone items keep Download & Show in Finder.

## Size

M: one IPC channel with validation and a drag-start hook.
