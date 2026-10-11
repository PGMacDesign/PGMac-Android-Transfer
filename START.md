# START: running the PGMac Android Transfer desktop app build

You are the orchestrator for turning PGMac Android Transfer into a signed Electron app for macOS. Everything you need is in this repo, the Linear project and the factory's docs; nothing depends on any earlier conversation. Read this whole file before acting.

## 1. What you are running

The desktop app is built by pgmac-factory one ticket at a time. You do not write product code. You start the factory, keep it moving, settle what it parks, and bring the owner only the decisions that are theirs.

- **Source of truth:** `docs/DESIGN.md` (architecture and Invariants) and the Linear project "PGMac Android Transfer" (P-PGM-13), whose assessment document "Electron vs native macOS app: assessment" records the decisions: Electron, Fastify kept in a `utilityProcess`, a per-launch API token, bring-your-own adb, Developer ID signing outside the Mac App Store.
- **Builder rules:** `AGENTS.md`.
- **Tickets:** `docs/tickets/PGM-<n>-<slug>.md`, one per factory ticket, filed with `factory/file_tickets.py`. `factory/ticket-ids.json` maps ticket ids to bead ids. Ids match Linear (PGM-360a and PGM-360b are two factory tickets for Linear's PGM-360, and so on).
- **Factory:** the engine at `~/_Development/_AIWorkspace/pgmac-factory`, run as a dedicated instance with `factory/factory.yaml`. Its data, logs, run lock, pause flag and Beads queue are in `~/factory-data-pgmac-transfer`, and queue ids start with `pat-`. How to operate it: `~/_Development/_AIWorkspace/pgmac-factory/docs/new-project.md`, sections 7 and 8.
- **Gate:** `./scripts/verify.sh` locally, plus the GitHub Actions `check` job (`requiredCheck: check`). The repo is public, so Actions minutes are free, and the workflow stays enabled on purpose.

Read, in order: this file, `docs/DESIGN.md`, `AGENTS.md`, `factory/factory.yaml`, then the factory's `docs/new-project.md`.

## 2. Ground rules

- Never open, edit or merge a product PR by hand. The factory opens, reviews and merges. You change product code only by filing or editing tickets. Docs and ticket files you commit directly to `main`.
- Commits: author `pgmacdesign@gmail.com` (check `git config user.email` first), no AI attribution lines, never an em-dash character (`scripts/verify.sh` fails on one).
- The owner's decisions go into `docs/DESIGN.md` or the ticket files in the same change that acts on them.
- Always run factory commands as `pnpm --dir ~/_Development/_AIWorkspace/pgmac-factory factory <command> --config <absolute path to this repo>/factory/factory.yaml`. Without `--config` a command acts on the shared instance, which belongs to other projects.
- Always run `bd` as `bd -C ~/factory-data-pgmac-transfer/beads ...`, with `BEADS_DIR` and `BEADS_DB` unset. Never run `bd init`; the queue already exists.
- Other factory instances may be running. Never stop, pause or change them. They share the usage limits, so this one may move slower while they run.
- Linear: when a ticket is filed, its Linear issue moves to In Progress; when all of a Linear issue's factory tickets merge, mark it Done and link the PRs. Linear descriptions are full-body rewrites: re-fetch before editing, never regenerate one from memory.
- This repo is public: everything committed is public. Keep machine paths, private links and anything about the owner's own devices out of committed files.

## 3. Preflight (every start)

```sh
R="$(git rev-parse --show-toplevel)"   # run from inside the repo
git -C "$R" pull --ff-only
git -C "$R" config user.email                                              # pgmacdesign@gmail.com
"$R/scripts/verify.sh"                                                     # green on main
ssh-add -l                                                                 # personal key loaded
git ls-remote git@github.com-personal:PGMacDesign/PGMac-Android-Transfer.git HEAD
gh auth status                                                             # logged in as PGMacDesign
pgrep -fl "cli.ts run --config .*PGMac-Android-Transfer/factory/factory.yaml" || echo "factory not running"
F=~/_Development/_AIWorkspace/pgmac-factory
C="$R/factory/factory.yaml"
pnpm --dir "$F" factory status --config "$C"                               # queue visible, not paused
```

## 4. Start the factory

```sh
F=~/_Development/_AIWorkspace/pgmac-factory
C="$(git rev-parse --show-toplevel)/factory/factory.yaml"
nohup pnpm --dir "$F" factory run --config "$C" >> ~/factory-data-pgmac-transfer/logs/run.log 2>&1 &
pnpm --dir "$F" factory status --config "$C"       # first claim within a few minutes
pnpm --dir "$F" factory events 20 --config "$C"
```

Run it in the background, then run the two checks in the same shell to confirm the first claim. To stop it: `pkill -INT -f "cli.ts run --config .*PGMac-Android-Transfer/factory/factory.yaml"`.

## 5. Filing tickets

```sh
R="$(git rev-parse --show-toplevel)"   # run from inside the repo
python3 "$R/factory/file_tickets.py" <milestone> --dry      # checks sections, size, em-dashes, deps
python3 "$R/factory/file_tickets.py" <milestone>            # files with the repo label, in dependency order
```

Then commit `factory/ticket-ids.json`. A ticket's front matter `milestone` decides which run files it; `W1` is the first wave. Each ticket keeps automated acceptance criteria separate from an "Owner manual check" section for GUI checks the builder can't run.

## 6. Keep it moving

Use `/loop` (no interval) with this work list: "watch the PGMac Android Transfer factory until the W1 tickets are merged or it is blocked; settle parks; keep Linear in sync; report milestones to the owner." On each check, follow section 8 of the factory's `docs/new-project.md`. Stop the loop and tell the owner when the wave is merged, when the factory is blocked on something only the owner can settle, or when it stops advancing for two checks in a row with work outstanding.

## 7. Milestones

- **W1 (De-risk and MVP code):** PGM-358, 359, 360a, 360b, 362a, 362b, 363, 364, 365a, 365b, 366, 367. Done when all have merged and the owner has run each ticket's "Owner manual check" (batch them into one list for the owner once the wave merges).
- **De-risk spike, PGM-361 (owner):** after PGM-358 and PGM-359 merge, and PGM-367 if possible, the owner launches the app from the Dock or Finder on a fresh macOS user account and records adb discovery and the privacy prompts. Prepare the build and a checklist from the Linear issue for them. Its findings unblock PGM-369.
- **Signed release (later waves):** PGM-368 (fuses, CSP) after PGM-367; PGM-369 (Info.plist, entitlements) after PGM-361's findings; PGM-374 (supply chain, minus GitHub settings); PGM-373 (auto-update) once PGM-372 exists; PGM-376 (docs) after QA. Write each as a ticket file and file it when its blockers clear.
- **Owner only:** PGM-370 (Apple Developer enrollment, costs money, takes days), PGM-371 (repo rulesets and Actions settings), PGM-372 (release workflow secrets in a GitHub Environment; the workflow file can be a factory ticket once PGM-370 is done), PGM-375 (clean-machine QA).
- **Later, not filed:** PGM-377, PGM-378, PGM-379.

## 8. What needs the owner

Batch these into one message, each with your recommendation:

- A `needs-decision` park that the docs don't answer.
- Anything that would spend money (Apple enrollment), GitHub settings changes, and builder login problems.
- Changes to the factory itself: propose, don't change.
- The W1 "Owner manual check" list, and starting the next wave.
