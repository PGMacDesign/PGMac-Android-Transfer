---
id: PGM-360b
title: Desktop app generates the API token per launch and hands it to its window
milestone: W1
deps: [PGM-358, PGM-360a]
size: S
---

## Goal

The desktop app's server requires a fresh random token on every launch, and only the app's own window has it.

## Context

- PGM-360a made the server require `API_TOKEN` when set, and made the page read `#token=<token>` from the URL fragment once, keep it in `sessionStorage`, and clear it from the address bar.
- PGM-358 added `electron/main.ts`, which forks the server with an env built by a helper module without an `electron` import.

## Acceptance criteria

1. Electron main generates 32 random bytes (`crypto.randomBytes(32).toString('hex')`) per launch and passes it to the forked server as `API_TOKEN`.
2. The window loads `http://127.0.0.1:<port>/#token=<token>`; no new preload function is needed.
3. The token is never written to disk, never printed, and never included in the server-exit error window (redact it if it appears in captured output).
4. Requests from any other origin or process without the token get 401 (already true from PGM-360a; this ticket just makes sure the desktop app always sets one).

## Test plan

- `test/electron/`: the env builder includes a 64-character hex `API_TOKEN`; two calls produce different tokens; the window URL contains the fragment; the output redaction removes the token from captured lines.

## Owner manual check

- With the app running, `curl -i http://127.0.0.1:<port>/api/snapshot` returns 401, and the app works normally.

## Sanctioned edits

- `electron/main.ts`, the Electron helper module from PGM-358, `test/electron/*`.

## Out of scope

- IPC instead of HTTP (later).

## Size

S: token generation and one URL change.
