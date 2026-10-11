#!/usr/bin/env bash
# The single local gate, and the factory's merge gate. Runs the same steps as the CI `check`
# job plus the em-dash guard: install (only when the lockfile changed), em-dash guard,
# typecheck, lint, format check, unit tests, build. Exits non-zero on the first failure.
# It must not modify tracked files, and it runs with a stripped environment (PATH, HOME, ...).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
start="$(date +%s)"
# Fingerprint of tracked changes, so a run with uncommitted work still passes as long as
# verification itself doesn't change anything.
tracked_state() { git status --porcelain --untracked-files=no; git diff HEAD --binary | shasum; }
before="$(tracked_state)"
echo "verify: node $(node --version), npm $(npm --version)"

# npm writes node_modules/.package-lock.json on every install, so a lockfile newer than it
# means dependencies changed since the last install (or there was none, as in a fresh worktree).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi

"$ROOT/scripts/guards/check-em-dash.sh"
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build

if [ "$(tracked_state)" != "$before" ]; then
  git status --porcelain --untracked-files=no >&2
  echo "verify: FAIL: tracked files changed during verification" >&2
  exit 1
fi

end="$(date +%s)"
echo "verify: OK in $((end - start))s"
