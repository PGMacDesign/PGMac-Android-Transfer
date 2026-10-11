# PGMac Android Transfer: Design

A local web app for moving files between a Mac and an Android device over WiFi, driven from Chrome or Firefox.

## Goals (v1)

1. Runs locally (`npm start`), opens the default browser, binds to `127.0.0.1` only.
2. Connects to an Android device over ADB Wireless Debugging. No companion app on the device.
3. Left pane: Android file browser (starts at `/sdcard`).
4. Right pane: Mac file browser (starts at `~`, can browse anywhere readable).
5. Drag and drop between panes in both directions, including multi-select and folders.
6. Parallel transfers through a bounded queue.
7. Session stays up (with auto-reconnect) until the user clicks **End Session**.
8. **Start Session** discovers and connects the device, pairing it first if needed.

## Non-goals (v1)

- Dragging files from Finder into the page, or from the page out to Finder (planned for v2).
- Copy/move within one pane, thumbnails/previews, search.
- Access to app-private storage (`/data/data`) on unrooted devices.
- A companion Android app.

## Transport

ADB over WiFi (Android 11+ Wireless Debugging). The backend shells out to the `adb` CLI via `child_process` (no JS ADB library) because pairing and mDNS discovery live only in the CLI.

`adb` resolution order: `ADB_PATH` env, `PATH`, `$ANDROID_HOME/platform-tools`, `~/Library/Android/sdk/platform-tools`. If none resolve, the UI shows an install hint (`brew install android-platform-tools`).

## Session flow

**Start Session**

1. Run `adb mdns services` and `adb devices -l`.
2. Candidates: mDNS `_adb-tls-connect` services, plus already-attached devices (USB, emulator, prior `adb connect`).
3. If `DEFAULT_DEVICE_IP` is set and exactly one candidate matches it, connect automatically. Otherwise, if exactly one candidate exists, connect to it. Otherwise show a picker.
4. If `DEFAULT_DEVICE_IP` is set but no mDNS match exists, try `adb connect <ip>:5555` (legacy `adb tcpip` mode) before falling through.
5. If no candidates exist, open the pairing modal.

Wireless Debugging uses a random port that changes each time it is toggled, so the IP alone is not enough to connect; mDNS supplies the current port.

**Pairing** (one-time per device/host)

- **QR (default):** the server generates a service name `studio-<random>` and password, renders `WIFI:T:ADB;S:<name>;P:<password>;;` as a QR code, and polls `adb mdns services` for a `_adb-tls-pairing` service with that name. On a match it runs `adb pair <ip>:<port> <password>`, then connects via the matching `_adb-tls-connect` service.
- **Code (fallback):** user enters pairing `ip:port` and the 6-digit code; server runs `adb pair`, then discovers and connects.

**Keepalive**

- Health check every 3 s (`adb -s <serial> get-state`). Header status: connected / reconnecting / lost.
- On loss: reconnect with backoff for up to ~2 minutes, re-resolving the serial via mDNS (by IP or service name) since the port may change.
- Running transfers fail on disconnect and become retryable. No automatic resume.
- Queued (not yet started) transfers pause during reconnect, resume on reconnect, and fail if reconnect gives up.
- If reconnect gives up, the UI offers Reconnect or Start new session.

**End Session**

- Confirms if transfers are active, cancels the queue, runs `adb disconnect <serial>` (wireless only), clears the Android pane. The server keeps running.
- Closing the browser tab does not end the session; state lives on the server and the page resyncs on reload.
- The server exits on Ctrl+C or the Quit menu item.

**Device info** (Android pane header): model name, battery level + charging state (`dumpsys battery`, every 30 s), `/sdcard` free/total (`df`). Mac pane header: free/total disk space.

## File browsing

- Both panes: list, navigate (breadcrumbs + shortcuts sidebar), refresh, show-hidden toggle, sort by name/size/date with folders first, multi-select (click, Cmd-click, Shift-click).
- Android shortcuts: `/sdcard`, DCIM, Download, Documents, Pictures, Movies, Music.
- Mac shortcuts: Home, Desktop, Downloads, Documents.
- File ops on both panes: new folder, rename (F2 / double-click name), delete with confirmation.
  - Mac delete moves to Trash (recoverable).
  - Android delete is permanent `rm -r`; the confirm dialog says so.
- Android paths are passed to `adb shell` with strict single-quote escaping. All user-supplied paths are validated (no NUL bytes, absolute paths only).

## Transfers

- Drag selected items from one pane to the other, onto the current folder or onto a folder row.
- The browser sends only paths. The server runs `adb push` / `adb pull`; file bytes never pass through the browser.
- Each dragged top-level item is one job (a folder is one job).
- **Conflicts:** before enqueuing, the server checks which destination names already exist. If any do, the UI asks once per batch: Replace / Keep both / Skip, with "apply to all in this batch". Keep both renames to `name (1).ext`, `name (2).ext`, etc.
- **Concurrency:** default 3 (`MAX_CONCURRENT_TRANSFERS`), adjustable at runtime in settings.
- **Progress:** total size measured up front; destination size polled about every 500 ms. Shows bytes, MB/s, ETA.
- **Atomic writes:** each transfer writes to `.<name>.pgmac-partial` in the destination folder and is renamed to its final name only on success, so a failed or cancelled Replace never destroys the original.
- **Cancel:** kills the adb process and removes the partial file.
- **Failure:** job marked failed with the error; manual retry button. No automatic retry.
- Live updates over a WebSocket. The destination pane refreshes when a job finishes.

## Stack

- Backend: Node 22+, TypeScript (strict), Fastify, `ws`.
- Frontend: React + Vite + TypeScript, plain CSS variables, light/dark from system preference.
- `qrcode` for pairing QR.
- Tests: Vitest unit tests for parsers, naming, escaping, queue; an integration test against an emulator (local only).
- CI: GitHub Actions running typecheck, lint, unit tests, build.

## Configuration (`.env`, gitignored; see `.env.example`)

| Var                        | Default | Purpose                              |
| -------------------------- | ------- | ------------------------------------ |
| `PORT`                     | `4848`  | HTTP port                            |
| `DEFAULT_DEVICE_IP`        | unset   | Preferred device IP for auto-connect |
| `MAX_CONCURRENT_TRANSFERS` | `3`     | Queue concurrency                    |
| `ADB_PATH`                 | unset   | Explicit adb binary                  |
| `OPEN_BROWSER`             | `true`  | Open browser on start                |
| `STATE_DIR`                | unset   | Folder for `state.json`              |

- Settings are kept in `state.json`: `~/.config/pgmac-transfer/state.json`, or `<STATE_DIR>/state.json` when `STATE_DIR` is set. When `<STATE_DIR>/state.json` doesn't exist yet and the default file does, the default file is copied in once at startup (it is left in place), so the downloads folder and last device carry over.
- The default device IP and the adb path can also be saved through `POST /api/settings`, because the desktop app can't edit its bundle or `.env`. For each of them the effective value is the saved setting, then the environment variable (`DEFAULT_DEVICE_IP`, `ADB_PATH`), then the default (no preferred device; adb found on `PATH`, `$ANDROID_HOME` or the SDK location). Saving an empty string clears the saved value. The rule lives in `effectiveSettings` in `src/server/config.ts`.
- A saved adb path must be absolute and executable, and its `adb version` must succeed within 5 seconds; otherwise the request fails and nothing changes. An accepted change re-resolves adb and broadcasts it as an `adb` message, and the next Start Session uses the current default device IP, so neither needs a restart.
- `PORT` and `OPEN_BROWSER` come from the environment only.

## v2: Finder and network volumes

### Finder drops into either pane

- Dropping files or folders from Finder onto a pane (or a folder row) works in Chrome and Firefox. Browsers never expose the dropped files' paths, so the bytes go through the page: the browser uploads them to the local server, which stages them under a private cache folder (`~/Library/Caches/pgmac-transfer/staging` on macOS, `$XDG_CACHE_HOME/pgmac-transfer/staging` on Linux) and then runs a normal job: `adb push` for the Android pane, a killable `cp -R` for the Mac pane (staging and the destination may be on different volumes, so a rename isn't enough).
- Planning, conflicts (Replace / Keep both / Skip), partial files, progress, cancel and the concurrency limit are the same as pane-to-pane jobs. Each dropped top-level item is one job.
- A Finder job starts in an `uploading` phase that holds no concurrency slot. The browser walks dropped folders (`webkitGetAsEntry`, reading each directory until an empty batch), uploads files one request at a time per job, creates empty folders, then marks the job complete; the server measures the staged copy and queues it. Upload progress is counted by the server as bytes reach disk. The row labels this phase "Reading from Finder" (adding "sends when the phone is back" while the session reconnects, since the read needs no device), and the transfer summary counts it separately and leaves its bytes out of the transferred total: the transfer that follows counts again from zero, so including them would show bytes climbing toward an unplugged phone and then dropping back.
- Left out: `.DS_Store` and `._*` AppleDouble files. Symlinks arrive as the files or folders they point to (browser limit).
- Before creating jobs the server checks free space where it stages; a shortfall (or `ENOSPC` mid-upload) fails with "Not enough space on this Mac to stage these files."
- If the page closes or reloads mid-upload, the job fails and can't be retried (only the page had the files). Once staged, a failed job retries from the staged copy.
- Leftover staging is cleared at startup only after the server owns its port, so starting a second copy of the app can't delete the running one's uploads.
- Drops onto the Mac pane work with or without a device session.
- Staged files are deleted when their job is done, cancelled, or cleared, at End Session, and at startup.

#### Real-path drops in the desktop app

- The desktop app's preload exposes `pgmacDesktop.getPathForFile(file)` (Electron's `webUtils.getPathForFile`, nothing else from `webUtils`). Inside the drop event the page reads each dropped top-level item's real path (a dropped folder is one path; its entries aren't walked) and plans `{ from: 'paths', destSide, destDir, srcPaths }`.
- These jobs run like a drag from the Mac pane: one job per path, a push onto the phone pane, or a copy (`cp -R` into the partial name, then rename) onto the Mac pane, which needs no session. Nothing is uploaded or staged, there is no "Reading from Finder" phase and no free-space check for staging. Conflicts, partial files, progress, cancel, retry (which reads the source path again) and the concurrency limit are the pane rules. The jobs' origin is `pane`.
- A copy job's source and destination are both Mac paths, so it waits for whichever of them is on an offline network volume, and follows either one when its share is remounted elsewhere.
- `.DS_Store` and `._*` files are copied like any other file, as in a Mac pane drag; only uploads leave them out.
- A copy into the dropped folder itself (or one of its subfolders) is refused at planning.
- If any dropped item has no path (`getPathForFile` returns `""`, as for items dragged from some apps), the whole drop uses the upload path above. Browser mode has no bridge and always uploads.
- Drag-out: a Mac-pane drag in the app calls `pgmacDesktop.startDrag(paths)`, a one-way `drag-out` message whose synchronous main handler (app window only, absolute paths without NUL, at most 1,000, no filesystem call) starts a native file drag instead of the in-app one, so no in-app drag state is set; a drop back into the window is a real-path drop, ignored on the Mac pane when every item already sits in its folder.

### Show in Finder / Show in Files

- Android items (labelled "Download & Show in Finder", since nothing is shown until the copy finishes): the selection is copied through the normal queue (with conflict handling) into the downloads folder, then the file manager opens with the copied items selected once every job in that batch has finished.
- Mac items: revealed in place, no copy.
- Downloads folder: a setting, kept in `state.json`. Default on macOS `~/Downloads`; on Linux `xdg-user-dir DOWNLOAD`, then `~/Downloads`, then home.
- Reveal: macOS uses `NSWorkspace.activateFileViewerSelectingURLs` through `osascript -l JavaScript` (selects several items, needs no Automation permission). Linux calls `org.freedesktop.FileManager1.ShowItems` over D-Bus and falls back to `xdg-open` on the folder.
- Firefox can't drag files out of a page to Finder, so this replaces a drag-out.

### Network volumes (NAS)

- A dropped SMB/NFS mount often hangs file calls instead of failing them. Mac file operations on network mounts (from the mount table: smbfs, afpfs, nfs, webdav, cifs, sshfs and similar) get timeouts, and the libuv threadpool is enlarged (`threadpool.ts`, the entry point's first import, which runs before the pool's first use) so a few hung calls can't starve the app.
- The first timeout or network error (`EIO`, `ENOTCONN`, `ESTALE`, `ETIMEDOUT`, `EHOSTDOWN`, ...) on a volume marks it offline. Calls on an offline volume fail immediately. A probe in a separate, killable process runs every 5 s until the volume answers again.
- The Mac pane shows "<name> is offline, waiting for it to reconnect" and refreshes when it returns.
- Jobs with a Mac-side path (the source of a push, the destination of a pull, either end of a copy) on an offline volume pause ("Waiting for <name>") instead of failing; a running attempt is torn down first. When the volume returns they restart from the beginning of the item. After 30 minutes offline they fail (retryable).
- A volume is identified by its mount source (e.g. `//nas.local/Share`, user part ignored). If it comes back at a different mount point (`/Volumes/Share-1`), paused jobs and open panes follow it.
- If a share drops in the middle of a folder Replace, the original (parked under its hidden backup name) is moved back when the share returns, before paused transfers restart.
- Retrying a job whose share is still offline is refused; it can't be left waiting with no deadline.
- A share that disappears from the mount table counts as offline, so its paths never start looking local.
- Volumes without a Trash: if moving to the Trash fails on a non-root mount, the UI offers "Delete permanently" behind a confirm.

## Invariants

### Transfer job lifecycle

1. **Terminal exactly once**: every job moves `queued → running → (done | failed | cancelled)` (or `queued → cancelled`) and reaches exactly one terminal state, never leaving it except via an explicit retry that creates a new attempt.
   - Guarded by: a single `finish(job, outcome)` owner that no-ops if the job is already terminal; the adb process exit, cancel, and disconnect handlers all route through it.
   - Test: cancel a job at the same tick its adb process exits successfully; assert one terminal event is emitted and the state matches whichever arrived first.
2. **Concurrency slot released exactly once**: the number of running jobs never exceeds the configured limit, and every exit path (success, failure, cancel, disconnect, End Session) frees its slot exactly once.
   - Guarded by: running jobs tracked as a set keyed by job id (membership, not a counter); release is a set delete.
   - Test: start N jobs at limit 2, cancel one, kill the device on another, finish the third; assert the running set never exceeds 2 and empties to zero.
3. **Queue always drains (liveness)**: while the session is connected, a queued job starts whenever a slot is free; every enqueued job eventually reaches a terminal state.
   - Guarded by: `pump()` is called after every enqueue, every slot release, every reconnect, and every concurrency-limit change.
   - Test: enqueue 5 jobs at limit 1 with one failing; assert all 5 reach terminal states without further user action.
4. **Originals never destroyed by a failed transfer**: a transfer writes to `.<name>.pgmac-partial` in the destination folder and renames over the final name only after the adb process exits 0; cancel and failure delete only the partial path.
   - Guarded by: the job records its partial path at start; cleanup operates solely on that recorded path.
   - Test: Replace a file, cancel mid-transfer; assert the original destination file is byte-identical and no partial remains.
5. **Progress is monotonic and bounded**: reported transferred bytes never decrease within an attempt and never exceed the measured total (clamped), and a job reports 100% only when done.
   - Guarded by: progress written through `max(prev, min(sample, total))`; 100% set only by `finish(done)`.
   - Test: feed out-of-order size samples, including one larger than total; assert the reported series is non-decreasing and below 100% until done.
6. **Late samples are dropped**: a progress poll that resolves after its job is terminal never mutates the job or emits an event.
   - Guarded by: each poll checks the job's state and attempt id before applying.
   - Test: cancel a job while a size poll is in flight; assert no progress event follows the cancelled event.

### Destination naming

1. **Keep-both names are unique across concurrent batches**: two jobs never resolve to the same final destination path, even when batches targeting the same folder are planned concurrently.
   - Guarded by: a server-side reserved-name set per destination folder, consulted alongside the real listing when generating `name (n).ext`, released when the job reaches a terminal state.
   - Test: plan two batches that both copy `a.txt` into the same folder with Keep both before either starts; assert they get distinct names.
2. **Busy paths are protected**: rename and delete refuse any path that is the source, destination, or ancestor of either for a non-terminal job.
   - Guarded by: file-op handlers check the active job set before acting.
   - Test: start a pull of `/sdcard/DCIM`, request delete of `/sdcard/DCIM`; assert a conflict error and the transfer continues.

### Device session

1. **One session at a time**: at most one device session is active; Start Session while one is active is rejected until End Session completes.
   - Guarded by: a single session state field owned by the session manager (`idle | connecting | connected | reconnecting | lost | ending`).
   - Test: fire two Start Session requests concurrently; assert one succeeds and the other is rejected.
2. **Stale session events are dropped**: health-check, reconnect, battery, and storage results from a previous session generation never mutate the current session.
   - Guarded by: a session generation counter incremented on every start and end; async results compare their stamped generation before applying.
   - Test: End Session while a reconnect attempt is in flight, then start a new session; assert the old attempt's result does not change the new session's state.
3. **Disconnect pauses, never orphans**: when the device drops, running jobs fail (retryable), queued jobs pause, and no adb transfer process from that session keeps running.
   - Guarded by: the session manager calls `queue.onDeviceLost()` which kills running processes through `finish(failed)` and sets the queue to paused.
   - Test: kill the emulator connection with 2 running and 3 queued jobs; assert 2 failed, 3 still queued, zero live adb child processes.
4. **Reconnect always resolves (liveness)**: a `reconnecting` session reaches `connected` or `lost` within the reconnect deadline (~2 minutes); on `connected` paused jobs resume, on `lost` they fail.
   - Guarded by: a deadline timer started on entering `reconnecting`, cleared on exit.
   - Test: drop the device and never bring it back; assert `lost` within the deadline and all queued jobs failed.
5. **End Session leaves nothing running**: after End Session completes, no job is non-terminal, no adb child process from the session is alive, and all session timers are cleared.
   - Guarded by: End Session sets state `ending`, cancels all jobs through `finish(cancelled)`, awaits child exits with a timeout, clears timers, then disconnects.
   - Test: End Session with active transfers; assert zero live children, zero pending timers, all jobs cancelled.

### Pairing

1. **Pairing waits are bounded**: a QR pairing attempt stops polling mDNS after its timeout (default 2 minutes) or when the modal closes, and never pairs with a service whose name differs from the one it generated.
   - Guarded by: a per-attempt deadline and an exact service-name match.
   - Test: start QR pairing with no device; assert polling stops at the deadline and the attempt reports a timeout.
2. **One pairing attempt at a time**: starting a new pairing attempt cancels the previous one, and a late result from the cancelled attempt is ignored.
   - Guarded by: an attempt id; poll results check it before acting.
   - Test: start attempt A, start attempt B, let A's poll resolve; assert A does not pair or emit success.

### Client sync

1. **Reload restores state**: a client that connects (or reconnects) receives a full snapshot of session and job state before any incremental event, so its view converges to the server state.
   - Guarded by: on WebSocket open the server sends `snapshot` first; events carry a monotonically increasing sequence number and the client discards events older than its snapshot.
   - Test: start transfers, reload the page mid-transfer; assert the job list and progress match the server and keep updating.
2. **The server is the single writer**: clients never mutate session or job state locally except as a reflection of server events; UI actions are requests to the server.
   - Guarded by: the client store is updated only by the WebSocket reducer and HTTP responses.
   - Test: two tabs open; cancel in tab A; assert tab B shows cancelled without a refresh.

### Finder uploads and staging

These apply to browser-mode drops. Real-path drops in the desktop app never create anything under the staging root.

1. **Uploading holds no slot**: a job in `uploading` never counts toward the concurrency limit and becomes `queued` only after the browser marks it complete and the staged copy is measured.
   - Guarded by: `canStart(entry)` returns false for `uploading`; only `completeUpload` moves it to `queued`.
   - Test: drop 5 items at limit 1 and leave them uploading; assert none is running and pane jobs still start.
2. **Abandoned uploads always end (liveness)**: an `uploading` job whose request aborts, whose open request has sent no bytes for 60 s, or that waited while no upload from its page moved for 60 s, reaches `failed` (not retryable). The page uploads 3 items at a time across all its drops (browsers allow 6 connections per host), so an item waiting its turn, even behind another drop, is not abandoned while any upload from the same page load is moving (a reloaded page's leftovers are), and a long request that keeps sending is never cut off.
   - Guarded by: request `close` before completion calls `failUpload`; a per-job idle timer that runs for the whole upload phase, fails (and aborts) a job whose own request stopped sending, and re-arms a waiting job while any uploading job from the same page (`pageId` on commit) has recent activity; one page-wide upload limiter, whose requests are aborted once their job leaves `uploading`.
   - Test: start an upload and abort the request; assert failed. Send nothing; advance 60 s; assert failed. Hold a request open with no bytes; assert it and its waiting sibling fail. Keep a sibling, or another drop, sending for minutes; assert the waiting job survives, then fails 60 s after it stops. Three concurrent drops never exceed 3 requests.
3. **Cancel stops the bytes**: after a Finder job is cancelled, no further upload bytes are written for it.
   - Guarded by: each upload request registers an AbortController on the job; cancel aborts it, and new requests for a non-`uploading` job are refused.
   - Test: cancel mid-request; assert the stream is destroyed and a following request gets 409.
4. **Staging stays inside its folder**: every upload write resolves under `staging/<jobId>/`.
   - Guarded by: each relative path segment passes `validateName`, and the resolved path is prefix-checked.
   - Test: upload with `../x`, `/abs`, `a//b`, and a NUL byte; assert 400 and nothing written outside staging.
5. **Staging is released exactly when it can't be needed**: a job's staging is deleted on `done`, `cancelled`, non-retryable `failed`, clear, End Session and startup, and kept for a retryable `failed`.
   - Guarded by: one `releaseStaging(entry)` called from those paths.
   - Test: fail a staged push, retry it; assert it pushes from staging. Clear it; assert staging is gone.

### Job eligibility

1. **One predicate decides who may start**: a device job (push/pull) starts only while the device is connected; a copy job starts with or without a session; no job starts while a volume holding one of its Mac-side paths (both ends of a copy) is offline; an uploading job never starts.
   - Guarded by: `canStart(entry)`, used by `pump()` and nowhere else.
   - Test: one case per clause, including a copy job draining while the session is `reconnecting`.
2. **Device events leave copy jobs alone**: `onDeviceLost` and `onSessionLost` touch only push/pull jobs, and not a pull whose bytes are already on the Mac (adb exited 0), and so does starting a new session from `lost` (Start Session, pairing, Start new session). Only an explicit End Session cancels everything.
   - Test: drop the device with a running copy job; assert it finishes. Start over from `lost`; assert copy and Mac-bound upload jobs (including a retryable failed one) are untouched and device jobs are cancelled.

### Volume health

1. **Offline fails fast**: a guarded call on an offline volume rejects without touching the filesystem.
   - Guarded by: the offline check runs before the call is issued.
   - Test: mark a volume offline with a fake fs whose calls never resolve; assert rejection within one tick.
2. **Paused jobs always resolve (liveness)**: a job waiting for a volume restarts when the volume returns or fails once the volume has been offline 30 minutes; the deadline belongs to the volume, not the job.
   - Guarded by: the monitor's per-volume deadline and online/give-up events, both routed through the queue.
   - Test: pause two jobs a minute apart; advance to 30 min after the drop; assert both failed at once.
3. **No unbounded waits on a dead network volume**: a wait on a child process or file call that touches a network volume ends within a bounded time once the volume stops answering, and the job releases its slot. A slow call on a volume that still answers its probe may keep running. Each job has at most one progress sample in flight, so a dying share can't pile hung calls onto the thread pool.
   - Guarded by: capped exit waits, guarded file calls (call deadline, then a probe), and a single-flight progress sampler.
   - Test: a runner whose child never exits after kill; assert the slot frees after the cap. A destination whose calls hang; assert one sample in flight.
4. **A paused job never runs a stale attempt**: an attempt that ends after its job was paused or remapped can't finish or fail the job.
   - Guarded by: the attempt id check in `finish`, also applied to the async pause decision.
   - Test: pause a running job, then resolve its old attempt; assert the job stays queued.
5. **Remount follows the source**: if a volume's source reappears at a new mount point, waiting jobs' paths (and a downloads folder on it) are rewritten to it before they restart. The old mount point is retired: whether it lingers in the table or leaves it, it never marks the share offline (this includes a share reconnected while the app wasn't watching, or before it started: an entry that leaves the table while its share is listed elsewhere, or that hangs while another mount of its share answers, is the stale one), and calls on paths under it fail at once with "moved" rather than hanging or writing to the local disk. An automounted share that left the table while idle is touched by the probe, which mounts it again.
   - Test: drop `/Volumes/A`, bring back the same source at `/Volumes/A-1`; assert the restarted job uses `/Volumes/A-1`. Then drop the stale `/Volumes/A` from the table, or call a path under it; assert `/Volumes/A-1` stays online. Idle-unmount an automounted share; assert it comes back.
6. **Originals go back before anything restarts**: an original moved aside by a folder Replace is recorded before that rename starts and stays recorded until the new copy is in or the original is back; no job on a returning share starts until that share's restore has finished.
   - Guarded by: the parked record (rewritten by remount moves, skipped while its finalize is still running), serialized restores, and a queue hold placed on `moved`/`online` and released only after the restore.
   - Test: a parking rename that lands with its reply lost; a share that returns at a new mount point; a restore that runs while another Replace is mid-swap; a held share's job stays waiting until release.

### Reveal

1. **Once per batch, after the batch**: a Show in Finder batch reveals at most once, only after every job in it is terminal, and only the `done` items; a later retry never reveals again.
   - Guarded by: a per-batch pending set removed when it empties.
   - Test: three jobs, one fails; assert one reveal of two paths; retry the failed one; assert no second reveal.
