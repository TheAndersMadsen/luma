#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${REVIVAL_ENV_FILE:-$ROOT/.env.production}"
project_name="${COMPOSE_PROJECT_NAME:-ai-pin-revival}"

usage() {
  echo "usage: $0 [--env-file FILE] [--project-name NAME]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --env-file) (($# >= 2)) || usage; env_file="$2"; shift 2 ;;
    --project-name) (($# >= 2)) || usage; project_name="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ "$env_file" = /* ]] || env_file="$PWD/$env_file"
[[ -f "$env_file" && ! -L "$env_file" && -r "$env_file" ]] || {
  echo "production environment is not a readable regular file: $env_file" >&2
  exit 1
}
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "invalid Compose project name: $project_name" >&2
  exit 1
}
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null

if [[ -z "${REVIVAL_RELEASE_ID:-}" ]]; then
  REVIVAL_RELEASE_ID="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
  export REVIVAL_RELEASE_ID
fi
export REVIVAL_DEPLOYMENT_ENVIRONMENT=production

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$ROOT/compose.yaml"
  -f "$ROOT/platform/compose/production.yaml"
)

docker compose "${compose[@]}" config --quiet
printf 'Compose configuration is valid for %s (%s).\n' "$project_name" "$REVIVAL_RELEASE_ID"
