---
id: PGM-402
title: Explain a blocked adb daemon instead of blaming the IP and port; fix the log folder name
milestone: W2
deps: []
size: S
---

## Goal

When macOS blocks the adb daemon from the local network, pairing and connecting say so and give the fix, instead of telling the user to check the IP and port. The packaged app's logs land in a folder named after the app.

## Context

- In the unsigned desktop build, the adb daemon the app starts gets `No route to host` for every LAN address, because macOS attributes its traffic to the app and the app has no Local Network permission. Starting the daemon from Terminal (`adb kill-server && adb start-server`) gives it Terminal's permission and pairing then works.
- `parsePairResult` in `src/server/adb/parse.ts` maps `unable to connect|connection refused|no route|timed out|protocol fault` to one message: "Could not reach the phone at that address. Check the IP and port on the pairing screen."
- `parseConnectResult` returns only a boolean, and connect failures surface through the session code.
- `electron/main.ts` reads `app.getPath('logs')`. Electron derives that folder from the app name, which comes from `package.json`'s `name` (`pgmac-android-transfer`), so the packaged app logs to `~/Library/Logs/pgmac-android-transfer`.

## Acceptance criteria

1. `parsePairResult` returns, for output containing `No route to host` (case-insensitive): "macOS is blocking adb from your local network. Quit any tools using adb, run `adb kill-server && adb start-server` in Terminal, then try again." The text is exact, backticks included. `connection refused`, `unable to connect` without `no route`, `timed out` and `protocol fault` keep today's message.
2. When `adb connect` fails with `No route to host` during Start Session, connect after pairing, or reconnect, the user sees the same message wherever a connect failure is shown today. Add a parser that returns a reason for connect failures, and keep `parseConnectResult`'s boolean behaviour for existing callers.
3. `electron/main.ts` calls `app.setName('PGMac Android Transfer')` before anything reads `app.getPath('logs')` or `app.getPath('userData')`. Check what `userData` resolves to before and after. If it would change (moving the settings folder), set the name only for the logs path instead, and say which you did and why in the summary.
4. `README.md`'s troubleshooting gains one entry with the message from criterion 1 and the Terminal command.

## Test plan

- `test/parse.test.ts`: `No route to host` output from `adb pair` and from `adb connect` maps to the new message; refused, timed out and protocol fault keep the old one; success still parses as success.
- A test that the session's connect-failure path surfaces the new message for `No route to host`.
- `test/electron/`: the logs and userData path decision from criterion 3, in a module without an `electron` import if it needs logic.

## Sanctioned edits

- `src/server/adb/parse.ts`, `src/server/session.ts`, `src/server/pairing.ts` (only to pass the reason through), `electron/main.ts`, an Electron helper module if needed, tests, `README.md`.

## Out of scope

- Signing, which is the real fix.
- Restarting adb automatically (the app never runs `adb kill-server`).

## Size

S: one parser branch, one message path and one app-name call.
