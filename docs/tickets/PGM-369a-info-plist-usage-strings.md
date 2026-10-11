---
id: PGM-369a
title: Declare Local Network, Bonjour and folder usage in the app's Info.plist
milestone: W2
deps: []
size: S
---

## Goal

The packaged app declares that it uses the local network, which Bonjour service types it browses, and why it reads the user's folders, so macOS can ask the user for those permissions instead of silently denying them. Without this, QR pairing in the packaged app never finds the phone.

## Context

- Observed on a Dock-launched build: the phone advertised the app's `_adb-tls-pairing._tcp` service and macOS Bonjour saw it from Terminal, but inside the app both discovery paths saw nothing, so QR pairing timed out. Both paths are the adb daemon's own mDNS (`adb mdns services`; the daemon is started by the app, so macOS attributes its traffic to the app) and the `/usr/bin/dns-sd` fallback in `src/server/adb/bonjour.ts` (also spawned by the app). An app that doesn't declare `NSLocalNetworkUsageDescription` and its `NSBonjourServices` types can't get Local Network access.
- Packaging is configured in `electron-builder.config.ts`; extra Info.plist keys go in `mac.extendInfo`. The config has a Vitest test that loads it and asserts its rules.

## Acceptance criteria

1. `mac.extendInfo` sets exactly these keys and values:
   - `NSLocalNetworkUsageDescription`: "PGMac Android Transfer finds and connects to your phone over your WiFi network."
   - `NSBonjourServices`: `["_adb-tls-connect._tcp", "_adb-tls-pairing._tcp"]`
   - `NSDesktopFolderUsageDescription`: "PGMac Android Transfer lets you browse your Desktop and copy files to and from your phone."
   - `NSDocumentsFolderUsageDescription`: "PGMac Android Transfer lets you browse your Documents folder and copy files to and from your phone."
   - `NSDownloadsFolderUsageDescription`: "PGMac Android Transfer lets you browse your Downloads folder and copy files to and from your phone."
   - `NSNetworkVolumesUsageDescription`: "PGMac Android Transfer lets you browse network drives and copy files to and from your phone."
   - `NSRemovableVolumesUsageDescription`: "PGMac Android Transfer lets you browse external drives and copy files to and from your phone."
2. Nothing else in the packaging config changes. Don't run `npm run make`.
3. `docs/DESIGN.md` gains a short note under Transport: the packaged app needs Local Network permission for discovery and pairing, because macOS attributes the adb daemon and `dns-sd` it starts to the app.

## Test plan

- Extend the packaging config test: each key above is present with the exact value, and `NSBonjourServices` lists exactly the two service types.

## Owner manual check

- Build with `npm run make`, install, and launch from the Dock. Start Session or QR pairing shows a Local Network prompt naming PGMac Android Transfer with the string above; after Allow, QR pairing finds the phone.

## Sanctioned edits

- `electron-builder.config.ts`, its test, `docs/DESIGN.md`.

## Out of scope

- Entitlements and the hardened runtime (they come with signing).
- An in-app message when a permission is denied (a later ticket).

## Size

S: configuration keys and one test.
