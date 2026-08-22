#!/usr/bin/bash
# The supported path for a legitimate protected-configuration change.
#
# `verify_configuration_evidence` refuses a deploy when any protected input
# moved. That is correct, and nothing here relaxes it. What was missing was a
# way to say "yes, I changed /etc/penumbra, here is exactly what moved and why"
# and have the deployment record learn it -- so the only remaining option was to
# hand-edit a digest row, which is the act the control exists to prevent.
#
# This entry point does the privileged reading (protected roots need sudo, the
# rendered Compose model needs docker) and hands pure files to adopt-config.py,
# which owns every decision and is testable against a fixture with neither.
#
# It is deliberately NOT part of any deploy path:
#   * it holds the same deployment lock deploy.sh, backup.sh and rollback.sh
#     take, so it cannot run alongside one;
#   * it refuses outright if a deploy, rollback, preflight, backup or canary
#     driver is anywhere in its process ancestry;
#   * nothing in the deploy path references it, and an acceptance test pins that;
#   * it has no option that skips, relaxes or disables a comparison -- after an
#     adoption it re-runs the REAL gate, verify_configuration_evidence, against
#     every record it touched and fails if that gate is not satisfied.
set -euo pipefail
remote_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$remote_dir/common.sh"

baseline=all
confirm=0
reason=""
expect_plan=""
show_all=0
json=0
usage() {
  cat >&2 <<'EOF'
usage: adopt-config [--baseline all|pending|current] [--show-all] [--json]
                    [--confirm --reason TEXT [--expect-plan TOKEN]]

Without --confirm this only PLANS: it recomputes the live protected
configuration evidence, prints every row that differs from each relevant
deployment record, and changes nothing.
EOF
  exit 64
}
while (($#)); do
  case "$1" in
    --baseline) (($# >= 2)) || usage; baseline="$2"; shift 2 ;;
    --confirm) confirm=1; shift ;;
    --reason) (($# >= 2)) || usage; reason="$2"; shift 2 ;;
    --expect-plan) (($# >= 2)) || usage; expect_plan="$2"; shift 2 ;;
    --show-all) show_all=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
case "$baseline" in all|pending|current) ;; *) usage ;; esac
[[ -z "$expect_plan" || "$expect_plan" =~ ^[0-9a-f]{64}$ ]] || usage_fail "--expect-plan must be a plan token"
((confirm)) || [[ -z "$reason" ]] || usage_fail "--reason is only meaningful with --confirm"

# NEVER FROM INSIDE A DEPLOY. The lock below already makes it impossible for
# this to run while deploy.sh holds it, but a driver that invoked this between
# its own lock acquisitions would slip past that, so the ancestry is checked
# too. Adoption is an operator decision taken with a deploy stopped; it is not a
# step any automated path may take on its own.
# What counts as "a driver is running me" is the PROGRAM an ancestor is
# executing, never a substring of its command line. Every driver on this host is
# launched as `exec bash <path-to-driver> ...` (lib/local.sh:117, :348, :451),
# so the interpreter and the script it was handed are the first two words of
# argv and their basenames are the only precise signal available from `ps`.
#
# Matching anywhere in the command line instead looked stricter and was strictly
# worse: an operator shell that had merely TYPED one of these names -- `less
# deploy.sh`, a for-loop over the driver files, the ssh command line that
# mentions one -- would be refused, and it would be refused in exactly the shell
# an operator is sitting in when a deploy has just failed and this tool is the
# way out. A control that is unavailable at 2am is the hand-edit again.
assert_not_inside_deployment_driver() {
  local drivers=(deploy.sh rollback.sh preflight.sh backup.sh canary.sh drift.sh)
  local pid="$$" parent command word driver examined
  local -a words
  while [[ -n "$pid" && "$pid" != 0 && "$pid" != 1 ]]; do
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || break
    [[ -n "$parent" && "$parent" != "$pid" ]] || break
    command="$(ps -o args= -p "$parent" 2>/dev/null || true)"
    # The interpreter and the script it was handed: the first two words that are
    # not interpreter options, so `bash -x /srv/.../deploy.sh` is caught and
    # `less notes/deploy.sh` is not. Everything past those is a driver's own
    # arguments and belongs to what it was ASKED to do, not to what it IS.
    # read -ra, not an unquoted expansion: a command line is arbitrary text and
    # must never be glob-expanded against this host's filesystem.
    words=()
    read -ra words <<<"$command" || true
    examined=0
    for word in "${words[@]}"; do
      [[ "$word" == -* ]] && continue
      ((examined += 1))
      ((examined <= 2)) || break
      for driver in "${drivers[@]}"; do
        [[ "${word##*/}" == "$driver" ]] || continue
        fail "protected configuration adoption refuses to run inside a deployment driver ($command); run it on its own, with no deploy in flight"
      done
    done
    pid="$parent"
  done
}

assert_target
assert_remote_root
for command in docker python3 sudo sha256sum stat readlink ps; do need "$command"; done
assert_not_inside_deployment_driver

driver="$remote_dir/adopt-config.py"
[[ -f "$driver" && ! -L "$driver" ]] || fail "protected configuration adoption driver is missing or unsafe"
transaction_driver="$remote_dir/transaction.py"
[[ -f "$transaction_driver" && ! -L "$transaction_driver" ]] || fail "authority transaction helper is missing or unsafe"

# The same lock deploy.sh takes at its line 52. Holding it is what makes "this
# never runs during a deploy" a property of the system rather than a promise.
[[ -d "$REMOTE_ROOT" && ! -L "$REMOTE_ROOT" ]] || fail "canonical deployment root is unsafe"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "a deployment, backup or rollback holds the deployment lock; protected configuration adoption never runs alongside one"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
chmod 700 "$work"

# MIRRORS record_configuration_evidence_with_env in common.sh. Same labels, same
# paths, same order. An acceptance test compares the two lists, because a label
# that exists here and not there (or the reverse) would silently drop the
# per-file explanation for exactly the row an operator is staring at.
protected_configuration_paths() {
  cat <<EOF
edge.security	$LEGACY_EDGE_DIR
attestation.security	$PRODUCTION_ATTEST_DIR
device-user.security	$PRODUCTION_DUC_DIR
keycloak.theme	$PRODUCTION_KEYCLOAK_THEME_DIR
bridge.config	/etc/penumbra
bridge.state	/var/lib/penumbra-center
bridge.unit	/etc/systemd/system/penumbra-center-bridge.service
EOF
}

# Per-file fingerprints under every protected root, so a changed directory can
# be reported as "center-bridge.env moved" rather than "a digest moved". Only
# names, metadata and digests are captured -- never a protected value -- which
# is the same rule record_configuration_evidence_with_env follows.
capture_protected_inventory() {
  local output="$1" pairs=() label path
  while IFS=$'\t' read -r label path; do
    [[ -n "$label" ]] || continue
    pairs+=("$label=$path")
  done < <(protected_configuration_paths)
  sudo -n python3 - "${pairs[@]}" >"$output" <<'PY'
import hashlib, os, stat, sys

def emit(label, relative, kind, metadata, size, digest):
    print(f"{label}\t{relative}\t{kind}\t{stat.S_IMODE(metadata.st_mode):o}\t"
          f"{metadata.st_uid}:{metadata.st_gid}\t{size}\t{digest}\t{metadata.st_mtime_ns}")

def visit(label, path, relative):
    if "\t" in relative or "\n" in relative:
        raise SystemExit(f"protected path name is not representable: {relative!r}")
    metadata = os.lstat(path)
    mode = metadata.st_mode
    if stat.S_ISREG(mode):
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        emit(label, relative, "reg", metadata, metadata.st_size, digest.hexdigest())
    elif stat.S_ISLNK(mode):
        target = os.readlink(path)
        emit(label, relative, "lnk", metadata, len(target),
             hashlib.sha256(target.encode()).hexdigest())
    elif stat.S_ISDIR(mode):
        emit(label, relative, "dir", metadata, 0, "-")
        for name in sorted(os.listdir(path)):
            visit(label, os.path.join(path, name), os.path.join(relative, name))
    else:
        emit(label, relative, "other", metadata, 0, "-")

for pair in sys.argv[1:]:
    label, _, root = pair.partition("=")
    root = os.path.abspath(root)
    # A root that is absent is not this tool's problem to report: the digest
    # comparison already fails loudly for it, and inventing an inventory for a
    # path that is not there would be a second, quieter answer.
    if not os.path.lexists(root):
        continue
    visit(label, root, ".")
PY
}

baselines_json="$work/baselines.jsonl"
: >"$baselines_json"

emit_baseline() {
  local kind="$1" record="$2" release_dir="$3" release_id="$4" evidence="$5" live="$6"
  python3 - "$kind" "$record" "$release_dir" "$release_id" "$evidence" "$live" >>"$baselines_json" <<'PY'
import json, sys
kind, record, release_dir, release_id, evidence, live = sys.argv[1:]
print(json.dumps({
    "kind": kind, "record": record, "releaseDir": release_dir, "releaseId": release_id,
    "evidence": evidence, "live": live,
}, sort_keys=True, separators=(",", ":")))
PY
}

# Freshly recorded live evidence for ONE release. Recorded per baseline and not
# shared, because the `rendered compose.json` row is a function of the release
# tree: a pending record and the current deployment can point at different
# releases, and comparing either against the other's rendering would report a
# difference that is not one.
record_live_evidence() {
  local release_dir="$1" output="$2"
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || fail "release tree is missing or unsafe: $release_dir"
  record_configuration_evidence "$release_dir" "$output"
}

resolved_any=0

# ── the pending/armed record ────────────────────────────────────────────────
#
# THE BASELINE THAT ACTUALLY BLOCKS THE NEXT DEPLOY. If a transaction is durably
# prepared, preflight.sh's pending branch and deploy.sh's resume path verify
# THIS record's config-digests.tsv, and they do it before deploy.sh:1384 ever
# compares current-deployment. Adopting into current-deployment while this
# exists changes a file the failing gate does not read.
#
# RESOLVED UNCONDITIONALLY, INCLUDING FOR --baseline current. `--baseline
# current` used to skip this block entirely, so an operator who chose it while a
# transaction was armed got a clean "adopted" for a file the failing gate never
# reads and no mention that the record which does block the deploy exists. That
# is the wrong-baseline hour of the night this tool was written, reproduced by a
# flag. Below, `current` refuses rather than succeeds quietly when a pending
# record with configuration evidence is present.
if true; then
  inventory_json="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
    || fail "authority transaction inventory is invalid"
  # Captured into a variable first, deliberately. Reading this straight into
  # mapfile through a process substitution would turn a REJECTED inventory into
  # an empty one, and an empty one reads as "no transaction is pending" -- which
  # is the single worst thing this tool could conclude wrongly.
  pending_tsv="$(python3 - "$inventory_json" <<'PY'
import json, sys
body = json.loads(sys.argv[1])
assert body.get("schemaVersion") == 1 and isinstance(body.get("active"), list) and len(body["active"]) <= 1
for item in body["active"]:
    assert set(item) == {"namespace", "record"}
    print(f'{item["namespace"]}\t{item["record"]}')
PY
  )" || fail "authority transaction inventory is not in its documented shape; refusing to assume no transaction is pending"
  mapfile -t pending_entries < <(printf '%s' "$pending_tsv")
  if ((${#pending_entries[@]} == 1)); then
    IFS=$'\t' read -r pending_namespace pending_record <<<"${pending_entries[0]}"
    [[ "$pending_namespace" == deploy ]] \
      || fail "a $pending_namespace authority transaction is pending; its configuration evidence is not this tool's to adopt — resume or complete it first"
    [[ -d "$pending_record" && ! -L "$pending_record" && -f "$pending_record/release-id" ]] \
      || fail "pending deployment record is incomplete or unsafe"
    pending_release_id="$(tr -d '\r\n' <"$pending_record/release-id")"
    validate_release_id "$pending_release_id"
    pending_release="$RELEASES_DIR/$pending_release_id"
    if [[ -f "$pending_record/config-digests.tsv" && ! -L "$pending_record/config-digests.tsv" ]]; then
      [[ "$baseline" != current ]] || fail "refusing --baseline current: a deploy transaction is durably prepared at $pending_record and ITS config-digests.tsv is what the resume path verifies first (deploy.sh:722 and :810), before anything compares current-deployment (deploy.sh:1384). Adopting into current-deployment alone would rewrite a file the failing gate does not read. Re-run with --baseline all, or --baseline pending to answer for that record only"
      record_live_evidence "$pending_release" "$work/live-pending.tsv"
      emit_baseline pending "$pending_record" "$pending_release" "$pending_release_id" \
        "$pending_record/config-digests.tsv" "$work/live-pending.tsv"
      resolved_any=1
    else
      # A pre-activation transaction never recorded configuration evidence; the
      # resume path proves predecessor recovery instead of comparing digests.
      # Saying so is the point: silence here would read as "no pending record".
      log "a pre-activation deploy transaction is pending at $pending_record; it carries no configuration evidence, so there is nothing to adopt into it"
    fi
  fi
fi

# ── the canonical current deployment record ─────────────────────────────────
if [[ "$baseline" == all || "$baseline" == current ]]; then
  if current_release="$(safe_release_pointer "$REMOTE_ROOT/current" 2>/dev/null)"; then
    current_record="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment" 2>/dev/null)" \
      || fail "canonical current release lacks a safe deployment record pointer"
    current_release_id="$(basename "$current_release")"
    validate_release_id "$current_release_id"
    [[ "$(tr -d '\r\n' <"$current_record/release-id")" == "$current_release_id" ]] \
      || fail "current release and deployment record disagree"
    [[ -f "$current_record/config-digests.tsv" && ! -L "$current_record/config-digests.tsv" ]] \
      || fail "canonical current deployment record has no safe configuration evidence"
    record_live_evidence "$current_release" "$work/live-current.tsv"
    emit_baseline current "$current_record" "$current_release" "$current_release_id" \
      "$current_record/config-digests.tsv" "$work/live-current.tsv"
    resolved_any=1
  elif [[ "$baseline" == current ]]; then
    fail "there is no canonical current deployment to adopt into"
  fi
fi

((resolved_any)) || fail "no deployment record with configuration evidence was resolved for --baseline $baseline"

capture_protected_inventory "$work/inventory.tsv"
protected_configuration_paths >"$work/protected-paths.tsv"

# One request document, so the driver reads facts rather than re-deriving them.
# The label -> path map comes from protected_configuration_paths above, which is
# the single list both the digest comparison and the per-file explanation read.
python3 - "$baselines_json" "$work/inventory.tsv" "$work/applied.tsv" \
  "$work/protected-paths.tsv" "$work/request.json" <<'PY'
import json, sys
baselines_path, inventory, applied, protected_paths, output = sys.argv[1:]
paths = {}
with open(protected_paths, encoding="utf-8") as handle:
    for line in handle:
        line = line.rstrip("\n")
        if not line:
            continue
        label, _, path = line.partition("\t")
        paths[label] = path
baselines = []
with open(baselines_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        baseline = json.loads(line)
        baseline["protectedPaths"] = paths
        baselines.append(baseline)
request = {
    "schemaVersion": 1,
    "inventory": inventory,
    "appliedList": applied,
    "baselines": baselines,
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(request, handle, sort_keys=True, separators=(",", ":"))
PY

driver_args=(--request "$work/request.json")
((show_all)) && driver_args+=(--show-all)
((json)) && driver_args+=(--json)
[[ -z "$expect_plan" ]] || driver_args+=(--expect-plan "$expect_plan")
if ((confirm)); then
  driver_args+=(--adopt --reason "$reason")
fi

: >"$work/applied.tsv"
python3 "$driver" "${driver_args[@]}"

# THE ADOPTED RECORD IS RE-PROVED BY THE GATE ITSELF. Not by a second opinion
# from this tool: by verify_configuration_evidence, the same function every
# deploy gate calls, against the same record and release. If adoption produced
# anything the gate would still refuse, that is a failure here and now rather
# than a surprise in the middle of the next cutover.
adopted=0
while IFS=$'\t' read -r adopted_record adopted_release; do
  [[ -n "$adopted_record" ]] || continue
  verify_configuration_evidence "$adopted_record/config-digests.tsv" "$adopted_release"
  adopted=$((adopted + 1))
done <"$work/applied.tsv"
if ((adopted > 0 && json == 0)); then
  log "re-proved $adopted adopted record(s) with verify_configuration_evidence"
fi
