---
id: PGM-358
title: Electron shell that runs the server in a utilityProcess and opens a window on it
milestone: W1
deps: []
size: M
---

## Goal

`npm run app` opens a desktop window running the existing app: Electron main picks a free loopback port, forks the unchanged server in a `utilityProcess`, and loads the UI from it. Browser mode (`npm start`) keeps working. This is the base every other desktop ticket builds on.

## Context

- Electron 44.7 bundles Node 24.21 with TypeScript type stripping, and `src/server/index.ts` already starts unmodified under it (`ELECTRON_RUN_AS_NODE=1 OPEN_BROWSER=0 PORT=49999 electron src/server/index.ts` served `/api/snapshot`).
- `loadConfig` (`src/server/config.ts`) rejects `PORT=0` and falls back to 4848, and the Host check in `src/server/app.ts` keys on the configured port, so main must pick a concrete free port itself.
- `src/server/threadpool.ts` must run before the libuv pool is first used. In a `utilityProcess`, pass `UV_THREADPOOL_SIZE` through `fork`'s `env` (read the value `threadpool.ts` would set and reuse it, don't duplicate a magic number).
- Sandboxed preloads can't use ES modules or import local files, so the preload is a single CommonJS file.

## Acceptance criteria

1. `electron` is added as a devDependency with `npm install -D electron@44` (lockfile updated), and `package.json` gains `"app": "vite build && electron electron/main.ts"` (or an equivalent that builds the UI first).
2. `electron/main.ts` picks a free port on `127.0.0.1`, forks `src/server/index.ts` with `utilityProcess.fork` and `env` containing the parent's environment plus `PORT=<port>`, `OPEN_BROWSER=0` and `UV_THREADPOOL_SIZE`.
3. The server signals readiness: when `process.parentPort` exists, `src/server/index.ts` posts `{ type: 'listening', port }` after `listen` succeeds. Main opens the window only after that message, on `http://127.0.0.1:<port>`.
4. The `BrowserWindow` has `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and preload `electron/preload.cjs`, which calls `contextBridge.exposeInMainWorld('pgmacDesktop', {})`. Later tickets add functions to that object; the empty object's presence is how the page knows it is in the desktop app.
5. `src/web/desktop.ts` exports a typed accessor (for example `desktopBridge(): PgmacDesktop | null`) that reads `window.pgmacDesktop`, with an interface that later tickets extend. No UI behaviour changes in this ticket.
6. If the server process exits before posting `listening`, or exits later while the window is open, main shows a window with the heading "PGMac Android Transfer couldn't start its server." (or "PGMac Android Transfer's server stopped." for a later exit) and the last 50 lines of the server's stdout and stderr, instead of a blank page.
7. Quitting the app kills the server process, so no listener is left on the chosen port.
8. Port choice, env building and the output ring buffer live in a module that doesn't import `electron` (for example `electron/lib.ts`), so Vitest can test them.
9. `tsconfig.json` `include` gains `electron` so the new files are typechecked. Browser mode is unchanged: `npm start` still serves on 4848 and opens the browser.

## Invariants

- Host/Origin 403 still applies under Electron: the server is unchanged apart from the readiness message, and `test/app.test.ts` already covers forged `Host` and foreign `Origin`. Don't touch that check.
- The server is started by exactly one process: main forks once per launch and never restarts it silently.

## Test plan

- `test/electron/lib.test.ts`: the chosen port is free and in range; the env contains `PORT`, `OPEN_BROWSER=0` and `UV_THREADPOOL_SIZE` and keeps the parent's `PATH`; the output buffer keeps only the last 50 lines.
- A test that `src/server/index.ts`'s readiness message is posted only when `process.parentPort` exists (extract the small function that decides it, if that keeps the entry file untestable otherwise).
- Existing tests stay green.

## Owner manual check

- `npm run app` opens a window; Start Session, browsing both panes and a phone to Mac transfer work.
- `npm start` still works in a browser on 4848 while the app runs on its own port.
- After quitting, `lsof -iTCP -sTCP:LISTEN | grep <port>` shows nothing.

## Sanctioned edits

- New: `electron/main.ts`, `electron/lib.ts` (or similar), `electron/preload.cjs`, `src/web/desktop.ts`, `test/electron/*`.
- `package.json`, `package-lock.json`, `tsconfig.json`, `src/server/index.ts` (readiness message only), `README.md` (a short "Desktop app (in development)" note with `npm run app`).

## Out of scope

- The API token (PGM-360a, PGM-360b), settings migration (PGM-362a, PGM-362b), menus and quit behaviour (PGM-365a, PGM-365b), packaging (PGM-367), fuses and CSP (later).

## Size

M: a new entry point plus small helpers, no change to server behaviour.
