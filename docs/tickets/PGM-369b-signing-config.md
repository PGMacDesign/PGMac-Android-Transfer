---
id: PGM-369b
title: Signed and notarized builds with npm run make:signed
milestone: W3
deps: [PGM-368a]
size: S
---

## Goal

`npm run make:signed` builds a Developer ID signed, hardened-runtime, notarized and stapled DMG, with only the entitlements Electron needs. `npm run make` stays unsigned for quick local builds.

## Context

- `electron-builder.config.ts` sets `mac.identity: null` (unsigned). electron-builder 26 is installed.
- Signing identity: `Developer ID Application: PGMacDesign Inc (YMQXY9Z658)`. Locally it is in the login keychain. In CI electron-builder imports it from `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD`.
- Notarization in electron-builder 26 (`node_modules/app-builder-lib/out/mac/MacTargetHelper.js`) runs when `mac.notarize` isn't `false` and credentials are in the environment: either `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (CI), or `APPLE_KEYCHAIN_PROFILE` (a stored `notarytool` profile; locally `pgmac-notary`). electron-builder staples the app after notarizing.
- Under the hardened runtime, Electron needs only `com.apple.security.cs.allow-jit`. The app spawns adb, `dns-sd`, `cp` and others and makes network connections; none of that needs an entitlement outside the App Sandbox. The Finder AppleScript delete was replaced by `shell.trashItem`, so no Apple Events entitlement.

## Acceptance criteria

1. New `build/entitlements.mac.plist` contains exactly one key, `com.apple.security.cs.allow-jit` set to true. It's used for both `entitlements` and `entitlementsInherit`.
2. When `PGMAC_SIGN=1`, the config sets `mac.identity` to `PGMacDesign Inc (YMQXY9Z658)`, `hardenedRuntime: true`, the entitlements above and `notarize: true`. Before packaging, it fails with "Set APPLE_KEYCHAIN_PROFILE, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, to notarize." if neither credential set is present. Without `PGMAC_SIGN`, the config is unsigned exactly as today (`identity: null`, `notarize: false`).
3. `package.json` gains `"make:signed": "PGMAC_SIGN=1 npm run make"`.
4. `README.md` "Build the desktop app" gains a short "Signed builds" part: the `make:signed` command, the two ways to provide notarization credentials (by variable name only), and the checks `codesign --verify --deep --strict --verbose=2 <app>`, `spctl --assess --type execute -vv <app>` and `xcrun stapler validate <app>`.
5. Don't run `npm run make` or `make:signed`.

## Test plan

- Extend the packaging config test: load the config with `PGMAC_SIGN` unset (unsigned, notarize false), with `PGMAC_SIGN=1` and `APPLE_KEYCHAIN_PROFILE` set (identity, hardened runtime, entitlements, notarize true), and with `PGMAC_SIGN=1` and no credentials (the exact error). Restore the environment after each case.
- A test that the entitlements file parses as a plist with exactly the one key.

## Owner manual check

- `APPLE_KEYCHAIN_PROFILE=pgmac-notary npm run make:signed`, then the three checks in criterion 4 pass on `release/mac-universal/PGMac Android Transfer.app`.

## Sanctioned edits

- `electron-builder.config.ts`, its test, new `build/entitlements.mac.plist`, `package.json` (one script), `README.md`.

## Out of scope

- The GitHub release workflow (PGM-372).

## Size

S: an entitlements file, a signing switch in the config, one script.
