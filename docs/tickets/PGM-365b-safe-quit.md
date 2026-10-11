---
id: PGM-365b
title: Quitting the desktop app mid-transfer asks first and shuts the server down cleanly
milestone: W1
deps: [PGM-365a, PGM-365c]
size: M
---

## Goal

Cmd+Q (or Quit from the menu) never silently kills transfers. With transfers running or queued, the app asks first; on confirm it cancels them through the server's shutdown path, so partial files are removed and no adb transfer process is left behind, then exits.

## Context

- `buildApp` (`src/server/app.ts`) returns `shutdown()`, which cancels pairing, ends the session, cancels every job (`queue.cancelAll()`), stops the volume monitor and closes the server. `POST /api/quit` and SIGINT/SIGTERM in `src/server/index.ts` call it.
- The server runs in a `utilityProcess` forked by `electron/main.ts` (PGM-358); main and the server can talk over `process.parentPort` / the `UtilityProcess` message channel.
- PGM-365c added a registry of the server's transfer child processes, `forceStop()` (synchronous kill of registered children plus removal of their partials), a `{ type: 'forceStop' }` parent-port message that runs it and exits, and a `process.on('exit')` hook that runs it. Use these for every forced path. Never find processes by scanning `ps` or matching command lines: that risks killing the shared adb daemon and is what an earlier attempt failed review on.
- `docs/DESIGN.md` Invariants, "Device session" 5 (End Session leaves nothing running) and "Transfer job lifecycle" 4 (originals never destroyed, partials removed).

## Acceptance criteria

1. On `before-quit`, main asks the server (over the parent port, not HTTP) how many jobs are non-terminal (running, queued, uploading, or waiting for a volume). It prevents the quit until it has the answer, waiting at most 2 seconds; with no answer it proceeds as if the count were zero.
2. Count 0: quit at once with no prompt.
3. Count N > 0: an async `dialog.showMessageBox` with message "Quit PGMac Android Transfer?", detail "1 transfer in progress will be cancelled." or "N transfers in progress will be cancelled.", buttons "Quit" (default) and "Cancel", and an `AbortSignal` (`signal` option). Cancel returns from the quit sequence immediately: no message is sent to the server and the app keeps running. A second Cmd+Q while the dialog is open does nothing new.
4. On Quit, main sends `{ type: 'shutdown' }`; the server runs `shutdown()` (which already ends with `forceStop()`) and replies `{ type: 'shutdownDone' }`. The whole sequence after confirmation fits in 10 seconds: main waits up to 8.5 seconds for the reply; without it, sends `{ type: 'forceStop' }` and waits up to 1 second for the server process to exit; then calls `kill()` on it if still alive and quits. Every wait is a timer started up front, so no step can push the total past 10 seconds.
5. SIGINT or SIGTERM delivered to Electron main at any point (including while the dialog is open) aborts the dialog through its `AbortSignal` and runs step 4 as a confirmed quit without asking.
6. The adb server daemon is left running; the app never runs `adb kill-server`. `README.md` says so in the desktop app section.
7. Browser mode quit paths (`POST /api/quit`, Ctrl+C) are unchanged.

## Invariants

- **Quit leaves nothing running** (Device session 5): after a confirmed quit, every job is terminal, no adb or `cp` child process from the server is alive, and no `.pgmac-partial` file remains. Test it with the server's message handler driven directly: active fake jobs, a quit request, then assert all cancelled, partials removed and no live child.
- **Quit always finishes (liveness)**: a confirmed quit calls `quit()` within 10 seconds of confirmation even if the server never replies and never exits. Test with fake timers and a server that ignores every message: `forceStop` is sent at 8.5 s, `kill` and `quit` by 9.5 s.
- **Cancel means nothing changes**: choosing Cancel sends no message to the server and never calls `kill` or `quit`. Test the Cancel branch to the end.
- **A signal never waits on the dialog**: a signal while the dialog is open aborts it and quits within the same 10-second cap.

## Test plan

- Server side: a small message handler module (count request, shutdown request) unit tested against a `buildApp` with fake runners.
- Main side: a quit controller in a module without an `electron` import, with the dialog, the server channel, the clock and timers injected; cases for count 0, N with Quit, N with Cancel (run to completion), no count answer within 2 seconds, a shutdown that never replies, a server that never exits after `forceStop`, a signal while the dialog is open, and a second Cmd+Q during the dialog.

## Owner manual check

- Start a large transfer, press Cmd+Q, confirm: the app exits, the destination has no `.pgmac-partial` file, and `ps` shows no `adb push`/`adb pull` child. Press Cmd+Q with nothing running: it exits with no prompt.

## Sanctioned edits

- `electron/main.ts`, new modules under `electron/`, `src/server/index.ts`, a new server module for the parent-port messages, tests, `README.md`.

## Out of scope

- Window and menu behaviour (PGM-365a).

## Size

M: a small parent-port protocol and a bounded quit controller; the process cleanup itself is PGM-365c.
