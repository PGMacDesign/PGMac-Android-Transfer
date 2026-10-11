---
id: PGM-360f
title: API token follow-ups from review
milestone: F1
deps: [PGM-360a]
size: S
---

## Goal

Close two small gaps reviewers found after the API token merged: a hand-set `API_TOKEN` that can't be sent over the WebSocket, and the desktop app echoing its token to the terminal.

## Context

- `resolveApiToken` accepts any non-empty `API_TOKEN`. The page sends the token as a `Sec-WebSocket-Protocol` value (`token.<token>`), which only allows HTTP token characters, so a value such as `abc/def` makes the `WebSocket` constructor throw and the page retries forever.
- Under Electron, the server still prints `... running at http://127.0.0.1:<port>/#token=<token>`. Electron main redacts the token per output chunk before echoing server output to its terminal, so a token split across two chunks is echoed in full.

## Acceptance criteria

1. A set `API_TOKEN` must match `^[A-Za-z0-9_-]{16,}$`. Anything else makes the server exit at startup with "API_TOKEN must be at least 16 characters of letters, digits, '-' or '_'." Generated tokens (hex) always match. An empty or whitespace value still means "generate".
2. When the server runs under Electron (`process.parentPort` exists), it prints the URL without the `#token=` fragment, so the token never reaches Electron's output handling. Browser and dev mode output is unchanged.
3. `.env.example` and `docs/DESIGN.md` state the `API_TOKEN` format.

## Test plan

- Token helper: valid, too short, `/`, space and empty values.
- The startup line builder: with and without a parent port.

## Sanctioned edits

- The token helper module, `src/server/index.ts`, `scripts/dev.ts` (only if it validates too), `.env.example`, `docs/DESIGN.md`, tests.

## Out of scope

- Changing how the page receives the token.

## Size

S: one validation rule and one print change.
