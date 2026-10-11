---
id: PGM-365c
title: Server tracks its transfer child processes and can force-stop them synchronously
milestone: W1
deps: []
size: M
---

## Goal

The server always knows which transfer processes it started, and can kill them and remove their partial files synchronously, so a forced exit never leaves an `adb push`/`adb pull` or `cp` running or a `.pgmac-partial` file behind. This replaces any need to find processes by scanning `ps`.

## Context

- Transfer processes are spawned in `src/server/transfers/adbRunner.ts`: `cp -R` for copy jobs and `adb.spawn([... 'push' | 'pull' ...])` (`src/server/adb/adb.ts`) for device jobs. Each job records its partial path (`docs/DESIGN.md`, Transfer job lifecycle 4).
- `buildApp`'s `shutdown()` cancels everything through `queue.cancelAll()`, which waits at most 8 seconds by default, so cleanup can still be running when it returns.
- The adb server daemon is forked by the adb client and reparented; it is never a direct child of this server. The app must never kill it (`AGENTS.md`, rule 5).
- The desktop app's quit (PGM-365b) needs a last-resort path when `shutdown()` doesn't finish in time.

## Acceptance criteria

1. A registry module (for example `src/server/transfers/children.ts`) records every transfer child process at spawn (the `cp` and `adb push`/`pull` processes in `adbRunner.ts`) together with its job's partial path, and removes it when the process exits. It holds `ChildProcess` objects (or pids) the server itself spawned; it never lists or matches system processes.
2. `forceStop()` is synchronous: it sends `SIGKILL` to every registered live child, then removes each registered partial path with a synchronous unlink (or recursive remove for folder partials), skipping paths on a volume the volume monitor reports offline (a sync call there could hang). Errors are caught per path; it never throws.
3. `forceStop()` runs from `process.on('exit')` in `src/server/index.ts`, so any exit of the server process, including `process.exit` after a hung shutdown, kills the registered children first.
4. When the server runs under Electron (`process.parentPort` exists), a parent-port message `{ type: 'forceStop' }` runs `forceStop()` and then `process.exit(1)`.
5. `shutdown()` in `buildApp` calls `forceStop()` after `queue.cancelAll()` returns, so anything the 8-second cancel left behind is killed before shutdown resolves.
6. Nothing in this ticket kills a process the server didn't spawn. The adb daemon keeps running.

## Invariants

- **Forced stop leaves nothing running** (Device session 5): after `forceStop()`, no registered child is alive and no registered partial path on an online volume exists. Test with real short-lived child processes (`sleep 30` stand-ins spawned through the registry) and temp partial files and folders.
- **Only own children**: `forceStop()` signals exactly the registered processes. Test that an unrelated process spawned outside the registry is still alive afterwards.
- **Registry empties (liveness)**: a child that exits on its own is removed from the registry. Test that after a normal job completes the registry is empty.

## Test plan

- Unit tests for the registry and `forceStop()` as above, including an offline-volume partial that is skipped and a remove error that is swallowed.
- A `buildApp` test where a fake runner's child ignores `SIGTERM`-style cancellation: `shutdown()` still resolves with the child dead and the partial gone.
- The parent-port handler: a fake `parentPort` delivering `forceStop` calls `forceStop` then exit (inject `exit`).

## Sanctioned edits

- `src/server/transfers/adbRunner.ts`, a new `src/server/transfers/children.ts`, `src/server/app.ts`, `src/server/index.ts`, a small parent-port message module if one doesn't exist, tests, `docs/DESIGN.md` (one sentence under Device session 5's guard).

## Out of scope

- The quit dialog and Electron main's quit sequence (PGM-365b).

## Size

M: one registry, one synchronous stop, three call sites.
