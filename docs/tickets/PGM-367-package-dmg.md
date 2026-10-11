---
id: PGM-367
title: Package the desktop app as an unsigned universal DMG
milestone: W1
deps: [PGM-358]
size: M
---

## Goal

`npm run make` turns a checkout into an installable `.app` inside a DMG, ready for the later signing and notarization work. Only what the app needs at runtime goes in.

## Context

- PGM-358 added `electron/main.ts`, `electron/preload.cjs` and `npm run app`. The server's `.ts` sources run directly under Electron's Node (type stripping), including from inside `app.asar`, so the server needs no build step; the UI is built by `vite build` into `dist/web`.
- `package.json` is `"type": "module"` with 5 production dependencies (`fastify`, `@fastify/static`, `@fastify/websocket`, `open`, `qrcode`).

## Acceptance criteria

1. Use electron-builder or Electron Forge, and state the choice and the reason in a comment at the top of the packaging config (both wrap `@electron/osx-sign` and `@electron/notarize` for later). Add it with `npm install -D`.
2. `npm run make` runs `vite build`, then packages. It is not part of `scripts/verify.sh` or CI (slow and macOS-only).
3. The app is named "PGMac Android Transfer", bundle id `com.pgmacdesign.androidtransfer`, version from `package.json`, category `public.app-category.utilities`.
4. The bundle contains `electron/`, `src/server/`, `src/shared/`, `dist/web/` and production `node_modules` only. No `test/`, `docs/`, `src/web/` sources, `scripts/`, `factory/`, devDependencies, `.env` files or source maps.
5. Targets: a universal (arm64 and x64) DMG with the usual drag-to-Applications layout. If universal fails for a real reason, two DMGs (arm64 and x64) instead, with the reason in the config comment.
6. Icon: a placeholder 1024x1024 PNG checked in as `build/icon.png` (a simple shape with the letters "AT" is fine; the owner replaces it later) and whatever `.icns` the tool needs generated from it at build time or checked in.
7. The output goes under `out/` or `release/`, which is added to `.gitignore`, `.prettierignore` and the ESLint ignores.
8. `README.md` gains "Build the desktop app" with `npm run make`, where the DMG lands, and that it is unsigned (right-click, Open on first launch).

## Test plan

- A Vitest test that loads the packaging config and asserts the include and exclude rules from criterion 4, the app name, the bundle id and the version source, so a later edit can't silently ship `test/` or devDependencies.
- `./scripts/verify.sh` stays green (it doesn't run the packager).

## Owner manual check

- On a clean checkout, `npm ci && npm run make` produces the DMG. Install it, right-click Open from `/Applications`: Start Session, a transfer each way and a Finder drop work. Record the DMG size in the PR or a follow-up comment. About shows the `package.json` version. Inspect `app.asar` (`npx @electron/asar list`) for no `test/` or `docs/`.

## Sanctioned edits

- `package.json`, `package-lock.json`, a new packaging config file (`electron-builder.yml`, `forge.config.ts` or similar), `build/icon.png` (and a generated `.icns` if checked in), `.gitignore`, `.prettierignore`, `eslint.config.js` (ignores only), `README.md`, a new test file.

## Out of scope

- Code signing, notarization, fuses, entitlements and auto-update (Signed release milestone).

## Size

M: packaging config, an icon placeholder and a config test.
