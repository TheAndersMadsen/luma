#!/usr/bin/env python3
"""Show, then adopt, a protected-configuration change into a deployment record.

WHY THIS EXISTS.

`record_configuration_evidence` fingerprints every protected input of a
deployment -- the four env files, the edge and attestation roots, the Keycloak
theme, /etc/penumbra, the bridge unit, the rendered Compose model -- into that
deployment's `config-digests.tsv`. `verify_configuration_evidence` re-records
the live inputs at each later gate and refuses the deployment if a single row
moved. That control is correct and stays exactly as strict as it is.

What it had no answer for was a LEGITIMATE change to one of those inputs.
/etc/penumbra holds the iroh ticket the bridge dials the Pin with. When the
Pin's server package was reinstalled during boot-loop recovery, its node
identity was regenerated and the recorded ticket addressed a node that no
longer existed: every request hung at "connecting to Pin via iroh", the Spotify
adapter reported {"adapter":"ready","upstream":"unavailable"}, and the canary
refused. Fixing it means editing /etc/penumbra -- which is the `bridge.config`
row. So the old ticket failed the canary, the new ticket failed the drift gate
with "protected configuration or rendered Compose model drift", and the deploy
refused before quiescing. There was no supported way out, and it was resolved by
hand-editing one digest row in a deployment record: precisely the act the
control exists to prevent, performed with no record, no review, and no signal.

This tool is that missing supported path, and it is built so that using it is
strictly MORE visible than the hand-edit it replaces:

  * It shows before it acts. Every differing row is printed with its recorded
    digest, its live digest, and -- for a protected directory -- which files
    underneath it moved. Silence was the failure mode of the hand-edit; this
    refuses to be silent.
  * It says which baseline it picked and why. See BASELINES below.
  * It defaults to a dry run, like `revival pin install`. Nothing is written
    without --confirm and an operator-supplied reason.
  * It rewrites only the rows it displayed, refuses if the evidence file moved
    under it between showing and adopting, and leaves a durable journal entry in
    the deployment record naming the before/after digests and the reason.

BASELINES, AND WHY GETTING THIS WRONG COSTS AN HOUR.

There are TWO drift comparisons on a deploy and they use DIFFERENT baselines:

  1. The PENDING/ARMED record. If a deploy transaction is durably prepared,
     preflight.sh and deploy.sh's resume path verify THAT RECORD's
     config-digests.tsv (preflight.sh's pending branch, deploy.sh:722 and :810).
     This happens FIRST and it aborts the run.
  2. current-deployment. deploy.sh:1384 compares the canonical current
     deployment record only after reconciliation, i.e. only if (1) passed.

Adopting into current-deployment while a pending transaction exists therefore
changes a file the failing gate never reads. That was diagnosed against the
wrong baseline on the night this tool was written, and the edit had to be
reverted. So this tool never guesses: it resolves both, reports both, states
which one the next deploy hits first, and adopts into each explicitly.

INPUT. A JSON request file (--request), written by adopt-config.sh, holding the
already-computed facts: for each baseline, the record directory, its release,
its recorded evidence file, and a freshly recorded LIVE evidence file for that
same release. All privileged reading happens in the shell entry point; this
driver is pure file comparison so it can be tested against a fixture directory
with no VPS, no sudo, and no Docker.
"""

import argparse
import getpass
import hashlib
import json
import os
import socket
import stat
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = 1
JOURNAL_NAME = "CONFIG_ADOPTION_JOURNAL.jsonl"
MARKER_NAME = "PROTECTED_CONFIGURATION_ADOPTED"
INVENTORY_NAME = "protected-inventory.tsv"

# Mirrors verify_configuration_evidence in common.sh, which drops exactly this
# row before comparing: bridge.state is live bridge working state and moves on
# its own. It is recorded for the audit trail and compared by nothing, so this
# tool must neither report it as drift nor rewrite it -- adopting a row the gate
# does not read would be churn that looks like a change.
UNCOMPARED_ROWS = frozenset({("protected", "bridge.state")})

# Why each baseline is relevant, in the words an operator needs at 2am. Keyed by
# baseline kind; the ordering note is added separately when both are present.
BASELINE_RATIONALE = {
    "pending": (
        "a deploy transaction is durably prepared on this host. preflight.sh's pending branch and "
        "deploy.sh's resume path (deploy.sh:722 and :810) verify THIS record's config-digests.tsv, "
        "and they run before any comparison against current-deployment."
    ),
    "current": (
        "this is the canonical current deployment record. preflight.sh and deploy.sh:1384 compare "
        "the live protected inputs against THIS record's config-digests.tsv."
    ),
}


class AdoptionError(Exception):
    """A refusal the operator can act on. Never a stack trace."""


# ── evidence rows ───────────────────────────────────────────────────────────


def row_key(fields):
    return (fields[0], fields[1])


def parse_evidence(text, label):
    """Rows in recorded order, keyed by (kind, label). Duplicates are refused.

    A duplicate key would make "rewrite the row that differs" ambiguous, and
    ambiguity is the one thing this tool may not have.
    """
    rows = []
    seen = set()
    for number, line in enumerate(text.split("\n"), 1):
        if line == "":
            continue
        fields = line.split("\t")
        if len(fields) < 3 or not fields[0] or not fields[1]:
            raise AdoptionError(f"malformed configuration evidence in {label} at line {number}")
        key = row_key(fields)
        if key in seen:
            raise AdoptionError(f"duplicate configuration evidence row in {label}: {key[0]} {key[1]}")
        seen.add(key)
        rows.append((key, line, fields))
    if not rows:
        raise AdoptionError(f"configuration evidence is empty: {label}")
    return rows


def read_identity(path, allow_missing=False):
    """Content plus the identity fields that prove the file did not move.

    O_NOFOLLOW, and the lstat before and the fstat after must agree, so a
    symlink swapped in mid-read cannot be what gets adopted.
    """
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        if allow_missing:
            return None
        raise AdoptionError(f"required file is missing: {path}")
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise AdoptionError(f"refusing a configuration evidence path that is not a regular file: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        chunks = []
        while True:
            chunk = os.read(descriptor, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    after = os.lstat(path)
    fingerprint = lambda meta: (meta.st_dev, meta.st_ino, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns)
    if not (fingerprint(before) == fingerprint(opened) == fingerprint(after)):
        raise AdoptionError(f"configuration evidence changed while it was being read: {path}")
    data = b"".join(chunks)
    return {
        "path": path,
        "text": data.decode("utf-8"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mtimeNs": before.st_mtime_ns,
        "identity": fingerprint(before),
        "mode": stat.S_IMODE(before.st_mode),
    }


# ── protected-path inventories ──────────────────────────────────────────────


def parse_inventory(path, allow_missing=True):
    """label -> relpath -> (type, mode, owner, size, sha256, mtimeNs)."""
    if path is None:
        return {}
    try:
        handle = open(path, "r", encoding="utf-8")
    except FileNotFoundError:
        if allow_missing:
            return {}
        raise AdoptionError(f"protected path inventory is missing: {path}")
    inventory = {}
    with handle:
        for number, line in enumerate(handle, 1):
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) != 8:
                raise AdoptionError(f"malformed protected path inventory at {path}:{number}")
            label, relpath = fields[0], fields[1]
            inventory.setdefault(label, {})[relpath] = tuple(fields[2:])
    return inventory


def describe_files(label, live_inventory, recorded_inventory, baseline_mtime_ns):
    """Which files under a changed protected root moved, and on what evidence.

    Two bases, and the tool always says which one it used:

      exact       a previous adoption left a per-file inventory in the record,
                  so added/removed/changed is a real comparison.
      mtime       no per-file baseline exists yet, so the best cheap answer is
                  "these files were written after the recorded evidence was".
                  Honest, useful, and explicitly NOT proof -- a change that
                  preserves mtime will not appear, and an unrelated touch will.
    """
    live = live_inventory.get(label)
    if live is None:
        return {"basis": "unavailable", "files": []}
    recorded = recorded_inventory.get(label)
    if recorded is not None:
        files = []
        for relpath in sorted(set(live) | set(recorded)):
            if relpath not in recorded:
                files.append({"path": relpath, "change": "added"})
            elif relpath not in live:
                files.append({"path": relpath, "change": "removed"})
            elif live[relpath] != recorded[relpath]:
                files.append({"path": relpath, "change": "changed"})
        return {"basis": "exact", "files": files}
    files = []
    for relpath in sorted(live):
        entry = live[relpath]
        if entry[0] == "dir":
            # A directory's own mtime moves whenever a child is created or
            # removed, which the child's own row already reports. Listing it
            # too only buries the file that matters.
            continue
        try:
            mtime_ns = int(entry[5])
        except ValueError:
            continue
        if mtime_ns > baseline_mtime_ns:
            files.append({"path": relpath, "change": "written-after-baseline"})
    return {"basis": "mtime", "files": files}


# ── comparison ──────────────────────────────────────────────────────────────


def compare_baseline(baseline, live_inventory, recorded_inventory):
    recorded = read_identity(baseline["evidence"])
    live = read_identity(baseline["live"])
    recorded_rows = parse_evidence(recorded["text"], baseline["evidence"])
    live_rows = parse_evidence(live["text"], baseline["live"])
    recorded_by_key = {key: (line, fields) for key, line, fields in recorded_rows}
    live_by_key = {key: (line, fields) for key, line, fields in live_rows}
    paths = baseline.get("protectedPaths", {})

    changes = []
    matched = []
    uncompared = []
    for key in sorted(set(recorded_by_key) | set(live_by_key)):
        if key in UNCOMPARED_ROWS:
            uncompared.append({"kind": key[0], "label": key[1]})
            continue
        recorded_entry = recorded_by_key.get(key)
        live_entry = live_by_key.get(key)
        if recorded_entry is not None and live_entry is not None and recorded_entry[0] == live_entry[0]:
            matched.append({"kind": key[0], "label": key[1], "digest": recorded_entry[1][2]})
            continue
        if recorded_entry is None:
            change = "added"
        elif live_entry is None:
            change = "removed"
        else:
            change = "changed"
        entry = {
            "kind": key[0],
            "label": key[1],
            "change": change,
            "recorded": None if recorded_entry is None else recorded_entry[1][2],
            "live": None if live_entry is None else live_entry[1][2],
            "recordedRow": None if recorded_entry is None else recorded_entry[0],
            "liveRow": None if live_entry is None else live_entry[0],
        }
        path = paths.get(key[1]) if key[0] == "protected" else None
        if path:
            entry["path"] = path
            detail = describe_files(key[1], live_inventory, recorded_inventory, recorded["mtimeNs"])
            entry["fileBasis"] = detail["basis"]
            entry["files"] = detail["files"]
        changes.append(entry)

    return {
        "kind": baseline["kind"],
        "record": baseline["record"],
        "releaseId": baseline.get("releaseId"),
        "releaseDir": baseline.get("releaseDir"),
        "evidence": baseline["evidence"],
        "evidenceSha256": recorded["sha256"],
        "rowCount": len(recorded_rows),
        "changes": changes,
        "matched": matched,
        "uncompared": uncompared,
        "_recorded": recorded,
        "_recordedRows": recorded_rows,
        "_liveByKey": live_by_key,
    }


def plan_token(results):
    """One token over everything the operator was shown.

    Binds the recorded file's exact bytes as well as the changes, so a token
    from an earlier plan cannot authorize an adoption against a file that has
    since moved -- including a move that happens to produce the same change set.
    """
    payload = [
        {
            "kind": result["kind"],
            "roles": result["roles"],
            "record": result["record"],
            "evidenceSha256": result["evidenceSha256"],
            "changes": [
                {
                    "kind": change["kind"],
                    "label": change["label"],
                    "change": change["change"],
                    "recorded": change["recorded"],
                    "live": change["live"],
                }
                for change in result["changes"]
            ],
        }
        for result in results
    ]
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ── adoption ────────────────────────────────────────────────────────────────


def rebuild_evidence(result):
    """The recorded file with EXACTLY the displayed rows substituted.

    Every other byte is carried across untouched; there is no regeneration of
    the file from the live recording. The result is then re-sorted the way
    record_configuration_evidence sorts (LC_ALL=C over whole lines) so that a
    later `verify_configuration_evidence` sees a byte-identical file, and the
    substitution is asserted line-for-line before anything is written.
    """
    changes = {(change["kind"], change["label"]): change for change in result["changes"]}
    lines = []
    for key, line, _fields in result["_recordedRows"]:
        change = changes.get(key)
        if change is None:
            lines.append(line)
            continue
        if change["change"] == "removed":
            continue
        lines.append(change["liveRow"])
    for change in result["changes"]:
        if change["change"] == "added":
            lines.append(change["liveRow"])

    before = [line for _key, line, _fields in result["_recordedRows"]]
    expected_removed = {
        change["recordedRow"] for change in result["changes"] if change["recordedRow"] is not None
    }
    expected_added = {change["liveRow"] for change in result["changes"] if change["liveRow"] is not None}
    if set(before) - set(lines) != expected_removed or set(lines) - set(before) != expected_added:
        raise AdoptionError("internal refusal: the rewrite would change rows that were not displayed")

    lines.sort(key=lambda value: value.encode("utf-8"))
    return "".join(f"{line}\n" for line in lines)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def append_durable(path, text, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, mode)
    try:
        os.write(descriptor, text.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(os.path.dirname(path))


def replace_durable(path, text, mode=0o600):
    directory = os.path.dirname(path)
    temporary = os.path.join(directory, f".{os.path.basename(path)}.adopt.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    try:
        os.write(descriptor, text.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(temporary, mode)
    os.replace(temporary, path)
    fsync_directory(directory)


def journal_entry(result, phase, reason, token, after_sha, operator, host, moment):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "dk.andersmadsen.ai-pin-revival.protected-configuration-adoption",
        "phase": phase,
        "at": moment,
        "operator": operator,
        "host": host,
        "baselineKind": result["kind"],
        "baselineRoles": result["roles"],
        "record": result["record"],
        "releaseId": result["releaseId"],
        "evidence": result["evidence"],
        "planToken": token,
        "reason": reason,
        "evidenceSha256Before": result["evidenceSha256"],
        "evidenceSha256After": after_sha,
        "rows": [
            {
                key: change[key]
                for key in ("kind", "label", "change", "recorded", "live", "path", "fileBasis", "files")
                if key in change
            }
            for change in result["changes"]
        ],
    }


def adopt(result, reason, token, live_inventory_path, operator, host):
    """Journal the intent, re-prove the file has not moved, replace, journal the fact.

    The intent line is written first and carries BOTH digests, so a crash
    between the two writes leaves an unambiguous record: the file on disk is
    either evidenceSha256Before or evidenceSha256After and the journal names
    both. The absence of a committed line then says which half completed.
    """
    record = result["record"]
    after_text = rebuild_evidence(result)
    after_sha = hashlib.sha256(after_text.encode("utf-8")).hexdigest()
    moment = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    intent = journal_entry(result, "intent", reason, token, after_sha, operator, host, moment)
    append_durable(os.path.join(record, JOURNAL_NAME), json.dumps(intent, sort_keys=True) + "\n")

    # The show-then-adopt window closes here. Re-read the evidence and require
    # byte-for-byte and inode-for-inode identity with what was displayed above;
    # anything else means something else has been editing this record and the
    # rows on screen are no longer the rows on disk.
    current = read_identity(result["evidence"])
    if current["sha256"] != result["evidenceSha256"] or current["identity"] != result["_recorded"]["identity"]:
        raise AdoptionError(
            f"refusing to adopt: {result['evidence']} changed after its differences were displayed; "
            "re-run the plan and review it again"
        )

    replace_durable(result["evidence"], after_text, mode=current["mode"] or 0o600)

    # Only now, and only if a fresh live inventory exists, does the per-file
    # baseline advance. Written after the evidence so a failed adoption never
    # leaves an inventory claiming a state the digests do not agree with.
    if live_inventory_path and os.path.exists(live_inventory_path):
        with open(live_inventory_path, "r", encoding="utf-8") as handle:
            replace_durable(os.path.join(record, INVENTORY_NAME), handle.read())

    committed = journal_entry(result, "committed", reason, token, after_sha, operator, host, moment)
    append_durable(os.path.join(record, JOURNAL_NAME), json.dumps(committed, sort_keys=True) + "\n")
    append_durable(
        os.path.join(record, MARKER_NAME),
        f"{moment}\t{operator}\t{token}\t{len(result['changes'])} row(s)\t{reason}\n",
    )
    return after_sha


# ── rendering ───────────────────────────────────────────────────────────────


ROLE_LABEL = {
    "pending": "PENDING/ARMED deployment record",
    "current": "current-deployment record",
}


def render(results, token, show_all, applied, out):
    write = lambda text="": out.write(f"{text}\n")
    heading = "ADOPTED" if applied else "PLAN — nothing has been changed"
    write(f"[ai-pin-revival] protected configuration adoption — {heading}")
    write()
    if len(results) > 1:
        write(
            "  Two baselines are relevant on this host. They are DIFFERENT files and a deploy "
            "checks them at different moments; the pending record is checked first and aborts"
        )
        write("  the run before the current-deployment comparison is ever reached.")
        write()

    total = 0
    for index, result in enumerate(results, 1):
        label = " and ".join(ROLE_LABEL[role] for role in result["roles"])
        write(f"  Baseline {index} of {len(results)}: {label}")
        write(f"    record         {result['record']}")
        write(f"    release        {result['releaseId']}")
        write(f"    evidence       {result['evidence']}")
        write(f"    file sha256    {result['evidenceSha256']}")
        write(f"    rows           {result['rowCount']}")
        for role in result["roles"]:
            write(f"    why this one   {BASELINE_RATIONALE[role]}")
        if result["uncompared"]:
            names = ", ".join(f"{row['kind']} {row['label']}" for row in result["uncompared"])
            write(f"    not compared   {names} (dropped by verify_configuration_evidence; left untouched)")
        write()
        if not result["changes"]:
            write("    No row differs from the live protected configuration.")
            write()
            continue
        total += len(result["changes"])
        write(f"    ROWS THAT DIFFER ({len(result['changes'])} of {result['rowCount']})")
        for change in result["changes"]:
            write(f"      {change['change'].upper():<8} {change['kind']} {change['label']}")
            write(f"        recorded   {change['recorded'] or '(row absent)'}")
            write(f"        live       {change['live'] or '(row absent)'}")
            if "path" in change:
                write(f"        path       {change['path']}")
                basis = change.get("fileBasis")
                files = change.get("files") or []
                if basis == "exact":
                    if files:
                        write("        files changed under it (exact, against this record's inventory):")
                        for item in files:
                            write(f"          {item['change']:<10} {item['path']}")
                    else:
                        write("        no file under it changed; the difference is in metadata only")
                elif basis == "mtime":
                    if files:
                        write("        files written after the recorded evidence (mtime heuristic, not proof):")
                        for item in files:
                            write(f"          {item['change']:<10} {item['path']}")
                    else:
                        write("        no file under it has an mtime later than the recorded evidence")
                    write("        (no per-file baseline exists in this record yet; this adoption writes one)")
                else:
                    write("        per-file detail is unavailable for this path")
        if show_all and result["matched"]:
            write()
            write(f"    ROWS THAT MATCH ({len(result['matched'])})")
            for row in result["matched"]:
                write(f"      ok       {row['kind']} {row['label']}  {row['digest']}")
        elif result["matched"]:
            write(f"    ROWS THAT MATCH ({len(result['matched'])}) — not shown; add --show-all")
        write()

    write(f"  plan token     {token}")
    write()
    if applied:
        write("  Adopted exactly the rows above. Each record now carries a journal entry naming the")
        write(f"  before and after digests and the reason ({JOURNAL_NAME}).")
        return
    if total == 0:
        write("  Nothing to adopt: every compared row already matches the live configuration.")
        return
    write("  Dry run")
    write("    Nothing was changed. Re-run with --confirm and --reason to adopt exactly the rows")
    write(f"    above, and add --expect-plan {token} to bind that confirmation to this exact plan.")


# ── entry point ─────────────────────────────────────────────────────────────


def validate_reason(reason):
    if reason is None:
        raise AdoptionError("--confirm requires --reason: an adoption without a stated reason is the hand-edit again")
    collapsed = " ".join(reason.split())
    if len(collapsed) < 8:
        raise AdoptionError("--reason must be a real sentence, not a placeholder (at least 8 characters)")
    if len(collapsed) > 1000:
        raise AdoptionError("--reason must be at most 1000 characters")
    if any(ord(character) < 32 for character in collapsed):
        raise AdoptionError("--reason must not contain control characters")
    return collapsed


def main(argv):
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--adopt", action="store_true")
    parser.add_argument("--reason")
    parser.add_argument("--expect-plan")
    parser.add_argument("--show-all", action="store_true")
    parser.add_argument("--json", action="store_true")
    options = parser.parse_args(argv)

    with open(options.request, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise AdoptionError("adoption request schema mismatch")
    baselines = request.get("baselines") or []
    if not baselines:
        raise AdoptionError(
            "no deployment record is available to adopt into: this host has neither a prepared "
            "deploy transaction nor a canonical current-deployment record"
        )

    live_inventory_path = request.get("inventory")
    live_inventory = parse_inventory(live_inventory_path)

    # ONE ENTRY PER EVIDENCE FILE, NOT PER ROLE. There is a real window in which
    # both roles name the same record: once a pointer transaction has committed
    # but SUCCEEDED has not been written, current-deployment already points at
    # the record the transaction inventory still reports as active. Treating that
    # as two baselines would show the same rows twice and, worse, would adopt the
    # first copy and then refuse the second for having changed underneath -- the
    # tool tripping over its own write. So they are merged, and the entry names
    # both roles it is answering for.
    results = []
    by_evidence = {}
    for baseline in baselines:
        key = os.path.realpath(baseline["evidence"])
        existing = by_evidence.get(key)
        if existing is not None:
            if baseline["kind"] not in existing["roles"]:
                existing["roles"].append(baseline["kind"])
            continue
        recorded_inventory = parse_inventory(os.path.join(baseline["record"], INVENTORY_NAME))
        result = compare_baseline(baseline, live_inventory, recorded_inventory)
        result["roles"] = [baseline["kind"]]
        by_evidence[key] = result
        results.append(result)

    token = plan_token(results)
    reason = validate_reason(options.reason) if options.adopt else None
    if options.expect_plan and options.expect_plan != token:
        raise AdoptionError(
            "refusing to act: --expect-plan does not match the plan computed now "
            f"(expected {options.expect_plan}, computed {token}); something changed since the plan you reviewed"
        )

    changed = [result for result in results if result["changes"]]
    applied = False
    if options.adopt:
        if not changed:
            # Not an error: an operator who fixed the input and re-ran should be
            # told it already agrees rather than made to wonder.
            pass
        else:
            operator = os.environ.get("SUDO_USER") or getpass.getuser()
            host = socket.gethostname()
            for result in changed:
                result["evidenceSha256After"] = adopt(
                    result, reason, token, live_inventory_path, operator, host
                )
            applied = True

    if options.json:
        json.dump(
            {
                "schemaVersion": SCHEMA_VERSION,
                "ok": True,
                "mode": "adopt" if applied else "plan",
                "planToken": token,
                "reason": reason,
                "baselines": [
                    {
                        key: value
                        for key, value in result.items()
                        if not key.startswith("_")
                    }
                    for result in results
                ],
            },
            sys.stdout,
            sort_keys=True,
            separators=(",", ":"),
        )
        sys.stdout.write("\n")
    else:
        render(results, token, options.show_all, applied, sys.stdout)

    # The adopted records are re-proved by the caller with the real gate
    # (verify_configuration_evidence). This driver only reports which ones it
    # touched, so the shell entry point knows what to re-prove.
    if applied:
        applied_list = request.get("appliedList")
        if not applied_list:
            raise AdoptionError("the adoption request names no path for the list of records to re-prove")
        with open(applied_list, "w", encoding="utf-8") as handle:
            for result in changed:
                handle.write(f"{result['record']}\t{result['releaseDir']}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except AdoptionError as error:
        sys.stderr.write(f"[ai-pin-revival] error: {error}\n")
        sys.exit(1)
    except OSError as error:
        # A refused write is a refusal, not a crash. The evidence file is only
        # ever replaced atomically after everything else has succeeded, so the
        # operator needs the reason, not a traceback that hides which half ran.
        sys.stderr.write(f"[ai-pin-revival] error: protected configuration adoption could not write: {error}\n")
        sys.exit(1)
