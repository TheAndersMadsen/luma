#!/usr/bin/env python3
"""Retention decisions for the release and backup stores.

WHAT THIS EXISTS FOR. `backups/` and `releases/` only ever grow. Nothing in
deploy.sh, rollback.sh, backup.sh or preflight.sh removes anything from either,
so the measured end state is preflight.sh:290 refusing every deploy for
insufficient free space -- with the wearer serving normally and no supported way
out except a hand-run `rm -rf` against directories the recovery path reads.

WHY THE DECISION LIVES IN A SEPARATE FILE. The entry point beside this one does
the privileged reading (deployment-record journals are root-owned) and the
removal. This module makes every keep/remove decision from a pure facts
document, so the policy can be tested against fixtures with no host, no sudo and
no production state -- exactly the split adopt-config.sh and adopt-config.py use.

THE POLICY IS "PROVE IT IS UNREFERENCED", NOT "KEEP THE NEWEST N". Newest-N is
wrong here and would have been wrong on the measured production state: the
release the `previous` pointer names is the 53rd newest of 65, and the backup the
first-cutover legacy rollback reads is the oldest complete one on the host. A
count-based rule deletes both and neither failure is visible until a recovery is
attempted. Every retained item below is retained because a named line of code
reads it, and the reason string says which.

WHAT READS PAST STATE, AND THEREFORE WHAT MAY NEVER BE REMOVED
--------------------------------------------------------------

Releases
  * `current` -> releases/<id>.  drift.sh:19 resolves it through
    safe_release_pointer, which requires the directory to EXIST (common.sh:4129).
    Every stateful operation is dispatched out of this tree (lib/local.sh:421).
  * `previous` -> releases/<id>.  Not decorative. deploy.sh:1519 and
    rollback.sh:403 read it into `oldPrevious`, and transaction.py's
    validate_old_precondition compares the journal's oldPrevious against the LIVE
    pointer via optional_target -> direct_child, which lstat()s the target and
    dies if it is not a directory (transaction.py:264).  Removing the release the
    `previous` pointer names therefore breaks the next DEPLOY and the next
    ROLLBACK, both at the point of publishing authority.
  * releases/<release-id of a retained deployment record>.  rollback.sh:131-155
    verifies the target release tree with THAT TREE'S OWN verify-release.py
    before it will roll back to it.
  * releases/<release-id of a pending record>.  preflight.sh:83-99.

Backups
  * backups/<name of a retained deployment record>.  This is the one that looks
    removable and is not.  Three separate readers:
      - transaction.py:667 pins the production channel-key contract path to
        exactly `<root>/backups/<record name>/invariants.tsv`, and
        load_channel_journal() -> channel_contract() lstat()s it.  rollback.sh:106
        runs `--channel-key-action verify-desired` against the CURRENT record
        before it will do anything, so a missing backup directory aborts the
        rollback before it starts.
      - domain.py:1451 re-hashes `backupManifest` out of the record's Keycloak
        migration journal.  client_journal() is on the path of client-verify and
        client-check-marker, which means drift.sh:107 and rollback.sh:116 both
        fail with a FileNotFoundError traceback if the backup is gone.
      - deploy.sh:811 reconstructs `BACKUP_ROOT/$(basename "$pending_record")` as
        the activation baseline when it resumes a pending transaction.
  * backups/<name of the first-cutover record>.  rollback.sh:873 opens
    `BACKUP_ROOT/$deployment_id` by name for a LEGACY rollback target and
    compares the live database against it.  That backup is the oldest on the
    host and is the entire pre-cutover recovery position.
  * The newest backup by SHA256SUMS mtime.  drift.sh:110-115 selects it by mtime
    and refuses if it is older than 36 hours.  Removing it changes the answer
    drift gives, so it is retained unconditionally even when nothing references
    it.

RETENTION IS TRANSITIVE ALONG THE ROLLBACK CHAIN, and that is deliberate.
Rolling the current deployment back makes its predecessor the current deployment
(rollback.sh:1055), and that predecessor is then itself rollback-eligible --
rollback.sh:55 asks only for SUCCEEDED and no MANUAL_ROLLBACK.  So the second
rollback reads the predecessor's OWN journals and its predecessor's backup.  The
chain is walked while each step stays rollback-eligible and stops at the legacy
predecessor, where old-current-deployment is empty.

WHAT IS NEVER TOUCHED, AND WHY
  * deployments/  -- records are the evidence every one of the above proofs is
    made of, they total 19 MB against 3.6 GB of backups, and a removed record is
    a removed proof.  There is no upside.
  * manifests/    -- 115 KB each.  A manifest whose release tree is gone is
    inert; a release whose manifest is gone cannot be verified.  The asymmetry
    is entirely one-way, so they stay.
  * packages/     -- not modelled here.  Reported, not removed.
  * anything whose name this module cannot classify, and any backup that is
    missing SHA256SUMS or BACKUP_MANIFEST.json.  An item that cannot be proven
    unreferenced is not eligible, and neither is an item this code does not
    understand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys


SCHEMA = 1
RELEASE_ID = re.compile(r"^[0-9a-f]{64}$")
# backup.sh:39's own id regex. A directory under backups/ whose name this does
# not match was not written by backup.sh, so nothing here knows what it is.
BACKUP_ID = re.compile(r"^[A-Za-z0-9._-]{8,96}$")


def die(message: str) -> "NoReturn":
    raise SystemExit(f"prune-state error: {message}")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def require(condition: bool, message: str) -> None:
    if not condition:
        die(message)


def load_request(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            request = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        die(f"retention request is unreadable: {error}")
    require(isinstance(request, dict), "retention request is not an object")
    require(request.get("schemaVersion") == SCHEMA, "retention request schema is unsupported")
    for key in ("root", "now", "minAgeSeconds", "pointers", "deployments", "backups", "releases",
                "activeTransactions", "includeIncomplete"):
        require(key in request, f"retention request is missing {key}")
    require(isinstance(request["root"], str) and request["root"].startswith("/"),
            "retention root is not an absolute path")
    return request


class Record:
    """One deployment record, reduced to the fields retention reasons are made of."""

    def __init__(self, raw: dict, root: str) -> None:
        require(isinstance(raw, dict), "deployment record fact is not an object")
        self.name = str(raw["name"])
        self.path = str(raw["path"])
        require(self.path == os.path.join(root, "deployments", self.name),
                f"deployment record path is outside the guarded directory: {self.path}")
        self.release_id = str(raw.get("releaseId") or "")
        self.old_current = str(raw.get("oldCurrent") or "")
        self.old_current_deployment = str(raw.get("oldCurrentDeployment") or "")
        self.markers = set(raw.get("markers") or [])
        # [{"backup": "<name>", "source": "keycloak-journal"|...}]
        self.references = list(raw.get("backupReferences") or [])

    @property
    def rollback_eligible(self) -> bool:
        """Exactly rollback.sh:55's admission test for the record being rolled back."""
        return "SUCCEEDED" in self.markers and "MANUAL_ROLLBACK" not in self.markers

    @property
    def non_terminal(self) -> bool:
        """A transaction this record armed that has not durably finished either way.

        Computed from the markers directly rather than trusting the inventory, so
        the two answers can be compared.  transaction.py's pending_inventory is
        the authority; this is the second opinion that makes a disagreement
        visible instead of silent.  The namespaces mirror transaction.py's
        namespace_paths()/operation_paths() stems exactly.
        """
        marks = self.markers
        for pointer_prefix, success in (("", "SUCCEEDED"), ("ROLLBACK_", "MANUAL_ROLLBACK")):
            prepared = f"{pointer_prefix}POINTER_TRANSACTION_PREPARED"
            committed = f"{pointer_prefix}POINTER_TRANSACTION_COMMITTED"
            aborted = f"{pointer_prefix}POINTER_TRANSACTION_ABORTED"
            if prepared in marks and aborted not in marks and not (committed in marks and success in marks):
                return True
        for operation_prefix in ("", "ROLLBACK_"):
            prepared = f"{operation_prefix}OPERATION_TRANSACTION_PREPARED"
            completed = f"{operation_prefix}OPERATION_TRANSACTION_COMPLETED"
            aborted = f"{operation_prefix}OPERATION_TRANSACTION_ABORTED"
            if prepared in marks and completed not in marks and aborted not in marks:
                return True
        # Armed activation with no terminal marker at all: live mutation began and
        # only a resume may finish it (deploy.sh's CANDIDATE_ACTIVATION_ARMED has
        # no abort path by design).
        for armed, terminal in (("CANDIDATE_ACTIVATION_ARMED", ("SUCCEEDED", "POINTER_TRANSACTION_ABORTED")),
                                ("ROLLBACK_ACTIVATION_ARMED", ("MANUAL_ROLLBACK", "ROLLBACK_POINTER_TRANSACTION_ABORTED"))):
            if armed in marks and not marks.intersection(terminal):
                return True
        return False


def add_reason(target: dict[str, list[str]], key: str, reason: str) -> None:
    reasons = target.setdefault(key, [])
    if reason not in reasons:
        reasons.append(reason)


def walk_lineage(start: str, records: dict[str, Record], retained: dict[str, list[str]],
                 label: str, missing: list[str]) -> None:
    """Retain every predecessor a rollback could hand authority to, in order.

    Depth 1 is retained unconditionally: it is the release and record
    rollback.sh:120-155 reads out of the CURRENT record whether or not it turns
    out to be admissible, and a rollback that is going to refuse should refuse on
    the evidence rather than on a directory this command removed.  The walk then
    continues only while each step would itself be rollback-eligible once it
    became current, because that is the exact condition rollback.sh:55 applies to
    the next hop.
    """
    seen = {start}
    current = records.get(start)
    depth = 0
    while current is not None:
        successor = current.old_current_deployment
        if not successor:
            # Empty old-current-deployment is the legacy predecessor: rollback.sh:124
            # takes the legacy branch, which reads backups/<this record's name> and
            # no further record. The chain ends here.
            return
        name = os.path.basename(successor)
        if name in seen:
            add_reason(retained, current.name, f"{label}-chain-cycle-stops-here")
            return
        seen.add(name)
        depth += 1
        nxt = records.get(name)
        if nxt is None:
            missing.append(f"{current.name} names a predecessor record that is not present: {successor}")
            return
        add_reason(retained, name, f"{label}-rollback-target-depth-{depth}")
        if not nxt.rollback_eligible:
            # rollback.sh:135 would refuse to hand authority past this record, so
            # nothing beyond it is reachable by any rollback.
            return
        current = nxt


def retained_records(request: dict, records: dict[str, Record],
                     warnings: list[str]) -> dict[str, list[str]]:
    retained: dict[str, list[str]] = {}
    missing: list[str] = []
    pointers = request["pointers"]

    current_deployment = pointers.get("currentDeployment") or ""
    if current_deployment:
        name = os.path.basename(current_deployment)
        require(name in records, f"the current-deployment pointer names a record that is not present: {current_deployment}")
        add_reason(retained, name, "authoritative-current-deployment")
        walk_lineage(name, records, retained, "current", missing)
    else:
        # AN UNREADABLE AUTHORITY POINTER IS A REFUSAL, NOT A WARNING.
        #
        # Every backup this command retains is retained because a RETAINED RECORD
        # names or references it, and the only root the record set hangs from is
        # this pointer. With it empty the retained set is empty, and the plan that
        # falls out is "remove every backup on the host", including
        # backups/<current record> -- the one transaction.py:667 pins the
        # production channel-key contract to and deploy.sh:811 rebuilds as a
        # pending transaction's activation baseline. It would be produced with a
        # single line of warning text among the removals, and the entry point's
        # own post-conditions could not catch it either: every one of them is
        # guarded by `[[ -n "$current_deployment" ]]`, so they are skipped in
        # exactly the case that needs them and the command exits 0.
        #
        # safe_deployment_pointer() (common.sh:4153) returns non-zero when the
        # pointer is not a symlink, resolves outside deployments/, or names
        # something that is not a directory -- i.e. precisely the half-published
        # or hand-disturbed authority states an operator is most likely to be
        # looking at when they reach for this command to free space. Reading
        # nothing there means the recovery position cannot be computed, and a
        # retention pass that cannot compute it must remove nothing at all.
        #
        # A host with no deployment records has no recovery position to lose, and
        # is the one case that is still allowed to plan (it plans nothing).
        require(not records,
                "the current-deployment pointer could not be resolved, but this host has "
                f"{len(records)} deployment record(s); every retention proof hangs from that "
                "pointer, so refusing rather than planning against an empty retained set")
        warnings.append("there is no current-deployment pointer and no deployment records; nothing could be retained by lineage")

    inventory_names: set[str] = set()
    for item in request["activeTransactions"]:
        require(isinstance(item, dict) and set(item) == {"namespace", "record"},
                "authority transaction inventory entry is not in its documented shape")
        name = os.path.basename(str(item["record"]))
        require(name in records, f"a pending {item['namespace']} transaction names a record that is not present: {item['record']}")
        inventory_names.add(name)
        add_reason(retained, name, f"pending-{item['namespace']}-authority-transaction")
        walk_lineage(name, records, retained, "pending", missing)

    # The independent marker scan. transaction.py --inventory is the authority and
    # is trusted for the refusal decision; this exists so that a record whose
    # markers say "unfinished" while the inventory says nothing is RETAINED and
    # SAID OUT LOUD, rather than quietly becoming eligible.
    for name, record in records.items():
        if record.non_terminal:
            add_reason(retained, name, "non-terminal-transaction-markers")
            walk_lineage(name, records, retained, "non-terminal", missing)
            if name not in inventory_names:
                warnings.append(
                    f"{name} carries non-terminal transaction markers that transaction.py --inventory "
                    "does not report as active; retained on the markers alone")

    warnings.extend(missing)
    return retained


def collect(request: dict) -> dict:
    root = request["root"]
    records = {}
    for raw in request["deployments"]:
        record = Record(raw, root)
        require(record.name not in records, f"duplicate deployment record: {record.name}")
        records[record.name] = record

    warnings: list[str] = []
    keep_records = retained_records(request, records, warnings)

    now = int(request["now"])
    floor = int(request["minAgeSeconds"])
    require(floor >= 0, "minAgeSeconds must not be negative")
    include_incomplete = bool(request["includeIncomplete"])
    pointers = request["pointers"]

    # ---- backups ----------------------------------------------------------
    keep_backups: dict[str, list[str]] = {}
    for name in sorted(keep_records):
        record = records[name]
        # The name-derived reference. deploy.sh:811, transaction.py:667 and
        # rollback.sh:873 all reconstruct this path from the record's NAME, so it
        # is retained whether or not a journal happens to spell it out.
        add_reason(keep_backups, name, f"named-by-retained-record:{name}")
        for reference in record.references:
            require(isinstance(reference, dict) and {"backup", "source"} <= set(reference),
                    "backup reference fact is not in its documented shape")
            add_reason(keep_backups, str(reference["backup"]),
                       f"referenced-by-retained-record:{name}:{reference['source']}")

    newest = request.get("newestVerifiedBackup") or ""
    if newest:
        add_reason(keep_backups, os.path.basename(newest), "newest-verified-backup-drift-gate")
    else:
        warnings.append("no verified backup with a SHA256SUMS file was found; drift.sh would already refuse")

    backups = []
    for raw in request["backups"]:
        name = str(raw["name"])
        path = str(raw["path"])
        require(path == os.path.join(root, "backups", name),
                f"backup path is outside the guarded directory: {path}")
        entry = {"name": name, "path": path, "bytes": int(raw["bytes"]), "mtime": int(raw["mtime"])}
        reasons = list(keep_backups.get(name, []))
        ineligible: list[str] = []
        if not BACKUP_ID.fullmatch(name):
            ineligible.append("name-is-not-a-backup-id")
        if not raw.get("complete"):
            # An incomplete backup can only ever make a caller fail -- every
            # reader tests for SHA256SUMS first -- so removing it cannot break a
            # path that would otherwise have worked. It is still held back by
            # default: it is the residue of a failed operation, and the operator
            # who asks for it should say so.
            ineligible.append("incomplete-missing-sha256sums-or-manifest")
        if now - entry["mtime"] < floor:
            ineligible.append(f"newer-than-age-floor-{floor}s")
        if reasons:
            entry["action"] = "keep"
            entry["reasons"] = reasons
        elif ineligible and not (include_incomplete and ineligible == ["incomplete-missing-sha256sums-or-manifest"]):
            entry["action"] = "ineligible"
            entry["reasons"] = ineligible
        else:
            entry["action"] = "remove"
            entry["reasons"] = [
                "no-retained-deployment-record-names-or-references-it",
                "not-the-newest-verified-backup",
                f"older-than-age-floor-{floor}s",
            ] + [reason for reason in ineligible if include_incomplete]
        backups.append(entry)
    backups.sort(key=lambda item: item["name"])

    # ---- releases ---------------------------------------------------------
    keep_releases: dict[str, list[str]] = {}
    for pointer, reason in (("current", "current-release-pointer"), ("previous", "previous-release-pointer")):
        target = pointers.get(pointer) or ""
        if target:
            add_reason(keep_releases, os.path.basename(target), reason)
        elif pointer == "current":
            # Same refusal, same reason, for the other authority root. The entry
            # point's last-ditch guard before each rm ("never remove a path a live
            # pointer still names") cannot cover this one: it compares against
            # `readlink -f current`, and the only way this branch is reached is
            # that the pointer did NOT resolve, so the comparison matches nothing
            # and the live release tree is removed like any other. The `if [[ -n
            # "$current_release" ]]` post-condition is skipped for the same
            # reason. A host with no release trees has nothing to lose and may
            # still plan.
            require(not request["releases"],
                    "the current release pointer could not be resolved, but this host has "
                    f"{len(request['releases'])} release tree(s); refusing rather than planning "
                    "with no authoritative current release")
            warnings.append("there is no current release pointer and no release trees")
    for name in sorted(keep_records):
        release_id = records[name].release_id
        if release_id:
            add_reason(keep_releases, release_id, f"release-of-retained-record:{name}")
        else:
            warnings.append(f"{name} has no release-id; its release could not be retained by name")
        old_current = records[name].old_current
        if old_current:
            add_reason(keep_releases, os.path.basename(old_current), f"rollback-target-release-of:{name}")

    releases = []
    for raw in request["releases"]:
        name = str(raw["name"])
        path = str(raw["path"])
        require(path == os.path.join(root, "releases", name),
                f"release path is outside the guarded directory: {path}")
        entry = {"name": name, "path": path, "bytes": int(raw["bytes"]), "mtime": int(raw["mtime"])}
        reasons = list(keep_releases.get(name, []))
        ineligible = []
        if not RELEASE_ID.fullmatch(name):
            ineligible.append("name-is-not-a-release-id")
        if now - entry["mtime"] < floor:
            ineligible.append(f"newer-than-age-floor-{floor}s")
        if reasons:
            entry["action"] = "keep"
            entry["reasons"] = reasons
        elif ineligible:
            entry["action"] = "ineligible"
            entry["reasons"] = ineligible
        else:
            entry["action"] = "remove"
            entry["reasons"] = [
                "not-named-by-the-current-or-previous-pointer",
                "not-the-release-of-any-retained-deployment-record",
                f"older-than-age-floor-{floor}s",
            ]
        releases.append(entry)
    releases.sort(key=lambda item: item["name"])

    # Every retained name must actually be on disk. A retained backup that is
    # already gone is not this command's doing, but it IS a broken recovery path
    # and the operator has to hear about it here rather than during a rollback.
    present_backups = {entry["name"] for entry in backups}
    for name, reasons in sorted(keep_backups.items()):
        if name not in present_backups:
            warnings.append(f"a retained backup is already missing from disk: {name} ({'; '.join(reasons)})")
    present_releases = {entry["name"] for entry in releases}
    for name, reasons in sorted(keep_releases.items()):
        if name not in present_releases:
            warnings.append(f"a retained release is already missing from disk: {name} ({'; '.join(reasons)})")

    plan = {
        "schemaVersion": SCHEMA,
        "root": root,
        "minAgeSeconds": floor,
        "includeIncomplete": include_incomplete,
        "retainedRecords": {name: sorted(reasons) for name, reasons in sorted(keep_records.items())},
        "backups": backups,
        "releases": releases,
        "warnings": warnings,
    }
    plan["totals"] = {
        "backupsKept": sum(1 for item in backups if item["action"] == "keep"),
        "backupsIneligible": sum(1 for item in backups if item["action"] == "ineligible"),
        "backupsRemoved": sum(1 for item in backups if item["action"] == "remove"),
        "backupBytesRemoved": sum(item["bytes"] for item in backups if item["action"] == "remove"),
        "backupBytesIneligible": sum(item["bytes"] for item in backups if item["action"] == "ineligible"),
        "releasesKept": sum(1 for item in releases if item["action"] == "keep"),
        "releasesIneligible": sum(1 for item in releases if item["action"] == "ineligible"),
        "releasesRemoved": sum(1 for item in releases if item["action"] == "remove"),
        "releaseBytesRemoved": sum(item["bytes"] for item in releases if item["action"] == "remove"),
    }
    plan["planToken"] = plan_token(plan)
    return plan


def plan_token(plan: dict) -> str:
    """A digest of the DECISIONS, not of the measurements.

    Sizes and mtimes are deliberately excluded so that a token stays valid across
    the seconds between a dry run and its --confirm; an item whose ACTION or
    reason changed in that window invalidates it, which is the case worth
    catching.
    """
    rows = []
    for kind in ("backups", "releases"):
        for item in plan[kind]:
            rows.append(f"{kind}\t{item['name']}\t{item['action']}\t{','.join(item['reasons'])}")
    rows.sort()
    digest = hashlib.sha256()
    digest.update(f"{plan['minAgeSeconds']}\t{int(plan['includeIncomplete'])}\n".encode())
    for row in rows:
        digest.update(row.encode() + b"\n")
    return digest.hexdigest()


def human_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if size < 1024 or unit == "GiB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} GiB"


def report(plan: dict, show_all: bool, stream) -> None:
    totals = plan["totals"]
    print(f"retention root: {plan['root']}", file=stream)
    print(f"age floor: {plan['minAgeSeconds']}s   incomplete backups eligible: "
          f"{'yes' if plan['includeIncomplete'] else 'no'}", file=stream)
    print("", file=stream)
    print("RETAINED DEPLOYMENT RECORDS (the roots every proof below hangs from)", file=stream)
    for name, reasons in plan["retainedRecords"].items():
        print(f"  {name}", file=stream)
        for reason in reasons:
            print(f"      because {reason}", file=stream)
    print("", file=stream)

    for kind, heading in (("backups", "BACKUPS"), ("releases", "RELEASES")):
        removing = [item for item in plan[kind] if item["action"] == "remove"]
        ineligible = [item for item in plan[kind] if item["action"] == "ineligible"]
        keeping = [item for item in plan[kind] if item["action"] == "keep"]
        print(f"{heading}: {len(keeping)} kept, {len(ineligible)} not eligible, "
              f"{len(removing)} to remove", file=stream)
        for item in keeping if show_all else []:
            print(f"  KEEP       {item['name']}  ({human_bytes(item['bytes'])})", file=stream)
            for reason in item["reasons"]:
                print(f"      because {reason}", file=stream)
        for item in ineligible:
            print(f"  NOT ELIGIBLE {item['name']}  ({human_bytes(item['bytes'])})", file=stream)
            for reason in item["reasons"]:
                print(f"      because {reason}", file=stream)
        for item in removing:
            print(f"  REMOVE     {item['name']}  ({human_bytes(item['bytes'])})", file=stream)
            if show_all:
                for reason in item["reasons"]:
                    print(f"      because {reason}", file=stream)
        print("", file=stream)

    if plan["warnings"]:
        print("WARNINGS", file=stream)
        for warning in plan["warnings"]:
            print(f"  ! {warning}", file=stream)
        print("", file=stream)

    print(f"would free: {human_bytes(totals['backupBytesRemoved'])} of backups + "
          f"{human_bytes(totals['releaseBytesRemoved'])} of releases = "
          f"{human_bytes(totals['backupBytesRemoved'] + totals['releaseBytesRemoved'])}", file=stream)
    if totals["backupBytesIneligible"]:
        print(f"held back as not eligible: {human_bytes(totals['backupBytesIneligible'])} of backups",
              file=stream)
    print(f"plan token: {plan['planToken']}", file=stream)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--show-all", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--expect-plan", default="")
    parser.add_argument("--emit-removals", default="")
    parser.add_argument("--confirm", action="store_true")
    arguments = parser.parse_args()

    plan = collect(load_request(arguments.request))

    if arguments.expect_plan:
        if not re.fullmatch(r"[0-9a-f]{64}", arguments.expect_plan):
            die("--expect-plan must be the 64-character plan token the dry run printed")
        if arguments.expect_plan != plan["planToken"]:
            die("the plan changed since the dry run printed that token; re-run without --confirm and read it again")

    if arguments.json:
        print(canonical(plan))
    else:
        report(plan, arguments.show_all or not arguments.confirm, sys.stderr if arguments.emit_removals == "-" else sys.stdout)

    if arguments.emit_removals:
        rows = []
        for kind in ("backups", "releases"):
            for item in plan[kind]:
                if item["action"] == "remove":
                    rows.append(f"{kind[:-1]}\t{item['path']}\t{item['bytes']}\n")
        payload = "".join(rows)
        if arguments.emit_removals == "-":
            sys.stdout.write(payload)
        else:
            with open(arguments.emit_removals, "w", encoding="utf-8") as handle:
                handle.write(payload)


if __name__ == "__main__":
    main()
