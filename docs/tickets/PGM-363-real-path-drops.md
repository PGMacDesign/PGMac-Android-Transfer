---
id: PGM-363
title: Finder drops use real file paths in the desktop app, with no upload or staging
milestone: W1
deps: [PGM-358]
size: M
---

## Goal

In the desktop app, a file or folder dropped from Finder transfers straight from where it is, like a drag from the Mac pane: no "Reading from Finder" phase, no staged copy, no free-space check for staging. Browser mode keeps the upload path.

## Context

- Browser drops: `src/web/finder.ts` walks the dropped entries, `src/web/uploader.ts` uploads them, the server stages them (`src/server/transfers/staging.ts`) and `queue.ts` runs `adb push` or a killable `cp -R` copy job. See `docs/DESIGN.md` "Finder drops into either pane".
- In Electron, `webUtils.getPathForFile(file)` returns a dropped file's real path. It is available to sandboxed preloads.
- `POST /api/transfers/plan` accepts `{ from: 'android' | 'mac', srcPaths, destDir }` for pane drags and `{ from: 'finder', destSide, destDir, items }` for uploads (`PlanRequest` in `src/shared/protocol.ts`).
- PGM-358 added `electron/preload.cjs` exposing `window.pgmacDesktop` and `src/web/desktop.ts`.

## Acceptance criteria

1. The preload adds `pgmacDesktop.getPathForFile(file)`, which calls `webUtils.getPathForFile` and nothing else from `webUtils`.
2. When it is available, a Finder drop collects each dropped top-level item's real path (a dropped folder is one path, not a walk of its entries) and sends a new plan form, `{ from: 'paths', destSide, destDir, srcPaths }`. If any item has no path (an empty string, as for items dragged from some apps), the whole drop falls back to the upload path.
3. Onto the phone pane, each path becomes a push job, the same as a drag from the Mac pane. Onto the Mac pane, each path becomes a copy job (`cp -R` into a partial name, then rename), with or without a device session.
4. Conflict handling (Replace / Keep both / Skip), partial files, progress, cancel, retry and the concurrency limit are the same as for pane drags. A retry re-reads the source path.
5. Network volumes: a job whose source or destination is on an offline volume pauses with "Waiting for <name>", as other Mac-side jobs do.
6. `.DS_Store` and `._*` files are not filtered for real-path folder drops, matching drags from the Mac pane. `docs/DESIGN.md` records this and the real-path flow.
7. Browser mode drops are unchanged: no `getPathForFile`, same upload and staging path.

## Invariants

- **Job eligibility** (`docs/DESIGN.md`, Job eligibility 1 and 2): a real-path copy job starts with or without a session, never while its source or destination volume is offline, and device events (`onDeviceLost`, `onSessionLost`) leave it alone. Test a copy job draining while the session is `reconnecting`.
- **Busy paths are protected** (Destination naming 2): rename and delete refuse a real-path job's source while it is non-terminal.
- **Nothing staged**: a real-path job never creates anything under the staging root. Test that the staging folder stays empty.

## Test plan

- `test/queue.test.ts` (or `app.test.ts`): plan and commit with `from: 'paths'` onto both sides; conflict decisions; copy job runs without a session; offline source volume pauses; staging root untouched; busy source refused for delete.
- `test/web/`: the drop handler uses real paths when the bridge returns them, and falls back to uploads when any path is empty or there is no bridge.

## Owner manual check

- In the app, drop a 5 GB file onto the phone pane: a push starts at once with no "Reading from Finder" phase. Drop a folder with an empty subfolder: the same tree arrives. Drop onto the Mac pane over an existing name: the conflict dialog appears.

## Sanctioned edits

- `electron/preload.cjs`, `src/web/desktop.ts`, `src/web/components/Pane.tsx`, `src/web/App.tsx`, `src/web/finder.ts`, `src/shared/protocol.ts`, `src/server/app.ts`, `src/server/transfers/queue.ts`, tests, `docs/DESIGN.md`.

## Out of scope

- Deleting the upload and staging code; it stays while browser mode exists.

## Size

M: one new plan form reusing the existing push and copy jobs, plus the preload function.
