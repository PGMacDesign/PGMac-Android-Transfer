---
id: PGM-360a
title: Require a per-launch token on the local API and WebSocket
milestone: W1
deps: []
size: M
---

## Goal

Every API request and WebSocket upgrade must carry a token generated at launch, so other local processes and other user accounts on the same Mac can no longer list, trash or transfer files through the loopback server. Browser mode passes the token to the page it opens.

## Context

- The `onRequest` hook in `src/server/app.ts` allows only a loopback `Host` and a matching or absent `Origin`. That stops other websites and DNS rebinding, but a request with no `Origin` passes, and loopback is shared by every account on the Mac. `/api/fs/*` can list and trash any file the user can read.
- The web client sends requests through `src/web/api.ts`, Finder uploads through `src/web/uploader.ts`, and opens the WebSocket in `src/web/store.ts`. The browser WebSocket API can't set headers.
- `src/server/index.ts` opens the browser with the `open` package and prints the URL.

## Acceptance criteria

1. `buildApp` accepts an optional token (through `AppOptions` or `Config`). When it is set, every request whose path starts with `/api/` or is `/ws` must present it, or gets `401` with `{ "error": "Unauthorized" }`. Static UI assets (`/`, `/assets/*`, `index.html`) stay public so the page can load.
2. HTTP clients present it as `Authorization: Bearer <token>`. The WebSocket client presents it as a second `Sec-WebSocket-Protocol` value, `new WebSocket(url, ['pgmac', 'token.<token>'])`; the server selects `pgmac` as the protocol (ws `handleProtocols`) so the browser accepts the connection.
3. Tokens are compared in constant time (`crypto.timingSafeEqual` after a length check).
4. The Host/Origin check runs first and still returns 403 for a forged `Host` or foreign `Origin`, with or without a valid token.
5. `src/server/index.ts` uses `API_TOKEN` from the environment if set (the desktop app will pass one), otherwise generates 32 random bytes as hex. It opens the browser at `http://127.0.0.1:<port>/#token=<token>`, and the line it prints is `PGMac Android Transfer is running at http://127.0.0.1:<port>/#token=<token>`, so a user with `OPEN_BROWSER=0` can still open it. Dev mode (`PGMAC_DEV=1`) does the same with the Vite port.
6. The page reads `#token=` once at startup, keeps it in `sessionStorage` (so a reload of the same tab keeps working), and removes the fragment from the address bar with `history.replaceState`. A page with no token shows "Open PGMac Android Transfer from the link printed in your terminal." instead of the app.
7. The token never appears in request logs, error messages or API responses (the URL fragment is never sent to the server).
8. `docs/DESIGN.md` gains a short "Local API token" section under Session flow or Configuration, and `.env.example` documents `API_TOKEN` as optional.

## Invariants

- **Host/Origin before token**: a forged `Host` gets 403 even with a valid token; a valid `Host` with no token gets 401 on `/api/*` and `/ws`. Test both.
- **No token, no data**: with a token configured, no `/api/*` route and no WebSocket message is reachable without it. Test a GET, a POST and a WebSocket upgrade with no token and with a wrong token.

## Test plan

- `test/app.test.ts` (or a new file): no token, wrong token (same length and different length), right token, over HTTP (`inject`) and over a real WebSocket upgrade; static `/` stays 200 without a token; forged Host with a right token is 403.
- `test/web/`: the token reader takes `#token=` from the hash, stores it, clears the hash, and falls back to `sessionStorage` on reload; `api.ts` adds the header; `uploader.ts` requests carry it.
- Existing tests keep passing with no token configured (the option is off by default in `buildApp`).

## Owner manual check

- `npm start` opens the app and everything works; `curl -i http://127.0.0.1:4848/api/snapshot` returns 401.

## Sanctioned edits

- `src/server/app.ts`, `src/server/index.ts`, `src/server/config.ts`, `src/web/api.ts`, `src/web/uploader.ts`, `src/web/store.ts`, `src/web/main.tsx` or `src/web/App.tsx` (no-token message), a new `src/web/token.ts`, tests, `docs/DESIGN.md`, `.env.example`, `README.md` (one line on the token link).

## Out of scope

- Electron passing its own token (PGM-360b). Replacing HTTP with Electron IPC (later).

## Size

M: one server check plus the client plumbing for three request paths.
