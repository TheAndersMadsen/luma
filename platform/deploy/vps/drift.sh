#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/lib/local.sh"

json=0
usage() { echo "usage: $0 [--remote vps] [--json]" >&2; exit 64; }
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
need_local ssh
args=()
((json)) && args+=(--json)
run_current_release_operation drift.sh "${args[@]}"
