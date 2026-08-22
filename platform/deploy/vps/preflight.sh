#!/usr/bin/env -S /bin/bash -p
set -euo pipefail
case "${BASH_SOURCE[0]}" in /*) SCRIPT_PATH="${BASH_SOURCE[0]}" ;; *) SCRIPT_PATH="$PWD/${BASH_SOURCE[0]}" ;; esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
builtin source "$SCRIPT_DIR/lib/local.sh"

min_free_gb=8
cleanup=0
json=0
archive_bytes=0
usage() {
  cat >&2 <<EOF
usage: $0 [--remote vps] [--min-free-gb N] [--archive-bytes N]
          [--cleanup-project-images] [--json]
EOF
  exit 64
}
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --min-free-gb) (($# >= 2)) || usage; min_free_gb="$2"; shift 2 ;;
    --archive-bytes) (($# >= 2)) || usage; archive_bytes="$2"; shift 2 ;;
    --cleanup-project-images) cleanup=1; shift ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
need_local ssh
args=(--min-free-gb "$min_free_gb" --archive-bytes "$archive_bytes")
((cleanup)) && args+=(--cleanup-project-images)
((json)) && args+=(--json)
run_remote_impl preflight.sh "${args[@]}"
