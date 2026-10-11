---
id: PGM-366
title: Desktop app moves files to the Trash with shell.trashItem instead of Finder AppleScript
milestone: W1
deps: [PGM-365b]
size: M
---

## Goal

On macOS versions without `/usr/bin/trash` (before macOS 15), the desktop app moves Mac-pane deletes to the Trash through Electron's `shell.trashItem`, so the signed app never needs the Apple Events entitlement or an Automation prompt. Browser mode is unchanged.

## Context

- `moveToTrash` in `src/server/fs/mac.ts` runs `/usr/bin/trash` when present, otherwise `osascript -e 'tell application "Finder" to delete ...'` on macOS, otherwise `gio trash`. A volume with no Trash ends in a 409 `NO_TRASH`, and the UI then offers "Delete permanently" (`src/web/deletes.ts`).
- `shell.trashItem` is available only in Electron's main process. The server runs in a `utilityProcess`; PGM-365b added a parent-port message module between the server and main. Reuse it rather than adding a second channel.

## Acceptance criteria

1. The trash step is injectable: `MacFs` (or `moveToTrash`) takes an optional trash function. Order when it is provided: `/usr/bin/trash` if present, else the injected function. The `osascript` fallback is used only when no function is injected (browser mode).
2. When the server runs under Electron (`process.parentPort` exists), it injects a function that sends `{ type: 'trash', id, paths }` to main and waits for `{ type: 'trashResult', id, error? }`, with a 60-second timeout that rejects.
3. Main handles `trash` by calling `shell.trashItem` for each path in order, stopping at the first failure, and replies with the error message if one failed. Main accepts only absolute paths with no NUL byte.
4. A failure that means the volume has no Trash still produces the existing `NO_TRASH` 409 and the "Delete permanently" offer. Map `shell.trashItem`'s error for that case into the same path the current code uses, and record the mapping in a comment.
5. The desktop app never spawns `osascript` for deletes.

## Invariants

- **One reply per request (liveness)**: every `trash` request resolves or rejects exactly once: on the reply, or at the 60-second timeout, and a late reply after the timeout is ignored. Test both orders with fake timers.
- **No silent permanent delete**: a trash failure never falls through to a permanent delete; only the user's "Delete permanently" confirm does that.

## Test plan

- `test/macfs.test.ts`: with an injected trash function, `/usr/bin/trash` missing (inject the check) uses the function and never `osascript`; a no-Trash error from it becomes `NO_TRASH`; without an injected function the old order holds.
- Unit tests for the request/reply helper: success, error, timeout, late reply ignored.
- Main-side path validation in a module without an `electron` import.

## Owner manual check

- On a macOS 14 Mac (or with `/usr/bin/trash` temporarily unavailable to the app), delete a Mac-pane file in the app: it goes to the Trash with no Automation prompt. Delete on an SMB share with no Trash: "Delete permanently" is still offered.

## Sanctioned edits

- `src/server/fs/mac.ts`, `src/server/app.ts` or `src/server/index.ts` (wiring), the parent-port message module from PGM-365b, `electron/main.ts`, Electron helper modules, tests, `docs/DESIGN.md` (one line under File browsing).

## Out of scope

- Changing the browser-mode delete path. Entitlements (the signed-release tickets).

## Size

M: an injectable trash step and one request/reply message pair.
