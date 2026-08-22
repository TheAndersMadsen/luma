#!/usr/bin/env -S /bin/bash -p
set -euo pipefail
case "${BASH_SOURCE[0]}" in /*) SCRIPT_PATH="${BASH_SOURCE[0]}" ;; *) SCRIPT_PATH="$PWD/${BASH_SOURCE[0]}" ;; esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
builtin source "$SCRIPT_DIR/lib/local.sh"

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
