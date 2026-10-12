---
id: PGM-372
title: Release workflow that signs, notarizes and publishes the DMG from a tag, behind a protected environment
milestone: W3
deps: [PGM-369b]
size: M
---

## Goal

A GitHub Actions workflow builds the signed, notarized DMG from a `v*` tag, waits for the owner's approval before it can read any signing secret, and attaches the DMG to the tag's GitHub Release. It never runs on its own: only a tag push or a manual dispatch starts it.

## Context

- PGM-369b added `npm run make:signed` (`PGMAC_SIGN=1`). electron-builder 26 signs with `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD`, and notarizes with `APPLE_API_KEY` (a path to the `.p8` file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- The existing `.github/workflows/ci.yml` runs on `pull_request` and pushes to `main` with no secrets. The repo is public, so fork PRs get no secrets and a read-only token.
- The owner will create a GitHub Environment named `release` (with themselves as required reviewer) holding these secrets: `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. The owner will keep the workflow disabled in GitHub until they turn it on.

## Acceptance criteria

1. New `.github/workflows/release.yml`, triggered only by `push: tags: ['v*']` and `workflow_dispatch` (input `publish`, boolean, default false). No `pull_request`, `pull_request_target`, `workflow_run`, `schedule` or branch push triggers, so merging this file starts nothing.
2. Top-level `permissions: contents: read`. One job, `release`, on `macos-latest`, with `environment: release` and `permissions: contents: write` (needed to publish). It runs on a tag push, or on dispatch, where it publishes only when `publish` is true.
3. Steps, in order:
   1. Checkout.
   2. Node 22 setup with the npm cache.
   3. `npm ci`.
   4. `npm run typecheck`, `npm run lint` and `npm test`.
   5. Write the `.p8` to `$RUNNER_TEMP/AuthKey.p8` from `APPLE_API_KEY_P8`, with mode 600.
   6. `npm run make:signed` with `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the temp path), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` set from the environment secrets.
   7. Verify the app with `codesign --verify --deep --strict --verbose=2`, `spctl --assess --type execute -vv` and `xcrun stapler validate`.
   8. Compute the DMG's SHA-256.
   9. Upload the DMG as a workflow artifact.
   10. On a tag push, or on dispatch with `publish`, create or update the GitHub Release for the tag with `gh release upload --clobber` (create it with `gh release create` if missing), with the SHA-256 in the notes.
   11. A final `if: always()` step deletes `$RUNNER_TEMP/AuthKey.p8` and any keychain electron-builder created.
4. Every `uses:` is pinned to a full 40-character commit SHA with the version in a trailing comment. Look up the SHAs with `git ls-remote` or `gh api`.
5. Secrets are passed only through `env:` on the steps that need them, never echoed, and never written anywhere except the temporary `.p8`.
6. A comment at the top of the file explains the trigger choice and why `pull_request_target` and `workflow_run` must never be added.
7. `README.md` gains "Releasing": push a `v*` tag, approve the `release` environment run, and the list of environment secret names (names only).

## Invariants

- **Nothing runs by accident**: the workflow has no trigger other than a tag push or a manual dispatch. Test by parsing the YAML.
- **Secrets only behind the environment**: no step outside the `release` job references a secret, and the job declares `environment: release`. Test by parsing the YAML.
- **Cleanup always runs**: the cleanup step has `if: always()`. Test by parsing the YAML.

## Test plan

- A Vitest test that parses `.github/workflows/release.yml` (add `yaml` as a devDependency with `npm install -D yaml` if no YAML parser is installed) and asserts the triggers, permissions, environment, the `always()` cleanup, that every `uses:` matches `@[0-9a-f]{40}`, and that `secrets.` appears only inside the `release` job.

## Sanctioned edits

- New `.github/workflows/release.yml` (the "never touch" rule for `.github/workflows/` is lifted for this one file only; don't change `ci.yml`), a new test, `package.json` and `package-lock.json` (only for `yaml`), `README.md`.

## Out of scope

- Repo rulesets and Actions settings (owner, PGM-371). Auto-update metadata (PGM-373). Running the workflow.

## Size

M: one workflow file and a YAML structure test.
