---
id: PGM-363f
title: Real-path drop planning follow-ups from review
milestone: F1
deps: [PGM-363]
size: S
---

## Goal

Fix the copy-into-itself check for case-sensitive volumes and put transfer direction in one place, two non-blocking review findings on the real-path drop flow.

## Context

- `src/server/transfers/queue.ts` refuses a copy whose destination is the source folder or inside it. It compares paths through `nameKey`, which folds case, so on a case-sensitive volume copying `/f/Album` into `/f/album` is wrongly refused. On the default case-insensitive APFS volume the folding is correct.
- `plan()` maps `from` and `destSide` to a direction through nested branches, separately from `planFinder()`'s direction logic.

## Acceptance criteria

1. The copy-into-itself check compares real path boundaries (`path.relative`, or a prefix check ending in `/`) and folds case only when the volume is case-insensitive. Detecting case sensitivity per volume is fine (for example `pathconf`-style probing via a cached check, or comparing `fs.stat` of the path with a case-swapped variant); if that isn't practical, compare without folding and resolve both paths with `fs.realpath` first, which gives the canonical case on case-insensitive volumes.
2. One function maps a plan request (`from`, `destSide`) to its direction (`push`, `pull`, `copy`), used by both `plan()` and `planFinder()`. No behaviour change.

## Test plan

- `test/queue.test.ts`: copying `/f/Album` into `/f/album` is allowed when the two are distinct (simulate a case-sensitive volume through the injected check); copying a folder into its own subfolder is still refused, including with a trailing slash and a differently cased path on a case-insensitive volume.
- Direction mapping: a table test over every `from`/`destSide` pair.

## Sanctioned edits

- `src/server/transfers/queue.ts`, `test/queue.test.ts`.

## Out of scope

- Any other planning change.

## Size

S: one comparison fix and one extracted function.
