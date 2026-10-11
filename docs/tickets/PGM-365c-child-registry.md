---
id: PGM-365c
title: Server tracks its transfer child processes and can kill them synchronously
milestone: W1
deps: []
size: S
---

## Goal

The server always knows which transfer processes it started and can kill them synchronously, so a forced exit never leaves an `adb push`/`adb pull` or `cp` running. This replaces any need to find processes by scanning `ps`.

## Context

- Transfer processes are spawned in `src/server/transfers/adbRunner.ts`: `cp -R` for copy jobs and `adb.spawn([... 'push' | 'pull' ...])` (`src/server/adb/adb.ts`) for device jobs.
- `buildApp`'s `shutdown()` cancels everything through `queue.cancelAll()`, which waits at most 8 seconds by default and removes partial files through the normal cancel path.
- The adb server daemon is forked by the adb client and reparented; it is never a direct child of this server. The app must never kill it (`AGENTS.md`, rule 5).
- The desktop app's quit (PGM-365b) needs a last-resort path when `shutdown()` doesn't finish in time.
- An earlier attempt also tried to delete partial files synchronously during a forced stop. Review showed that can't be done reliably (partials on the device, on a share that moved or dropped, racing a child that is still being killed), so this ticket deliberately covers processes only. Partial cleanup stays where it is: the normal cancel path.

## Acceptance criteria

1. A registry module (for example `src/server/transfers/children.ts`) records the pid (a plain number, read once right after `spawn`) of every transfer child process the runners spawn (the `cp` and `adb push`/`pull` processes in `adbRunner.ts`), and removes it on that child's `exit` event. It stores numbers only, never `ChildProcess` objects, and never lists or matches system processes.
2. `forceStop()` is synchronous: for each registered pid it calls `process.kill(pid, 'SIGKILL')` inside its own `try`/`catch` (`ESRCH` means it already exited). It reads no `ChildProcess` properties and does no filesystem work.
3. `src/server/index.ts` calls `forceStop()` from `process.on('exit')`, so any exit of the server process kills the registered children first.
4. When the server runs under Electron (`process.parentPort` exists), a parent-port message `{ type: 'forceStop' }` runs `forceStop()` and then `process.exit(1)`.
5. `shutdown()` in `buildApp` calls `forceStop()` after `queue.cancelAll()` returns, so a child the 8-second cancel didn't stop is killed before shutdown resolves.
6. `docs/DESIGN.md` Device session 5 gains one sentence: a forced stop (only after a shutdown timeout) kills every transfer process but may leave hidden `.pgmac-partial` files; originals are never touched, since a partial replaces its original only after a successful transfer.

## Invariants

- **Forced stop leaves no transfer process running** (Device session 5): after `forceStop()`, no registered child is alive. Test with real stand-in children (`sleep 30` spawned through the registry).
- **Only own children**: `forceStop()` signals exactly the registered processes. Test that a process spawned outside the registry is still alive afterwards.
- **Registry empties (liveness)**: a child that exits on its own leaves the registry. Test that after a normal job completes the registry is empty.

## Test plan

- Unit tests for the registry and `forceStop()` as above, including a pid that already exited (`ESRCH` is swallowed and the loop continues).
- A `buildApp` test where a fake runner's child ignores cancellation: `shutdown()` still resolves with the child dead.
- The parent-port handler: a fake `parentPort` delivering `forceStop` calls `forceStop` then exit (inject `exit`).

## Sanctioned edits

- `src/server/transfers/adbRunner.ts`, a new `src/server/transfers/children.ts`, `src/server/app.ts`, `src/server/index.ts`, a small parent-port message module if one doesn't exist, tests, `docs/DESIGN.md` (the sentence in criterion 6).

## Out of scope

- Removing partial files during a forced stop (see Context). The quit dialog and Electron main's quit sequence (PGM-365b).
- `electron/main.ts` today stops the server by killing the utility process directly, which skips this ticket's `exit` hook. PGM-365b replaces that with a sequence that sends `forceStop` first. Don't change `electron/main.ts` here, and reviewers shouldn't flag that path in this ticket.

## Review notes

This ticket has failed review three times on ever narrower hypotheticals. Settled for this ticket: pids are plain numbers the server owns, so throwing property getters and `EPERM` on its own children are not in scope; a pid reused by the OS in the microseconds between a child's exit and its `exit` event is an accepted residual risk.

## Size

S: one registry, one synchronous kill, three call sites.
