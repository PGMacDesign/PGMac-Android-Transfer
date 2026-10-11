---
id: PGM-360a
title: Require a per-launch token on the local API and WebSocket, in browser mode and the desktop app
milestone: W1
deps: []
size: M
---

## Goal

Every API request and WebSocket upgrade must carry a token generated at launch, so other local processes and other user accounts on the same Mac can no longer list, trash or transfer files through the loopback server. Browser mode, dev mode and the desktop app each hand the token to their own page, so all three keep working.

## Context

- The `onRequest` hook in `src/server/app.ts` allows only a loopback `Host` and a matching or absent `Origin`. That stops other websites and DNS rebinding, but a request with no `Origin` passes, and loopback is shared by every account on the Mac. `/api/fs/*` can list and trash any file the user can read.
- The web client sends requests through `src/web/api.ts`, Finder uploads through `src/web/uploader.ts`, and opens the WebSocket in `src/web/store.ts`. The browser WebSocket API can't set headers.
- `src/server/index.ts` opens the browser with the `open` package and prints the URL.
- `scripts/dev.ts` runs the server with `node --watch` (it restarts on every file change) plus the Vite dev server on port 5173.
- `electron/main.ts` forks the server with an env built in `electron/lib.ts` and loads `http://127.0.0.1:<port>` in its window.
- An earlier attempt failed review because the token broke the desktop app (its window had no token), dev mode could end up with two different tokens, and an open tab whose token was refused retried forever without saying why. The criteria below cover all three.

## Acceptance criteria

1. `buildApp` accepts an optional token (through `AppOptions` or `Config`). When it is set, every request whose path starts with `/api/` or is `/ws` must present it, or gets `401` with `{ "error": "Unauthorized" }`. Static UI assets (`/`, `/assets/*`, `index.html`) stay public so the page can load.
2. HTTP clients present it as `Authorization: Bearer <token>`. The WebSocket client presents it as a second `Sec-WebSocket-Protocol` value, `new WebSocket(url, ['pgmac', 'token.<token>'])`; the server selects `pgmac` as the protocol (ws `handleProtocols`) so the browser accepts the connection.
3. Tokens are compared in constant time (`crypto.timingSafeEqual` after a length check).
4. The Host/Origin check runs first and still returns 403 for a forged `Host` or foreign `Origin`, with or without a valid token.
5. One helper, `resolveApiToken(env)`, returns `API_TOKEN` when it is non-empty after trimming, otherwise 32 random bytes as hex. Every launcher uses it, so an empty `API_TOKEN` means "generate" everywhere.
6. Browser mode: `src/server/index.ts` uses the helper, opens the browser (when it does today) at `http://127.0.0.1:<port>/#token=<token>`, and prints `PGMac Android Transfer is running at http://127.0.0.1:<port>/#token=<token>`, so a user with `OPEN_BROWSER=0` can still open it.
7. Dev mode: `scripts/dev.ts` resolves the token once and passes it to the server child as `API_TOKEN`, so `--watch` restarts keep the same token, and prints `Open http://127.0.0.1:5173/#token=<token>` once. Browser-opening behaviour in dev mode is unchanged from today.
8. Desktop app: Electron main resolves a fresh token per launch, passes it to the forked server as `API_TOKEN`, and loads `http://127.0.0.1:<port>/#token=<token>`. The token is never written to disk or printed, and is redacted from the captured server output shown in the server-exit window.
9. The page reads `#token=` once at startup, keeps it in `sessionStorage` (so a reload of the same tab keeps working), and removes the fragment from the address bar with `history.replaceState`. A page with no token shows "Open PGMac Android Transfer from the link printed in your terminal." instead of the app.
10. When the WebSocket closes, the page asks `GET /api/snapshot` with its token before reconnecting. On 401 it stops reconnecting and shows "This page's link has expired. Open PGMac Android Transfer from the link printed in your terminal." On any other result it reconnects as today.
11. The token never appears in request logs, error messages or API responses (the URL fragment is never sent to the server).
12. `docs/DESIGN.md` gains a short "Local API token" section under Session flow or Configuration, and `.env.example` documents `API_TOKEN` as optional.

## Invariants

- **Host/Origin before token**: a forged `Host` gets 403 even with a valid token; a valid `Host` with no token gets 401 on `/api/*` and `/ws`. Test both.
- **Every launcher's page can authenticate (liveness)**: browser, dev and desktop each give their page the token the server expects. Test the helper (empty and whitespace `API_TOKEN` generate; a set one is kept), the dev launcher's child env, and the Electron env builder and window URL.
- **A refused token stops the retry loop**: after a 401 probe the page makes no further WebSocket attempts. Test with a fake socket and fetch.
- **No token, no data**: with a token configured, no `/api/*` route and no WebSocket message is reachable without it. Test a GET, a POST and a WebSocket upgrade with no token and with a wrong token.

## Test plan

- `test/app.test.ts` (or a new file): no token, wrong token (same length and different length), right token, over HTTP (`inject`) and over a real WebSocket upgrade; static `/` stays 200 without a token; forged Host with a right token is 403.
- `test/web/`: the token reader takes `#token=` from the hash, stores it, clears the hash, and falls back to `sessionStorage` on reload; `api.ts` adds the header; `uploader.ts` requests carry it.
- Existing tests keep passing with no token configured (the option is off by default in `buildApp`).

## Owner manual check

- `npm start` opens the app and everything works; `curl -i http://127.0.0.1:4848/api/snapshot` returns 401.

## Sanctioned edits

- `src/server/app.ts`, `src/server/index.ts`, `src/server/config.ts`, a shared token helper module, `scripts/dev.ts`, `electron/main.ts`, `electron/lib.ts`, `src/web/api.ts`, `src/web/uploader.ts`, `src/web/store.ts`, `src/web/main.tsx` or `src/web/App.tsx` (token messages), a new `src/web/token.ts`, tests, `docs/DESIGN.md`, `.env.example`, `README.md` (one line on the token link).

## Out of scope

- Replacing HTTP with Electron IPC (later). This ticket now includes the desktop part that was PGM-360b.

## Size

M: one server check, the client plumbing for three request paths, and token hand-off in three launchers.
