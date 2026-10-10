# Design Brief: PGMac Android Transfer

## What it is

A local web app (runs on the user's Mac, opened in Chrome or Firefox at `http://127.0.0.1:4848`) for moving files between a Mac and an Android phone over WiFi. Think of a two-pane file manager in the spirit of classic FTP clients (Transmit, Cyberduck, FileZilla), but modern and calm. The left pane shows the phone, the right pane shows the Mac, and you drag files between them.

The connection uses Android's built-in Wireless Debugging, so there is no app on the phone. The user is technical (developer-level), uses it in short bursts to move photos, videos, downloads and documents, and wants it fast, legible and unfussy.

## What I want from you

A visual design and clickable prototype of the screens and states listed below, desktop-first, in both light and dark themes. The goal is to see what it will look like and tweak it before it gets built. Please keep it buildable as a single-page React app with plain CSS (CSS custom properties for tokens, no heavy component library).

## Layout

```
+-----------------------------------------------------------------------------------+
| App bar: name/logo | session status pill | [Start Session] / [End Session] | menu |
+----------------------------------------+------------------------------------------+
| ANDROID PANE                           | MAC PANE                                 |
| Header: device name, battery %,        | Header: "This Mac", free disk space      |
|   charging icon, storage free/total    |                                          |
| Toolbar: back/up, breadcrumbs,         | Toolbar: back/up, breadcrumbs,           |
|   new folder, refresh, show hidden     |   new folder, refresh, show hidden       |
| +----------+-------------------------+ | +----------+---------------------------+ |
| | Shortcut | File list               | | | Shortcut | File list                 | |
| | sidebar  | name | size | modified  | | | sidebar  | name | size | modified    | |
| +----------+-------------------------+ | +----------+---------------------------+ |
+----------------------------------------+------------------------------------------+
| Transfer panel (collapsible): overall progress, list of jobs, clear completed     |
+-----------------------------------------------------------------------------------+
```

- The two panes split the width 50/50 and should feel symmetrical. The Android pane should be identifiable at a glance (subtle accent color or device glyph), without the two panes looking like different apps.
- Sidebar shortcuts:
  - Android: Internal storage (`/sdcard`), DCIM, Download, Documents, Pictures, Movies, Music.
  - Mac: Home, Desktop, Downloads, Documents.
- File list: folders first, then files. Columns are name (with a file-type icon), size and modified date. Clicking a column header sorts by it. Double-click opens a folder. Supports single-click, Cmd-click and Shift-click selection.
- Minimum comfortable width is about 1100px. Below that, the panes can stack or the sidebars can collapse; that's your call.

## Screens and states to design

### 1. No session (first launch)

- Both panes are visible. The Mac pane is fully usable. The Android pane shows an empty state with a short explanation and a prominent **Start Session** button.
- Status pill: "No device".

### 2. Start Session: searching

- Short-lived. A modal or inline state: "Looking for devices on your network...".

### 3. Device picker

- Shown when more than one device is found. Each row shows the device model, its IP:port or "USB", the connection type (WiFi / USB / Emulator), and a Connect button.
- If a preferred device IP is configured and found, it connects automatically and this step is skipped.

### 4. Pair a new device (modal)

- Shown when no paired device is found. Two tabs:
  - **QR code (default):** a large QR code, plus three short steps: "On your phone: Settings > Developer options > Wireless debugging > Pair device with QR code, then scan." A waiting indicator, and a timeout state after 2 minutes with a "Try again" button.
  - **Pairing code:** fields for IP address, port and the 6-digit code shown on the phone, plus a Pair button.
- Success state: "Paired with Pixel 8 Pro. Connecting..."
- Error states: wrong code, device not found, timeout.

### 5. Connected (the main view)

- Android pane header: device model ("Pixel 8 Pro"), battery ("78%" with a charging bolt when plugged in; use a warning color under 15%), storage ("41.2 GB free of 128 GB", ideally with a thin usage bar).
- Mac pane header: "This Mac", "212 GB free of 1 TB".
- Status pill: green "Connected", with the device IP on hover.
- The app bar button becomes **End Session**.

### 6. Dragging

- Dragging a selection from one pane shows a drag ghost with a count ("3 items").
- The other pane highlights as a drop target for its current folder. Hovering a folder row highlights that folder as a more specific target.
- Dropping onto the same pane it came from is not allowed and should look disabled.

### 7. Conflict dialog

- "4 of 12 items already exist in Download." Options: **Replace**, **Keep both** (renames to `name (1).ext`), **Skip**. A checkbox: "Apply to all conflicts in this batch". If the box is unchecked, it steps through the conflicts one at a time, showing the file name, with each size and modified date side by side.

### 8. Transfer panel

- Collapsed: one line with overall progress ("3 active, 5 queued, 1.2 GB of 4.8 GB") and an expand chevron.
- Expanded: one row per job with a direction indicator (phone to Mac / Mac to phone), the name (a folder shows its item count), a progress bar, transferred / total, speed (MB/s), ETA, and an action:
  - Queued: Cancel
  - Running: Cancel
  - Done: green check, row fades to muted
  - Failed: error text (for example "Device disconnected") and a **Retry** button
  - Cancelled: muted, with "Cancelled"
  - Paused (device reconnecting): "Waiting for device"
- A "Clear completed" action, and a small settings control for "Parallel transfers: 3" (range 1 to 6).

### 9. File operations

- **New folder:** an inline editable row at the top of the list.
- **Rename:** inline edit of the name (F2 or double-click the name).
- **Delete (Mac):** confirm dialog, "Move 3 items to Trash?"
- **Delete (Android):** a stronger confirm dialog: "Permanently delete 3 items from Pixel 8 Pro? This cannot be undone." Destructive styling.
- A right-click context menu with the same actions, plus a toolbar "show hidden files" toggle.
- Error toast example: "Can't delete DCIM while it is being transferred."

### 10. Connection trouble

- **Reconnecting:** the status pill turns amber ("Reconnecting..."), a slim banner appears above the Android pane, the Android pane dims but keeps its last listing, and queued jobs show "Waiting for device".
- **Lost:** red pill, banner "Lost connection to Pixel 8 Pro" with **Reconnect** and **Start new session** buttons.

### 11. End Session

- If transfers are active: confirm "End session? 3 transfers in progress will be cancelled."
- Afterwards the Android pane returns to the no-session empty state.

### 12. Setup error

- ADB not found: full-width message explaining that Android platform tools are required, with a copyable `brew install android-platform-tools` command and a "Check again" button.

## Sample data (for realism)

- Device: Pixel 8 Pro, Android 15, 192.168.1.42:37115 over WiFi, battery 78% charging, storage 41.2 GB free of 128 GB.
- Android `/sdcard/DCIM/Camera`: `PXL_20260914_183022.jpg` (4.1 MB), `PXL_20260914_183040.mp4` (312 MB), `PXL_20260915_090511.jpg` (3.8 MB), 40+ similar files.
- Android `/sdcard/Download`: `boarding-pass.pdf`, `invoice_2026-09.pdf`, `app-release.apk` (48 MB), `Screenshots/` folder.
- Mac `~/Downloads`: `Project Brief.pdf`, `holiday-photos/` (212 items), `ubuntu-24.04.iso` (5.7 GB), `notes.md`.
- Transfers in flight: `PXL_20260914_183040.mp4` phone to Mac, 61% at 22.4 MB/s; `holiday-photos/` Mac to phone, 212 items, 18%; `ubuntu-24.04.iso` queued; `app-release.apk` done; `invoice_2026-09.pdf` failed: "Device disconnected".

## Visual direction

- Calm, utilitarian and dense enough for file lists: compact rows of about 28 to 32px, a tabular-numeral font for sizes and dates, and a clear focus ring for keyboard use.
- Light and dark themes that follow the system setting, plus a manual toggle in the menu.
- One accent color for primary actions, and status colors for connected (green), reconnecting (amber), lost / destructive (red).
- Native-feeling on macOS without imitating Finder exactly. Avoid generic dashboard styling.
- Accessibility: WCAG AA contrast in both themes, all actions reachable by keyboard, and drag-and-drop paired with keyboard shortcuts ("Send to Mac" / "Send to phone").

## Out of scope for this design (planned later)

- Dragging files from Finder into the page, or from the page out to Finder.
- Thumbnails, previews and search.
- Copying or moving within the same pane.
