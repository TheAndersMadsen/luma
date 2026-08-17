#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/lib/local.sh"

deployment=""
json=0
usage() { echo "usage: $0 [--remote vps] --deployment ID [--json]" >&2; exit 64; }
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --deployment) (($# >= 2)) || usage; deployment="$2"; shift 2 ;;
    --json) json=1; shift ;;
    # Named explicitly so the answer is the reason rather than `usage:`. This
    # argument was documented for long enough that it is in muscle memory, and
    # a bare usage error at rollback time reads as an operator typo — which is
    # how a recovery control that never existed survived unnoticed.
    --confirm-database-restore*)
      echo "error: rollback never restores a database; --confirm-database-restore is not implemented anywhere." >&2
      echo "       This command returns the app to the previous release and keeps every post-cutover write." >&2
      echo "       Manual database restore procedure: docs/recovery.md (Restoring a database)." >&2
      exit 64 ;;
    *) usage ;;
  esac
done
[[ "$deployment" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage
need_local ssh
args=(--deployment "$deployment")
((json)) && args+=(--json)
run_current_release_operation rollback.sh "${args[@]}"
