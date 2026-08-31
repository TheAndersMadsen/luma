#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${REVIVAL_ENV_FILE:?REVIVAL_ENV_FILE is required}"
operator_compose="${REVIVAL_CONFIG_DIR:?REVIVAL_CONFIG_DIR is required}/production/operator.compose.yaml"
application="${REVIVAL_COMPOSE_APPLICATION:?REVIVAL_COMPOSE_APPLICATION is required}"
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

"$SCRIPT_DIR/preflight.sh" --env-file "$env_file" --project-name "$project_name"

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$application"
  -f "$operator_compose"
)
up=(up --yes --detach --wait --wait-timeout "$wait_timeout" --pull always --remove-orphans)

if ((dry_run)); then
  printf 'docker compose'
  printf ' %q' "${compose[@]}" "${up[@]}"
  printf '\n'
  exit 0
fi

[[ "${REVIVAL_DEPLOY_CONFIRMED:-}" == 1 ]] || {
  echo "production deployment requires revival deploy production --confirm" >&2
  exit 1
}

# `--yes` is Compose's supported noninteractive trust flag for remote Compose
# artifacts. Revival has already required an explicit --confirm and completed
# preflight, so there is no second prompt that could print interpolated secrets.
docker compose "${compose[@]}" "${up[@]}"
docker compose "${compose[@]}" ps
if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  # Setup leaves the descriptor-bound Pin bundle in an owner-only staging
  # namespace. The new Center fails closed while the old pointer is active;
  # switch it only after Compose reports the exact new services ready, then run
  # one complete verification over the combined server-and-Pin release.
  node "$ROOT/platform/deploy/pin/acquire-release.mjs" --activate --json
fi
"$SCRIPT_DIR/verify.sh" --env-file "$env_file" --project-name "$project_name"
printf 'Cosmos deployment %s passed production verification.\n' "$REVIVAL_RELEASE_ID"
