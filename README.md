# PGMac Android Transfer

Move files between your Mac and an Android phone over WiFi, from a two-pane file manager in your browser. The phone is on the left, your Mac is on the right, and you drag files between them.

It uses Android's built-in **Wireless debugging** (ADB), so nothing gets installed on the phone.

## Features

- Browse the phone's shared storage (`/sdcard`) and your Mac side by side
- Drag and drop files and folders in both directions, with multi-select
- Drop files and folders from Finder onto either pane
- **Download & Show in Finder** (**Download & Show in Files** on Linux) for phone items: copies them to your downloads folder and opens it with them selected
- Parallel transfers (1 to 6 at once) with progress, speed, ETA, cancel and retry
- Conflict handling per batch: Replace, Keep both (`name (1).ext`) or Skip
- New folder, rename and delete on both sides (Mac deletes go to the Trash)
- QR code or pairing-code setup for new phones, and automatic reconnect if the connection drops
- Battery level and free storage for the phone, free disk space for the Mac
- Light and dark themes, compact or comfortable rows, full keyboard support

## Requirements

- macOS (Linux should work but is untested)
- [Node.js](https://nodejs.org) 22.18 or newer
- Android platform tools (`adb`): `brew install android-platform-tools`
- An Android 11+ phone on the same WiFi network as the Mac, with **Developer options** enabled

## Getting started

```sh
git clone https://github.com/PGMacDesign/PGMac-Android-Transfer.git
cd PGMac-Android-Transfer
npm install
npm start
```

`npm start` builds the UI, starts the server on `http://127.0.0.1:4848` and opens it in your default browser. Stop it with Ctrl+C or **Quit server** in the menu.

The page opens on a link ending in `#token=...`, a secret generated at each start that keeps other programs and other accounts on your Mac out of the API. With `OPEN_BROWSER=0`, open the link printed in the terminal.

### Desktop app (in development)

`npm run app` builds the UI and opens it in its own window instead of a browser tab. It runs the same server on a free port of its own, so it can run alongside `npm start`, and stops the server when you quit.

Quitting (Cmd+Q, or Quit in the menu) with transfers running or queued asks first. Confirming cancels them, removes their partial files and stops every transfer process before the app exits; with nothing running it quits at once. The adb server daemon is left running, since other tools may share it: the app never runs `adb kill-server`.

In the app, you can also drag Mac-pane items out of the window onto Finder, the Desktop or another app, and they arrive as the real files. Phone items still use **Download & Show in Finder**.

### Build the desktop app

```sh
npm run make
```

This builds the UI and packages it, with the server and its production dependencies, into a universal (Apple silicon and Intel) app. The DMG lands in `release/`, named `PGMac Android Transfer-<version>-universal.dmg`. Open it and drag the app to Applications. It needs macOS to build.

The app is unsigned for now, so macOS won't open it with a double-click the first time. Right-click it in Applications and choose **Open**, then **Open** again in the dialog (on recent macOS versions you may instead need **Open Anyway** under **System Settings > Privacy & Security**). Later launches open normally.

### Connecting a phone

1. On the phone, open **Settings > Developer options > Wireless debugging** and turn it on.
2. Click **Start Session**.
   - A phone that's already paired with this Mac connects automatically, or you pick it from a list if there are several.
   - The first time, a pairing window opens. On the phone, tap **Pair device with QR code** and scan the code on screen with the scanner it opens (the Camera app treats it as a WiFi network), or use **Pair device with pairing code** and type the IP address, port and code into the **Pairing code** tab.
3. Browse, drag and drop. Click **End Session** when you're done.

The session stays up until you end it. If the phone drops off the network, the app reconnects on its own for up to two minutes; transfers that were running at the time fail and can be retried, and queued ones wait for the phone.

### Finder

- **Drop from Finder:** drag files or folders from Finder onto either pane, or onto a folder in it. The page uploads them to the local server, which keeps a temporary copy in its cache folder and then copies it into place with the same conflict handling, progress and cancel as any other transfer. `.DS_Store` and `._*` files are left out. Keep the tab open until each item shows **Queued** or later: closing or reloading it mid-upload fails those items, and you'll need to drop them again. Drops onto the Mac pane work without a phone connected.
- **Copying out to Finder:** browsers can't drag files out of a page into Finder (Firefox not at all, Chrome only one file at a time), so use **Download & Show in Finder** instead. Select items on the phone and choose it from the right-click menu or the toolbar. They're copied to your downloads folder, and Finder opens with them selected once the copy finishes. On the Mac pane, **Show in Finder** reveals the items where they are. Change the folder under **Downloads folder…** in the menu.

### Network drives (NAS)

- **When a share drops:** if a mounted network share (SMB, NFS and similar) stops answering, the app marks it offline instead of freezing. The Mac pane shows "<share> is offline, waiting for it to reconnect" and refreshes on its own when the share comes back. Other folders keep working.
- **Transfers wait:** transfers to or from that share show **Waiting for <share>**. When the share returns they start again from the beginning of the item. If it stays away for 30 minutes they fail, and you can retry them.
- **Remounts:** if macOS remounts the share at a new path (for example `/Volumes/Share-1`), open panes and waiting transfers follow it.
- **No Trash:** many shares have no Trash. If an item can't be moved to the Trash there, the app asks whether to delete it permanently.

Android turns Wireless debugging off when the phone switches WiFi networks. If Start Session can't find the phone, check that the toggle is still on.

## Settings

**Settings…** in the menu sets the default device IP and the adb path. Leave a field empty to fall back to `DEFAULT_DEVICE_IP` or `ADB_PATH` from `.env`, and otherwise to choosing a device each time and finding adb automatically. In the desktop app, **Locate adb…** picks the file in a Finder dialog. Changes apply at once and are kept across restarts.

Browser mode keeps its settings where it always has; the desktop app keeps its own in its folder under `~/Library/Application Support`, starting from a copy of browser mode's the first time it runs.

## Configuration

Copy `.env.example` to `.env` and edit as needed. Every value is optional.

| Variable                   | Default | Purpose                                                                                             |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `PORT`                     | `4848`  | Port for the local UI (always bound to `127.0.0.1`)                                                 |
| `DEFAULT_DEVICE_IP`        | unset   | Your phone's IP. If it's found on the network, Start Session connects to it without asking          |
| `MAX_CONCURRENT_TRANSFERS` | `3`     | Starting number of parallel transfers (1 to 6; also adjustable in the UI)                           |
| `ADB_PATH`                 | unset   | Full path to `adb`. Otherwise `PATH`, `$ANDROID_HOME` and the default Android SDK location are used |
| `OPEN_BROWSER`             | `true`  | Open the browser on start                                                                           |

Giving the phone a reserved IP in your router makes `DEFAULT_DEVICE_IP` reliable.

## How it works

A small Node server runs `adb` on your behalf and serves the UI. The browser only sends paths; file contents go straight from `adb push`/`adb pull` to disk and never pass through the browser, so file size isn't limited by the browser.

- Each transfer writes to a hidden `.name.pgmac-partial` next to the destination and is renamed into place only when it finishes, so a cancelled or failed transfer never leaves a half-written file or destroys the file it was replacing.
- The server only answers requests addressed to `127.0.0.1`/`localhost` on its own port and refuses cross-site requests, so other web pages can't use it to read or change your files.
- Android has no Trash over ADB, so deleting on the phone is permanent; the app asks first.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design and the invariants the tests check.

## Development

```sh
npm run dev          # API server with --watch plus the Vite dev server on :5173
npm test             # unit tests
npm run test:emulator  # end-to-end against the one attached device or emulator
npm run typecheck
npm run lint
npm run format
```

`test:emulator` copies test files to `/sdcard/Download/pgmac-it-*` on the attached device and removes them afterwards.

## Troubleshooting

- **"Android platform tools are required"**: install them with `brew install android-platform-tools`, or set the adb path under **Settings…** (or `ADB_PATH`), then click **Check again**.
- **Start Session finds nothing**: confirm Wireless debugging is on and the phone and Mac are on the same network. Some routers block mDNS between devices; use **Pair a new device > Pairing code** in that case.
- **"Port 4848 is already in use"**: the app is probably already running. Open `http://127.0.0.1:4848`, or set a different `PORT`.
- **Can't see `Android/data`**: Android 11+ blocks other apps' private folders over ADB unless the phone is rooted.

## Roadmap

- Thumbnails, previews and search

## License

[MIT](LICENSE)
