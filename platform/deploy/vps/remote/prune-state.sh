#!/usr/bin/env bash
# Retention for the release and backup stores: the privileged half.
#
# WHAT IT IS FOR. Nothing in this tree has ever removed a release tree or a
# backup. On the host as measured, that is 80 backup directories (3.6 GB) and 65
# release trees (545 MB) on a disk that is 88% full, and preflight.sh:290 refuses
# a deploy below 8 GiB free. The end state of the growth is a production that
# cannot be deployed to, reached quietly, while everything else looks healthy.
#
# THIS FILE DOES THE READING AND THE REMOVING. Every keep/remove DECISION is made
# by prune-state.py from a pure facts document, so the policy is testable with no
# host and no sudo. Same split, and for the same reason, as adopt-config.sh and
# adopt-config.py.
#
# IT IS DELIBERATELY NOT PART OF ANY DEPLOY PATH:
#   * it holds the same deployment lock deploy.sh, backup.sh, rollback.sh and
#     adopt-config.sh take, so it cannot run alongside one;
#   * it refuses outright if a deploy, rollback, preflight, backup, canary or
#     drift driver is anywhere in its process ancestry;
#   * nothing in the deploy path references it, and an acceptance test pins that;
#   * it never writes to deployments/ or manifests/ and never touches a pointer.
#
# WITHOUT --confirm IT REMOVES NOTHING. It prints the full plan, every retained
# item with the named reason it is retained, and a plan token.
set -euo pipefail
remote_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$remote_dir/common.sh"

confirm=0
json=0
show_all=0
expect_plan=""
include_incomplete=0
min_age_hours=24
usage() {
  cat >&2 <<'EOF'
usage: prune-state [--min-age-hours N] [--show-all] [--json]
                   [--include-incomplete] [--confirm [--expect-plan TOKEN]]

Without --confirm this only PLANS: it proves which backups and release trees no
recovery path can still reach, prints what it would remove and why, and changes
nothing.
EOF
  exit 64
}
while (($#)); do
  case "$1" in
    --min-age-hours) (($# >= 2)) || usage; min_age_hours="$2"; shift 2 ;;
    --include-incomplete) include_incomplete=1; shift ;;
    --expect-plan) (($# >= 2)) || usage; expect_plan="$2"; shift 2 ;;
    --show-all) show_all=1; shift ;;
    --confirm) confirm=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$min_age_hours" =~ ^[0-9]{1,4}$ ]] || usage_fail "--min-age-hours must be a whole number of hours"
[[ -z "$expect_plan" || "$expect_plan" =~ ^[0-9a-f]{64}$ ]] || usage_fail "--expect-plan must be a plan token"
((confirm)) || [[ -z "$expect_plan" ]] || usage_fail "--expect-plan is only meaningful with --confirm"

# NEVER FROM INSIDE A DEPLOY. Byte-for-byte the control adopt-config.sh uses, and
# for the same reason: the lock below already makes it impossible to run while a
# driver holds it, but a driver that invoked this BETWEEN its own lock
# acquisitions would slip past that. Removing a recovery position is an operator
# decision taken with nothing in flight; it is not a step any automated path may
# take on its own. Matching is on the PROGRAM an ancestor is executing -- the
# first two non-option words of its argv -- never a substring of the command
# line, so an operator shell that merely typed `less deploy.sh` is not refused.
assert_not_inside_deployment_driver() {
  local drivers=(deploy.sh rollback.sh preflight.sh backup.sh canary.sh drift.sh)
  local pid="$$" parent command word driver examined
  local -a words
  while [[ -n "$pid" && "$pid" != 0 && "$pid" != 1 ]]; do
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || break
    [[ -n "$parent" && "$parent" != "$pid" ]] || break
    command="$(ps -o args= -p "$parent" 2>/dev/null || true)"
    words=()
    read -ra words <<<"$command" || true
    examined=0
    for word in "${words[@]}"; do
      [[ "$word" == -* ]] && continue
      ((examined += 1))
      ((examined <= 2)) || break
      for driver in "${drivers[@]}"; do
        [[ "${word##*/}" == "$driver" ]] || continue
        fail "state retention refuses to run inside a deployment driver ($command); run it on its own, with nothing in flight"
      done
    done
    pid="$parent"
  done
}

assert_target
assert_remote_root
for command in python3 sudo flock stat find du readlink sha256sum ps; do need "$command"; done
assert_not_inside_deployment_driver

driver="$remote_dir/prune-state.py"
[[ -f "$driver" && ! -L "$driver" ]] || fail "state retention driver is missing or unsafe"
transaction_driver="$remote_dir/transaction.py"
[[ -f "$transaction_driver" && ! -L "$transaction_driver" ]] || fail "authority transaction helper is missing or unsafe"

[[ -d "$REMOTE_ROOT" && ! -L "$REMOTE_ROOT" ]] || fail "canonical deployment root is unsafe"
for guarded in "$BACKUP_ROOT" "$RELEASES_DIR" "$DEPLOYMENTS_DIR"; do
  [[ -d "$guarded" && ! -L "$guarded" && "$(readlink -f -- "$guarded")" == "$guarded" ]] \
    || fail "guarded store is missing or unsafe: $guarded"
done

# The same lock deploy.sh takes at its line 52. Holding it is what makes "this
# never runs during a deploy, a backup or a rollback" a property of the system
# rather than a promise, and it is also what makes the facts below a consistent
# snapshot rather than a race.
exec 9>"$LOCK_FILE"
flock -n 9 || fail "a deployment, backup, rollback or adoption holds the deployment lock; state retention never runs alongside one"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
chmod 700 "$work"

# ── the authority inventory ────────────────────────────────────────────────
# Captured into a variable first, deliberately, exactly as adopt-config.sh does:
# reading a REJECTED inventory straight through a process substitution turns it
# into an empty one, and an empty one reads as "nothing is pending" -- the single
# worst thing this command could conclude wrongly, because a pending record's
# baseline backup is the thing a resume cannot be completed without.
inventory_json="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
  || fail "authority transaction inventory is invalid; refusing to remove anything"
python3 - "$inventory_json" <<'PY' >"$work/active.json"
import json, sys
body = json.loads(sys.argv[1])
assert body.get("schemaVersion") == 1 and isinstance(body.get("active"), list) and len(body["active"]) <= 1
for item in body["active"]:
    assert set(item) == {"namespace", "record"}
print(json.dumps(body["active"], sort_keys=True, separators=(",", ":")))
PY

# ── backup references held inside deployment records ───────────────────────
# Read under sudo because the two journals that matter are root-owned:
# CHANNEL_KEY_METADATA_TRANSACTION.json is written by transaction.py under sudo,
# and domain-cutover/keycloak/JOURNAL.json is written mode 0400 by domain.py.
# Reading them as `anders` returns "Permission denied" -- which, if it were
# silently swallowed, would report the CURRENT deployment's own backup as
# unreferenced. That is the exact mistake this command must not make, so a failed
# read is fatal rather than empty.
#
# THREE STRUCTURED SOURCES AND ONE RAW SCAN. The structured readers name the
# field and the file, so the reason string an operator sees is specific. The raw
# scan then reads every regular file in the record and extracts anything shaped
# like a backup path; it exists to catch a reference this code does not know
# about yet, and its finds are retained under the source label `scan`. Records
# are under 1.4 MB each on this host, so scanning all of them is free. The scan
# emits ONLY the matched backup path -- never file content -- so no protected
# value can leave a record through it.
sudo -n python3 - "$REMOTE_ROOT" >"$work/references.tsv" <<'PY'
import json, os, re, sys

root = sys.argv[1]
deployments = os.path.join(root, "deployments")
backups = os.path.join(root, "backups")
pattern = re.compile(re.escape(backups).encode() + rb"/([A-Za-z0-9._-]{8,96})")
emitted = set()


def emit(record, name, source):
    key = (record, name, source)
    if key in emitted:
        return
    emitted.add(key)
    print(f"{record}\t{name}\t{source}")


def under_backups(value):
    if not isinstance(value, str) or not value.startswith(backups + "/"):
        return None
    name = value[len(backups) + 1:].split("/", 1)[0]
    return name or None


for record in sorted(os.listdir(deployments)):
    directory = os.path.join(deployments, record)
    if not os.path.isdir(directory) or os.path.islink(directory):
        continue
    for relative, field in (
        (os.path.join("domain-cutover", "keycloak", "JOURNAL.json"), "backupManifest"),
        ("CHANNEL_KEY_METADATA_TRANSACTION.json", "backupContract"),
    ):
        path = os.path.join(directory, relative)
        if not os.path.isfile(path) or os.path.islink(path):
            continue
        try:
            document = json.load(open(path, encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise SystemExit(f"unreadable deployment journal {path}: {error}")
        name = under_backups(document.get(field))
        if name:
            emit(record, name, os.path.basename(relative).removesuffix(".json").lower())
    pointer = os.path.join(directory, "rollback-backup-path")
    if os.path.isfile(pointer) and not os.path.islink(pointer):
        name = under_backups(open(pointer, encoding="utf-8").read().strip())
        if name:
            emit(record, name, "rollback-backup-path")
    for current, directories, files in os.walk(directory, followlinks=False):
        directories.sort()
        for filename in sorted(files):
            path = os.path.join(current, filename)
            if os.path.islink(path):
                continue
            try:
                with open(path, "rb") as handle:
                    blob = handle.read()
            except OSError as error:
                raise SystemExit(f"unreadable deployment record file {path}: {error}")
            for match in pattern.finditer(blob):
                emit(record, match.group(1).decode(), "scan")
PY

# ── the stores themselves ──────────────────────────────────────────────────
store_facts() {
  local store="$1" output="$2" name path
  : >"$output"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    name="$(basename -- "$path")"
    # A symlink or a non-directory in either store is not something this command
    # will classify, let alone remove. Report it and move on.
    if [[ -L "$path" || ! -d "$path" ]]; then
      warn "ignoring a non-directory entry under $store: $name"
      continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$name" "$(du -sk -- "$path" | awk '{print $1}')" \
      "$(stat -c '%Y' "$path")" "$path" >>"$output"
  done < <(find "$store" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)
}
store_facts "$BACKUP_ROOT" "$work/backups.tsv"
store_facts "$RELEASES_DIR" "$work/releases.tsv"

# drift.sh:110's exact selection, reproduced rather than approximated: the
# directory holding the most recently modified SHA256SUMS anywhere two levels
# under the backup root. Whatever this returns is retained unconditionally,
# because removing it would change the answer `./revival drift` gives.
newest_backup="$(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name SHA256SUMS \
  -printf '%T@\t%h\n' | LC_ALL=C sort -n | tail -n 1 | cut -f2-)"

deployment_facts() {
  local record path name
  while IFS= read -r path; do
    [[ -n "$path" && -d "$path" && ! -L "$path" ]] || continue
    name="$(basename -- "$path")"
    printf '%s\n' "$name"
  done < <(find "$DEPLOYMENTS_DIR" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)
}
deployment_facts >"$work/deployments.txt"

current_release="$(safe_release_pointer "$REMOTE_ROOT/current" 2>/dev/null || true)"
previous_release="$(safe_release_pointer "$REMOTE_ROOT/previous" 2>/dev/null || true)"
current_deployment="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment" 2>/dev/null || true)"

python3 - "$REMOTE_ROOT" "$work" "$((min_age_hours * 3600))" "$include_incomplete" \
  "$current_release" "$previous_release" "$current_deployment" "$newest_backup" \
  >"$work/request.json" <<'PY'
import json, os, sys, time

root, work, floor, include_incomplete, current, previous, current_deployment, newest = sys.argv[1:]
deployments_dir = os.path.join(root, "deployments")

MARKERS = [
    "SUCCEEDED", "MANUAL_ROLLBACK", "INGRESS_ACTIVATED", "ROLLBACK_INGRESS_ACTIVATED",
    "CANDIDATE_ACTIVATION_ARMED", "ROLLBACK_ACTIVATION_ARMED", "ROLLBACK_ACTIVATION_FAILED",
    "APPLICATION_COMMITTED", "ROLLBACK_APPLICATION_COMMITTED",
    "POINTER_TRANSACTION_PREPARED", "POINTER_TRANSACTION_COMMITTED", "POINTER_TRANSACTION_ABORTED",
    "OPERATION_TRANSACTION_PREPARED", "OPERATION_TRANSACTION_COMPLETED", "OPERATION_TRANSACTION_ABORTED",
    "OPERATION_TRANSACTION_QUIESCING", "OPERATION_TRANSACTION_QUIESCED",
    "ROLLBACK_POINTER_TRANSACTION_PREPARED", "ROLLBACK_POINTER_TRANSACTION_COMMITTED",
    "ROLLBACK_POINTER_TRANSACTION_ABORTED",
    "ROLLBACK_OPERATION_TRANSACTION_PREPARED", "ROLLBACK_OPERATION_TRANSACTION_COMPLETED",
    "ROLLBACK_OPERATION_TRANSACTION_ABORTED",
    "ROLLBACK_OPERATION_TRANSACTION_QUIESCING", "ROLLBACK_OPERATION_TRANSACTION_QUIESCED",
]

references = {}
with open(os.path.join(work, "references.tsv"), encoding="utf-8") as handle:
    for line in handle:
        line = line.rstrip("\n")
        if not line:
            continue
        record, name, source = line.split("\t")
        references.setdefault(record, []).append({"backup": name, "source": source})


def text(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


deployments = []
with open(os.path.join(work, "deployments.txt"), encoding="utf-8") as handle:
    for name in handle.read().split("\n"):
        if not name:
            continue
        directory = os.path.join(deployments_dir, name)
        deployments.append({
            "name": name,
            "path": directory,
            "releaseId": text(os.path.join(directory, "release-id")),
            "oldCurrent": text(os.path.join(directory, "old-current")),
            "oldCurrentDeployment": text(os.path.join(directory, "old-current-deployment")),
            "markers": [marker for marker in MARKERS
                        if os.path.isfile(os.path.join(directory, marker))],
            "backupReferences": references.get(name, []),
        })


def store(filename, complete_check):
    entries = []
    with open(os.path.join(work, filename), encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            name, kilobytes, mtime, path = line.split("\t")
            entry = {"name": name, "path": path, "bytes": int(kilobytes) * 1024, "mtime": int(mtime)}
            if complete_check:
                entry["complete"] = all(
                    os.path.isfile(os.path.join(path, required))
                    for required in ("SHA256SUMS", "BACKUP_MANIFEST.json")
                )
            entries.append(entry)
    return entries


request = {
    "schemaVersion": 1,
    "root": root,
    "now": int(time.time()),
    "minAgeSeconds": int(floor),
    "includeIncomplete": include_incomplete == "1",
    "pointers": {
        "current": current or None,
        "previous": previous or None,
        "currentDeployment": current_deployment or None,
    },
    "activeTransactions": json.load(open(os.path.join(work, "active.json"), encoding="utf-8")),
    "newestVerifiedBackup": newest or None,
    "deployments": deployments,
    "backups": store("backups.tsv", True),
    "releases": store("releases.tsv", False),
}
json.dump(request, sys.stdout, sort_keys=True, separators=(",", ":"))
PY

plan_args=(--request "$work/request.json" --emit-removals "$work/removals.tsv")
((show_all)) && plan_args+=(--show-all)
((json)) && plan_args+=(--json)
((confirm)) && plan_args+=(--confirm)
[[ -z "$expect_plan" ]] || plan_args+=(--expect-plan "$expect_plan")
python3 "$driver" "${plan_args[@]}"

if ((confirm == 0)); then
  ((json)) || log "dry run only; nothing was removed. Re-run with --confirm to act on this plan."
  exit 0
fi

# ── removal ────────────────────────────────────────────────────────────────
#
# Each path is re-derived and re-checked HERE, immediately before the rm, rather
# than trusted because the planner produced it. The planner works on a facts
# document; this works on the filesystem. A path that does not still satisfy
# every one of these is not removed, and the whole command fails rather than
# skipping it quietly.
removed_backups=0
removed_releases=0
removed_bytes=0
while IFS=$'\t' read -r kind path bytes; do
  [[ -n "$kind" ]] || continue
  case "$kind" in
    backup) store_root="$BACKUP_ROOT" ;;
    release) store_root="$RELEASES_DIR" ;;
    *) fail "removal plan named an unknown store: $kind" ;;
  esac
  [[ "$path" == "$store_root/"* ]] || fail "removal plan named a path outside its store: $path"
  name="${path#"$store_root/"}"
  [[ "$name" != */* && "$name" != "." && "$name" != ".." ]] \
    || fail "removal plan named a nested path: $path"
  [[ -d "$path" && ! -L "$path" && "$(readlink -f -- "$path")" == "$path" ]] \
    || fail "refusing to remove a path that is not a plain directory: $path"
  # Never remove anything a live pointer still resolves to, whatever the plan
  # says. This can only ever be redundant; it is here because the cost of it
  # being needed once is the production the pointer describes.
  for pointer in current previous current-deployment; do
    [[ "$(readlink -f -- "$REMOTE_ROOT/$pointer" 2>/dev/null || true)" != "$path" ]] \
      || fail "refusing to remove a path an authority pointer still names: $pointer -> $path"
  done
  rm -rf -- "$path"
  [[ ! -e "$path" && ! -L "$path" ]] || fail "removal did not take effect: $path"
  removed_bytes=$((removed_bytes + bytes))
  case "$kind" in
    backup) removed_backups=$((removed_backups + 1)) ;;
    release) removed_releases=$((removed_releases + 1)) ;;
  esac
done <"$work/removals.tsv"

# ── post-conditions: prove the recovery path still exists ──────────────────
#
# Not a second opinion from this command's own planner: the same predicates the
# recovery drivers apply. If any of these fails, the removal has already
# happened, and saying so loudly is the only remaining useful act.
recovery_ok=1
# The global authority scan, re-run against what is left. transaction.py's
# pending_inventory walks EVERY deployment record and parses every transaction
# journal it finds, and that scan is the first thing deploy.sh, rollback.sh,
# preflight.sh and adopt-config.sh each do. An aborted record's journal still
# names the release tree it was going to publish, so if that scan resolved those
# paths rather than merely reading them, removing an abandoned release would
# break all four commands at once, everywhere, at their first line. It does not
# -- optional_target() is reached only for the record being committed -- but the
# blast radius of being wrong about that is the whole control plane, so it is
# re-proved here rather than reasoned about.
python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory >/dev/null \
  || { warn "the global authority transaction inventory no longer parses after removal"; recovery_ok=0; }
if [[ -n "$current_release" ]]; then
  safe_release_pointer "$REMOTE_ROOT/current" >/dev/null \
    || { warn "the current release pointer no longer resolves"; recovery_ok=0; }
fi
if [[ -n "$previous_release" ]]; then
  # deploy.sh:1519 and rollback.sh:403 both read this, and transaction.py's
  # direct_child() lstat()s whatever it names.
  safe_release_pointer "$REMOTE_ROOT/previous" >/dev/null \
    || { warn "the previous release pointer no longer resolves; deploy and rollback both publish authority through it"; recovery_ok=0; }
fi
if [[ -n "$current_deployment" ]]; then
  safe_deployment_pointer "$REMOTE_ROOT/current-deployment" >/dev/null \
    || { warn "the current-deployment pointer no longer resolves"; recovery_ok=0; }
  baseline="$BACKUP_ROOT/$(basename -- "$current_deployment")"
  [[ -d "$baseline" && -f "$baseline/SHA256SUMS" && -f "$baseline/invariants.tsv" \
    && -f "$baseline/BACKUP_MANIFEST.json" ]] \
    || { warn "the current deployment's rollback baseline backup is incomplete or gone: $baseline"; recovery_ok=0; }
  (cd "$baseline" && sha256sum -c SHA256SUMS >/dev/null) \
    || { warn "the current deployment's rollback baseline backup no longer verifies: $baseline"; recovery_ok=0; }
  target_record="$(tr -d '\r\n' <"$current_deployment/old-current-deployment" 2>/dev/null || true)"
  if [[ -n "$target_record" ]]; then
    target_backup="$BACKUP_ROOT/$(basename -- "$target_record")"
    [[ -d "$target_record" && -d "$target_backup" && -f "$target_backup/SHA256SUMS" ]] \
      || { warn "the rollback target's record or backup is missing: $target_record"; recovery_ok=0; }
    target_release="$(tr -d '\r\n' <"$current_deployment/old-current" 2>/dev/null || true)"
    [[ -z "$target_release" || -d "$target_release" ]] \
      || { warn "the rollback target release tree is missing: $target_release"; recovery_ok=0; }
  fi
fi
current_newest="$(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name SHA256SUMS \
  -printf '%T@\t%h\n' | LC_ALL=C sort -n | tail -n 1 | cut -f2-)"
[[ "$current_newest" == "$newest_backup" ]] \
  || { warn "the newest verified backup drift.sh selects has changed: was $newest_backup, now $current_newest"; recovery_ok=0; }

available_kb="$(df -Pk /home/anders | awk 'NR==2 {print $4}')"
if ((json)); then
  python3 - "$removed_backups" "$removed_releases" "$removed_bytes" "$available_kb" "$recovery_ok" <<'PY'
import json, sys
backups, releases, freed, available, ok = sys.argv[1:]
print(json.dumps({
    "ok": ok == "1", "removedBackups": int(backups), "removedReleases": int(releases),
    "freedBytes": int(freed), "availableKiB": int(available),
}, sort_keys=True, separators=(",", ":")))
PY
else
  log "removed $removed_backups backup(s) and $removed_releases release tree(s); $((removed_bytes / 1024 / 1024)) MiB reclaimed, ${available_kb} KiB now free on /home/anders"
fi
((recovery_ok)) || fail "state retention completed its removals but a recovery-path post-condition FAILED; treat production as un-rollbackable until the warnings above are resolved"
