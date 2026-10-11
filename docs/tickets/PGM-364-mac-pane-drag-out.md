---
id: PGM-364
title: Drag Mac-pane items out to Finder and other apps in the desktop app
milestone: W1
deps: [PGM-358, PGM-363]
size: M
---

## Goal

In the desktop app, dragging selected Mac-pane items out of the window drops them as real files in Finder, on the Desktop or in another app. Dropping them on the phone pane still pushes them.

## Context

- `webContents.startDrag({ file, files, icon })` starts a native drag of files on disk. It must be called synchronously while the page is still handling `dragstart`: any `await` before it (including async filesystem checks) makes the drag start too late or not at all. On macOS the icon must be a non-empty image.
- A synchronous filesystem call in Electron main can hang the whole app when the path is on a network share that stopped answering (`docs/DESIGN.md`, Volume health 3). So main must not touch the filesystem on this path at all.
- Once a native drag is running, a drop back into the window arrives like a Finder drop (`dataTransfer.types` contains `Files`). PGM-363 added `pgmacDesktop.getPathForFile` and the real-path drop flow (`from: 'paths'`), so such a drop onto the phone pane already becomes a push from the real paths.
- Pane drags start in `dragStart` in `src/web/components/Pane.tsx`; the in-app drag is tracked in React state (`drag`, `setDrag`).
- An earlier attempt kept the in-app drag state set during the native drag. Native drags don't reliably deliver `dragend` or pointer events back to the page, so that state went stale and a later Finder drop pushed the wrong files. This design removes that state for Mac-pane drags in the desktop app.

## Acceptance criteria

1. The preload adds `pgmacDesktop.startDrag(paths: string[])`, which calls `ipcRenderer.send('drag-out', paths)` and returns nothing. No reply channel, no promise.
2. Main registers a synchronous `ipcMain.on('drag-out', ...)` handler that: accepts the message only from the app's own window (compare `event.sender` with the window's `webContents`); keeps only strings that are absolute paths with no NUL byte, capped at 1,000 paths; and calls `event.sender.startDrag({ file: first, files: all, icon })` immediately, inside `try`/`catch` (log and ignore a failure). It does no filesystem calls and no `await`. The icon is a small non-empty PNG checked in under `electron/` and loaded once at startup with `nativeImage`.
3. In the desktop app, `dragstart` on Mac-pane items calls `startDrag` with the selected items' full paths, calls `preventDefault()` on the HTML drag, and does not set the in-app `drag` state. Browser mode keeps today's in-app drag exactly.
4. A drop of those items onto the phone pane (or one of its folder rows) arrives as a Finder-style drop and goes through PGM-363's real-path flow, so it pushes them with the usual conflict handling. Drops onto the Mac pane while the drag-out came from that same pane are ignored when every dropped path's parent is the pane's current folder (dropping items where they already are); otherwise they follow PGM-363's real-path copy.
5. Phone-pane items never call `startDrag`; they keep the in-app drag only.
6. A path deleted after the listing is not checked up front. If the native drag fails for it, Finder reports it; the app stays responsive.

## Invariants

- **Main never blocks on the filesystem for a drag**: the `drag-out` handler makes no `fs` call. Test the handler module with a fake `fs` that throws on any access and assert it is never called.
- **No stale drag state**: in the desktop app, starting a Mac-pane drag-out leaves the in-app `drag` state null, so a later Finder drop is never mistaken for an in-app drag. Test that the drag-start helper never calls `setDrag` when the bridge exists.
- **Only the app's window can start a drag**: a `drag-out` message from any other sender is ignored.

## Test plan

- `test/electron/`: the path filter (relative, NUL-containing, non-string and over-cap inputs dropped; no `fs` access); the handler ignores other senders and catches a throwing `startDrag`.
- `test/web/`: the drag-start helper calls the bridge only for Mac-pane items and only when the bridge exists, never sets in-app drag state in that case, and leaves browser mode unchanged; the same-folder drop check from criterion 4.

## Owner manual check

- In the app, drag 3 selected Mac-pane files onto the Desktop: all 3 are copied. Drag a Mac-pane item onto the phone pane: a push starts. Then drag a file from Finder onto the phone pane: that file, not the earlier one, is pushed.

## Sanctioned edits

- `electron/main.ts`, `electron/preload.cjs`, Electron helper modules, a new icon under `electron/`, `src/web/desktop.ts`, `src/web/components/Pane.tsx`, `src/web/App.tsx`, tests, `README.md` and `docs/DESIGN.md` (one line each on drag-out in the app).

## Out of scope

- Dragging phone files out (file promises; a later spike). Phone items keep Download & Show in Finder.
- Checking up front that dragged files still exist.

## Size

M: one synchronous IPC handler and a desktop-only drag-start path.
