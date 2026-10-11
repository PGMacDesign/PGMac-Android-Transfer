---
id: PGM-359
title: Find Homebrew's adb when the app is launched from the Dock
milestone: W1
deps: []
size: S
---

## Goal

adb is found at Homebrew's install paths even when the process has launchd's minimal `PATH`, so a desktop app launched from the Dock or Finder doesn't report "adb not found" for Homebrew-only users.

## Context

- `resolveAdbPath` (`src/server/adb/adb.ts`) checks the explicit path, each `PATH` entry, `$ANDROID_HOME`/`$ANDROID_SDK_ROOT`, `~/Library/Android/sdk` and `~/Android/Sdk`.
- A Dock launch gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and usually no `ANDROID_HOME`. Homebrew installs adb at `/opt/homebrew/bin/adb` (Apple silicon) or `/usr/local/bin/adb` (Intel).

## Acceptance criteria

1. `/opt/homebrew/bin/adb` and `/usr/local/bin/adb` are candidates, after the explicit path and the `PATH` entries and before the `ANDROID_HOME`/`ANDROID_SDK_ROOT` and SDK folder candidates.
2. The explicit path (`ADB_PATH`, and later the Settings value) still wins over every other candidate.
3. An adb found on `PATH` still wins over the Homebrew candidates, so terminal launches behave as before.
4. The candidate list is testable without the real filesystem: make the fixed prefixes, the environment and the home folder injectable (for example an optional argument with defaults), keeping the current call sites working unchanged.
5. `docs/DESIGN.md` "Transport" lists the new resolution order.

## Test plan

- Unit tests in `test/` with a temp dir standing in for the Homebrew prefix: with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, no `ANDROID_HOME`, and adb only under the fake Homebrew prefix, the resolver returns that path.
- An explicit path beats the Homebrew candidate.
- An adb on `PATH` beats the Homebrew candidate.
- Non-executable files are skipped (existing behaviour, keep it covered).

## Sanctioned edits

- `src/server/adb/adb.ts`, a new or existing test file, `docs/DESIGN.md` (Transport section).

## Out of scope

- Bundling or downloading adb (a later decision ticket).
- The Settings field for the adb path (PGM-362a, PGM-362b).

## Size

S: one function and its tests.
