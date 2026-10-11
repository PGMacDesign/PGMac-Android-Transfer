---
id: PGM-358f
title: Electron shell follow-ups from review
milestone: F1
deps: [PGM-358, PGM-365a]
size: S
---

## Goal

Fix three small non-blocking issues reviewers found in the Electron shell and its window handling after they merged.

## Context

- `electron/main.ts` shows the last 50 lines of server output when the server exits, then appends `(exit code N)`. The append happens before trimming to the limit, so a server that printed 50 or more lines shows only 49 of them.
- `electron/windowState.ts` raises a restored window to the minimum size, then clamps its position; on a display smaller than the minimum the clamp's upper bound goes negative and the window extends off the display on every launch.
- `test/electron/readiness.test.ts` checks that `src/server/index.ts` posts its readiness message after clearing stale staging by comparing the positions of substrings in the source text. A harmless rewording can break it, and it can't prove the order at runtime.

## Acceptance criteria

1. The server-exit window shows the last 50 output lines and the exit code on its own line outside those 50.
2. The readiness ordering is tested by behaviour, not source text: extract the startup sequence (listen, clear stale staging, announce) into a function with injected steps and assert the call order, including that a failing or slow staging clear still delays the announcement until it settles.
3. On a display smaller than the window's minimum size, the restored window is placed at the display's top-left corner (its work area origin) instead of a negative or off-display position.

## Test plan

- `test/electron/lib.test.ts`: 60 lines of output plus an exit code yields 50 lines and a separate exit-code line.
- `test/electron/readiness.test.ts`: the injected-step test above replaces the source-text test.
- The window-state tests: a display smaller than the minimum size yields the work area origin.

## Sanctioned edits

- `electron/main.ts`, `electron/lib.ts`, `src/server/index.ts`, `src/server/readiness.ts`, `electron/windowState.ts`, and their test files.

## Out of scope

- Any behaviour change beyond these two fixes.

## Size

S: two small fixes and their tests.
