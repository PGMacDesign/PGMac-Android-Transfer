#!/usr/bin/env python3
"""File PGMac Android Transfer tickets from docs/tickets/ into this instance's Beads queue.

    factory/file_tickets.py <milestone> [--dry] [--only PGM-NNN,...]

<milestone> is a front-matter milestone value (W1 is the first wave): every ticket file whose
front matter has that milestone is filed, in dependency order, with the
repo:PGMac-Android-Transfer label (which releases it to the factory at once) and its deps mapped to bead ids.
--only narrows to the named tickets (for example PGM-358,PGM-359). Always run --dry first: it checks the five sections the factory
requires, the size, the em-dash rule and every dependency, and files nothing.

factory/ticket-ids.json maps PGM id to bead id and is updated as tickets are
created; a ticket already in it is skipped, so a rerun after a failure resumes.
Dependencies must be filed in this run or already be in ticket-ids.json.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICKETS = os.path.join(ROOT, "docs", "tickets")
IDS_FILE = os.path.join(ROOT, "factory", "ticket-ids.json")
BEADS = os.path.expanduser(os.environ.get("FACTORY_BEADS", "~/factory-data-pgmac-transfer/beads"))
LABEL = "repo:PGMac-Android-Transfer"
SECTIONS = ["Goal", "Acceptance criteria", "Test plan", "Out of scope", "Size"]


def parse(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise ValueError(f"{path}: no front matter")
    meta = {}
    for line in m.group(1).splitlines():
        line = line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            meta[key.strip()] = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
        else:
            meta[key.strip()] = value.strip("'\"")
    return meta, m.group(2).strip() + "\n"


def problems(meta, body):
    out = [f"missing ## {s}" for s in SECTIONS if not re.search(rf"^##\s+{re.escape(s)}\s*$", body, re.M)]
    size = re.search(r"^##\s+Size\s*$\s*([^\n]*)", body, re.M)
    if not size or not re.match(r"^(S|M)\b", size.group(1).strip()):
        out.append("Size must start with S or M")
    if "\u2014" in body or "\u2014" in meta.get("title", ""):
        out.append("em-dash")
    return out


def order(tickets):
    by_id = {t["id"]: t for t in tickets}
    done, seq = set(), []

    def visit(tid, stack):
        if tid in done or tid not in by_id:
            return
        if tid in stack:
            sys.exit(f"dependency cycle through {tid}")
        for d in by_id[tid]["deps"]:
            visit(d, stack | {tid})
        done.add(tid)
        seq.append(by_id[tid])

    for t in sorted(tickets, key=lambda t: t["id"]):
        visit(t["id"], set())
    return seq


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    only = set()
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
    positional = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--only")]
    if len(positional) != 1:
        sys.exit(__doc__)
    milestone = positional[0]

    ids = json.load(open(IDS_FILE)) if os.path.exists(IDS_FILE) else {}
    tickets = []
    for name in sorted(os.listdir(TICKETS)):
        if not re.match(r"^PGM-\d+[a-z]?-.*\.md$", name):
            continue
        meta, body = parse(os.path.join(TICKETS, name))
        if meta.get("milestone") != milestone or (only and meta["id"] not in only):
            continue
        tickets.append({"id": meta["id"], "title": meta["title"], "deps": meta.get("deps", []), "body": body, "meta": meta})
    if not tickets:
        sys.exit(f"no tickets for milestone {milestone}")

    filing = {t["id"] for t in tickets}
    bad = False
    for t in order(tickets):
        p = problems(t["meta"], t["body"])
        p += [f"unfiled dep {d}" for d in t["deps"] if d not in filing and d not in ids]
        status = "already filed" if t["id"] in ids else ("OK" if not p else "PROBLEMS: " + "; ".join(p))
        bad = bad or (bool(p) and t["id"] not in ids)
        print(f'{t["id"]} {t["title"]} deps={t["deps"]} {len(t["body"])} chars {status}')
    if bad:
        sys.exit("fix the problems above; nothing filed")
    if dry:
        return

    tmp = tempfile.mkdtemp(prefix="pgm-tickets-")
    for t in order(tickets):
        if t["id"] in ids:
            continue
        path = os.path.join(tmp, f'{t["id"]}.md')
        with open(path, "w", encoding="utf-8") as f:
            f.write(t["body"])
        cmd = ["bd", "create", "--title", f'{t["id"]} {t["title"]}', "--type", "feature", "--priority", "2",
               "--body-file", path, "--labels", LABEL, "--json"]
        deps = [ids[d] for d in t["deps"]]
        if deps:
            cmd += ["--deps", ",".join(deps)]
        out = subprocess.run(cmd, cwd=BEADS, capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit(f'bd create failed for {t["id"]}: {out.stderr}')
        data = json.loads(out.stdout)
        data = data[0] if isinstance(data, list) else data
        ids[t["id"]] = data["id"]
        with open(IDS_FILE, "w") as f:
            json.dump(ids, f, indent=2, sort_keys=True)
            f.write("\n")
        print("filed", t["id"], data["id"])


if __name__ == "__main__":
    main()
