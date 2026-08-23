#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${REVIVAL_ENV_FILE:-$ROOT/.env.production}"
project_name="${COMPOSE_PROJECT_NAME:-ai-pin-revival}"
wait_timeout="${REVIVAL_DEPLOY_WAIT_TIMEOUT:-180}"
dry_run=0

usage() {
  echo "usage: $0 [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS] [--dry-run]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --env-file) (($# >= 2)) || usage; env_file="$2"; shift 2 ;;
    --project-name) (($# >= 2)) || usage; project_name="$2"; shift 2 ;;
    --wait-timeout) (($# >= 2)) || usage; wait_timeout="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ "$env_file" = /* ]] || env_file="$PWD/$env_file"
[[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || {
  echo "wait timeout must be a positive number of seconds" >&2
  exit 1
}

if [[ -z "${REVIVAL_RELEASE_ID:-}" ]]; then
  REVIVAL_RELEASE_ID="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
  export REVIVAL_RELEASE_ID
fi
export REVIVAL_DEPLOYMENT_ENVIRONMENT=production

"$SCRIPT_DIR/preflight.sh" --env-file "$env_file" --project-name "$project_name"

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$ROOT/compose.yaml"
  -f "$ROOT/platform/compose/production.yaml"
)
up=(up --build --detach --remove-orphans --wait --wait-timeout "$wait_timeout")

if ((dry_run)); then
  printf 'docker compose'
  printf ' %q' "${compose[@]}" "${up[@]}"
  printf '\n'
  exit 0
fi

docker compose "${compose[@]}" "${up[@]}"
docker compose "${compose[@]}" ps
printf 'Cosmos deployment %s is healthy.\n' "$REVIVAL_RELEASE_ID"
