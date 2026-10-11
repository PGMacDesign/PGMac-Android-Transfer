---
id: PGM-364f
title: Mac-pane drops onto a folder row copy into that folder
milestone: F1
deps: [PGM-364]
size: S
---

## Goal

In the desktop app, dragging a Mac-pane item onto one of that pane's folder rows copies it into that folder again. Only a drop that would put items back where they already are is ignored.

## Context

- `src/web/components/Pane.tsx` ignores a real-path drop onto the Mac pane when every dropped path's parent is the pane's current folder. That check runs before the folder-row destination is considered, so dragging `/Users/me/Pics/a.jpg` onto the `Album` row in `/Users/me/Pics` does nothing. It also swallows a Finder drop of files that happen to live in the folder the pane shows.

## Acceptance criteria

1. A real-path drop is ignored only when every dropped path's parent equals the drop's actual destination folder (the folder row's path for a row drop, the current folder for a background drop).
2. Dragging a Mac-pane item onto a folder row in the same pane copies it into that folder, with the usual conflict handling.
3. Browser mode is unchanged.

## Test plan

- `test/web/`: the drop decision helper (extract it if needed) with: background drop of same-folder items (ignored), folder-row drop of same-folder items (copies to the row's folder), a Finder drop from another folder (copies), items whose parent is the row folder dropped on that row (ignored).

## Sanctioned edits

- `src/web/components/Pane.tsx`, a helper module in `src/web/` if extracted, tests.

## Out of scope

- Move semantics (Mac-pane drops always copy).

## Size

S: one condition and its test.
