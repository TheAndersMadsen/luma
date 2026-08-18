#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/domain.sh"

release_id=""
archive=""
manifest=""
verifier=""
deployment_id=""
crud=0
json=0
usage() {
  echo "usage: deploy --release-id SHA256 --archive PATH --manifest PATH --verifier PATH [--deployment-id ID] [--crud] [--json] [--skip-staging-smoke]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --release-id) (($# >= 2)) || usage; release_id="$2"; shift 2 ;;
    --archive) (($# >= 2)) || usage; archive="$2"; shift 2 ;;
    --manifest) (($# >= 2)) || usage; manifest="$2"; shift 2 ;;
    --verifier) (($# >= 2)) || usage; verifier="$2"; shift 2 ;;
    --deployment-id) (($# >= 2)) || usage; deployment_id="$2"; shift 2 ;;
    --crud) crud=1; shift ;;
    --json) json=1; shift ;;
    # Skip the ISOLATED REHEARSAL only. Everything that actually protects
    # production still runs: the verified backup, the candidate canaries, drift
    # detection, and rollback. The rehearsal is the expensive part — it restores
    # a full copy and exercises it — and when it fails on its own defects rather
    # than the candidate's, it costs a full outage window for nothing. This flag
    # exists so iterating on a release does not require paying that repeatedly;
    # it is recorded in the deployment record so a release that skipped it is
    # never mistaken for one that passed it.
    --skip-staging-smoke) skip_staging_smoke=1; shift ;;
    *) usage ;;
  esac
done
skip_staging_smoke="${skip_staging_smoke:-0}"
validate_release_id "$release_id"
[[ -n "$deployment_id" ]] || deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-${release_id:0:12}"
[[ "$deployment_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage
[[ -f "$archive" && -f "$manifest" && -f "$verifier" ]] || usage
[[ "$archive" == "$REMOTE_ROOT/incoming/$release_id/"* ]] || fail "archive is outside the guarded incoming directory"
[[ "$manifest" == "$REMOTE_ROOT/incoming/$release_id/"* ]] || fail "manifest is outside the guarded incoming directory"
[[ "$verifier" == "$REMOTE_ROOT/incoming/$release_id/"* ]] || fail "verifier is outside the guarded incoming directory"
((crud == 0)) || fail "mutating CRUD canaries are disabled; use the read-only production canary"

assert_target
assert_remote_root
for command in docker python3 node flock openssl curl sha256sum cmp systemctl sync pgrep readlink; do need "$command"; done
ensure_layout
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another deployment or backup holds the lock"
assert_durable_inputs
assert_active_durable_mounts

bootstrap_transaction_driver="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/transaction.py"
[[ -f "$bootstrap_transaction_driver" && ! -L "$bootstrap_transaction_driver" ]] \
  || fail "global authority transaction helper is missing or unsafe"
bootstrap_inventory="$(python3 "$bootstrap_transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
  || fail "global authority transaction inventory is invalid"
bootstrap_pending_namespace="$(python3 - "$bootstrap_inventory" <<'PY'
import json,sys
body=json.loads(sys.argv[1]); active=body.get("active")
assert body.get("schemaVersion")==1 and isinstance(active,list) and len(active)<=1
print("" if not active else active[0]["namespace"])
PY
)"
[[ "$bootstrap_pending_namespace" != rollback ]] \
  || fail "a rollback authority transaction is pending and must be resumed before deployment"

record="$DEPLOYMENTS_DIR/$deployment_id"
[[ ! -e "$record" ]] || fail "deployment id already exists"
mkdir -p "$record"
chmod 700 "$record"
printf '%s\n' "$release_id" >"$record/release-id"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/started-at"
chmod 600 "$record/release-id" "$record/started-at"

release_dir="$RELEASES_DIR/$release_id"
incoming_release="$RELEASES_DIR/.${release_id}.incoming"
verification="$record/package-verification.json"
[[ ! -e "$incoming_release" ]] || fail "stale incoming release exists"
if [[ -d "$release_dir" ]]; then
  python3 "$verifier" --archive "$archive" --manifest "$manifest" --json >"$verification"
  python3 "$verifier" --tree "$release_dir" --manifest "$manifest" --json >>"$verification"
else
  python3 "$verifier" --archive "$archive" --manifest "$manifest" --extract "$incoming_release" --json >"$verification" \
    || { rm -rf -- "$incoming_release"; fail "release archive verification failed"; }
fi
if ! python3 - "$verification" "$release_id" <<'PY'
import json,sys
lines=[line for line in open(sys.argv[1],encoding="utf-8") if line.strip()]
assert lines
for line in lines:
    result=json.loads(line)
    assert result.get("ok") is True
    assert result.get("profile")=="vps"
    assert result.get("releaseId")==sys.argv[2]
PY
then
  [[ ! -e "$incoming_release" ]] || rm -rf -- "$incoming_release"
  fail "verified package identity does not match the requested release"
fi
if [[ ! -d "$release_dir" ]]; then mv "$incoming_release" "$release_dir"; fi
chmod 600 "$verification"
if [[ -f "$MANIFESTS_DIR/$release_id.json" ]]; then
  cmp -s "$manifest" "$MANIFESTS_DIR/$release_id.json" || fail "stored manifest conflicts with the verified release"
else
  install -m 600 "$manifest" "$MANIFESTS_DIR/$release_id.json"
fi
if [[ -f "$PACKAGES_DIR/$release_id.tar.gz" ]]; then
  cmp -s "$archive" "$PACKAGES_DIR/$release_id.tar.gz" || fail "stored package conflicts with the verified release"
else
  install -m 600 "$archive" "$PACKAGES_DIR/$release_id.tar.gz"
fi
# Auditable evidence for the exact selected-package code that is executing the
# cutover. Package verification proves membership; this record makes that
# execution binding explicit without retaining mutable bootstrap copies.
driver_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
common_path="$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")/common.sh")"
domain_path="$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")/domain.sh")"
domain_helper_path="$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")/domain.py")"
incoming_release_dir="$REMOTE_ROOT/incoming/$release_id"
[[ "$driver_path" == "$REMOTE_ROOT/incoming/$release_id/verified-driver/platform/deploy/vps/remote/deploy.sh" ]] \
  || fail "deployment driver is not the selected verified release copy"
[[ "$common_path" == "$REMOTE_ROOT/incoming/$release_id/verified-driver/platform/deploy/vps/remote/common.sh" ]] \
  || fail "common deployment library is not the selected verified release copy"
[[ "$domain_path" == "$REMOTE_ROOT/incoming/$release_id/verified-driver/platform/deploy/vps/remote/domain.sh" ]] \
  || fail "domain transaction library is not the selected verified release copy"
[[ "$domain_helper_path" == "$REMOTE_ROOT/incoming/$release_id/verified-driver/platform/deploy/vps/remote/domain.py" ]] \
  || fail "domain transaction helper is not the selected verified release copy"
: >"$record/executing-code.tsv"
for spec in "remote.deploy:$driver_path" "remote.common:$common_path" "remote.domain:$domain_path" \
  "remote.domain-helper:$domain_helper_path" "release.verifier:$verifier"; do
  label="${spec%%:*}"; path="${spec#*:}"
  [[ -f "$path" && ! -L "$path" ]] || fail "executing deployment material is missing or unsafe: $label"
  printf '%s\t%s\t%s\n' "$label" "$(sha256sum "$path" | awk '{print $1}')" "$(stat -c '%a' "$path")" \
    >>"$record/executing-code.tsv"
done
for common_lib in "$(dirname -- "$common_path")"/lib/*.sh; do
  [[ -f "$common_lib" && ! -L "$common_lib" ]] || fail "common library material is missing or unsafe"
  printf 'remote.common-lib.%s\t%s\t%s\n' "$(basename "$common_lib")" \
    "$(sha256sum "$common_lib" | awk '{print $1}')" "$(stat -c '%a' "$common_lib")" \
    >>"$record/executing-code.tsv"
done
chmod 600 "$record/executing-code.tsv"
release_verifier="$release_dir/platform/deploy/vps/verify-release.py"
[[ -f "$release_verifier" && ! -L "$release_verifier" ]] || fail "selected release verifier is missing"
transaction_driver="$release_dir/platform/deploy/vps/remote/transaction.py"
[[ -f "$transaction_driver" && ! -L "$transaction_driver" ]] || fail "selected release transaction helper is missing"

record_keycloak_post_migration_evidence() {
  local target_record="$1" data digest temporary postgres
  data="$target_record/keycloak-post-migration-data.tsv"
  digest="$target_record/keycloak-post-migration-data.sha256"
  if [[ -f "$digest" ]]; then
    verify_keycloak_post_migration_evidence "$target_record"
    return
  fi
  [[ ! -e "$digest" && ! -L "$digest" ]] || return 1
  if [[ ! -f "$data" ]]; then
    [[ ! -e "$data" && ! -L "$data" ]] || return 1
    temporary="$(mktemp "$target_record/.keycloak-post-migration-data.XXXXXX")"
    postgres="$("${COMPOSE[@]}" ps -q postgres)"
    [[ -n "$postgres" ]] || { rm -f -- "$temporary"; return 1; }
    capture_postgres_data "$postgres" cosmos "$temporary" \
      || { rm -f -- "$temporary"; return 1; }
    chmod 600 "$temporary"
    mv "$temporary" "$data"
    sync -f "$data"
  fi
  temporary="$(mktemp "$target_record/.keycloak-post-migration-digest.XXXXXX")"
  (cd "$target_record" && sha256sum keycloak-post-migration-data.tsv) >"$temporary" \
    || { rm -f -- "$temporary"; return 1; }
  chmod 600 "$temporary"
  mv "$temporary" "$digest"
  sync -f "$digest"
  verify_keycloak_post_migration_evidence "$target_record"
}

# THE PRE-COMMIT ZERO-DELTA COMPARISON: mutable compatibility state captured
# BEFORE the candidate started, against the same state captured AFTER it started
# and ran its migrations. Two call sites use it — the normal cutover and the
# precommit-resume path — and they must not drift apart, which is why this is one
# function.
#
# WHY THE TWO MOVING MANIFESTS ARE PASSED AS PATHS rather than read out of the two
# backup directories. In the normal cutover both backups are taken by THIS
# release's backup.sh, so both sides contain this release's projected data manifest
# and its retained-text schema manifest, and the paths are simply the two
# backups'. In the precommit-resume path the post-candidate backup is taken by the
# PENDING release's backup.sh — it has to be, because its other artifacts are
# compared byte-for-byte against a baseline that same code produced — and that
# release cannot be asked for evidence in a format it predates. So the resume
# captures those two manifests itself, with this release's helpers, and hands them
# in here. The COMPARISONS BELOW ARE IDENTICAL either way; only the provenance of
# the two files differs, and each is produced by the newest code that can produce
# both sides of its own comparison.
#
# AN ADDITIVE MIGRATION DOES NOT AFFECT THESE FILES UNIFORMLY, and assuming it did
# is what stopped three deploys:
#
#   postgres-data.tsv       MOVES. `to_jsonb(t)` encodes the SCHEMA as well as the
#       data, so `ADD COLUMN IF NOT EXISTS` rewrites every row's JSON without a
#       single wearer byte moving. Handled at CAPTURE time rather than here: the
#       caller takes the post-candidate backup with --data-columns-source pointing
#       at the pre-candidate backup's relation-column sidecar, so both manifests
#       are digested over the same column sets and this stays a plain byte
#       comparison. A changed value, an appearing or vanishing row, and a DROPPED
#       column all still fail — the projection only hides columns that did not
#       exist before.
#   postgres-schema.tsv     MOVES, and must: here the schema IS the subject, so
#       there is nothing to project away. Byte equality is still what decides
#       whether anything changed; only after it fails is the delta handed to
#       classify_schema_delta, which either proves it non-destructive and names
#       what it allowed, or refuses and names the object it refused.
#   postgres-security.json  does NOT move for the additive changes this project
#       permits. capture_postgres_security enumerates relations of kind r/p/v/m/S/f
#       — an index is kind 'i', so CREATE INDEX is invisible to it — and column
#       ACLs only where attacl is set, which a freshly added column has not. A
#       brand-new TABLE would move it, and that is deliberately left to fail: a new
#       relation's owner and grants are a security decision and nothing here proves
#       them safe. Byte-exact on purpose.
#   cosmos-state.inventory.json, bridge-inventory.{before,after}.json  do not move:
#       they describe files on disk, not the database. Byte-exact.
# KEYCLOAK'S SESSION STORAGE, AND WHY IT IS THE ONE THING NOT COMPARED.
#
# The zero-delta gate proves the candidate did not move WEARER DATA across the
# activation window. Keycloak's session tables are not wearer data: they are
# mutated by ANY authentication, and the only thing that can authenticate inside
# a quiesced window is this deploy's own wearer canary, which signs in after the
# candidate is up and before this comparison runs.
#
# Keycloak 25+ persists ONLINE sessions in the offline_* tables, so that login
# moves them every single time. Measured on this host: 15 -> 16 rows on login,
# and Center's RP-initiated logout does NOT remove the row (it clears the local
# cookies and returns an end-session URL for a browser to navigate). Ordering
# cannot avoid it either — the baseline is pre-candidate by construction and the
# canary is necessarily post-candidate.
#
# So comparing these two relations measures the deploy's own instrument and fails
# every resume for it. They are excluded HERE AND NOWHERE ELSE: every cosmos
# relation and every other keycloak relation is still compared byte-for-byte, and
# the schema comparison beside this one is untouched. The cost is that a candidate
# which corrupted session rows would not be caught by this gate; sessions are
# ephemeral auth state that any sign-in rewrites, which is a different and far
# smaller class of harm than the data loss this gate exists to prevent.
zero_delta_volatile_filtered() {
  local manifest="$1" destination="$2"
  awk -F'\t' 'NF < 3 || !($1 == "keycloak" && $2 == "public" \
    && ($3 == "offline_user_session" || $3 == "offline_client_session"))' \
    "$manifest" >"$destination"
}

compare_precommit_compatibility_state() {
  local before="$1" after="$2" context="$3" data_after="$4" schema_before="$5" schema_after="$6" name
  for name in postgres-security.json \
    cosmos-state.inventory.json bridge-inventory.before.json bridge-inventory.after.json; do
    cmp -s "$before/$name" "$after/$name" || fail "$context: $name"
  done
  local volatile_work
  volatile_work="$(mktemp -d)"
  chmod 700 "$volatile_work"
  zero_delta_volatile_filtered "$before/postgres-data.tsv" "$volatile_work/before.tsv"
  zero_delta_volatile_filtered "$data_after" "$volatile_work/after.tsv"
  if ! cmp -s "$volatile_work/before.tsv" "$volatile_work/after.tsv"; then
    rm -rf -- "$volatile_work"
    fail "$context: postgres-data.tsv"
  fi
  rm -rf -- "$volatile_work"
  compare_schema_manifests "$schema_before" "$schema_after" "$context"
}

# The --data-columns-source arguments for a post-candidate backup, given the
# pre-candidate backup it will be compared against. Empty when that backup predates
# the sidecar: the capture then falls back to the live column list and an additive
# migration fails the comparison above — refusing, never silently passing.
#
# SAME-RELEASE ONLY. --data-columns-source is this release's option, so it may be
# passed only to this release's backup.sh ("$release_dir"). The resume path drives
# a POSSIBLY OLDER backup.sh and must not pass it; it captures its own projected
# manifest instead (capture_resume_candidate_evidence below).
precommit_projection_args() {
  local baseline="$1"
  [[ -f "$baseline/postgres-data.tsv.columns" && ! -L "$baseline/postgres-data.tsv.columns" ]] || return 0
  printf '%s\n%s\n' --data-columns-source "$baseline/postgres-data.tsv.columns"
}

# The post-candidate half of the resume's zero-delta proof, captured by THIS
# release from the same quiesced cluster the resume backup has just archived.
#
# Nothing here is a substitute for that backup: it still runs, still restore-tests
# itself, and still supplies every artifact the comparison takes byte-exactly
# (postgres-security.json, the cosmos and bridge inventories) — those must come
# from the same code that produced the baseline or the byte comparison is
# meaningless. What it cannot supply is evidence in a format it predates, and
# there are exactly two such files:
#
#   the DATA manifest, which must be digested over the PRE-candidate column list
#       or an added column moves every row's digest (to_jsonb encodes the schema);
#   the SCHEMA manifest, which must retain its pg_dump text or a digest delta can
#       only be refused, never classified.
#
# Both are captured with common.sh's canonical producers, byte-identical to the
# ones the pending release used for the baseline, so the two sides remain
# comparable. The capture point is safe: the backup ran --leave-quiesced, so every
# writer and the bridge are still stopped and only PostgreSQL is up — the cluster
# cannot have moved between its capture and this one.
#
# "$baseline" is the RESUME'S OWN pre-candidate backup, not the record's original
# one: the column list a digest is narrowed to must be the one in force on the
# before-side of the comparison this evidence is for.
capture_resume_candidate_evidence() {
  local work="$1" baseline="$2" columns_source="" postgres
  [[ -d "$work" && ! -L "$work" ]] || return 1
  # Empty when the baseline predates the sidecar, exactly as precommit_projection_args
  # is: the capture then falls back to the live column list and an additive
  # migration fails the comparison — refusing, never silently passing. Validated
  # before it can narrow a digest.
  if [[ -f "$baseline/postgres-data.tsv.columns" && ! -L "$baseline/postgres-data.tsv.columns" ]]; then
    validate_relation_column_sidecar "$baseline/postgres-data.tsv.columns"
    columns_source="$baseline/postgres-data.tsv.columns"
  fi
  postgres="$(find_postgres_container)"
  capture_postgres_data "$postgres" cosmos "$work/candidate-data.tsv" "$columns_source"
  capture_postgres_schema "$postgres" cosmos "$work/candidate-schema.tsv" retain-sql
}

# The pre-candidate schema manifest the resume classifies against, WITH the
# retained pg_dump text beside it — which is what classify_schema_delta needs and
# what a baseline taken by a release older than retain-sql does not have.
#
# "$baseline" here is the RESUME'S OWN pre-candidate backup, captured after
# re-quiescing (see the resume path); the record's original backup is the rollback
# baseline and is not what the candidate is measured against.
#
# It is not re-derivable: the pre-candidate dump cannot be re-taken once the
# candidate has migrated. It can, however, be RECOVERED, because the isolated
# staging rehearsal captured this cluster at the transaction's original
# pre-candidate boundary and kept its text. Provenance is not what makes that
# acceptable — binding is: read_dump refuses any retained text that does not
# reproduce the exact digest, byte count and line count of the manifest THE GATE
# COMPARES, which is the baseline's own, copied here byte-for-byte. Text from the
# wrong cluster, the wrong boundary or a later edit cannot survive that check — so
# the rehearsal's text is usable exactly when the schema has not moved since, and
# is refused by name when it has.
#
# When neither source has the text, no sidecar is written and the classifier
# refuses by name. That is the safe direction and it is deliberate: an additive
# migration then blocks the resume instead of passing unexamined.
resume_baseline_schema_manifest() {
  local baseline="$1" record="$2" work="$3" manifest database source
  manifest="$work/baseline-schema.tsv"
  [[ -f "$baseline/postgres-schema.tsv" && ! -L "$baseline/postgres-schema.tsv" ]] || return 1
  install -m 600 "$baseline/postgres-schema.tsv" "$manifest" || return 1
  cmp -s "$baseline/postgres-schema.tsv" "$manifest" || return 1
  for database in cosmos keycloak; do
    source=""
    if [[ -f "$baseline/postgres-schema.tsv.$database.sql" \
      && ! -L "$baseline/postgres-schema.tsv.$database.sql" ]]; then
      source="$baseline/postgres-schema.tsv.$database.sql"
    elif [[ -f "$record/staging-smoke-evidence/postgres-schema.before.tsv.$database.sql" \
      && ! -L "$record/staging-smoke-evidence/postgres-schema.before.tsv.$database.sql" ]]; then
      source="$record/staging-smoke-evidence/postgres-schema.before.tsv.$database.sql"
    fi
    [[ -n "$source" ]] || continue
    install -m 600 "$source" "$manifest.$database.sql" || return 1
    cmp -s "$source" "$manifest.$database.sql" || return 1
  done
  printf '%s\n' "$manifest"
}

# The wearer's cost of a release, measured instead of assumed.
#
# quiesce_ingress_services stops the cloudflared user unit, the cloudflared
# system unit, nginx.service and penumbra-center-bridge.service. nginx is the
# HOST's shared web server, so this takes down aipin.andersmadsen.dk,
# connectivity-check.cosmos.humane.cloud and the default vhost along with this
# project — and the paired Pin, which POSTs a device-status report every five
# minutes to contain-api.andersmadsen.dk, is connection-REFUSED for the entire
# window. Refused, not 502'd: nginx is not running to log it, so the outage
# leaves no server-side trace at all and is reconstructible only by diffing
# access-log timestamps afterwards. The journal on this host shows real windows
# of 3m21s, 3m36s, 9m56s and 10m05s. None of them was budgeted or recorded
# anywhere, and roughly a fifth of device-status reports are lost in bands that
# line up with them.
#
# This records both edges into the deployment record and prints the measured
# window, so the number a wearer paid for a release is a fact in the record
# rather than an inference from log gaps.
#
# Over budget WARNS rather than fails, deliberately: the window is only
# measurable once it has already closed, and aborting an otherwise-accepted
# deployment at that point would reopen it for longer and hand the wearer a
# rollback's window on top of the deploy's. The budget exists to make the cost
# arguable — the actor who can act on it is the operator reading this line and
# the next deploy, not this one.
#
# DEFINED HERE, ABOVE THE RECONCILE, AND NOT BESIDE THE CUTOVER STATE IT USED TO
# SIT WITH. The reconcile of a pending transaction quiesces exactly the same four
# units and can hold them down for MINUTES — on 2026-08-11 an armed-transaction
# resume kept the edge closed from 21:04:37Z to 21:17:45Z, a 788s outage — and it
# runs before the old definition point, so calling these from there was a
# "command not found" away rather than a measurement. That resume recorded
# nothing at all: the deployment's PUBLIC_INGRESS_WINDOW showed 950s for a night
# in which the wearer actually lost about 1738s across two windows, and the
# budget line under-reported by more than the budget itself.
#
# WHY 480 AND NOT 420, WHICH THIS SAID UNTIL THE PHASES WERE ACTUALLY MEASURED.
#
# 420 was never a number the sequence below could hit. It was set before the
# window was instrumented, against the reconstructed access-log bands above, and
# nothing ever checked it against the cost of the phases that must observe a
# quiesced state. Measured on deployment 20260812T140840Z — this release's code,
# with both landed optimisations (archive_inventory sequential reads,
# capture_postgres_data batched sessions) already in it — from the deployment
# record's own marker mtimes and its two backup directories:
#
#   pre-candidate restore-proven backup (--leave-quiesced)          80.4s
#   quiesce the four ingress units + isolated staging smoke        130.7s
#   stop containers, install config/Nginx/Cloudflare route, arm      7.5s
#   candidate up -d, image+config evidence, precommit canary,
#     bridge start                                                  69.6s
#   post-candidate (zero-delta) restore-proven backup               81.6s
#   seal checks, zero-delta compares, candidate restart,
#     Keycloak client migration + post-migration evidence           37.6s
#   desired-state verifies, two quiesced canaries, restore ingress  ~43s
#                                                                  ------
#                                                                  450.4s
#
# The last row is derived rather than directly observed, because that deployment
# failed 44s into it and went CANDIDATE_ACTIVATION_PENDING at 451s instead of
# closing its window normally. The resume path runs the same trailing sequence:
# on 20260812T143047Z it spent 80s from precommit-resume-evidence to the window
# close, of which the compares/restart/Keycloak part is the 37.6s row above.
# The second current-code observation, 20260812T130434Z, runs the first three
# rows ~6s slower, which puts a clean single-run cutover at 450-456s.
#
# So the honest floor of ONE fully successful cutover window on this code is
# ~456s, and 420 sat below it. Nothing in the table can leave the window without
# a gate proving less than it proves today: the pre-candidate backup IS the step
# that stops the writers, the staging smoke is anchored on that backup and
# reopening the edge for it readmits the Pin's device-status POSTs and Keycloak's
# own session writes into the zero-delta comparison (see the long WHY beside the
# rehearsal), the candidate must never receive public ingress before the
# precommit canary passes, and the post-candidate backup defines the zero-delta
# boundary the commit is argued from.
#
# 480s is that floor plus about 5% headroom, and it is a number with a unit
# rather than a round one: the Pin reports device status every 300s, so 480 caps
# the loss at two reports — which is what the warn below already counts in. 420
# claimed to cap it at one, and the sequence has never supported that.
PUBLIC_INGRESS_BUDGET_SECONDS=480

# Edges of the public-ingress outage this deployment imposes on the wearer. All
# three stay empty until something actually quiesces the edge, so a deploy that
# failed before quiescence reports no window rather than a fabricated zero.
public_ingress_quiesce_epoch=""
public_ingress_quiesce_utc=""
public_ingress_window_seconds=""

open_public_ingress_window() {
  # Idempotent. Recovery calls this from a state where the window is usually
  # STILL open — the deployment failed before ingress was restored — and
  # restarting the clock there would discard the whole outage so far and report
  # only the recovery's tail, which is the flattering half.
  [[ -z "$public_ingress_quiesce_epoch" ]] || return 0
  public_ingress_quiesce_epoch="$(date -u +%s)"
  public_ingress_quiesce_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# Closes the open window and appends it to the record. One row per window, and
# the running total, because a deployment that fails AFTER public acceptance
# re-quiesces during recovery and opens a second one — reporting only the first
# would understate what the wearer lost by exactly the part that went wrong.
# Row shape: window<TAB>startedUtc<TAB>endedUtc<TAB>seconds<TAB>cumulative<TAB>budget
record_public_ingress_window() {
  local ended_epoch ended_utc elapsed total existing=""
  [[ -n "$public_ingress_quiesce_epoch" ]] || return 0
  ended_epoch="$(date -u +%s)"
  ended_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  elapsed=$((ended_epoch - public_ingress_quiesce_epoch))
  total=$((${public_ingress_window_seconds:-0} + elapsed))
  [[ ! -f "$record/PUBLIC_INGRESS_WINDOW" ]] || existing="$(cat "$record/PUBLIC_INGRESS_WINDOW")"
  {
    [[ -z "$existing" ]] || printf '%s\n' "$existing"
    printf 'window\t%s\t%s\t%s\t%s\t%s\n' "$public_ingress_quiesce_utc" "$ended_utc" \
      "$elapsed" "$total" "$PUBLIC_INGRESS_BUDGET_SECONDS"
  } >"$record/PUBLIC_INGRESS_WINDOW.tmp"
  chmod 600 "$record/PUBLIC_INGRESS_WINDOW.tmp"
  mv "$record/PUBLIC_INGRESS_WINDOW.tmp" "$record/PUBLIC_INGRESS_WINDOW"
  sync -f "$record/PUBLIC_INGRESS_WINDOW"
  # Clearing the mark is what makes the window "closed": every later exit path
  # tests it, so a second quiescence must call open_public_ingress_window again
  # rather than silently extending this row.
  public_ingress_quiesce_epoch=""
  public_ingress_quiesce_utc=""
  public_ingress_window_seconds="$total"
  log "public ingress was down for ${elapsed}s ($((elapsed / 60))m$((elapsed % 60))s), ending $ended_utc; ${total}s total for this deployment. The paired Pin was connection-refused for that whole window and nothing server-side recorded it"
  # THE BUDGET IS A PER-OPERATION NUMBER READ AGAINST A CUMULATIVE ONE, AND THE
  # DIFFERENCE BETWEEN THE TWO IS THE WHOLE DIAGNOSIS ON A COMPOSITE DEPLOYMENT.
  #
  # PUBLIC_INGRESS_BUDGET_SECONDS is derived from the phase table above: it is
  # what ONE quiesced operation costs. A deployment can legitimately impose more
  # than one — resuming a predecessor's armed transaction and then cutting over
  # is two — and the total is deliberately charged to this record, because the
  # wearer lost both. On 2026-08-12 deployment 20260812T140840Z recorded
  # 310s + 453s = 763s that way: a 310s resume of 20260812T130434Z's pending
  # candidate, then its own 453s cutover. Neither window was anywhere near 763s,
  # and reading only the total makes a deploy that took two ordinary outages look
  # like one catastrophic one.
  #
  # So say both. The total is still what is budgeted — raising the budget to
  # cover a composite would be the fiction, since the wearer really was down that
  # long — but the per-window line names which half to go and look at, and it is
  # printed only when there IS more than one window, because otherwise the two
  # lines are the same number said twice.
  if ((elapsed != total)); then
    ((elapsed <= PUBLIC_INGRESS_BUDGET_SECONDS)) \
      || warn "this single window alone was ${elapsed}s against the ${PUBLIC_INGRESS_BUDGET_SECONDS}s per-operation budget"
    warn "this deployment imposed more than one outage on the wearer; ${elapsed}s of the ${total}s total is this window, and the rest was quiesced before it. Read PUBLIC_INGRESS_WINDOW in the record for the individual rows"
  fi
  ((total <= PUBLIC_INGRESS_BUDGET_SECONDS)) \
    || warn "public ingress window ${total}s exceeded the ${PUBLIC_INGRESS_BUDGET_SECONDS}s budget; the wearer lost roughly $((total / 300)) device-status reports to this deployment"
}

# transaction.py out of the PENDING release tree. See cross_release_baseline_options
# in common.sh: this helper belongs to a possibly-older release and its interface
# must not be assumed, so every argument list is checked against the frozen
# release-boundary baseline before anything runs.
run_pending_transaction() {
  local driver="$1"
  shift
  assert_cross_release_options transaction.py "$@"
  python3 "$driver" "$@"
}

run_pending_transaction_privileged() {
  local driver="$1"
  shift
  assert_cross_release_options transaction.py "$@"
  sudo -n python3 "$driver" "$@"
}

restore_pending_managed_configuration() {
  local target_record="$1" snapshot state name path mode owner digest parent temporary
  snapshot="$target_record/config-before"
  python3 - "$snapshot" "$RUNTIME_ENV" "$COSMOS_ENV" "$PROVIDER_ENV" "$CENTER_ENV" \
    "$PRIVATE_DIR/edge/envoy.yaml" "$PRIVATE_DIR/spotify-adapter/token" <<'PY'
import hashlib,os,stat,sys
root=sys.argv[1]; paths=sys.argv[2:]
names=("runtime.env","cosmos.env","providers.env","center.env","edge-envoy.yaml","spotify-token")
rows={}
for raw in open(os.path.join(root,"presence.tsv"),encoding="utf-8"):
    fields=raw.rstrip("\n").split("\t"); assert len(fields)==6
    state,name,path,mode,owner,digest=fields; assert name not in rows
    rows[name]=(state,path,mode,owner,digest)
assert set(rows)==set(names)
for name,path in zip(names,paths):
    state,recorded,mode,owner,digest=rows[name]; assert recorded==path
    saved=os.path.join(root,name)
    if state=="absent":
        assert (mode,owner,digest)==("-","-","-") and not os.path.lexists(saved)
    else:
        assert state=="present" and os.path.isfile(saved) and not os.path.islink(saved)
        meta=os.stat(saved)
        assert format(stat.S_IMODE(meta.st_mode),"o")==mode
        assert f"{meta.st_uid}:{meta.st_gid}"==owner
        assert hashlib.sha256(open(saved,"rb").read()).hexdigest()==digest
PY
  while IFS=$'\t' read -r state name path mode owner digest; do
    parent="$(dirname -- "$path")"; mkdir -p -- "$parent"
    if [[ "$state" == present ]]; then
      temporary="$(mktemp "$parent/.operation-restore.XXXXXX")"
      cp -a -- "$snapshot/$name" "$temporary" || { rm -f -- "$temporary"; return 1; }
      [[ "$(stat -c '%a' "$temporary")" == "$mode" \
        && "$(stat -c '%u:%g' "$temporary")" == "$owner" \
        && "$(sha256sum "$temporary" | awk '{print $1}')" == "$digest" ]] \
        || { rm -f -- "$temporary"; return 1; }
      mv -f -- "$temporary" "$path" || return 1
    else
      [[ "$state" == absent ]] || return 1
      rm -f -- "$path" || return 1
    fi
  done <"$snapshot/presence.tsv"
}

restore_pending_asset_presence() {
  local target_record="$1" manifest state name path expected
  manifest="$target_record/config-before/assets-presence.tsv"
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  while IFS=$'\t' read -r state name path; do
    case "$name" in
      edge) expected="$PRIVATE_DIR/edge" ;;
      attest) expected="$PRIVATE_DIR/attest" ;;
      duc) expected="$PRIVATE_DIR/duc" ;;
      keycloak-theme) expected="$PRIVATE_DIR/keycloak-theme" ;;
      *) return 1 ;;
    esac
    [[ "$path" == "$expected" ]] || return 1
    case "$state" in
      present) sudo -n test -d "$path" && ! sudo -n test -L "$path" || return 1 ;;
      absent) sudo -n rm -rf -- "$path" || return 1; sudo -n test ! -e "$path" || return 1 ;;
      *) return 1 ;;
    esac
  done <"$manifest"
  [[ "$(wc -l <"$manifest" | tr -d '[:space:]')" == 4 ]]
}

restore_pending_live_mutation() {
  local target_record="$1"
  restore_pending_managed_configuration "$target_record" || return 1
  restore_pending_asset_presence "$target_record" || return 1
  if [[ -f "$target_record/domain-cutover/nginx/SNAPSHOT.json" ]]; then
    domain_nginx_restore "$target_record" validate-only || return 1
  fi
  if [[ -f "$target_record/domain-cutover/cloudflared/JOURNAL.json" ]]; then
    domain_cloudflared_restore "$target_record" || return 1
  fi
  if [[ -f "$target_record/nginx-install/snapshot/PRESENCE.COMPLETE" ]]; then
    restore_nginx_transaction_snapshot "$target_record" 0 validate-only || return 1
  elif [[ -f "$target_record/nginx-install/INSTALL.COMPLETE" ]]; then
    return 1
  fi
}

# Recovery restarts cold containers and reopens ingress moments before the
# semantic probes run; Cloudflare connector re-registration and cold service
# starts need bounded patience or a healthy predecessor reads as failed.
verify_legacy_application_with_patience() {
  local snapshot="$1" attempt
  for attempt in 1 2 3 4 5 6; do
    if verify_legacy_application "$snapshot"; then return 0; fi
    ((attempt < 6)) || break
    sleep 10
  done
  return 1
}

recover_pending_pre_activation_application() {
  local target_record="$1" pending_release="$2"
  local old_current old_deployment old_release_id cookie
  local -a recovery_canary public_canary
  local verify_before_route="domain_cloudflared_verify_before"
  [[ -f "$target_record/before/running-containers.txt" \
    && ! -L "$target_record/before/running-containers.txt" ]] || return 1
  local route_state=recorded
  [[ ! -f "$target_record/domain-cutover/cloudflared/INSTALLED.json" ]] || route_state=desired
  [[ ! -f "$target_record/domain-cutover/cloudflared/RESTORED.json" ]] || route_state=before
  # Recovery re-quiesces, so it is an outage whether or not the resume above had
  # already opened a window. Opening is idempotent, so the usual case — the resume
  # failed with the edge still down — keeps the original start instant instead of
  # restarting the clock and reporting only recovery's flattering tail.
  open_public_ingress_window
  quiesce_ingress_services "$target_record/ingress-active.tsv" 0 "$target_record" "$route_state" || return 1
  if [[ -f "$target_record/LIVE_MUTATION_STARTED" ]]; then
    stop_project_containers "$PROJECT" || return 1
    remove_project_containers "$PROJECT" || return 1
    restore_pending_live_mutation "$target_record" || return 1
  elif [[ -f "$target_record/domain-cutover/cloudflared/JOURNAL.json" ]]; then
    domain_cloudflared_restore "$target_record" || return 1
  fi
  if declare -F "$verify_before_route" >/dev/null; then
    "$verify_before_route" "$target_record" || return 1
  fi
  old_current="$(tr -d '\r\n' <"$target_record/old-current")"
  old_deployment="$(tr -d '\r\n' <"$target_record/old-current-deployment")"
  cookie="$target_record/.pre-activation-recovery.cookies"
  if [[ -n "$old_current" ]]; then
    [[ "$old_current" == "$RELEASES_DIR/"* && -d "$old_current" && ! -L "$old_current" \
      && "$old_deployment" == "$DEPLOYMENTS_DIR/"* && -d "$old_deployment" \
      && ! -L "$old_deployment" && -f "$old_deployment/running-images.tsv" \
      && -f "$old_deployment/config-digests.tsv" ]] || return 1
    old_release_id="$(basename "$old_current")"
    validate_release_id "$old_release_id" || return 1
    load_compose_command "$old_current" || return 1
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans || return 1
    wait_for_services "$old_current" || return 1
    verify_image_evidence "$old_deployment/running-images.tsv" "$old_current" || return 1
    verify_configuration_evidence "$old_deployment/config-digests.tsv" "$old_current" || return 1
    start_recorded_ingress_service "$target_record/ingress-active.tsv" \
      penumbra-center-bridge.service || return 1
    write_owner_canary_cookie "$old_current" "$cookie" || return 1
    recovery_canary=(--release-id "$old_release_id" \
      --image-evidence "$old_deployment/running-images.tsv" --require-remote-tts \
      --require-owner-spotify --quiesced-loopback --expect-bridge-ready \
      --cookie-file "$cookie")
    [[ -f "$old_deployment/domain-cutover/keycloak/APPLIED.json" ]] \
      || recovery_canary+=(--legacy-dashboard-origin)
    # CROSS-RELEASE INVOCATION: canary.sh belongs to $pending_release, a possibly
    # OLDER release than the one running this code, and its interface must not be
    # assumed. run_cross_release_script refuses any option newer than the frozen
    # release-boundary baseline in common.sh.
    run_cross_release_script "$pending_release" canary.sh \
      "${recovery_canary[@]}" || return 1
    restore_ingress_services "$target_record/ingress-active.tsv" "$target_record" before || return 1
    if declare -F "$verify_before_route" >/dev/null; then
      "$verify_before_route" "$target_record" || return 1
    fi
    assert_ingress_matches_recorded "$target_record/ingress-active.tsv" || return 1
    public_canary=(--release-id "$old_release_id" \
      --image-evidence "$old_deployment/running-images.tsv" --require-remote-tts \
      --require-owner-spotify --cookie-file "$cookie")
    [[ -f "$old_deployment/domain-cutover/keycloak/APPLIED.json" ]] \
      || public_canary+=(--legacy-dashboard-origin)
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh; see above.
    run_cross_release_script "$pending_release" canary.sh \
      "${public_canary[@]}" || return 1
    rm -f -- "$cookie"
  else
    [[ -z "$old_deployment" ]] || return 1
    start_recorded_containers "$target_record/before/running-containers.txt" || return 1
    restore_ingress_services "$target_record/ingress-active.tsv" "$target_record" before || return 1
    if declare -F "$verify_before_route" >/dev/null; then
      "$verify_before_route" "$target_record" || return 1
    fi
    assert_ingress_matches_recorded "$target_record/ingress-active.tsv" || return 1
    verify_legacy_application_with_patience "$target_record/before" || return 1
  fi
}

pending_transaction_reconciled=0

# EVERY SCRIPT AND HELPER THIS FUNCTION RUNS OUT OF $pending_release BELONGS TO A
# POSSIBLY-OLDER RELEASE, and its interface is whatever it was when that release
# was cut. That is not incidental: the partial effects on disk are that release's,
# so unwinding or finishing them is that release's job. What it cannot be asked
# for is evidence in a format it predates — see cross_release_baseline_options in
# common.sh, and capture_resume_candidate_evidence above for what this release
# produces itself instead of asking for.
reconcile_pending_deployment_transaction() {
  local pending=() pending_raw pending_record pending_release_id pending_release pending_manifest pending_verifier
  local pending_transaction_driver cookie pending_baseline baseline resume_backup_id resume_backup
  local pending_name resume_evidence resume_baseline_schema
  local resume_baseline_id
  local -a resume_center_python
  inventory_json="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
    || fail "global authority transaction inventory is invalid"
  # Captured into a variable rather than piped into `mapfile` from a process
  # substitution: there, `||` binds to mapfile's own status, which is 0 even when
  # the python exits non-zero. A foreign authority transaction printed its
  # refusal to stderr and was then SILENTLY SKIPPED — `pending` came back empty
  # and the reconcile returned as if nothing were pending, which is the opposite
  # of what the message below promises. The trailing `x` survives command
  # substitution's newline stripping so an empty inventory stays empty.
  pending_raw="$(python3 - "$inventory_json" <<'PY'
import json,sys
body=json.loads(sys.argv[1]); active=body.get("active")
assert body.get("schemaVersion")==1 and isinstance(active,list) and len(active)<=1
for item in active:
    assert set(item)=={"namespace","record"}
    if item["namespace"] != "deploy": raise SystemExit("foreign rollback authority transaction")
    print(item["record"])
PY
  )x" || fail "a foreign authority transaction prevents deployment"
  pending_raw="${pending_raw%x}"
  [[ -z "$pending_raw" ]] || mapfile -t pending <<<"$pending_raw"
  ((${#pending[@]} == 1)) || return 0
  pending_record="${pending[0]}"
  # Split from the release-id check below, not conjoined with it: the two prove
  # different things and the reopen scope depends on only one of them. Conjoined,
  # a record with perfectly good ingress evidence but a missing or symlinked
  # release-id refused with NO scope armed, so a host that was already down got
  # neither a reopen nor a marker — the evidence naming exactly which units to
  # start was sitting right there, proven, and unused.
  [[ -f "$pending_record/ingress-active.tsv" && ! -L "$pending_record/ingress-active.tsv" ]] \
    || fail "pending deployment operation lacks durable ingress evidence"
  # REOPEN-ONLY SCOPE, armed the instant the ingress evidence is proven durable.
  #
  # The full recovery below cannot be armed here: it branches on the record's
  # phase into recoveries that need $pending_release, which is not validated
  # until the checks that follow. But reopening the recorded ingress needs
  # nothing except this record and the evidence file just proven above — and the
  # gap matters, because the case where ingress is ALREADY down on entry is
  # exactly the case this reconcile exists for: a previous deploy that died
  # inside its own quiesced window. A refusal between here and the full arming
  # would then walk away from a host it had already proven it could reopen,
  # leaving the site connection-refused and writing no marker at all.
  reconcile_reopen_only_record="$pending_record"
  [[ -f "$pending_record/release-id" && ! -L "$pending_record/release-id" ]] \
    || fail "pending deployment operation lacks durable identity"
  pending_release_id="$(tr -d '\r\n' <"$pending_record/release-id")"
  validate_release_id "$pending_release_id"
  pending_release="$RELEASES_DIR/$pending_release_id"
  pending_manifest="$MANIFESTS_DIR/$pending_release_id.json"
  pending_verifier="$pending_release/platform/deploy/vps/verify-release.py"
  pending_transaction_driver="$pending_release/platform/deploy/vps/remote/transaction.py"
  [[ -d "$pending_release" && ! -L "$pending_release" && -f "$pending_manifest" && ! -L "$pending_manifest" \
    && -f "$pending_verifier" && ! -L "$pending_verifier" \
    && -f "$pending_transaction_driver" && ! -L "$pending_transaction_driver" ]] \
    || fail "incomplete pointer transaction release material is unsafe"
  verify_release_verifier_entry "$pending_manifest" "$pending_verifier" "$pending_release_id" \
    || fail "incomplete pointer transaction verifier is not manifest-bound"
  # Arm the EXIT trap installed below with the two validated paths it needs. This
  # assignment is deliberately here — after the record and its release tree have
  # been proven safe, and BEFORE the first line of this function that can stop a
  # single ingress unit — so that every quiesce below happens with a recovery that
  # knows what to restore. Nothing between here and the first quiesce can leave
  # ingress down, and everything after it is covered.
  reconcile_target_record="$pending_record"
  reconcile_target_release="$pending_release"
  # CROSS-RELEASE INVOCATION: $pending_release's own verify-release.py, which must
  # be its own — a release tree is verified by the verifier its manifest binds.
  # Its interface is that release's; only baseline options may be passed.
  assert_cross_release_options verify-release.py --tree --manifest --expect-release-id --json
  python3 "$pending_verifier" --tree "$pending_release" --manifest "$pending_manifest" \
    --expect-release-id "$pending_release_id" --json >/dev/null
  if [[ -f "$pending_record/OPERATION_TRANSACTION_PREPARED" \
      && ! -f "$pending_record/CANDIDATE_ACTIVATION_ARMED" ]]; then
    # Before candidate activation is armed, recovery returns to the predecessor.
    # LIVE_MUTATION_STARTED distinguishes the pure quiescence window from a
    # partial configuration/Nginx installation. Both paths prove the exact
    # predecessor semantics before operation or pointer authority is aborted.
    run_pending_transaction "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --namespace deploy --operation-action verify
    recover_pending_pre_activation_application "$pending_record" "$pending_release" \
      || fail "pending pre-activation operation could not prove exact predecessor recovery"
    if [[ -f "$pending_record/POINTER_TRANSACTION_PREPARED" ]]; then
      [[ ! -f "$pending_record/INGRESS_ACTIVATED" \
        && ! -f "$pending_record/POINTER_TRANSACTION_COMMITTED" ]] \
        || fail "pre-activation recovery found committed or accepted pointer authority"
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        >"$pending_record/POINTER_TRANSACTION_ABORTED.tmp"
      chmod 600 "$pending_record/POINTER_TRANSACTION_ABORTED.tmp"
      mv "$pending_record/POINTER_TRANSACTION_ABORTED.tmp" \
        "$pending_record/POINTER_TRANSACTION_ABORTED"
      sync -f "$pending_record/POINTER_TRANSACTION_ABORTED"
    fi
    run_pending_transaction "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --namespace deploy --operation-action abort
    if [[ -f "$pending_record/LIVE_MUTATION_STARTED" ]]; then
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        >"$pending_record/LIVE_MUTATION_RECOVERED.tmp"
      chmod 600 "$pending_record/LIVE_MUTATION_RECOVERED.tmp"
      mv "$pending_record/LIVE_MUTATION_RECOVERED.tmp" \
        "$pending_record/LIVE_MUTATION_RECOVERED"
      sync -f "$pending_record/LIVE_MUTATION_RECOVERED"
    fi
    if [[ -d "$pending_record/staged" && ! -L "$pending_record/staged" ]]; then
      sudo -n rm -rf -- "$pending_record/staged"
    fi
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$pending_record/PRE_ACTIVATION_RECOVERED.tmp"
    chmod 600 "$pending_record/PRE_ACTIVATION_RECOVERED.tmp"
    mv "$pending_record/PRE_ACTIVATION_RECOVERED.tmp" "$pending_record/PRE_ACTIVATION_RECOVERED"
    sync -f "$pending_record/PRE_ACTIVATION_RECOVERED"
    pending_transaction_reconciled=1
    return 0
  fi
  [[ -f "$pending_record/config-digests.tsv" \
    && -f "$pending_record/resolved-images.tsv" \
    && -f "$pending_record/POINTER_TRANSACTION.json" ]] \
    || fail "incomplete pointer transaction lacks durable activation evidence"
  python3 - "$pending_record/POINTER_TRANSACTION.json" "$pending_record" "$pending_release" \
    "$REMOTE_ROOT" <<'PY'
import json,os,stat,sys
path,record,release,root=sys.argv[1:]
metadata=os.lstat(path); assert stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
body=json.load(open(path,encoding="utf-8"))
assert body.get("schemaVersion")==1 and body.get("namespace")=="deploy" and body.get("record")==record
assert body.get("desiredCurrent")==release and body.get("desiredCurrentDeployment")==record
assert body.get("desiredPrevious")==body.get("oldCurrent")
def pointer(name):
    value=os.path.join(root,name)
    if not os.path.lexists(value): return ""
    assert os.path.islink(value)
    return os.path.realpath(value)
if not os.path.exists(os.path.join(record,"INGRESS_ACTIVATED")):
    assert pointer("current")==body.get("oldCurrent")
    assert pointer("previous")==body.get("oldPrevious")
    assert pointer("current-deployment")==body.get("oldCurrentDeployment")
PY
  # THE RECORD'S OWN BACKUP, taken in the quiesced window this transaction opened.
  # It is still verified, still kept, and it is still the ROLLBACK AND RECOVERY
  # BASELINE: it is the only restore-tested copy of the store as it was before the
  # candidate ever ran, it is what the channel-key metadata journal is contracted
  # against below, and rollback.sh resolves it by the record's name.
  #
  # What it is NOT, on a resume, is the zero-delta reference. See the resume path
  # below: this backup was sealed inside a quiesced window that has since CLOSED,
  # and every hour of legitimate live traffic after it — the Pin's five-minute
  # device-status POSTs, Keycloak's session writes — would be attributed to the
  # candidate by a comparison anchored here.
  pending_baseline="$BACKUP_ROOT/$(basename "$pending_record")"
  [[ -d "$pending_baseline" && ! -L "$pending_baseline" && -f "$pending_baseline/SHA256SUMS" ]] \
    || fail "pending activation baseline backup is unavailable"
  (cd "$pending_baseline" && sha256sum -c SHA256SUMS >/dev/null)
  verify_backup_artifact_manifest "$pending_baseline"
  [[ -f "$pending_record/domain-cutover/nginx/SNAPSHOT.json" \
    && -f "$pending_record/domain-cutover/nginx/DESIRED.json" \
    && -f "$pending_record/domain-cutover/keycloak/JOURNAL.json" ]] \
    || fail "pending activation lacks its public Center domain transaction"
  if [[ ! -f "$pending_record/CHANNEL_KEY_METADATA_TRANSACTION.json" ]]; then
    [[ ! -f "$pending_record/INGRESS_ACTIVATED" && -f "$pending_baseline/invariants.tsv" ]] \
      || fail "pending accepted activation lacks its channel-key metadata journal"
    # Inlined rather than routed through prepare_channel_key_metadata: that helper
    # is defined further down this file, AFTER the point where this function runs,
    # and reads a $channel_key_path that is likewise not assigned yet. Calling it
    # from here would fail on an unset variable in the middle of an armed
    # transaction. The privileged driver is the pending release's, so the argument
    # list goes through the cross-release check like every other one.
    run_pending_transaction_privileged "$pending_transaction_driver" \
      --root "$REMOTE_ROOT" --record "$pending_record" --channel-key-action prepare \
      --channel-key-path "$CENTER_DATA_DIR/channel-key.json" \
      --channel-key-contract "$pending_baseline/invariants.tsv"
  fi
  run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
    --channel-key-action apply
  if [[ -f "$pending_record/trust-root-zero-delta.tsv" ]]; then
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --trust-root-action verify --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
  else
    [[ ! -f "$pending_record/INGRESS_ACTIVATED" ]] \
      || fail "pending accepted activation lacks trust-root zero-delta evidence"
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --trust-root-action record \
      --staged-attest "$pending_record/staged/assets/attest" --staged-duc "$pending_record/staged/assets/duc" \
      --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
  fi
  cookie="$pending_record/.reconcile-owner.cookies"
  if [[ -f "$pending_record/INGRESS_ACTIVATED" ]]; then
    [[ -f "$pending_record/running-images.tsv" ]] \
      || fail "accepted pointer transaction lacks running image evidence"
    verify_configuration_evidence "$pending_record/config-digests.tsv" "$pending_release"
    verify_image_evidence "$pending_record/running-images.tsv" "$pending_release"
    domain_nginx_verify_desired "$pending_record" \
      || fail "accepted pending activation has Center Nginx drift"
    domain_cloudflared_verify_desired "$pending_record" \
      || fail "accepted pending activation has Cloudflare route or configuration drift"
    domain_keycloak_verify_desired "$pending_record" "$RUNTIME_ENV" 8088 \
      || fail "accepted pending activation has Center Keycloak drift"
    verify_keycloak_post_migration_evidence "$pending_record" \
      || fail "accepted pending activation lacks valid Keycloak migration evidence"
    assert_ingress_matches_recorded "$pending_record/ingress-active.tsv" \
      || fail "incomplete pointer transaction ingress no longer matches accepted state"
    write_owner_canary_cookie "$pending_release" "$cookie"
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh, baseline options only.
    run_cross_release_script "$pending_release" canary.sh \
      --release-id "$pending_release_id" --image-evidence "$pending_record/running-images.tsv" \
      --require-remote-tts --require-owner-spotify --cookie-file "$cookie"
  else
    # The prepared candidate owns the live-store activation phase but has not
    # gained authority. Resume that exact verified release with public ingress
    # closed, re-run the zero-delta backup proof, then accept it normally.
    domain_cloudflared_verify_desired "$pending_record" \
      || fail "pending candidate Cloudflare route is not in its durable desired state"
    # THE RESUME'S OWN OUTAGE, OPENED BEFORE THE CONDITIONAL RATHER THAN INSIDE IT.
    # Everything below here runs with the edge closed and takes minutes — two full
    # restore-tested backups, two candidate starts and three canaries — and it is
    # the wearer's outage whether THIS invocation stopped the units or found them
    # already stopped by the predecessor that left the transaction armed. Opening
    # inside the `if` would measure only the first case and report zero for the
    # second, which is exactly the case where the edge has been down longest.
    #
    # Already-down is timed from HERE and not from whenever the predecessor
    # stopped it: that instant is not knowable from this process, and the reopen
    # below is the part this deployment is accountable for. The row is therefore a
    # floor on the resume's outage, never an overstatement.
    open_public_ingress_window
    if ! assert_ingress_quiesced; then
      quiesce_ingress_services "$pending_record/ingress-active.tsv" 0 "$pending_record" desired \
        || fail "could not re-quiesce ingress for pending candidate activation"
    fi
    domain_nginx_reapply "$pending_record" validate-only \
      || fail "could not resume the pending Center Nginx transaction"
    load_compose_command "$pending_release"
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --channel-key-action verify-desired
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --trust-root-action verify --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
    pending_name="$(basename "$pending_record")"
    # THE RESUME'S ZERO-DELTA REFERENCE IS TAKEN HERE, NOT INHERITED.
    #
    # $pending_baseline was sealed inside the quiesced window this transaction
    # opened, and that window CLOSED when the transaction was left pending: public
    # ingress has been open since, so the wearer's Pin has been POSTing
    # device-status every five minutes and Keycloak has been writing sessions and
    # events. Anchoring the zero-delta proof there answers "has anything changed
    # since that window?", to which hours of legitimate live serving is a yes — and
    # the gate would refuse an innocent candidate, on an ARMED transaction that has
    # no abort path. That is a deadlock, not a safety property.
    #
    # The question the gate is actually for is "does the CANDIDATE change anything
    # when it runs?", and the only window in which a resume can honestly ask it is
    # its OWN: re-quiesced above, candidate not yet started, ingress closed. So the
    # pre-candidate half is captured NOW, from that window, and the candidate is
    # measured against it below. Not one comparison is dropped or loosened — every
    # artifact compared after this is compared exactly as strictly, against a
    # before-side that a candidate mutation still moves.
    #
    # $pending_baseline stays exactly what it was: the restore-tested rollback and
    # recovery baseline, and the contract the channel-key journal is bound to.
    #
    # Taken by $pending_release's backup.sh for the same reason the post-candidate
    # one below is (see that comment): both sides of a byte comparison must come
    # from one producer. No projection source is passed — a pre-candidate baseline
    # wants the live column list, and --data-columns-source is newer than the
    # release boundary anyway.
    #
    # The bridge is started first only because backup.sh proves its own health
    # before archiving; nginx and both Cloudflare connectors stay stopped, so this
    # opens no public ingress.
    start_recorded_ingress_service "$pending_record/ingress-active.tsv" penumbra-center-bridge.service
    resume_baseline_id="precommit-resume-baseline-${pending_name:0:40}-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
    baseline="$BACKUP_ROOT/$resume_baseline_id"
    # CROSS-RELEASE INVOCATION: $pending_release's backup.sh, baseline options only.
    run_cross_release_script "$pending_release" backup.sh \
      --backup-id "$resume_baseline_id" --leave-quiesced --already-locked --public-ingress-quiesced \
      --cloudflared-record "$pending_record" --cloudflared-state desired \
      --ingress-evidence "$pending_record/ingress-active.tsv"
    [[ -f "$baseline/SHA256SUMS" && -f "$baseline/BRIDGE_QUIESCED" \
      && -f "$baseline/PUBLIC_INGRESS_QUIESCED" ]] \
      || fail "resumed candidate pre-candidate baseline backup is incomplete"
    assert_ingress_quiesced || fail "resumed candidate baseline backup reopened ingress"
    (cd "$baseline" && sha256sum -c SHA256SUMS >/dev/null)
    verify_backup_artifact_manifest "$baseline"
    # --leave-quiesced: every writer and the bridge are still stopped and only
    # PostgreSQL is up, so the cluster this baseline archived is the exact cluster
    # the candidate is about to be started against on the next line. Nothing can
    # slip between the capture and the mutation being measured.
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans
    wait_for_services "$pending_release"
    record_image_evidence "$pending_release" "$pending_record/running-images.tsv"
    verify_running_against_resolved "$pending_record/resolved-images.tsv" "$pending_record/running-images.tsv"
    verify_configuration_evidence "$pending_record/config-digests.tsv" "$pending_release"
    write_owner_canary_cookie "$pending_release" "$cookie"
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh, baseline options only.
    # --baseline is the resume's own pre-candidate backup for the same reason the
    # zero-delta comparison is: canary.sh's verify_invariants holds live row counts
    # against that file exactly, and the record's original invariants.tsv predates
    # hours of the wearer's own writes.
    run_cross_release_script "$pending_release" canary.sh \
      --release-id "$pending_release_id" --baseline "$baseline" \
      --image-evidence "$pending_record/running-images.tsv" --require-remote-tts \
      --quiesced-loopback --cookie-file "$cookie"
    start_recorded_ingress_service "$pending_record/ingress-active.tsv" penumbra-center-bridge.service
    resume_backup_id="precommit-resume-${pending_name:0:40}-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
    resume_backup="$BACKUP_ROOT/$resume_backup_id"
    # CROSS-RELEASE INVOCATION, and the one that deadlocked deploy 14. backup.sh
    # here is $pending_release's — it MUST be, because the artifacts this backup
    # contributes to the zero-delta proof (postgres-security.json, the cosmos and
    # bridge inventories) are compared byte-for-byte against a baseline that same
    # code produced, and two different producers of one format agree only by luck.
    #
    # So NOTHING newer than the release-boundary baseline is passed to it: no
    # --data-columns-source, no successor of it. The two manifests this release
    # needs in this release's formats are captured immediately below by this
    # release, from the same still-quiesced cluster.
    run_cross_release_script "$pending_release" backup.sh \
      --backup-id "$resume_backup_id" --leave-quiesced --already-locked --public-ingress-quiesced \
      --cloudflared-record "$pending_record" --cloudflared-state desired \
      --ingress-evidence "$pending_record/ingress-active.tsv"
    [[ -f "$resume_backup/SHA256SUMS" && -f "$resume_backup/BRIDGE_QUIESCED" \
      && -f "$resume_backup/PUBLIC_INGRESS_QUIESCED" ]] \
      || fail "resumed candidate zero-delta backup is incomplete"
    assert_ingress_quiesced || fail "resumed candidate backup reopened ingress"
    (cd "$resume_backup" && sha256sum -c SHA256SUMS >/dev/null)
    verify_backup_artifact_manifest "$resume_backup"
    # This release's own evidence, kept in the deployment record rather than inside
    # the backup: that backup's SHA256SUMS and BACKUP_MANIFEST.json were sealed and
    # verified above, and writing into it would invalidate both.
    resume_evidence="$pending_record/precommit-resume-evidence"
    # Rebuilt from empty every attempt. A retained sidecar from an earlier failed
    # resume would otherwise still be sitting beside the manifest, and the
    # classifier would read it — bound to the right digest or not, evidence this
    # attempt did not produce has no business in this attempt's comparison.
    [[ ! -L "$resume_evidence" && ( ! -e "$resume_evidence" || -d "$resume_evidence" ) ]] \
      || fail "resume evidence path is unsafe"
    rm -rf -- "$resume_evidence"
    mkdir "$resume_evidence"
    chmod 700 "$resume_evidence"
    capture_resume_candidate_evidence "$resume_evidence" "$baseline" \
      || fail "could not capture this release's post-candidate zero-delta manifests"
    resume_baseline_schema="$(resume_baseline_schema_manifest "$baseline" "$pending_record" "$resume_evidence")" \
      || fail "could not bind the pre-candidate schema manifest the resume must classify against"
    compare_precommit_compatibility_state "$baseline" "$resume_backup" \
      "resumed candidate changed compatibility state before acceptance" \
      "$resume_evidence/candidate-data.tsv" \
      "$resume_baseline_schema" "$resume_evidence/candidate-schema.tsv"
    # Center's own data directory across the same window, and the reason it is not
    # compare_center_zero_delta_with_migration (the cutover's helper): that one
    # ALLOWS the channel key's mode/uid/gid to advance from the journal's old
    # values to its desired ones, because on the cutover the migration happens
    # inside the compared window. On a resume it does not — --channel-key-action
    # apply and verify-desired both ran above, before this baseline was captured —
    # so the key is already at its desired metadata on BOTH sides and no transition
    # may appear here at all. That makes this arm strictly stricter, not looser: the
    # whole inventory must be byte-identical, and the key is still pinned to the
    # journal's content digest and desired ownership rather than merely to itself.
    #
    # The journal is written THROUGH THE SUDO BOUNDARY by the transaction driver
    # (run_pending_transaction_privileged above), so it lands root-owned 0600 and
    # the deployment user cannot open() it — on ANY resume, not just an unlucky
    # one. Read it with the privilege it was written with, exactly as
    # compare_center_zero_delta_with_migration does further down this file. The
    # comparison below is untouched: same assertions, same strictness, only the
    # interpreter that can actually read argv[3] differs.
    resume_center_python=(python3)
    [[ -r "$pending_record/CHANNEL_KEY_METADATA_TRANSACTION.json" ]] \
      || resume_center_python=(sudo -n python3)
    "${resume_center_python[@]}" - "$baseline/center-data.inventory.json" \
      "$resume_backup/center-data.inventory.json" \
      "$pending_record/CHANNEL_KEY_METADATA_TRANSACTION.json" <<'PY'
import json,sys
before={item["path"]:item for item in json.load(open(sys.argv[1],encoding="utf-8"))}
after={item["path"]:item for item in json.load(open(sys.argv[2],encoding="utf-8"))}
journal=json.load(open(sys.argv[3],encoding="utf-8")); assert set(before)==set(after)
for name in before:
    old,new=before[name],after[name]
    assert old==new
    if name=="channel-key.json":
        assert old.get("sha256")==journal["contentSha256"]
        assert (old.get("mode"),old.get("uid"),old.get("gid"))==(oct(journal["desiredMode"]),journal["desiredUid"],journal["desiredGid"])
PY
    load_compose_command "$pending_release"
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --channel-key-action verify-desired
    run_pending_transaction_privileged "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --trust-root-action verify --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans
    wait_for_services "$pending_release"
    domain_keycloak_apply "$pending_record" "$RUNTIME_ENV" 8088 center.andersmadsen.dk \
      || fail "could not resume the pending Center Keycloak migration"
    record_keycloak_post_migration_evidence "$pending_record" \
      || fail "could not resume Keycloak post-migration evidence"
    domain_nginx_verify_desired "$pending_record" \
      || fail "pending Center Nginx transaction drifted before activation"
    domain_cloudflared_verify_desired "$pending_record" \
      || fail "pending Cloudflare route drifted before activation"
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh, baseline options only.
    run_cross_release_script "$pending_release" canary.sh \
      --release-id "$pending_release_id" --baseline "$resume_backup" \
      --image-evidence "$pending_record/running-images.tsv" --require-remote-tts \
      --quiesced-loopback --cookie-file "$cookie"
    start_recorded_ingress_service "$pending_record/ingress-active.tsv" penumbra-center-bridge.service
    wait_for_services "$pending_release"
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh, baseline options only.
    run_cross_release_script "$pending_release" canary.sh \
      --release-id "$pending_release_id" --image-evidence "$pending_record/running-images.tsv" \
      --require-remote-tts --require-owner-spotify --quiesced-loopback --expect-bridge-ready \
      --cookie-file "$cookie"
    restore_ingress_services "$pending_record/ingress-active.tsv" "$pending_record" desired
    domain_cloudflared_verify_desired "$pending_record" \
      || fail "pending Cloudflare route drifted after connector activation"
    assert_ingress_matches_recorded "$pending_record/ingress-active.tsv" \
      || fail "resumed candidate ingress differs from its recorded state"
    # Serving again and proven to match the recorded pre-cutover state, so the
    # resume's window is a fact. Closed HERE rather than after the public canary
    # below, for the same reason the cutover path closes it here: the edge is
    # already containing the wearer's traffic, and charging the canary's duration to
    # the outage would overstate it. This row goes into the CURRENT deployment's
    # record, not the pending one: this invocation is what took the edge down and
    # what the operator is reading a budget line for, and a deploy that resumes a
    # predecessor and then cuts over pays for both windows.
    record_public_ingress_window
    # CROSS-RELEASE INVOCATION: $pending_release's canary.sh, baseline options only.
    run_cross_release_script "$pending_release" canary.sh \
      --release-id "$pending_release_id" --image-evidence "$pending_record/running-images.tsv" \
      --require-remote-tts --require-owner-spotify --cookie-file "$cookie"
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$pending_record/INGRESS_ACTIVATED.tmp"
    chmod 600 "$pending_record/INGRESS_ACTIVATED.tmp"
    mv "$pending_record/INGRESS_ACTIVATED.tmp" "$pending_record/INGRESS_ACTIVATED"
    sync -f "$pending_record/INGRESS_ACTIVATED"
  fi
  assert_ingress_matches_recorded "$pending_record/ingress-active.tsv" \
    || fail "pending candidate ingress drifted before pointer publication"
  domain_cloudflared_verify_desired "$pending_record" \
    || fail "pending Cloudflare route drifted before pointer publication"
  run_pending_transaction "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
    --namespace deploy --reconcile
  if [[ -f "$pending_record/OPERATION_TRANSACTION_PREPARED" ]]; then
    run_pending_transaction "$pending_transaction_driver" --root "$REMOTE_ROOT" --record "$pending_record" \
      --namespace deploy --operation-action complete
  fi
  rm -f -- "$cookie"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$pending_record/POINTER_TRANSACTION_RECONCILED"
  chmod 600 "$pending_record/POINTER_TRANSACTION_RECONCILED"
  pending_transaction_reconciled=1
}

# THE RECONCILE PATH'S SAFETY NET, AND WHY IT IS INSTALLED HERE.
#
# reconcile_pending_deployment_transaction stops public ingress — nginx AND both
# reviewed Cloudflare connectors — before it can prove anything, and every `fail`
# inside it exits the script on the spot. Until this trap existed, the first
# `trap ... EXIT` in this file was installed far below (early_cleanup, with
# finish_deploy later still), so a failure anywhere inside the reconcile exited
# with ingress quiesced and NOTHING to bring it back: the wearer's Pin was
# connection-refused until an operator restarted the stack, nginx and both
# cloudflared units (cloudflared-tunnel.service system + cloudflared-hermes.service
# user) by hand. Two production outages ended exactly that way.
#
# The trap is therefore installed BEFORE the call, not after it. Everything the
# reconcile can quiesce lives inside that one function, so bracketing the call
# covers every failure path inside it — including the zero-delta refusal the
# rebaseline below fixes — with no gap left between the first quiesce and the
# first trap.
reconcile_target_record=""
reconcile_target_release=""
# Set earlier than the two above and never cleared: the narrow window in which
# this record's ingress evidence is proven but its release tree is not. It is a
# strict subset of what the pair above authorise, so it is only ever consulted
# when they are still empty.
reconcile_reopen_only_record=""

# One writer for the reconcile's durable outcome, so a marker can never be
# written without its mode. The names are load-bearing and are asserted
# elsewhere: RECONCILE_RECOVERED means the application was proven, and only the
# path that proved it may write it.
record_reconcile_marker() {
  local target_record="$1" marker="$2"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$target_record/$marker"
  chmod 600 "$target_record/$marker"
}

# HAS ANYTHING ACTUALLY BEEN QUIESCED?
#
# The trap is armed before the reconcile's first quiesce on purpose, so being
# armed says nothing about whether ingress is down: both arms can fail on either
# side of their quiesce. A manifest check, a drift gate or an inventory read can
# refuse a deployment with every recorded unit still active and the host still
# fully serving, and running the recovery there would stop the stack and both
# connectors just to put them back — an outage window opened by the safety net
# itself, on a healthy production.
#
# So the condition is read off the LIVE UNITS rather than off where in this file
# the failure happened: the record's ingress evidence names the units that were
# active when the transaction opened, and if every one of them is still active
# then nothing has been taken down and there is nothing to restore. This also
# covers the container stack without a second probe — on both arms the quiesce
# strictly precedes any container mutation, so an untouched ingress implies an
# untouched application stack.
#
# The live store is deliberately NOT part of that claim: `--channel-key-action
# apply` runs before the resume arm's quiesce, and on the accepted arm with no
# quiesce at all, so a refusal after it can leave the channel key advanced with
# ingress never touched. Skipping recovery still costs nothing there, because
# neither recovery arm restores the channel key in any case — that is
# restore_channel_key_metadata's job, wired into finish_deploy.
#
# Unreadable or missing evidence answers "disturbed": the recovery is then the
# safe direction, and it does its own validation of the same file.
reconcile_ingress_disturbed() {
  local evidence="$1" kind manager unit expected _rest
  # Structurally, not just existentially: an evidence file that names no service
  # row at all — every row a `contract` row, say — would otherwise probe nothing,
  # fall out of the loop, and report "not disturbed" for a host that is entirely
  # down. validate_ingress_evidence is the same check the restore itself makes,
  # so anything it rejects cannot be restored either and must take the recovery
  # branch, which does its own validation and reports the refusal honestly.
  validate_ingress_evidence "$evidence" || return 0
  # `|| [[ -n "$kind" ]]` because the python validator above accepts a final row
  # with no trailing newline while bash's `read` returns non-zero on it — the row
  # would be silently dropped here, and a single dropped row is exactly the unit
  # whose state decides this answer.
  while IFS=$'\t' read -r kind manager unit expected _rest || [[ -n "$kind" ]]; do
    [[ "$kind" != contract ]] || continue
    [[ "$expected" == active ]] || continue
    managed_systemctl "$manager" is-active --quiet "$unit" || return 0
  done <"$evidence"
  return 1
}

# LAST-RESORT INGRESS REOPEN, used only after the full proven recovery below has
# already failed. It does not replace or soften a single gate: the transaction
# stays pending, the application stays unproven, RECONCILE_RECOVERED is NOT
# written, and the operator is told so. All it refuses to do is leave the host
# connection-refused because the proof could not be completed.
#
# It goes through restore_ingress_services, so it is all four recorded units or
# none — bridge, nginx and BOTH cloudflared connectors. Bringing back only the
# system tunnel and not the user one leaves Cloudflare answering 530 for the
# wearer, which is not a recovery; and restore_ingress_services' own refusal to
# leave a half-open edge standing is kept exactly as it is.
#
# Bounded patience for the same reason verify_legacy_application_with_patience
# has it: the realistic failure here is a cold service start or a Cloudflare
# connector that has not finished re-registering, and both are transient. A
# permanently unstartable unit still ends as a reported failure, because at that
# point ingress genuinely cannot be reopened by anyone.
reconcile_reopen_recorded_ingress() {
  local target_record="$1" evidence="$2" attempt route_state
  for attempt in 1 2 3; do
    # Re-derived every attempt: the recovery that just failed may itself have
    # advanced the durable Cloudflare markers part-way, and
    # restore_ingress_services must verify against what is on disk NOW.
    route_state=recorded
    [[ ! -f "$target_record/domain-cutover/cloudflared/INSTALLED.json" ]] || route_state=desired
    [[ ! -f "$target_record/domain-cutover/cloudflared/RESTORED.json" ]] || route_state=before
    if restore_ingress_services "$evidence" "$target_record" "$route_state"; then return 0; fi
    ((attempt < 3)) || break
    sleep 10
  done
  # Three full-fidelity attempts have failed, and each one force-quiesced the whole
  # edge on its way out rather than leave it half-open. That is the right rule for
  # a restore that can still be retried; as the last word it converts one dead
  # unit into a dark host. So the final pass starts everything it can and stops
  # nothing — see reopen_recorded_ingress_best_effort for why the all-or-none rule
  # inverts here. It never claims a proof: 0 and 20 both mean "the edge is open",
  # not "the application is good", and the caller marks them differently.
  reopen_recorded_ingress_best_effort "$evidence"
}

# Ingress-and-application recovery for a reconcile that did not finish. Both
# arms reuse the recovery this file already owns rather than inventing a second
# one; what differs is only what "the recorded application" means at the phase
# the record is in.
# Three outcomes, because they are three different things to tell an operator:
#   0  the recorded application and ingress are back AND proven
#   10 ingress is back, the application could not be proven
#   1  ingress could not be reopened at all
#
# The reopen exists because the reconcile's own failure is very often the SAME
# call the recovery is about to make — the pre-activation arm literally re-runs
# recover_pending_pre_activation_application, and the armed arm re-runs
# wait_for_services and restore_ingress_services. A deterministic failure
# reproduces exactly, and both of those quiesce before they fail, so the second
# attempt used to leave the host stopped where the first found it serving. What
# could not be proven must not be claimed; what must not survive is the outage.
# Maps the reopen's own result onto reconcile_restore_recorded_service's outcome
# codes, so both arms report a partial reopen as the distinct thing it is rather
# than rounding it to "recovered" or to "failed".
# The recovery must run in a subshell — its helpers call `fail` on unsafe input,
# and an exit from inside this handler would skip both the marker and the original
# status. But bash RESETS a caught trap to its default disposition inside `( )`,
# so the signal traps installed above protect this shell and NOT the child that
# does the actual restoring. A SIGHUP from a dropped ssh therefore killed the
# recovery mid-flight and left the edge closed — the exact outage those traps were
# added to prevent. Re-install them in the child.
#
# PIPE is here and not above for a reason of its own: the first thing the degraded
# pass does when a unit will not start is `warn`, which writes to stderr, i.e. to
# the ssh channel. If that channel is already gone the write raises SIGPIPE, whose
# default action would terminate the child part-way through starting the remaining
# units. `:` rather than `warn`, because warning about a broken pipe would write to
# the broken pipe.
# The partial marker exists to stop an operator treating a serving host as dark,
# so its wording must not overstate in the other direction. nginx is not one unit
# among four: with nginx down the connectors have nothing to proxy to and NOTHING
# is publicly served, however many units came back.
warn_partial_reopen() {
  if managed_systemctl system is-active --quiet nginx.service; then
    warn "public ingress is only PARTIALLY back; the units named above stayed down, the rest are serving, the application containers were NOT started by this path, and the pending transaction still needs an operator"
  else
    warn "public ingress is NOT serving: nginx is among the units that stayed down, so nothing is publicly reachable even though other units came back. The pending transaction still needs an operator"
  fi
}

run_reconcile_recovery() {
  (
    trap 'warn "signal received while public ingress is being restored; finishing the restore first"' HUP INT TERM
    trap ':' PIPE
    "$@"
  )
}

reconcile_reopen_outcome() {
  local target_record="$1" evidence="$2" status
  reconcile_reopen_recorded_ingress "$target_record" "$evidence"
  status=$?
  case "$status" in
    0) return 10 ;;
    20) return 20 ;;
    *) return 1 ;;
  esac
}

reconcile_restore_recorded_service() {
  local target_record="$reconcile_target_record" target_release="$reconcile_target_release"
  local evidence="$target_record/ingress-active.tsv"
  # Non-regular evidence is a reason to skip the PROOF, not a reason to skip the
  # reopen. Returning here made the last-resort canonical start reachable from the
  # arm that quiesced nothing and unreachable from the arm that quiesced
  # everything — and it reported a host whose four units were untouched and
  # serving as "connection-refused until an operator acts".
  if [[ ! -f "$evidence" || -L "$evidence" ]]; then
    reconcile_reopen_outcome "$target_record" "$evidence"
    return $?
  fi
  if [[ ! -f "$target_record/CANDIDATE_ACTIVATION_ARMED" ]]; then
    # Before candidate activation is armed the predecessor is still the exact
    # authority, so the recovery is the one the reconcile itself would have run:
    # it restores the recorded application, restores every recorded ingress
    # service, and PROVES the predecessor with that release's own canaries
    # (quiesced first, then public). No second implementation of any of that.
    # In its own subshell: this path reaches helpers that call `fail` on drift,
    # and `fail` is `exit 1` (common.sh). Uncontained, that exit terminated the
    # recovery child outright — so a drift detected AFTER the quiesce skipped the
    # reopen entirely and left the edge closed, which is the opposite of what the
    # split below was written for. Containing it turns every such abort back into
    # the `return 1` the caller already knows how to handle.
    ( recover_pending_pre_activation_application "$target_record" "$target_release" ) && return 0
    reconcile_reopen_outcome "$target_record" "$evidence"
    return $?
  fi
  # Contained for the same reason as the pre-activation arm above.
  ( reconcile_restore_armed_service "$target_record" "$target_release" "$evidence" ) && return 0
  reconcile_reopen_outcome "$target_record" "$evidence"
  return $?
}

# The armed arm's proven recovery, split out only so that every one of its
# `return 1`s falls through to the ingress reopen in its caller instead of
# ending the handler with the edge closed.
reconcile_restore_armed_service() {
  local target_record="$1" target_release="$2" evidence="$3"
  local route_state cookie recorded_release_id
  local -a recovery_canary
  # ARMED: live-store mutation has begun, and by this file's design an armed
  # transaction is never aborted — only resumed and completed. So the predecessor
  # must NOT be started against state the candidate has already touched. What must
  # not survive the failure is the OUTAGE: bring the recorded candidate stack back
  # up and restore every recorded ingress service, so the next resume starts from
  # a serving host instead of from an operator's manual restart.
  #
  # Same route-state derivation as recover_pending_pre_activation_application: the
  # durable markers say which Cloudflare configuration is on disk right now, and
  # restore_ingress_services must verify against that one, not against a guess.
  route_state=recorded
  [[ ! -f "$target_record/domain-cutover/cloudflared/INSTALLED.json" ]] || route_state=desired
  [[ ! -f "$target_record/domain-cutover/cloudflared/RESTORED.json" ]] || route_state=before
  recorded_release_id="$(tr -d '\r\n' <"$target_record/release-id")"
  validate_release_id "$recorded_release_id" || return 1
  load_compose_command "$target_release" || return 1
  "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans || return 1
  wait_for_services "$target_release" || return 1
  start_recorded_ingress_service "$evidence" penumbra-center-bridge.service || return 1
  restore_ingress_services "$evidence" "$target_record" "$route_state" || return 1
  assert_ingress_matches_recorded "$evidence" || return 1
  cookie="$target_record/.reconcile-recovery.cookies"
  write_owner_canary_cookie "$target_release" "$cookie" || return 1
  recovery_canary=(--release-id "$recorded_release_id" --require-remote-tts \
    --require-owner-spotify --cookie-file "$cookie")
  # A record can be armed before its candidate ever reported images (arming
  # precedes the candidate's first start), so this evidence is offered only when
  # the record actually has it.
  [[ ! -f "$target_record/running-images.tsv" ]] \
    || recovery_canary+=(--image-evidence "$target_record/running-images.tsv")
  # CROSS-RELEASE INVOCATION: canary.sh belongs to $target_release, the release
  # whose application is the one now serving, and its interface must not be
  # assumed. No --baseline: the only backups this record owns were taken before
  # the live-serving window, and holding a restored production against them is
  # exactly the mistake the rebaseline below removes.
  run_cross_release_script "$target_release" canary.sh "${recovery_canary[@]}" \
    || { rm -f -- "$cookie"; return 1; }
  rm -f -- "$cookie"
}

finish_reconcile() {
  local status=$?
  local recovery_status
  # EXIT is cleared to break the recursion; the other three are IGNORED rather
  # than reset to their default, which is what `trap -` would do. This handler is
  # the thing that reopens public ingress, and it can legitimately run for
  # minutes — reconcile_reopen_recorded_ingress alone retries three times with a
  # ten-second sleep. The driver runs over a plain ssh with a keepalive, so a
  # dropped connection delivers SIGHUP straight into that window; under `trap -`
  # it killed the recovery mid-flight and left the edge closed with no marker.
  #
  # The three are trapped to a COMMAND, not to '' — and installed BEFORE EXIT is
  # cleared. Both details are load-bearing and were both wrong before:
  #   - Ordering: with EXIT cleared first, a signal arriving in the gap still ran
  #     the outer `trap 'exit 129' HUP` with no EXIT handler left to re-enter, so
  #     the recovery was abandoned silently. Installing these first shrinks that
  #     to the instant between entering this handler and its first statement,
  #     which bash gives no way to close.
  #   - `trap ''` sets SIG_IGN, and POSIX preserves SIG_IGN across execve. Every
  #     `docker`, `compose up` and `systemctl` this handler runs would have
  #     inherited it and become unkillable by those signals — and several of them
  #     have no client-side timeout. A command trap is reset to the default in
  #     children, so only this shell is protected.
  trap 'warn "signal received while public ingress is being restored; finishing the restore first"' HUP INT TERM
  # PIPE ON THIS SHELL TOO, not only inside run_reconcile_recovery. The commonest
  # reason this handler is running at all is a dropped ssh: sshd sends SIGHUP,
  # `trap 'exit 129' HUP` turns it into an exit, and the exit fires this handler.
  # Its first act on both arms is a `warn` — a write to stderr, which IS that dead
  # channel. Without this trap the kernel killed the handler on that single write,
  # before one unit was started and before any marker was written: the site stayed
  # connection-refused and, with both connectors down, Cloudflare answered 530 for
  # every hostname on the tunnel — including the operator's way back in.
  trap ':' PIPE
  trap - EXIT
  set +e
  # pending_transaction_reconciled is the reconcile's own completion evidence: once
  # it is set, ingress has already been restored and proven by the path that set
  # it, and a signal arriving in the window before the trap is cleared must not
  # re-run recovery over a finished transaction.
  if ((status != 0 && pending_transaction_reconciled == 0)) && [[ -n "$reconcile_target_record" ]]; then
    if ! reconcile_ingress_disturbed "$reconcile_target_record/ingress-active.tsv"; then
      # Every recorded unit is still active: this failure never touched ingress,
      # so there is nothing to recover and recovering anyway would be the outage.
      # The deployment is still refused and the transaction is still pending —
      # that is the failure the operator came for, and it did not cost the site.
      warn "pending transaction reconciliation failed before anything was quiesced; public ingress was never interrupted"
      exit "$status"
    fi
    warn "pending transaction reconciliation failed; restoring the recorded application and public ingress"
    run_reconcile_recovery reconcile_restore_recorded_service
    recovery_status=$?
    if ((recovery_status == 0)); then
      record_reconcile_marker "$reconcile_target_record" RECONCILE_RECOVERED
      warn "public ingress and the recorded application are back; the pending transaction is still pending"
    elif ((recovery_status == 10)); then
      # Deliberately NOT RECONCILE_RECOVERED: the edge is serving again, but the
      # application behind it was never proven by a canary, so nothing may record
      # that it was. This marker says exactly that much and no more.
      record_reconcile_marker "$reconcile_target_record" RECONCILE_INGRESS_REOPENED
      warn "public ingress is back, but the application containers were NOT started by this path and the recorded application is unproven: expect accepted-then-failing requests rather than connection-refused. The pending transaction is still pending and needs an operator"
    elif ((recovery_status == 20)); then
      # Distinct from both neighbours on purpose. RECONCILE_INGRESS_REOPENED would
      # overstate it — part of the edge is still down — and RECONCILE_RECOVERY_FAILED
      # would understate it, sending an operator to a host they think is dark when
      # the dashboard is in fact serving. The warnings from the degraded pass name
      # the exact units that stayed down.
      record_reconcile_marker "$reconcile_target_record" RECONCILE_INGRESS_PARTIALLY_REOPENED
      warn_partial_reopen
    else
      record_reconcile_marker "$reconcile_target_record" RECONCILE_RECOVERY_FAILED
      warn "public ingress could NOT be restored automatically; the Pin is connection-refused until an operator acts"
    fi
  elif ((status != 0 && pending_transaction_reconciled == 0)) && [[ -n "$reconcile_reopen_only_record" ]] \
    && reconcile_ingress_disturbed "$reconcile_reopen_only_record/ingress-active.tsv"; then
    # The refusal happened before this invocation could arm the full recovery, so
    # ingress being down is not this invocation's doing — it was already down on
    # entry, which is the state a dead predecessor leaves behind. Nothing here
    # claims otherwise: no application is proven, no transaction is advanced, and
    # the deployment stays refused with its original status. The one thing that
    # is not acceptable is exiting with a reopen proven possible and not tried.
    warn "the deployment was refused with public ingress already down; reopening the recorded ingress without advancing the transaction"
    # Through reconcile_reopen_outcome, exactly as the armed arm goes: calling the
    # reopen directly here threw away its partial result, so a host with nginx, the
    # bridge and the system connector all serving was recorded RECONCILE_RECOVERY_FAILED
    # and the operator told the Pin was connection-refused.
    run_reconcile_recovery reconcile_reopen_outcome "$reconcile_reopen_only_record" \
      "$reconcile_reopen_only_record/ingress-active.tsv"
    recovery_status=$?
    if ((recovery_status == 10)); then
      record_reconcile_marker "$reconcile_reopen_only_record" RECONCILE_INGRESS_REOPENED
      warn "public ingress is back, but the application containers were NOT started by this path and the recorded application is unproven: expect accepted-then-failing requests rather than connection-refused. The pending transaction is still pending and needs an operator"
    elif ((recovery_status == 20)); then
      record_reconcile_marker "$reconcile_reopen_only_record" RECONCILE_INGRESS_PARTIALLY_REOPENED
      warn_partial_reopen
    else
      record_reconcile_marker "$reconcile_reopen_only_record" RECONCILE_RECOVERY_FAILED
      warn "public ingress could NOT be restored automatically; the Pin is connection-refused until an operator acts"
    fi
  fi
  # A reconcile that did NOT finish still took the wearer's edge down, and on
  # this path for longer than a successful one: the resume's own close is only
  # reached when the transaction is accepted, so exactly the worse windows exited
  # through here unrecorded. Same disposition as finish_deploy's tail, including
  # the refusal to imply a closed window when nothing could reopen the edge.
  if [[ -n "$public_ingress_quiesce_epoch" ]]; then
    local window_evidence="${reconcile_target_record:-$reconcile_reopen_only_record}/ingress-active.tsv"
    if reconcile_ingress_disturbed "$window_evidence"; then
      # Do not imply the window closed. It has not: some recorded unit is still
      # stopped, so the Pin stays connection-refused until an operator acts.
      warn "public ingress is STILL DOWN; the figure below is the window so far, not its total width"
    fi
    record_public_ingress_window || warn "the public ingress window could not be recorded in $record"
  fi
  exit "$status"
}
trap finish_reconcile EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
reconcile_pending_deployment_transaction
# The reconcile is over. On every path that returns, ingress is either untouched
# (nothing was pending) or restored and proven, and nothing below quiesces
# anything until the backup far down this file, which finish_deploy covers.
trap - EXIT HUP INT TERM
if ((pending_transaction_reconciled)); then
  # The initial selected-release preflight deliberately stopped at the pending
  # activation boundary. Once authority is reconciled, run the complete gate
  # before this invocation is allowed to begin another cutover.
  bash "$release_dir/platform/deploy/vps/remote/preflight.sh" \
    --min-free-gb 8 --archive-bytes "$(stat -c '%s' "$PACKAGES_DIR/$release_id.tar.gz")"
fi
post_reconcile_inventory="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
  || fail "global authority transaction inventory failed after reconciliation"
python3 - "$post_reconcile_inventory" <<'PY'
import json,sys
body=json.loads(sys.argv[1])
assert body.get("schemaVersion")==1 and body.get("active")==[]
PY

old_current=""
old_previous=""
old_current_deployment=""
if old_current="$(safe_release_pointer "$REMOTE_ROOT/current" 2>/dev/null)"; then printf '%s\n' "$old_current" >"$record/old-current"; else : >"$record/old-current"; fi
if old_previous="$(safe_release_pointer "$REMOTE_ROOT/previous" 2>/dev/null)"; then printf '%s\n' "$old_previous" >"$record/old-previous"; else : >"$record/old-previous"; fi
if old_current_deployment="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment" 2>/dev/null)"; then
  printf '%s\n' "$old_current_deployment" >"$record/old-current-deployment"
else
  : >"$record/old-current-deployment"
fi
if [[ -n "$old_current" ]]; then
  [[ "$(basename "$old_current")" != "$release_id" ]] \
    || fail "requested release is already current; same-release rebuilds are not safe deployment units"
  [[ -n "$old_current_deployment" && -f "$old_current_deployment/SUCCEEDED" \
    && -f "$old_current_deployment/INGRESS_ACTIVATED" \
    && -f "$old_current_deployment/POINTER_TRANSACTION_COMMITTED" \
    && -f "$old_current_deployment/release-id" ]] \
    || fail "canonical current release lacks an exact successful deployment record pointer"
  [[ "$(tr -d '\r\n' <"$old_current_deployment/release-id")" == "$(basename "$old_current")" ]] \
    || fail "current release and deployment record disagree"
  [[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" \
    && -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ]] \
    || fail "canonical deployment topology is ambiguous under the deployment lock"
  [[ -f "$old_current_deployment/running-images.tsv" && -f "$old_current_deployment/config-digests.tsv" ]] \
    || fail "current deployment rollback evidence is incomplete"
  old_release_id="$(basename "$old_current")"
  old_manifest="$MANIFESTS_DIR/$old_release_id.json"
  [[ -f "$old_manifest" && ! -L "$old_manifest" ]] \
    || fail "current release manifest is missing or unsafe"
  # The selected, package-verified verifier is the independent trust root for
  # the older tree that recovery may execute.
  python3 "$release_verifier" --tree "$old_current" --manifest "$old_manifest" \
    --expect-release-id "$old_release_id" --json >/dev/null
  verify_image_evidence "$old_current_deployment/running-images.tsv" "$old_current"
  verify_configuration_evidence "$old_current_deployment/config-digests.tsv" "$old_current"
else
  [[ ! -e "$REMOTE_ROOT/current" && ! -L "$REMOTE_ROOT/current" ]] \
    || fail "canonical current pointer exists but is unsafe under the deployment lock"
  [[ ! -e "$REMOTE_ROOT/current-deployment" && ! -L "$REMOTE_ROOT/current-deployment" ]] \
    || fail "canonical deployment lineage exists without a safe current pointer"
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" \
    && -n "$(docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" ]] \
    || fail "first-cutover topology is ambiguous under the deployment lock"
fi
chmod 600 "$record/old-current" "$record/old-previous" "$record/old-current-deployment"
record_project_state "$record/before"
if [[ -z "$old_current" ]]; then
  write_legacy_semantic_evidence "$record/before/semantic-baseline.tsv" \
    || fail "legacy application does not satisfy the first-cutover recovery baseline"
fi
domain_discovery="$record/public-edge-discovery.json"
domain_discover_public_edge "$domain_discovery" \
  || fail "active dashboard edge discovery failed under the deployment lock"
domain_assert_public_tls "$domain_discovery" \
  || fail "reviewed wildcard TLS pair cannot serve the canonical Center domain"
domain_cloudflared_assert_ready \
  || fail "the fixed Cloudflare tunnel configuration is not valid before deployment"
assert_managed_cloudflared_topology \
  || fail "Cloudflare is not running as the exact allowlisted system and user connectors"
domain_cloudflared_prepare "$record" \
  || fail "Cloudflare Center-route transaction could not capture its exact preimage"
keycloak_before_host=cosmos.andersmadsen.dk
if [[ -n "$old_current_deployment" \
    && -f "$old_current_deployment/domain-cutover/keycloak/APPLIED.json" ]]; then
  keycloak_before_host=center.andersmadsen.dk
fi

stage=""
cleanup_staged_material() {
  [[ -n "$stage" ]] || return 0
  [[ "$stage" == "$record/staged" && "$stage" == "$DEPLOYMENTS_DIR/"* ]] || return 1
  if [[ -e "$stage" ]]; then sudo -n rm -rf -- "$stage" || return 1; fi
  [[ ! -e "$stage" ]]
}
early_cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  cleanup_staged_material || status=1
  exit "$status"
}
trap early_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage="$record/staged"
stage_env="$stage/env"
stage_assets="$stage/assets"
mkdir -p "$stage_env" "$stage_assets"
chmod 700 "$stage" "$stage_env" "$stage_assets"
stage_private_configuration "$stage_env"
capture_live_center_env "$stage_env/center.env"

postgres_before="$(find_postgres_container)"
stage_paired_identity "$postgres_before" "$stage_env/center.env"

edge_source="$PRIVATE_DIR/edge"; [[ -d "$edge_source" ]] || edge_source=/home/anders/cosmos-edge
attest_source="$(active_attestation_root)"
duc_source="$(active_device_user_root)"
theme_source="$PRIVATE_DIR/keycloak-theme"; [[ -d "$theme_source" ]] || theme_source=/home/anders/keycloak-themes/humane
for source in "$edge_source" "$attest_source" "$duc_source" "$theme_source"; do
  sudo -n test -d "$source" || fail "required protected asset tree is missing"
done
sudo -n cp -a "$edge_source" "$stage_assets/edge"
sudo -n cp -a "$attest_source" "$stage_assets/attest"
sudo -n cp -a "$duc_source" "$stage_assets/duc"
sudo -n cp -a "$theme_source" "$stage_assets/keycloak-theme"

runtime_stage="$stage_env/runtime.env"
cosmos_stage="$stage_env/cosmos.env"
provider_stage="$stage_env/providers.env"
center_stage="$stage_env/center.env"
rebind_runtime_keycloak_credentials() {
  local runtime="$1" keycloak_admin keycloak_password
  keycloak_admin="$(read_env_value "$RUNTIME_ENV" KEYCLOAK_ADMIN 2>/dev/null || true)"
  keycloak_password="$(read_env_value "$RUNTIME_ENV" KEYCLOAK_ADMIN_PASSWORD 2>/dev/null || true)"
  [[ -n "$keycloak_admin" && -n "$keycloak_password" ]] \
    || fail "staged runtime credentials are missing Keycloak administrator values"
  update_env_value "$runtime" KEYCLOAK_ADMIN "$keycloak_admin"
  update_env_value "$runtime" KEYCLOAK_ADMIN_PASSWORD "$keycloak_password"
}
rebind_runtime_keycloak_credentials "$runtime_stage"
update_env_value "$runtime_stage" REVIVAL_RELEASE_ID "$release_id"
update_env_value "$runtime_stage" REVIVAL_IMAGE_TAG "$release_id"
# Cosmos rejects service-path revisions longer than 63 characters, so the
# container revision uses a short prefix while release identity stays full.
update_env_value "$runtime_stage" REVIVAL_REVISION "${release_id:0:16}"
update_env_value "$runtime_stage" COSMOS_REVISION "${release_id:0:16}"
update_env_value "$runtime_stage" REVIVAL_DEPLOYMENT_ENVIRONMENT production
update_env_value "$runtime_stage" REVIVAL_PRIVATE_DIR "$PRIVATE_DIR"
update_env_value "$runtime_stage" REVIVAL_DATA_DIR "$DATA_DIR"
update_env_value "$runtime_stage" REVIVAL_COSMOS_ENV_FILE "$COSMOS_ENV"
update_env_value "$runtime_stage" REVIVAL_PROVIDER_ENV_FILE "$PROVIDER_ENV"
update_env_value "$runtime_stage" REVIVAL_CENTER_ENV_FILE "$CENTER_ENV"
update_env_value "$runtime_stage" REVIVAL_CENTER_DATA_DIR "$CENTER_DATA_DIR"
update_env_value "$runtime_stage" REVIVAL_EDGE_CONFIG_FILE "$PRIVATE_DIR/edge/envoy.yaml"
update_env_value "$runtime_stage" REVIVAL_EDGE_CERT_DIR "$PRIVATE_DIR/edge/certs"
update_env_value "$runtime_stage" REVIVAL_ATTEST_DIR "$PRIVATE_DIR/attest"
update_env_value "$runtime_stage" REVIVAL_DUC_DIR "$PRIVATE_DIR/duc"
update_env_value "$runtime_stage" REVIVAL_KEYCLOAK_THEME_DIR "$PRIVATE_DIR/keycloak-theme"
update_env_value "$runtime_stage" REVIVAL_SPOTIFY_ADAPTER_SECRET_FILE "$PRIVATE_DIR/spotify-adapter/token"
update_env_value "$runtime_stage" REVIVAL_CENTER_PORT 14000
update_env_value "$runtime_stage" REVIVAL_CONNECTIVITY_PORT 18085
update_env_value "$runtime_stage" REVIVAL_AI_BUS_HTTP_PORT 18086
update_env_value "$runtime_stage" REVIVAL_KEYCLOAK_PORT 8088
update_env_value "$runtime_stage" REVIVAL_EDGE_PORT 18443
update_env_value "$runtime_stage" REVIVAL_GRAFANA_PORT 13001
update_env_value "$runtime_stage" COSMOS_DEMO_ENABLED true

# The operator's pending configuration changes, applied to the CANDIDATE only.
#
# Here rather than inside stage_private_configuration, and the position is the
# whole correctness argument. capture_live_center_env above re-imports
# KEYCLOAK_SCOPES from the running Center container, so a proposal applied
# earlier would be overwritten by the value it was meant to replace. Everything
# below this line that writes an env value writes a name no proposal may name --
# COSMOS_REMOTE_TTS_ENABLED is set by the speech canary a few lines down, which
# is exactly why the catalog marks it undeliverable from the dashboard.
apply_configuration_proposals "$stage_env"

upload_base_url="$(read_env_value "$cosmos_stage" COSMOS_CAPTURE_UPLOAD_BASE_URL 2>/dev/null || true)"
if [[ -z "$upload_base_url" ]]; then
  upload_base_url="$(read_env_value "$cosmos_stage" COSMOS_CAPTURE_SHARE_BASE_URL 2>/dev/null || true)"
  if [[ -z "$upload_base_url" ]]; then
    upload_base_url="$(read_env_value "$runtime_stage" COSMOS_CAPTURE_SHARE_BASE_URL 2>/dev/null || true)"
  fi
fi
if [[ -z "$upload_base_url" ]]; then
  if [[ -n "${COSMOS_CAPTURE_UPLOAD_BASE_URL-}" ]]; then
    upload_base_url="$COSMOS_CAPTURE_UPLOAD_BASE_URL"
  elif [[ -n "${REVIVAL_PUBLIC_ORIGIN-}" ]]; then
    upload_base_url="$REVIVAL_PUBLIC_ORIGIN"
  fi
fi
if [[ -z "$upload_base_url" ]]; then
  upload_base_url="https://center.andersmadsen.dk"
  warn "defaulting COSMOS_CAPTURE_UPLOAD_BASE_URL to ${upload_base_url}; set it explicitly before deployment"
fi
if [[ -n "$upload_base_url" ]]; then
  update_env_value "$cosmos_stage" COSMOS_CAPTURE_UPLOAD_BASE_URL "$upload_base_url"
else
  fail "COSMOS_CAPTURE_UPLOAD_BASE_URL is required for production compose interpolation"
fi

onboarding_endpoint="$(read_env_value "$cosmos_stage" COSMOS_ONBOARDING_ENDPOINT 2>/dev/null || true)"
if [[ -z "$onboarding_endpoint" ]]; then
  if [[ -n "${COSMOS_ONBOARDING_ENDPOINT-}" ]]; then
    onboarding_endpoint="$COSMOS_ONBOARDING_ENDPOINT"
  elif [[ -n "${REVIVAL_PUBLIC_ORIGIN-}" ]]; then
    onboarding_endpoint="$REVIVAL_PUBLIC_ORIGIN"
  else
    onboarding_endpoint="${upload_base_url}"
  fi
fi
if [[ -z "$onboarding_endpoint" ]]; then
  onboarding_endpoint="https://center.andersmadsen.dk"
  warn "defaulting COSMOS_ONBOARDING_ENDPOINT to ${onboarding_endpoint}; set it explicitly before deployment"
fi
update_env_value "$cosmos_stage" COSMOS_ONBOARDING_ENDPOINT "$onboarding_endpoint"

searxng_secret="$(read_env_value "$cosmos_stage" SEARXNG_SECRET 2>/dev/null || true)"
if [[ -z "$searxng_secret" ]]; then
  searxng_secret="$(openssl rand -hex 32)"
  update_env_value "$cosmos_stage" SEARXNG_SECRET "$searxng_secret"
fi
(( ${#searxng_secret} >= 32 )) || fail "SearXNG secret is too short"
remove_env_value "$cosmos_stage" COSMOS_SEARXNG_BASE_URL
unset searxng_secret

# Prove the legacy provider produces a real MP3 before enabling the device-facing
# remote speech defaults in the staged candidate.
tts_tmp="$record/precutover-tts"
mkdir -p "$tts_tmp"
chmod 700 "$tts_tmp"
curl --silent --show-error --fail --connect-timeout 5 --max-time 40 \
  -D "$tts_tmp/headers" -o "$tts_tmp/audio.mp3" -H 'content-type: application/json' \
  --data '{"text":"Ai Pin Revival provider canary."}' http://127.0.0.1:18086/demo-api/speech
python3 - "$tts_tmp/headers" "$tts_tmp/audio.mp3" "$record/precutover-tts.tsv" <<'PY'
import hashlib,sys
headers=open(sys.argv[1],encoding="latin1").read().lower(); audio=open(sys.argv[2],"rb").read()
assert "content-type: audio/mpeg" in headers
assert 1024 <= len(audio) <= 2_000_000
assert audio.startswith(b"ID3") or (len(audio)>2 and audio[0]==0xff and audio[1]&0xe0==0xe0)
open(sys.argv[3],"w",encoding="utf-8").write(f"bytes\t{len(audio)}\nsha256\t{hashlib.sha256(audio).hexdigest()}\n")
PY
rm -rf -- "$tts_tmp"
chmod 600 "$record/precutover-tts.tsv"
update_env_value "$cosmos_stage" COSMOS_REMOTE_TTS_ENABLED true

spotify_live="$PRIVATE_DIR/spotify-adapter/token"
spotify_stage="$stage/spotify-token"
if [[ -f "$spotify_live" ]]; then
  [[ "$(stat -c '%u:%g' "$spotify_live")" == 1000:1001 ]] || fail "Spotify adapter token has unexpected ownership"
  spotify_mode="$(stat -c '%a' "$spotify_live")"
  [[ "$spotify_mode" == 400 || "$spotify_mode" == 440 ]] || fail "Spotify adapter token must be mode 0400 or 0440"
  install -m 600 "$spotify_live" "$spotify_stage"
else
  openssl rand -hex 32 >"$spotify_stage"
  chmod 600 "$spotify_stage"
fi
spotify_bytes="$(tr -d '\r\n' <"$spotify_stage" | wc -c | tr -d '[:space:]')"
((spotify_bytes >= 32)) || fail "Spotify adapter token is too short"

edge_token="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=')"
[[ "$edge_token" != "$(tr -d '\r\n' <"$spotify_stage")" ]] || fail "edge and Spotify tokens must be distinct"
for file in "$runtime_stage" "$cosmos_stage" "$provider_stage" "$center_stage"; do update_env_value "$file" COSMOS_EDGE_TOKEN "$edge_token"; done
unset edge_token
python3 "$release_dir/platform/edge/render-envoy.py" \
  --env "$runtime_stage" --template "$release_dir/platform/edge/envoy/envoy.yaml.tpl" \
  --output "$stage_assets/edge/envoy.yaml" --cert-dir /etc/cosmos-edge/certs >/dev/null
chmod 600 "$stage_assets/edge/envoy.yaml"

load_compose_command_with_env "$release_dir" "$runtime_stage" "$cosmos_stage" "$provider_stage" "$center_stage"
"${COMPOSE[@]}" config --quiet
assert_compose_ports
docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || docker pull --quiet "$HELPER_IMAGE" >/dev/null

# Resolve every pinned third-party image and build every first-party image before
# entering the quiesced window. Cutover itself runs with --pull never --no-build.
mapfile -t configured_images < <("${COMPOSE[@]}" config --images | LC_ALL=C sort -u)
for image in "${configured_images[@]}"; do
  [[ "$image" == ai-pin-revival/* ]] && continue
  docker pull --quiet "$image" >/dev/null
done
export COMPOSE_PARALLEL_LIMIT=1
"${COMPOSE[@]}" build --pull ai-bus
"${COMPOSE[@]}" build --pull center
"${COMPOSE[@]}" build --pull spotify-adapter
for image in "ai-pin-revival/cosmos:$release_id" "ai-pin-revival/center:$release_id" "ai-pin-revival/spotify-adapter:$release_id"; do
  docker image inspect "$image" >/dev/null || fail "candidate image was not built: $image"
done
: >"$record/resolved-images.tsv"
for image in "${configured_images[@]}"; do
  image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  repo_digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$image" 2>/dev/null || true)"
  printf '%s\t%s\t%s\n' "$image" "$image_id" "$repo_digests" >>"$record/resolved-images.tsv"
done
chmod 600 "$record/resolved-images.tsv"

backup_path="$BACKUP_ROOT/$deployment_id"
rollback_needed=1
writers_quiesced=0
cutover_started=0
config_installed=0
pointers_changed=0
nginx_transaction_invoked=0
domain_nginx_invoked=0
domain_cloudflared_invoked=0
cloudflared_route_state=recorded
channel_owner_before=""
ingress_evidence="$record/ingress-active.tsv"
ingress_quiesced=0
application_committed=0
postcandidate_backup=""
recovery_forbidden=0
channel_key_path="$CENTER_DATA_DIR/channel-key.json"

prepare_channel_key_metadata() {
  local driver="$1" target_record="$2" contract="$3"
  sudo -n python3 "$driver" --root "$REMOTE_ROOT" --record "$target_record" \
    --channel-key-action prepare --channel-key-path "$channel_key_path" --channel-key-contract "$contract"
}

apply_channel_key_metadata() {
  local driver="$1" target_record="$2"
  sudo -n python3 "$driver" --root "$REMOTE_ROOT" --record "$target_record" --channel-key-action apply
  sudo -n python3 "$driver" --root "$REMOTE_ROOT" --record "$target_record" --channel-key-action verify-desired
}

restore_channel_key_metadata() {
  local driver="$1" target_record="$2"
  [[ -f "$target_record/CHANNEL_KEY_METADATA_TRANSACTION.json" ]] || return 0
  sudo -n python3 "$driver" --root "$REMOTE_ROOT" --record "$target_record" --channel-key-action restore
  sudo -n python3 "$driver" --root "$REMOTE_ROOT" --record "$target_record" --channel-key-action verify-old
}

compare_center_zero_delta_with_migration() {
  local before="$1" after="$2" journal="$3"
  # The channel-key journal is written by the sudo-boundary transaction driver
  # and is therefore root-owned; read it with the same privilege when the
  # deployment user cannot open it directly.
  local -a comparison_python=(python3)
  [[ -r "$journal" ]] || comparison_python=(sudo -n python3)
  "${comparison_python[@]}" - "$before" "$after" "$journal" <<'PY'
import json,sys
before_path,after_path,journal_path=sys.argv[1:]
before={item["path"]:item for item in json.load(open(before_path,encoding="utf-8"))}
after={item["path"]:item for item in json.load(open(after_path,encoding="utf-8"))}
journal=json.load(open(journal_path,encoding="utf-8"))
assert set(before)==set(after) and set(journal)>={"contentSha256","oldMode","oldUid","oldGid","desiredMode","desiredUid","desiredGid"}
for name in before:
    old,new=before[name],after[name]
    if name=="channel-key.json":
        assert old.get("sha256")==new.get("sha256")==journal["contentSha256"]
        assert (old.get("mode"),old.get("uid"),old.get("gid"))==(oct(journal["oldMode"]),journal["oldUid"],journal["oldGid"])
        assert (new.get("mode"),new.get("uid"),new.get("gid"))==(oct(journal["desiredMode"]),journal["desiredUid"],journal["desiredGid"])
        for key in set(old)|set(new):
            if key not in {"mode","uid","gid"}: assert old.get(key)==new.get(key)
    else: assert old==new
PY
}

managed_snapshot="$record/config-before"
mkdir -p "$managed_snapshot"
chmod 700 "$managed_snapshot"
managed_names=(runtime.env cosmos.env providers.env center.env edge-envoy.yaml spotify-token)
managed_paths=("$RUNTIME_ENV" "$COSMOS_ENV" "$PROVIDER_ENV" "$CENTER_ENV" "$PRIVATE_DIR/edge/envoy.yaml" "$spotify_live")
: >"$managed_snapshot/presence.tsv"
for index in "${!managed_names[@]}"; do
  name="${managed_names[$index]}"; path="${managed_paths[$index]}"
  if [[ -f "$path" ]]; then
    cp -a "$path" "$managed_snapshot/$name"
    printf 'present\t%s\t%s\t%s\t%s\t%s\n' "$name" "$path" \
      "$(stat -c '%a' "$path")" "$(stat -c '%u:%g' "$path")" \
      "$(sha256sum "$path" | awk '{print $1}')" >>"$managed_snapshot/presence.tsv"
  else
    printf 'absent\t%s\t%s\t-\t-\t-\n' "$name" "$path" >>"$managed_snapshot/presence.tsv"
  fi
done
chmod 600 "$managed_snapshot/presence.tsv"
: >"$managed_snapshot/assets-presence.tsv"
for spec in "edge:$PRIVATE_DIR/edge" "attest:$PRIVATE_DIR/attest" "duc:$PRIVATE_DIR/duc" \
  "keycloak-theme:$PRIVATE_DIR/keycloak-theme"; do
  name="${spec%%:*}"; path="${spec#*:}"
  if [[ -d "$path" && ! -L "$path" ]]; then
    printf 'present\t%s\t%s\n' "$name" "$path" >>"$managed_snapshot/assets-presence.tsv"
  elif [[ ! -e "$path" && ! -L "$path" ]]; then
    printf 'absent\t%s\t%s\n' "$name" "$path" >>"$managed_snapshot/assets-presence.tsv"
  else
    fail "managed security asset path is unsafe: $path"
  fi
done
chmod 600 "$managed_snapshot/assets-presence.tsv"

restore_managed_configuration() {
  local state name path mode owner digest parent temporary actual
  while IFS=$'\t' read -r state name path mode owner digest; do
    parent="$(dirname -- "$path")"
    mkdir -p -- "$parent"
    if [[ "$state" == present ]]; then
      [[ -f "$managed_snapshot/$name" && ! -L "$managed_snapshot/$name" ]] || return 1
      [[ "$(stat -c '%a' "$managed_snapshot/$name")" == "$mode" \
        && "$(stat -c '%u:%g' "$managed_snapshot/$name")" == "$owner" \
        && "$(sha256sum "$managed_snapshot/$name" | awk '{print $1}')" == "$digest" ]] || return 1
      temporary="$(mktemp "$parent/.restore.XXXXXX")"
      cp -a "$managed_snapshot/$name" "$temporary"
      [[ "$(stat -c '%a' "$temporary")" == "$mode" \
        && "$(stat -c '%u:%g' "$temporary")" == "$owner" \
        && "$(sha256sum "$temporary" | awk '{print $1}')" == "$digest" ]] || { rm -f -- "$temporary"; return 1; }
      mv -f -- "$temporary" "$path"
      [[ "$(stat -c '%a' "$path")" == "$mode" \
        && "$(stat -c '%u:%g' "$path")" == "$owner" \
        && "$(sha256sum "$path" | awk '{print $1}')" == "$digest" ]] || return 1
    else
      [[ "$state" == absent && "$mode" == - && "$owner" == - && "$digest" == - ]] || return 1
      rm -f -- "$path"
    fi
  done <"$managed_snapshot/presence.tsv"
}

restore_managed_asset_presence() {
  local state name path expected
  [[ -f "$managed_snapshot/assets-presence.tsv" ]] || return 1
  while IFS=$'\t' read -r state name path; do
    case "$name" in
      edge) expected="$PRIVATE_DIR/edge" ;;
      attest) expected="$PRIVATE_DIR/attest" ;;
      duc) expected="$PRIVATE_DIR/duc" ;;
      keycloak-theme) expected="$PRIVATE_DIR/keycloak-theme" ;;
      *) return 1 ;;
    esac
    [[ "$path" == "$expected" ]] || return 1
    case "$state" in
      present) [[ -d "$path" && ! -L "$path" ]] || return 1 ;;
      absent) sudo -n rm -rf -- "$path" || return 1; [[ ! -e "$path" ]] || return 1 ;;
      *) return 1 ;;
    esac
  done <"$managed_snapshot/assets-presence.tsv"
  [[ "$(wc -l <"$managed_snapshot/assets-presence.tsv" | tr -d '[:space:]')" == 4 ]]
}

restore_connectivity_nginx() {
  [[ -d "$record/nginx-install" ]] || return 0
  if [[ -f "$record/nginx-install/snapshot/PRESENCE.COMPLETE" ]]; then
    if ! systemctl is-active --quiet nginx.service; then
      restore_nginx_transaction_snapshot "$record" 0 validate-only
    else
      restore_nginx_transaction_snapshot "$record" 0
    fi
  elif [[ -f "$record/nginx-install/INSTALL.COMPLETE" ]]; then
    return 1
  else
    # The installer arms live mutation only after atomically publishing the
    # completed presence manifest. No manifest therefore means no Nginx state
    # was changed, and recovery must not infer absence or delete anything.
    return 0
  fi
}

restore_domain_nginx() {
  [[ -f "$record/domain-cutover/nginx/SNAPSHOT.json" ]] || return 0
  if systemctl is-active --quiet nginx.service; then
    domain_nginx_restore "$record" reload
  else
    domain_nginx_restore "$record" validate-only
  fi
}

restore_domain_cloudflared() {
  [[ -f "$record/domain-cutover/cloudflared/JOURNAL.json" ]] || return 0
  domain_cloudflared_restore "$record"
}

restore_domain_keycloak() {
  [[ -f "$record/domain-cutover/keycloak/JOURNAL.json" ]] || return 0
  domain_keycloak_wait 8088 "$keycloak_before_host" || return 1
  domain_keycloak_restore "$record" "$runtime_stage" 8088 "$keycloak_before_host"
}

verify_recorded_containers() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)" == true ]] || return 1
  done <"$record/before/running-containers.txt"
}

restore_pointer() {
  local pointer="$1" target="$2"
  if [[ -n "$target" ]]; then
    ln -sfn "$target" "$REMOTE_ROOT/.${pointer}.restore"
    mv -Tf "$REMOTE_ROOT/.${pointer}.restore" "$REMOTE_ROOT/$pointer"
  else
    rm -f -- "$REMOTE_ROOT/$pointer"
  fi
}

complete_candidate_commit() {
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" --namespace deploy \
    --old-current "$old_current" --old-previous "$old_previous" \
    --old-current-deployment "$old_current_deployment" \
    --desired-current "$release_dir" --desired-previous "$old_current" \
    --desired-current-deployment "$record" || return 1
  [[ "$(safe_release_pointer "$REMOTE_ROOT/current")" == "$release_dir" \
    && "$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment")" == "$record" \
    && -f "$record/APPLICATION_COMMITTED" && -f "$record/SUCCEEDED" \
    && -f "$record/POINTER_TRANSACTION_COMMITTED" ]] || return 1
}

prepare_candidate_commit() {
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" --namespace deploy \
    --old-current "$old_current" --old-previous "$old_previous" \
    --old-current-deployment "$old_current_deployment" \
    --desired-current "$release_dir" --desired-previous "$old_current" \
    --desired-current-deployment "$record" --prepare-only
}

reprove_candidate_acceptance() {
  local cookie="$record/.finish-owner.cookies" canary_args
  [[ -f "$record/INGRESS_ACTIVATED" && -f "$record/running-images.tsv" \
    && -f "$record/config-digests.tsv" ]] || return 1
  assert_ingress_matches_recorded "$ingress_evidence" || return 1
  verify_configuration_evidence "$record/config-digests.tsv" "$release_dir" || return 1
  verify_image_evidence "$record/running-images.tsv" "$release_dir" || return 1
  domain_nginx_verify_desired "$record" || return 1
  domain_cloudflared_verify_desired "$record" || return 1
  domain_keycloak_verify_desired "$record" "$RUNTIME_ENV" 8088 || return 1
  verify_keycloak_post_migration_evidence "$record" || return 1
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action verify-desired || return 1
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --trust-root-action verify --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc" || return 1
  write_owner_canary_cookie "$release_dir" "$cookie" || return 1
  canary_args=(--release-id "$release_id" --image-evidence "$record/running-images.tsv" \
    --require-remote-tts --require-owner-spotify --cookie-file "$cookie")
  if [[ -n "$postcandidate_backup" && -f "$postcandidate_backup/invariants.tsv" ]]; then
    canary_args+=(--baseline "$postcandidate_backup")
  fi
  bash "$release_dir/platform/deploy/vps/remote/canary.sh" "${canary_args[@]}" >/dev/null
  local status=$?
  rm -f -- "$cookie"
  ((status == 0)) || return 1
  assert_ingress_matches_recorded "$ingress_evidence"
}

recover_previous_application() {
  local recovery_ok=1 old_release_id="" recovery_cookie="$record/recovery-owner.cookies"
  # Same disposition rules as finish_reconcile, and for the same two reasons.
  # `trap - EXIT HUP INT TERM` restored the DEFAULT (terminate) for the three
  # signals, and this handler is entered with public ingress ALREADY QUIESCED and
  # then runs for minutes — compose down, compose up, wait_for_services, two
  # canaries, and verify_legacy_application_with_patience. A SIGHUP from a dropped
  # ssh anywhere in that window killed it outright with the container stack, the
  # bridge, nginx and BOTH cloudflared connectors down, and no marker written.
  #
  # PIPE matters MORE here than in the reconcile: this handler's first act is a
  # `log`, which writes to STDOUT, so closing stderr alone is not the only way in.
  # Signals are installed before EXIT is cleared so nothing lands in the gap, and
  # they are commands rather than '' because SIG_IGN survives execve and would
  # make this handler's own docker and systemctl children unkillable.
  trap 'warn "signal received while the deployment is restoring public ingress; finishing the restore first"' HUP INT TERM
  trap ':' PIPE
  trap - EXIT
  set +e
  # Recovery stops public ingress again. If the cutover had already restored it
  # this is a SECOND outage the wearer pays for the same deployment, and it is
  # the longer, worse one; open a new window rather than letting it go
  # unmeasured because the first was already recorded.
  open_public_ingress_window
  quiesce_ingress_services "$ingress_evidence" 0 "$record" "$cloudflared_route_state" || recovery_ok=0
  if assert_ingress_quiesced; then ingress_quiesced=1; else recovery_ok=0; fi
  if ((cutover_started)); then
    if [[ -f "$runtime_stage" && -f "$cosmos_stage" && -f "$provider_stage" && -f "$center_stage" ]]; then
      load_compose_command_with_env "$release_dir" "$runtime_stage" "$cosmos_stage" "$provider_stage" "$center_stage"
    else
      load_compose_command "$release_dir"
    fi
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1
    if [[ $? != 0 ]]; then
      stop_project_containers "$PROJECT" || recovery_ok=0
      remove_project_containers "$PROJECT" || recovery_ok=0
    fi
  fi
  if ((config_installed)); then
    restore_managed_configuration || recovery_ok=0
    restore_managed_asset_presence || recovery_ok=0
    if ((nginx_transaction_invoked)); then restore_connectivity_nginx || recovery_ok=0; fi
    if ((domain_nginx_invoked)); then restore_domain_nginx || recovery_ok=0; fi
  fi
  restore_domain_cloudflared || recovery_ok=0
  cloudflared_route_state=before
  domain_cloudflared_verify_before "$record" || recovery_ok=0
  restore_channel_key_metadata "$transaction_driver" "$record" || recovery_ok=0
  if ((pointers_changed)); then
    restore_pointer current "$old_current" || recovery_ok=0
    restore_pointer previous "$old_previous" || recovery_ok=0
    restore_pointer current-deployment "$old_current_deployment" || recovery_ok=0
  fi
  if [[ -n "$old_current" && -d "$old_current" ]]; then
    old_release_id="$(basename "$old_current")"
    load_compose_command "$old_current"
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans || recovery_ok=0
    wait_for_services "$old_current" || recovery_ok=0
    restore_domain_keycloak || recovery_ok=0
    if [[ -n "$old_current_deployment" && -f "$old_current_deployment/running-images.tsv" \
        && -f "$old_current_deployment/config-digests.tsv" ]]; then
      (verify_configuration_evidence "$old_current_deployment/config-digests.tsv" "$old_current") || recovery_ok=0
      (verify_image_evidence "$old_current_deployment/running-images.tsv" "$old_current") || recovery_ok=0
      start_recorded_ingress_service "$ingress_evidence" penumbra-center-bridge.service || recovery_ok=0
      write_owner_canary_cookie "$old_current" "$recovery_cookie" || recovery_ok=0
      recovery_canary=(--release-id "$old_release_id" --image-evidence "$old_current_deployment/running-images.tsv" \
        --require-remote-tts --require-owner-spotify --quiesced-loopback --expect-bridge-ready \
        --cookie-file "$recovery_cookie")
      [[ "$keycloak_before_host" != cosmos.andersmadsen.dk ]] || recovery_canary+=(--legacy-dashboard-origin)
      if [[ -f "$backup_path/SHA256SUMS" && -f "$backup_path/invariants.tsv" ]]; then
        recovery_canary+=(--baseline "$backup_path")
      fi
      bash "$release_dir/platform/deploy/vps/remote/canary.sh" "${recovery_canary[@]}" >/dev/null || recovery_ok=0
      restore_ingress_services "$ingress_evidence" "$record" before || recovery_ok=0
      domain_cloudflared_verify_before "$record" || recovery_ok=0
      assert_ingress_matches_recorded "$ingress_evidence" || recovery_ok=0
      if ((recovery_ok)); then
        ingress_quiesced=0
        public_recovery_canary=(--release-id "$old_release_id" \
          --image-evidence "$old_current_deployment/running-images.tsv" --require-remote-tts \
          --require-owner-spotify --cookie-file "$recovery_cookie")
        [[ "$keycloak_before_host" != cosmos.andersmadsen.dk ]] || public_recovery_canary+=(--legacy-dashboard-origin)
        [[ ! -f "$backup_path/invariants.tsv" ]] || public_recovery_canary+=(--baseline "$backup_path")
        bash "$release_dir/platform/deploy/vps/remote/canary.sh" "${public_recovery_canary[@]}" >/dev/null || recovery_ok=0
      fi
    else
      recovery_ok=0
    fi
  elif ((writers_quiesced || cutover_started)); then
    start_recorded_containers "$record/before/running-containers.txt" || recovery_ok=0
    restore_domain_keycloak || recovery_ok=0
    restore_ingress_services "$ingress_evidence" "$record" before || recovery_ok=0
    domain_cloudflared_verify_before "$record" || recovery_ok=0
    assert_ingress_matches_recorded "$ingress_evidence" || recovery_ok=0
    if ((recovery_ok)); then ingress_quiesced=0; fi
    verify_legacy_application_with_patience "$record/before" || recovery_ok=0
  fi
  if ! assert_ingress_matches_recorded "$ingress_evidence"; then
    restore_ingress_services "$ingress_evidence" "$record" before || recovery_ok=0
    domain_cloudflared_verify_before "$record" || recovery_ok=0
    assert_ingress_matches_recorded "$ingress_evidence" || recovery_ok=0
    if ((recovery_ok)); then ingress_quiesced=0; fi
  fi
  if ((recovery_ok)); then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLED_BACK"
    chmod 600 "$record/ROLLED_BACK"
    rm -f -- "$recovery_cookie"
    return 0
  fi
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/RECOVERY_FAILED"
  chmod 600 "$record/RECOVERY_FAILED"
  rm -f -- "$recovery_cookie"
  return 1
}

# REOPEN THE EDGE FOR A TRANSACTION THAT WILL BE RESUMED.
#
# An armed candidate is never aborted — only resumed — so this path deliberately
# does not roll back. It also, until now, did not bring public ingress back: it
# wrote CANDIDATE_ACTIVATION_PENDING and exited with all four units stopped and
# the container stack down. The wearer stayed connection-refused until a human
# noticed and resumed, and the resume could not even start, because preflight
# refuses when the Cloudflare units are not running — the gate protecting the
# tunnel cannot run while the tunnel is down. That deadlock cost a real outage.
#
# Reopening changes nothing about the transaction: it stays pending, nothing is
# committed, no proof is claimed. It only refuses to leave the host dark while
# waiting for a human. The candidate stack is what comes back, not the
# predecessor — live mutation has already begun, and starting the previous
# release against a store the candidate has touched is the one thing this file
# never does.
reopen_pending_candidate_ingress() {
  local evidence="$1" reopened=0
  warn "the transaction stays pending, but public ingress will not be left down for it"
  if [[ ${#COMPOSE[@]} -gt 0 ]]; then
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans >/dev/null 2>&1 \
      || warn "the candidate application stack could not be started; the edge will open in front of a degraded application"
  fi
  reopen_recorded_ingress_best_effort "$evidence"
  case $? in
    0) reopened=1; warn "public ingress is back; the candidate activation is still pending and needs a resume" ;;
    20) reopened=1; warn "public ingress is only PARTIALLY back; the units named above stayed down and the candidate activation is still pending" ;;
    *) warn "public ingress could NOT be reopened; the Pin is connection-refused until an operator acts" ;;
  esac
  ((reopened == 0)) || record_reconcile_marker "$record" RECONCILE_INGRESS_REOPENED
}

finish_deploy() {
  local status=$? operation_terminal=0
  # Same disposition rules as finish_reconcile, and for the same two reasons.
  # `trap - EXIT HUP INT TERM` restored the DEFAULT (terminate) for the three
  # signals, and this handler is entered with public ingress ALREADY QUIESCED and
  # then runs for minutes — compose down, compose up, wait_for_services, two
  # canaries, and verify_legacy_application_with_patience. A SIGHUP from a dropped
  # ssh anywhere in that window killed it outright with the container stack, the
  # bridge, nginx and BOTH cloudflared connectors down, and no marker written.
  #
  # PIPE matters MORE here than in the reconcile: this handler's first act is a
  # `log`, which writes to STDOUT, so closing stderr alone is not the only way in.
  # Signals are installed before EXIT is cleared so nothing lands in the gap, and
  # they are commands rather than '' because SIG_IGN survives execve and would
  # make this handler's own docker and systemctl children unkillable.
  trap 'warn "signal received while the deployment is restoring public ingress; finishing the restore first"' HUP INT TERM
  trap ':' PIPE
  trap - EXIT
  if [[ -f "$record/POINTER_TRANSACTION_COMMITTED" && -f "$record/SUCCEEDED" ]]; then
    application_committed=1
    rollback_needed=0
  elif [[ -f "$record/POINTER_TRANSACTION_PREPARED" && -f "$record/INGRESS_ACTIVATED" ]]; then
    # Public acceptance is durable, so an interrupted pointer publication is
    # replayed only after current ingress and the owner/public contract are
    # re-proven. No previous application is started across this phase.
    if reprove_candidate_acceptance && complete_candidate_commit; then
      application_committed=1
      rollback_needed=0
    else
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/COMMIT_COMPLETION_FAILED"
      chmod 600 "$record/COMMIT_COMPLETION_FAILED"
      status=1
      rollback_needed=0
    fi
  fi
  if ((application_committed)) && [[ -f "$record/OPERATION_TRANSACTION_PREPARED" \
      && ! -f "$record/OPERATION_TRANSACTION_COMPLETED" ]]; then
    if python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
      --namespace deploy --operation-action complete; then
      :
    else
      status=1
    fi
  fi
  if ((application_committed)) && ! assert_ingress_matches_recorded "$ingress_evidence"; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/INGRESS_STATE_DRIFT"
    chmod 600 "$record/INGRESS_STATE_DRIFT"
    status=1
  fi
  if ((rollback_needed && recovery_forbidden)); then
    warn "candidate activation is durably prepared and will be resumed from the same verified release"
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/CANDIDATE_ACTIVATION_PENDING.tmp"
    chmod 600 "$record/CANDIDATE_ACTIVATION_PENDING.tmp"
    mv "$record/CANDIDATE_ACTIVATION_PENDING.tmp" "$record/CANDIDATE_ACTIVATION_PENDING"
    sync -f "$record/CANDIDATE_ACTIVATION_PENDING"
    rollback_needed=0
    status=1
    reopen_pending_candidate_ingress "$ingress_evidence"
  fi
  if ((rollback_needed)); then
    warn "deployment did not commit; proving recovery of the exact previous application"
    if ! recover_previous_application; then
      warn "automatic recovery failed; see $record/RECOVERY_FAILED"
      status=1
    elif [[ -f "$record/POINTER_TRANSACTION_PREPARED" && ! -f "$record/INGRESS_ACTIVATED" ]]; then
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/POINTER_TRANSACTION_ABORTED.tmp"
      chmod 600 "$record/POINTER_TRANSACTION_ABORTED.tmp"
      mv "$record/POINTER_TRANSACTION_ABORTED.tmp" "$record/POINTER_TRANSACTION_ABORTED"
      sync -f "$record/POINTER_TRANSACTION_ABORTED"
      python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
        --namespace deploy --operation-action abort || status=1
    elif [[ -f "$record/OPERATION_TRANSACTION_PREPARED" ]]; then
      python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
        --namespace deploy --operation-action abort || status=1
    fi
  fi
  if [[ ! -f "$record/OPERATION_TRANSACTION_PREPARED" \
      || -f "$record/OPERATION_TRANSACTION_COMPLETED" \
      || -f "$record/OPERATION_TRANSACTION_ABORTED" ]]; then
    operation_terminal=1
  fi
  if ((operation_terminal)); then
    cleanup_staged_material || status=1
  else
    warn "preserving staged trust roots for the pending deployment operation"
  fi
  # A deployment that did NOT ship still took the wearer's ingress down, usually
  # for longer than a successful one — the happy-path call sits after public
  # acceptance and never runs on this route, so exactly the worse windows were
  # the unrecorded ones. Record it here for every other exit.
  if [[ -n "$public_ingress_quiesce_epoch" ]]; then
    # DERIVED FROM THE LIVE UNITS, not from a marker. This used to key on
    # RECOVERY_FAILED alone, so the armed-preserve path above — where recovery is
    # FORBIDDEN rather than failed, and no such marker is written — recorded a
    # tidy closed window while every unit was still stopped. The number said the
    # outage had ended and it had not, which is worse than not measuring it.
    if reconcile_ingress_disturbed "$ingress_evidence"; then
      warn "public ingress is STILL DOWN; the figure below is the window so far, not its total width"
    fi
    record_public_ingress_window || warn "the public ingress window could not be recorded in $record"
  fi
  [[ ! -e "$incoming_release" ]] || rm -rf -- "$incoming_release"
  [[ ! -e "$incoming_release_dir" ]] || rm -rf -- "$incoming_release_dir"
  exit "$status"
}
trap finish_deploy EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Close the gap between initial extraction and the first live-state operation.
# Images were built from this tree, but the tree itself must still be the exact
# selected immutable release immediately before quiescence.
python3 "$release_verifier" --tree "$release_dir" \
  --manifest "$MANIFESTS_DIR/$release_id.json" --json >/dev/null

# Snapshot the exact existing Center client before the baseline backup. Admin
# authentication may touch Keycloak session/audit tables, so the subsequent
# backup deliberately captures that bounded read-side effect as part of the
# rollback baseline instead of pretending a later REST export is zero-delta.
domain_keycloak_snapshot_before "$record" "$runtime_stage" 8088 "$keycloak_before_host" \
  || fail "could not snapshot the existing Keycloak Center client"

# This backup leaves the exact writers quiesced; every later failure path
# restarts and canaries the recorded stack.
record_ingress_services "$ingress_evidence"
verify_cloudflared_activation_state "$ingress_evidence" "$record" recorded \
  || fail "Cloudflare ingress evidence does not bind the prepared configuration preimage"
python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --namespace deploy --operation-action prepare \
  --operation-ingress-evidence "$ingress_evidence"
# Pointer intent is distinct from operation authority but is also durable before
# quiescence. Until CANDIDATE_ACTIVATION_ARMED exists, a restart must recover the
# recorded application instead of attempting candidate activation.
prepare_candidate_commit
python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --namespace deploy --operation-action quiescing
# The wearer's outage starts HERE, not at quiesce_ingress_services below: the
# backup on the next line runs with --leave-quiesced, so it is the step that
# actually stops the writers and the ingress units. Marking the later call would
# under-report the window by the whole duration of a full restore-tested backup.
open_public_ingress_window
writers_quiesced=1
bash "$release_dir/platform/deploy/vps/remote/backup.sh" \
  --backup-id "$deployment_id" --leave-quiesced --already-locked \
  --cloudflared-record "$record" --cloudflared-state recorded --ingress-evidence "$ingress_evidence"
python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --namespace deploy --operation-action quiesced
[[ -f "$backup_path/BRIDGE_QUIESCED" ]] || fail "restore-tested backup did not retain Pin ingress quiescence"
verify_backup_artifact_manifest "$backup_path"
domain_keycloak_bind_backup "$record" "$backup_path" \
  || fail "Keycloak Center client journal could not bind to the restore-tested baseline"
quiesce_ingress_services "$ingress_evidence" 1 "$record" recorded
assert_ingress_quiesced || fail "managed ingress did not quiesce after backup"
ingress_quiesced=1

# WHY THE REHEARSAL BELOW STILL RUNS INSIDE THE OUTAGE WINDOW. The obvious
# optimization — restore ingress here, run the isolated smoke with the
# predecessor serving, re-quiesce for the cutover — fails on evidence, not on
# exposure. The exposure half actually checks out: restoring ingress would
# bring back the OLD stack (the candidate's Nginx/Cloudflare state is installed
# only after LIVE_MUTATION_STARTED, so a bad candidate still never receives
# public ingress), and the smoke binds no host ports at all. What breaks is the
# zero-delta chain anchored on $backup_path, captured just above with every
# writer stopped: the post-candidate backup is compared against it
# byte-for-byte before commit (postgres data/schema/security, cosmos state,
# bridge inventories), the precommit canaries verify its invariants.tsv, and
# prepare_channel_key_metadata and domain_keycloak_bind_backup bind their
# journals to it. Reopening ingress restarts the quiesced writers and readmits
# the Pin's five-minute device-status POSTs and Keycloak's own session/event
# writes, so those comparisons would then refuse the deploy for deltas no
# candidate caused — after cutover had started, which costs a full recovery and
# a second, longer window. Moving the rehearsal out of the window therefore
# means re-baselining all of that evidence on a second post-rehearsal backup
# (what the precommit-resume path does), not reordering these lines.
# Preserve the full staging-smoke transcript in the deployment record. The smoke
# runs in the quiesced window and can fail on latent environment-specific gates;
# a durable per-record log makes those failures diagnosable after recovery.
staging_smoke_log="$record/staging-smoke.log"
: >"$staging_smoke_log"
chmod 600 "$staging_smoke_log"
if (( skip_staging_smoke )); then
  # Record the skip as durable evidence, not just a log line. A release that
  # never rehearsed must never be mistaken later for one that rehearsed and
  # passed — the marker is what a reader of this record, or a future gate,
  # checks. Everything that guards production still ran: the backup was taken
  # and restore-verified above, and the canaries and drift check run below.
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/STAGING_SMOKE_SKIPPED"
  chmod 600 "$record/STAGING_SMOKE_SKIPPED"
  printf 'staging smoke skipped by --skip-staging-smoke\n' >>"$staging_smoke_log"
  warn "staging smoke SKIPPED by request: the isolated rehearsal did not run for this release"
elif ! REVIVAL_STAGING_SMOKE_TRACE="${REVIVAL_STAGING_SMOKE_TRACE:-0}" \
  REVIVAL_STAGING_SMOKE_EVIDENCE="$record/staging-smoke-evidence" \
  bash "$release_dir/platform/deploy/vps/remote/staging-smoke.sh" \
  --release-id "$release_id" --backup "$backup_path" --env-dir "$stage_env" \
  --attest-dir "$stage_assets/attest" --duc-dir "$stage_assets/duc" \
  --keycloak-theme-dir "$stage_assets/keycloak-theme" --spotify-token-file "$spotify_stage" \
  2> >(tee -a "$staging_smoke_log" >&2) > >(tee -a "$staging_smoke_log"); then
  warn "staging smoke failed; transcript preserved at $staging_smoke_log"
  tail -n 40 "$staging_smoke_log" >&2 || true
  fail "isolated staging smoke did not pass"
fi

assert_ingress_quiesced || fail "managed ingress reopened before cutover"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/LIVE_MUTATION_STARTED.tmp"
chmod 600 "$record/LIVE_MUTATION_STARTED.tmp"
mv "$record/LIVE_MUTATION_STARTED.tmp" "$record/LIVE_MUTATION_STARTED"
sync -f "$record/LIVE_MUTATION_STARTED"
cutover_started=1
stop_project_containers "$PROJECT"
stop_project_containers "$LEGACY_PROJECT"

# First live configuration write: the old containers are stopped and a full,
# restore-tested backup plus isolated candidate rehearsal both exist.
config_installed=1
mkdir -p "$PRIVATE_DIR" "$PRIVATE_DIR/spotify-adapter"
chmod 700 "$PRIVATE_DIR" "$PRIVATE_DIR/spotify-adapter"
for asset in edge attest duc keycloak-theme; do
  if [[ ! -d "$PRIVATE_DIR/$asset" ]]; then
    sudo -n cp -a "$stage_assets/$asset" "$PRIVATE_DIR/$asset"
    [[ "$(protected_path_digest "$PRIVATE_DIR/$asset")" == "$(protected_path_digest "$stage_assets/$asset")" ]] \
      || fail "protected asset changed during installation: $asset"
  fi
done
for spec in "$runtime_stage:$RUNTIME_ENV" "$cosmos_stage:$COSMOS_ENV" "$provider_stage:$PROVIDER_ENV" "$center_stage:$CENTER_ENV"; do
  source_file="${spec%%:*}"; destination_file="${spec#*:}"
  temporary="$(mktemp "${destination_file}.tmp.XXXXXX")"
  install -m 600 "$source_file" "$temporary"
  mv -f -- "$temporary" "$destination_file"
done
temporary="$(mktemp "$PRIVATE_DIR/edge/.envoy.yaml.tmp.XXXXXX")"
install -m 600 "$stage_assets/edge/envoy.yaml" "$temporary"
mv -f -- "$temporary" "$PRIVATE_DIR/edge/envoy.yaml"
if [[ ! -f "$spotify_live" ]]; then
  sudo -n install -o 1000 -g 1001 -m 400 "$spotify_stage" "$spotify_live"
fi

domain_nginx_invoked=1
domain_nginx_install "$record" \
  "$release_dir/platform/edge/nginx/ai-pin-revival-center.conf.template" \
  "$domain_discovery" 14000 8088 validate-only
domain_nginx_verify_desired "$record" \
  || fail "canonical Center Nginx transaction did not reach its durable desired state"

domain_cloudflared_invoked=1
domain_cloudflared_install "$record" \
  || fail "canonical Center Cloudflare route transaction did not install its validated desired state"
cloudflared_route_state=desired
domain_cloudflared_verify_desired "$record" \
  || fail "canonical Center Cloudflare route transaction did not reach its durable desired state"

nginx_transaction_invoked=1
bash "$release_dir/platform/edge/install-connectivity.sh" \
  --source "$release_dir/platform/edge/nginx/ai-pin-revival-connectivity.conf" --backup-dir "$record" --nginx-stopped
validate_nginx_transaction_snapshot "$record" 1 || fail "Nginx installation lacks complete transaction evidence"

load_compose_command "$release_dir"
"${COMPOSE[@]}" config --quiet
assert_compose_ports
record_configuration_evidence "$release_dir" "$record/config-digests.tsv"
prepare_channel_key_metadata "$transaction_driver" "$record" "$backup_path/invariants.tsv"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/CANDIDATE_ACTIVATION_ARMED.tmp"
chmod 600 "$record/CANDIDATE_ACTIVATION_ARMED.tmp"
mv "$record/CANDIDATE_ACTIVATION_ARMED.tmp" "$record/CANDIDATE_ACTIVATION_ARMED"
sync -f "$record/CANDIDATE_ACTIVATION_ARMED"
recovery_forbidden=1
apply_channel_key_metadata "$transaction_driver" "$record"
sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --trust-root-action record --staged-attest "$stage_assets/attest" --staged-duc "$stage_assets/duc" \
  --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
if ! "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans; then
  # The candidate is torn down by recovery, taking its container logs with it.
  # Preserve the failing containers' state and logs in the record first so a
  # crash-loop (bad env, migration, dependency) is diagnosable after the fact.
  candidate_failure_log="$record/candidate-failure.log"
  {
    echo "=== candidate up -d failed at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    "${COMPOSE[@]}" ps || true
    for cid in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do
      name="$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')"
      echo "--- inspect $name ---"
      docker inspect --format '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}}' "$cid" 2>/dev/null || true
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null | grep -E 'COSMOS_INSTANCE_ID|COSMOS_POD_NAME|COSMOS_REVISION|COSMOS_WORKLOAD' || true
      echo "--- logs $name (tail 25) ---"
      docker logs --tail 25 "$cid" 2>&1 | tail -25 || true
    done
  } >"$candidate_failure_log" 2>&1 || true
  chmod 600 "$candidate_failure_log" 2>/dev/null || true
  warn "candidate activation failed; diagnostics preserved at $candidate_failure_log"
  tail -n 60 "$candidate_failure_log" >&2 || true
  fail "candidate stack did not become healthy"
fi
record_image_evidence "$release_dir" "$record/running-images.tsv"
verify_running_against_resolved "$record/resolved-images.tsv" "$record/running-images.tsv"
verify_configuration_evidence "$record/config-digests.tsv" "$release_dir"
owner_canary_cookie="$stage_env/owner-canary.cookies"
write_owner_canary_cookie "$release_dir" "$owner_canary_cookie"
bash "$release_dir/platform/deploy/vps/remote/canary.sh" \
  --release-id "$release_id" --baseline "$backup_path" --image-evidence "$record/running-images.tsv" \
  --require-remote-tts --quiesced-loopback --cookie-file "$owner_canary_cookie"
assert_ingress_quiesced || fail "managed ingress reopened during precommit canary"

# Capture the complete mutable compatibility state after the first live start.
# Public ingress remains down; the bridge is started only so backup can prove
# its own health, while Nginx/Cloudflare remain stopped.
start_recorded_ingress_service "$ingress_evidence" penumbra-center-bridge.service
ingress_quiesced=0
postcandidate_backup_id="precommit-${deployment_id:0:64}-$(date -u +%Y%m%dT%H%M%SZ)"
postcandidate_backup="$BACKUP_ROOT/$postcandidate_backup_id"
# Digest this backup's relation data over the columns the PRE-candidate backup was
# digested over, so the byte comparison below answers "did a value move?" and not
# "did the column list change?". See compare_precommit_compatibility_state.
postcandidate_projection_args=()
mapfile -t postcandidate_projection_args < <(precommit_projection_args "$backup_path")
bash "$release_dir/platform/deploy/vps/remote/backup.sh" \
  --backup-id "$postcandidate_backup_id" --leave-quiesced --already-locked --public-ingress-quiesced \
  --cloudflared-record "$record" --cloudflared-state desired --ingress-evidence "$ingress_evidence" \
  "${postcandidate_projection_args[@]}"
[[ -f "$postcandidate_backup/SHA256SUMS" && -f "$postcandidate_backup/BRIDGE_QUIESCED" \
  && -f "$postcandidate_backup/PUBLIC_INGRESS_QUIESCED" ]] \
  || fail "post-candidate zero-delta backup is incomplete"
assert_ingress_quiesced || fail "post-candidate backup did not leave every ingress service quiesced"
ingress_quiesced=1
(cd "$postcandidate_backup" && sha256sum -c SHA256SUMS >/dev/null)
verify_backup_artifact_manifest "$postcandidate_backup"
# SAME-RELEASE: both backups were taken by this release's backup.sh, so both
# already contain this release's projected data manifest and its retained-text
# schema manifest. The paths are simply the two backups' own.
compare_precommit_compatibility_state "$backup_path" "$postcandidate_backup" \
  "candidate changed compatibility state before commit" \
  "$postcandidate_backup/postgres-data.tsv" \
  "$backup_path/postgres-schema.tsv" "$postcandidate_backup/postgres-schema.tsv"
compare_center_zero_delta_with_migration \
  "$backup_path/center-data.inventory.json" "$postcandidate_backup/center-data.inventory.json" \
  "$record/CHANNEL_KEY_METADATA_TRANSACTION.json" \
  || fail "candidate changed Center data beyond the journaled channel-key owner migration"
verify_image_evidence "$record/running-images.tsv" "$release_dir"
verify_configuration_evidence "$record/config-digests.tsv" "$release_dir"
recovery_forbidden=0

# Restart the already-proven candidate with ingress still closed. From this
# point a failure leaves the selected candidate in place; it never runs an old
# application against state touched after the zero-delta boundary.
recovery_forbidden=1
load_compose_command "$release_dir"
sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" --channel-key-action verify-desired
sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --trust-root-action verify --live-attest "$PRIVATE_DIR/attest" --live-duc "$PRIVATE_DIR/duc"
"${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans
wait_for_services "$release_dir"
domain_keycloak_apply "$record" "$RUNTIME_ENV" 8088 center.andersmadsen.dk \
  || fail "canonical Center Keycloak client migration failed"
record_keycloak_post_migration_evidence "$record" \
  || fail "Keycloak post-migration database evidence could not be recorded"
domain_nginx_verify_desired "$record" \
  || fail "canonical Center Nginx state drifted before activation"
domain_cloudflared_verify_desired "$record" \
  || fail "canonical Center Cloudflare route drifted before activation"
bash "$release_dir/platform/deploy/vps/remote/canary.sh" \
  --release-id "$release_id" --baseline "$postcandidate_backup" \
  --image-evidence "$record/running-images.tsv" --require-remote-tts \
  --quiesced-loopback --cookie-file "$owner_canary_cookie"
# Bring up the local Pin bridge first, prove the full owner path with public
# ingress still closed, then activate and prove the public edge.  No success
# marker or authority pointer exists until every one of these checks passes.
start_recorded_ingress_service "$ingress_evidence" penumbra-center-bridge.service
ingress_quiesced=0
wait_for_services "$release_dir"
bash "$release_dir/platform/deploy/vps/remote/canary.sh" \
  --release-id "$release_id" \
  --image-evidence "$record/running-images.tsv" --require-remote-tts \
  --require-owner-spotify --require-wearer-plane --quiesced-loopback --expect-bridge-ready \
  --cookie-file "$owner_canary_cookie"
restore_ingress_services "$ingress_evidence" "$record" desired
domain_cloudflared_verify_desired "$record" \
  || fail "canonical Center Cloudflare route drifted after connector activation"
assert_ingress_matches_recorded "$ingress_evidence" || fail "activated ingress differs from its recorded pre-cutover state"
# Public ingress is serving again and matches its recorded pre-cutover state, so
# the wearer's outage is over and its width is now a fact rather than a guess.
record_public_ingress_window
# The last gate before the deployment is accepted, and the only one that reaches
# Center's wearer data plane through the fully activated public edge.
bash "$release_dir/platform/deploy/vps/remote/canary.sh" \
  --release-id "$release_id" \
  --image-evidence "$record/running-images.tsv" --require-remote-tts \
  --require-owner-spotify --require-wearer-plane --cookie-file "$owner_canary_cookie"

printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/INGRESS_ACTIVATED.tmp"
chmod 600 "$record/INGRESS_ACTIVATED.tmp"
mv "$record/INGRESS_ACTIVATED.tmp" "$record/INGRESS_ACTIVATED"
sync -f "$record/INGRESS_ACTIVATED"
assert_ingress_matches_recorded "$ingress_evidence" || fail "ingress changed after public acceptance"
pointers_changed=1
complete_candidate_commit || fail "accepted candidate pointer transaction could not be completed"
application_committed=1
python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --namespace deploy --operation-action complete

# Remove sensitive staged copies only after accepted authority is durable.
cleanup_staged_material || fail "sensitive staged material could not be removed"
rollback_needed=0
writers_quiesced=0
recovery_forbidden=0
trap - EXIT HUP INT TERM

if ((json)); then
  # publicIngressWindowSeconds carries the wearer-visible cost of this release to
  # whatever consumes --json. It is null only when the deployment never opened
  # the window; a successful deploy always has a number here.
  python3 - "$release_id" "$deployment_id" "$backup_path" "$public_ingress_window_seconds" <<'PY'
import json,sys
window=sys.argv[4]
print(json.dumps({
    "ok":True,"releaseId":sys.argv[1],"deploymentId":sys.argv[2],"backup":sys.argv[3],
    "canary":"read-only","publicIngressWindowSeconds":int(window) if window else None,
},separators=(",",":")))
PY
else
  log "deployed canonical release $release_id (deployment $deployment_id)"
fi
