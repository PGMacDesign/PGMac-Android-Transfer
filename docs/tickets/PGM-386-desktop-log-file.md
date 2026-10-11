---
id: PGM-386
title: Desktop app writes its logs to ~/Library/Logs
milestone: W2
deps: []
size: M
---

## Goal

The desktop app keeps a log file, so a failure in a Dock-launched app (for example QR pairing timing out) can be diagnosed afterwards.

## Context

- The server runs in a utility process forked by `electron/main.ts`. Main captures its stdout and stderr (for the server-exit window and to echo to its own stdout), but launched from the Dock or Finder that output goes nowhere.
- The API token can appear in server output; main already redacts it for the server-exit window.
- Pairing lives in `src/server/pairing.ts` (`PairingManager`): QR mode polls `adb mdns services` every second for a `_adb-tls-pairing` service with the generated name, then runs `adb pair` and connects. Today it logs nothing.
- The Help menu is built in `electron/menu.ts`.

## Acceptance criteria

1. Electron main appends to `<app.getPath('logs')>/main.log` (on macOS `~/Library/Logs/PGMac Android Transfer/main.log`): the server's stdout and stderr and main's own lifecycle messages (start, server listening, server exit with code, quit), one line per entry prefixed with an ISO timestamp and the source (`main`, `server`, `server:err`).
2. Output is split into whole lines before writing (a partial line is held until its newline or until the stream ends), and the API token is redacted from each whole line, so a token split across chunks is still removed.
3. Before each write, if `main.log` is larger than 5 MB it is renamed to `main.old.log` (replacing any existing one) and a new file starts. Write errors are swallowed and never crash the app.
4. The Help menu gains "Show Logs", which calls `shell.showItemInFolder` on `main.log` (creating an empty file first if none exists).
5. `PairingManager` logs at info level through the server's existing logger (or `console.log` if there is none): QR attempt started with its service name, a line whenever the number of `_adb-tls-pairing` services seen changes (with their names, never the password), match found, `adb pair` result, connect result, timeout, and cancel. The pairing password never appears in a log line.
6. Browser mode output is unchanged apart from the new pairing lines.

## Invariants

- **No secret reaches the log**: neither the API token nor the pairing password appears in `main.log`. Test a token split across two chunks and a pairing attempt's full log output.
- **Logging never breaks the app**: an unwritable log folder leaves the app running. Test with a log path whose parent is a file.

## Test plan

- `test/electron/`: the line splitter and redactor (split token, multiple lines per chunk, trailing partial line flushed at end); rotation at the size limit; a write failure is swallowed. Keep the logic in a module without an `electron` import.
- `test/pairing.test.ts`: the log lines for start, service count change, match, pair failure, timeout and cancel, and that the password never appears.

## Sanctioned edits

- `electron/main.ts`, `electron/menu.ts`, a new log module under `electron/`, `src/server/pairing.ts`, tests, `README.md` (one line on where logs live).

## Out of scope

- Uploading or sharing logs. Log levels or a settings switch.

## Size

M: a small file logger with redaction and rotation, a menu item, and pairing log lines.
