---
id: PGM-367f
title: Keep nested test and spec files of dependencies out of the app bundle
milestone: F1
deps: [PGM-367]
size: S
---

## Goal

The packaged `app.asar` holds only runtime files from production dependencies, not their nested test, spec or type-test files.

## Context

- `electron-builder.config.ts` excludes test folders only directly under each package. A packaged build still contains files such as `node_modules/sonic-boom/types/tests/test.ts` and `node_modules/json-schema-traverse/spec/index.spec.js`.
- The config test added with packaging asserts the include and exclude rules.

## Acceptance criteria

1. The `files` patterns exclude, at any depth under `node_modules`: `test`, `tests`, `__tests__`, `spec` and `example`/`examples` folders, and `*.test.*`, `*.spec.*`, `*.md` (except `LICENSE*`), `*.map` and `*.d.ts` files.
2. No runtime file of the 5 production dependencies (`fastify`, `@fastify/static`, `@fastify/websocket`, `open`, `qrcode`) or their dependencies is excluded: a package's `main`/`exports` targets must never match an exclusion. Check this in the test by resolving each production dependency's entry file (and its transitive production dependencies' entry files) and asserting none matches the exclusion patterns.
3. Don't run `npm run make`; the owner will.

## Test plan

- Extend the packaging config test: the patterns exclude the two example paths above and a nested `tests/x.test.js`; every production dependency entry file is still included.

## Sanctioned edits

- `electron-builder.config.ts`, the packaging config test.

## Out of scope

- Shrinking Electron itself or switching packagers.

## Size

S: a few patterns and their test.
