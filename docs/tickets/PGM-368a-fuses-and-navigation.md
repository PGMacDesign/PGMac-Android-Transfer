---
id: PGM-368a
title: Electron fuses and in-app navigation blocking for the signed app
milestone: W3
deps: []
size: S
---

## Goal

The packaged app can't be used as a signed Node runtime by other programs, refuses a tampered `app.asar`, and never navigates its window away from the app.

## Context

- With Electron's default fuses, `ELECTRON_RUN_AS_NODE=1 "/Applications/PGMac Android Transfer.app/Contents/MacOS/PGMac Android Transfer" script.js` runs any script as this app, inheriting its signature and any Local Network or folder permission the user granted it.
- electron-builder 26 (installed) flips fuses at package time from the `electronFuses` key in `electron-builder.config.ts` (see `node_modules/app-builder-lib/out/configuration.d.ts`). No extra dependency is needed.
- The server runs in a `utilityProcess` (`electron/main.ts`), not `child_process.fork`, so `RunAsNode` isn't needed. Confirm by grepping for `fork(` and `ELECTRON_RUN_AS_NODE` before turning it off.
- `electron/main.ts` already denies `window.open` through `setWindowOpenHandler` and opens allowed links via `electron/links.ts`.

## Acceptance criteria

1. `electronFuses` in `electron-builder.config.ts` sets `runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `grantFileProtocolExtraPrivileges: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`. Leave `enableCookieEncryption` and the rest at their defaults.
2. Every window's `webContents` gets a `will-navigate` handler that calls `preventDefault()` for any URL whose origin isn't the app's own `http://127.0.0.1:<port>` origin, and hands `http:`/`https:` URLs to the existing external-link helper instead. The origin check lives in a module without an `electron` import.
3. Don't run `npm run make`.

## Test plan

- Extend the packaging config test: the six fuse values above are set exactly.
- `test/electron/`: the navigation decision for the app origin (allowed), another port on 127.0.0.1 (blocked), `https://github.com/...` (blocked, handed to the external helper), `file:` and `javascript:` (blocked, not handed on).

## Owner manual check

- After `npm run make`: `npx @electron/fuses read --app "release/mac-universal/PGMac Android Transfer.app"` shows those fuse states. `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/PGMac Android Transfer" -e "console.log(1)"` doesn't print 1.

## Sanctioned edits

- `electron-builder.config.ts`, its test, `electron/main.ts`, `electron/links.ts` or a new helper module, tests.

## Out of scope

- A Content-Security-Policy (separate ticket). Signing and entitlements (PGM-369b).

## Size

S: six config values and one navigation guard.
