#!/usr/bin/env bash
# Local side of the supported release/backup retention command.
#
# Streamed with run_remote_impl rather than dispatched through
# run_current_release_operation, and that is the whole point of the choice: this
# tool is needed exactly when the disk is too full for a deploy to run, so it
# cannot depend on a release having already shipped it to the server. It is also
# why it is not in run_current_release_operation's operation allowlist -- that
# path executes out of `current`, which is one of the things this command reasons
# about, and it takes the deployment lock for its own callers before the entry
# point can decide whether taking it is appropriate.
#
# The argument list is closed. There is no pass-through, so no future caller can
# hand the remote entry point an option this file has not been read to allow.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/lib/local.sh"

confirm=0
json=0
show_all=0
expect_plan=""
include_incomplete=0
min_age_hours=24
explain() {
  cat <<EOF
usage: ./revival prune-state [--remote vps] [--min-age-hours N] [--show-all]
                             [--include-incomplete] [--json]
                             [--confirm [--expect-plan TOKEN]]

Gives backups/ and releases/ a retention policy and reclaims what no recovery
path can still reach. Nothing else in this tree removes anything from either
store, so without this they grow until preflight refuses every deploy for
insufficient free space -- with production serving normally the whole time.

WITHOUT --confirm this only PLANS: it prints every backup and release tree it
would remove, every one it would keep with the named reason it is kept, and a
plan token. It changes nothing.
WITH --confirm it removes exactly what it printed, then re-proves the recovery
path -- the current and previous release pointers still resolve, the current
deployment's rollback baseline backup still verifies against its own SHA256SUMS,
the rollback target's record, backup and release tree are all still present, and
drift.sh still selects the same newest verified backup.

WHAT IT WILL NOT REMOVE, whatever the age
  the current release and the release the current deployment record names; the
  release the \`previous\` pointer names (deploy and rollback both publish
  authority through it); every release and backup along the rollback chain, which
  is transitive because rolling back makes the predecessor current and therefore
  itself rollback-eligible; anything named by a pending or armed transaction; the
  newest verified backup, which drift.sh selects by mtime; and anything it cannot
  classify. Deployment records and manifests are never touched at all.

Options
  --min-age-hours N     never remove anything modified within the last N hours.
                        Default 24. This is defence in depth, not the policy:
                        everything reachable is already retained by proof.
  --include-incomplete  also remove backups missing SHA256SUMS or
                        BACKUP_MANIFEST.json. Held back by default: they are the
                        residue of failed operations, and the operator who wants
                        them gone should say so.
  --show-all            also list every retained item and its reason
  --confirm             act; without it, plan only
  --expect-plan TOKEN   refuse unless the plan still matches the token the dry
                        run printed
  --json                machine-readable plan or result
  --remote NAME         SSH target (default: vps)
  --help                show this message
EOF
}
usage() { explain >&2; exit 64; }
while (($#)); do
  case "$1" in
    --help|-h) explain; exit 0 ;;
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --min-age-hours) (($# >= 2)) || usage; min_age_hours="$2"; shift 2 ;;
    --include-incomplete) include_incomplete=1; shift ;;
    --expect-plan) (($# >= 2)) || usage; expect_plan="$2"; shift 2 ;;
    --show-all) show_all=1; shift ;;
    --confirm) confirm=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$min_age_hours" =~ ^[0-9]{1,4}$ ]] \
  || usage_error "--min-age-hours must be a whole number of hours"
[[ -z "$expect_plan" || "$expect_plan" =~ ^[0-9a-f]{64}$ ]] \
  || usage_error "--expect-plan must be the 64-character plan token the dry run printed"
# Refused here as well as remotely, so an operator who reached for the token
# without --confirm is told before a connection is opened.
((confirm)) || [[ -z "$expect_plan" ]] \
  || usage_error "--expect-plan is only meaningful with --confirm; without it nothing is removed anyway"

need_local ssh
args=(--min-age-hours "$min_age_hours")
((show_all)) && args+=(--show-all)
((include_incomplete)) && args+=(--include-incomplete)
((json)) && args+=(--json)
((confirm)) && args+=(--confirm)
[[ -z "$expect_plan" ]] || args+=(--expect-plan "$expect_plan")
run_remote_impl prune-state.sh "${args[@]}"
