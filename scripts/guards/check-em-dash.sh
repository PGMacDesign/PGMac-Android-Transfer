#!/usr/bin/env bash
# Fails if any tracked (or untracked, not ignored) text file contains the em-dash (U+2014).
# Excluded: docs/design/ (exported design prototypes, kept as exported).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export LC_ALL=C

EM_DASH="$(printf '\342\200\224')"
PATHSPEC=(. ':(exclude)docs/design')

# Canary: prove the byte sequence matches, so a locale or quoting slip cannot pass silently.
if ! printf 'a%sb\n' "$EM_DASH" | grep -q -F -e "$EM_DASH"; then
  echo "check-em-dash: FAIL: em-dash pattern did not match the canary; the scan is broken" >&2
  exit 1
fi

file_count="$(git ls-files --cached --others --exclude-standard -- "${PATHSPEC[@]}" | wc -l | tr -d ' ')"
if [ "$file_count" -eq 0 ]; then
  echo "check-em-dash: FAIL: no files to scan (is this a git checkout?)" >&2
  exit 1
fi

matches="$(git ls-files -z --cached --others --exclude-standard -- "${PATHSPEC[@]}" \
  | xargs -0 grep -I -n -F -e "$EM_DASH" -- 2>/dev/null || true)"

if [ -n "$matches" ]; then
  echo "$matches" >&2
  echo "check-em-dash: FAIL: em-dash (U+2014) found above. Rewrite with commas, colons, parentheses or separate sentences." >&2
  exit 1
fi

echo "check-em-dash: OK ($file_count files)"
