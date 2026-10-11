---
id: PGM-365b
title: Quitting the desktop app mid-transfer asks first and shuts the server down cleanly
milestone: W1
deps: [PGM-365a]
size: M
---

## Goal

Cmd+Q (or Quit from the menu) never silently kills transfers. With transfers running or queued, the app asks first; on confirm it cancels them through the server's shutdown path, so partial files are removed and no adb transfer process is left behind, then exits.

## Context

- `buildApp` (`src/server/app.ts`) returns `shutdown()`, which cancels pairing, ends the session, cancels every job (`queue.cancelAll()`), stops the volume monitor and closes the server. `POST /api/quit` and SIGINT/SIGTERM in `src/server/index.ts` call it.
- The server runs in a `utilityProcess` forked by `electron/main.ts` (PGM-358); main and the server can talk over `process.parentPort` / the `UtilityProcess` message channel.
- `docs/DESIGN.md` Invariants, "Device session" 5 (End Session leaves nothing running) and "Transfer job lifecycle" 4 (originals never destroyed, partials removed).

## Acceptance criteria

1. On `before-quit`, main asks the server (over the parent port, not HTTP) how many jobs are non-terminal (running, queued, uploading, or waiting for a volume). It prevents the quit until it has the answer, waiting at most 2 seconds; with no answer it proceeds as if the count were zero.
2. Count 0: quit at once with no prompt.
3. Count N > 0: a native dialog with message "Quit PGMac Android Transfer?", detail "1 transfer in progress will be cancelled." or "N transfers in progress will be cancelled.", buttons "Quit" (default) and "Cancel". Cancel keeps the app running and changes nothing.
4. On Quit, main tells the server to shut down; the server runs `shutdown()` and replies when it resolves. Main waits at most 10 seconds for that reply, then kills the server process if it is still alive, then exits.
5. The adb server daemon is left running; the app never runs `adb kill-server`. `README.md` says so in the desktop app section.
6. Browser mode quit paths (`POST /api/quit`, Ctrl+C) are unchanged.

## Invariants

- **Quit leaves nothing running** (Device session 5): after a confirmed quit, every job is terminal, no adb or `cp` child process from the server is alive, and no `.pgmac-partial` file remains. Test it with the server's message handler driven directly: active fake jobs, a quit request, then assert all cancelled, partials removed and no live child.
- **Quit always finishes (liveness)**: a confirmed quit exits within the 10-second cap even if `shutdown()` hangs. Test the main-side quit controller with a server that never replies and fake timers.
- **Cancel means nothing changes**: choosing Cancel sends no shutdown message.

## Test plan

- Server side: a small message handler module (count request, shutdown request) unit tested against a `buildApp` with fake runners.
- Main side: a quit controller in a module without an `electron` import, with the dialog, the server channel and the timer injected; cases for count 0, N with Quit, N with Cancel, no answer within 2 seconds, and a shutdown that never replies.

## Owner manual check

- Start a large transfer, press Cmd+Q, confirm: the app exits, the destination has no `.pgmac-partial` file, and `ps` shows no `adb push`/`adb pull` child. Press Cmd+Q with nothing running: it exits with no prompt.

## Sanctioned edits

- `electron/main.ts`, new modules under `electron/`, `src/server/index.ts`, a new server module for the parent-port messages, tests, `README.md`.

## Out of scope

- Window and menu behaviour (PGM-365a).

## Size

M: a two-message protocol over the parent port and a bounded quit controller.
