---
id: PGM-362a
title: Default device IP and adb path become saved settings, with a configurable state folder
milestone: W1
deps: []
size: M
---

## Goal

The default device IP and the adb path can be changed through the settings API and are saved in the state file, so the desktop app (whose bundle and `.env` are read-only) can configure them. The state folder can be moved with `STATE_DIR`. Browser mode with an existing `.env` behaves as before.

## Context

- `loadConfig` (`src/server/config.ts`) reads `PORT`, `DEFAULT_DEVICE_IP`, `MAX_CONCURRENT_TRANSFERS`, `ADB_PATH` and `OPEN_BROWSER` from the environment and `<repo>/.env`.
- `StateStore` (`src/server/stateStore.ts`) keeps `lastUsed` and `downloadsDir` in `~/.config/pgmac-transfer/state.json`.
- `POST /api/settings` in `src/server/app.ts` accepts `maxConcurrent` and `downloadsDir` and emits a `settings` event; `Settings` is in `src/shared/protocol.ts`. `POST /api/adb/recheck` re-resolves adb.

## Acceptance criteria

1. When `STATE_DIR` is set, the state file is `<STATE_DIR>/state.json`; otherwise it stays `~/.config/pgmac-transfer/state.json`.
2. When `STATE_DIR` is set and `<STATE_DIR>/state.json` doesn't exist, but `~/.config/pgmac-transfer/state.json` does, its contents are copied in once at startup, so earlier users keep their downloads folder and last device. The old file is left untouched.
3. `StateStore` persists `defaultDeviceIp` and `adbPath`. `Settings` gains `defaultDeviceIp: string | null` and `adbPath: string | null`, holding the saved values (null when not saved).
4. Effective values follow one rule: saved setting, then the environment variable (`DEFAULT_DEVICE_IP`, `ADB_PATH`), then the default. Put it in one function in `config.ts` or a sibling module.
5. `POST /api/settings` accepts `defaultDeviceIp` (an IPv4 address or hostname; an empty string clears the saved value) and `adbPath` (an empty string clears it). Invalid IP text gets 400 "Enter an IP address like 192.168.1.20.".
6. A non-empty `adbPath` must be absolute, executable, and `adb version` from it must succeed within 5 seconds; otherwise 400 "That file isn't a working adb." and the previous value stays in use and saved.
7. A change takes effect without a restart: a new adb path is resolved and broadcast as an `adb` event (as `/api/adb/recheck` does), and the next Start Session uses the new default device IP.
8. `docs/DESIGN.md` Configuration documents `STATE_DIR` and the precedence; `.env.example` lists `STATE_DIR` as optional.

## Invariants

- **Settings beat env beat default**, for both fields, at startup and after a change. Test each layer.
- **A rejected adb path changes nothing**: the saved value, the resolved adb and the snapshot are identical before and after a 400.

## Test plan

- Unit tests for the precedence function (all combinations of saved, env and default for both fields).
- `StateStore` tests with a temp `STATE_DIR`: save and reload both fields; first-run import copies the old file once and doesn't overwrite an existing new one.
- `app.test.ts`-style tests for `POST /api/settings`: valid and invalid IP, clearing, a working fake adb script, a non-executable file, a script that exits 1; the `settings` and `adb` events.
- Browser mode with `.env` values and no saved settings yields the same config as before.

## Sanctioned edits

- `src/server/config.ts`, `src/server/stateStore.ts`, `src/server/app.ts`, `src/server/session.ts` (reading the current default IP), `src/server/index.ts`, `src/shared/protocol.ts`, tests, `docs/DESIGN.md`, `.env.example`. Any `src/web` change is limited to keeping the build and types compiling.

## Out of scope

- The Settings UI and Electron passing `STATE_DIR` (PGM-362b). Port and open-browser stay environment-only.

## Size

M: two persisted fields, one precedence rule, one validated route.
