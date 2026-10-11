# AGENTS.md

Rules for any agent changing this repo. Read this, then `docs/DESIGN.md`, before writing code.

## What this is

PGMac Android Transfer moves files between a Mac and an Android device over adb (WiFi or USB). It runs in two modes:

- **Browser mode** (`npm start`): a Fastify server on `127.0.0.1:4848` serves a React UI that opens in the default browser.
- **Desktop app** (being added): an Electron shell that runs the same server in a `utilityProcess` and opens a window on it. The plan and its reasoning are in the Linear project "PGMac Android Transfer" and its assessment document; the ticket you are building quotes what you need.

## Stack

- Node 22.18+ with TypeScript type stripping. The server's `.ts` files run directly, with no server build step. Only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- Server: Fastify 5, `@fastify/websocket`, `@fastify/static`. Entry `src/server/index.ts`, app in `src/server/app.ts`.
- UI: React 19 and Vite, plain CSS in `src/web/styles.css`. Wire types shared by both sides live in `src/shared/protocol.ts`.
- Tests: Vitest, in `test/` (`test/web/` for UI logic). `test/integration` needs an emulator and is skipped unless `PGMAC_EMULATOR_TEST=1`.

## Commands

- `./scripts/verify.sh`: the merge gate. Installs if the lockfile changed, then the em-dash guard, typecheck, lint, format check, tests and build. Run it before you finish; it must pass.
- `npm run format`: fix formatting (Prettier checks every file, including Markdown and YAML).
- `npm start`: browser mode, for manual checks.

## Architecture rules

1. **The laws in `docs/DESIGN.md` under "Invariants" hold.** Transfer job lifecycle, destination naming, device session, pairing, client sync, Finder uploads and staging, job eligibility, volume health and reveal. A change that touches one of those state machines keeps every law and adds a test for any law it changes, including the violating path.
2. **Browser mode keeps working.** Every ticket leaves `npm start` behaving as before unless the ticket says otherwise. Desktop-only behaviour is chosen at runtime (for example, a preload bridge being present), never by breaking the browser path.
3. **The server binds to `127.0.0.1` only, and the `onRequest` Host/Origin check in `src/server/app.ts` stays.** It returns 403 for a forged `Host` or a foreign `Origin`. New checks (such as a token) are added after it, never instead of it.
4. **Child processes take argv arrays.** Never run a local shell (`exec`, `shell: true`, string commands). Commands that run on the device go through `Adb.shell()` with its quoting. User-supplied paths are validated (absolute, no NUL bytes).
5. **Never run `adb kill-server`.** Other tools may share the adb server daemon.
6. **Electron security defaults.** Every `BrowserWindow` has `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. The preload exposes only the functions a ticket names, through `contextBridge`, and main validates every argument it receives from the page.
7. **Code that can be unit tested lives outside Electron entry files.** Logic used by `electron/main.ts` or the preload (port choice, env building, path validation, config precedence) goes in modules that don't import `electron`, so Vitest can test it.
8. **`src/server/threadpool.ts` stays the first import of the server entry**, and any process that starts the server sets `UV_THREADPOOL_SIZE` before the server starts.

## Never open windows

This runs on the owner's desktop while they work. Never launch anything that opens a window, takes focus or opens a browser tab: no `npm run app`, `npm start`, `npm run dev`, `electron`, `open`, `osascript`, packaged `.app` launches, `npm run make` or any packager step that builds or mounts a DMG (`hdiutil`, `appdmg` and Forge's DMG maker drive Finder windows), or tests that do any of these. A packaging ticket is verified by testing its config, not by running the packager. Verify with unit tests and `./scripts/verify.sh` only; GUI behaviour is the owner's manual check after merge. If the server must run in a test, start it in-process with `buildApp` (no `listen` on 4848, no browser).

## Dependencies

Add or change dependencies only with `npm install <pkg>` (or `npm install -D <pkg>`), so `package-lock.json` updates with them. A hand-edited `package.json` fails `npm ci`. Keep production dependencies to what the ticket needs; everything in them ships inside the signed app.

## Commits

- Author `pgmacdesign@gmail.com`.
- No AI attribution: no `Co-Authored-By` trailers for an AI, no "Generated with" lines.
- Never write the em-dash character (U+2014) anywhere: code, comments, strings, docs, commit messages. The guard in `scripts/verify.sh` fails on it. Use commas, colons, parentheses or separate sentences.
- Comments explain why, not what. No ticket ids in code or comments.

## Never touch

Unless the ticket explicitly says so:

- `.github/workflows/`
- `factory/`, `AGENTS.md`, `START.md`, `docs/tickets/`
- `LICENSE`
- `.env` files (local configuration, gitignored)

## Tickets

Each ticket names its sanctioned edits. If a change outside them is needed, explain why in your summary. A ticket's "Owner manual check" section lists GUI checks the owner runs after merge (a Dock launch, a drag to the Desktop); you can't run them, so cover the same behaviour with unit tests where the ticket asks and leave the rest. If the acceptance criteria conflict with a rule here, stop and ask for a decision rather than picking one.
