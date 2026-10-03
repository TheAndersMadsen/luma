#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${LUMA_ENV_FILE:?LUMA_ENV_FILE is required}"
operator_compose="${LUMA_CONFIG_DIR:?LUMA_CONFIG_DIR is required}/production/operator.compose.yaml"
application="${LUMA_COMPOSE_APPLICATION:?LUMA_COMPOSE_APPLICATION is required}"
project_name="${COMPOSE_PROJECT_NAME:-luma}"
wait_timeout="${LUMA_DEPLOY_WAIT_TIMEOUT:-180}"
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
# The confirmed CLI re-renders the edge configuration and the operator overlay
# from this release. `up` recreates a service whose mounts changed, but Compose
# does not recreate a container when only a file-backed secret's contents
# change, so recreate the edge services to load the rendered files.
edge_services=(traefik)
if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  edge_services+=(edge)
fi
edge_up=(up --yes --detach --wait --wait-timeout "$wait_timeout" --no-deps --force-recreate "${edge_services[@]}")

if ((dry_run)); then
  # The steps a confirmed deploy takes, in order, then the exact commands.
  steps=(
    "Re-render the edge configuration and operator overlay from this release."
    "Pull this release's digest-pinned images, start every service, and wait until each is healthy."
    "Recreate the edge containers (${edge_services[*]}): every hostname Traefik serves pauses briefly."
  )
  if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
    steps+=("Switch Center to this release's staged Pin apps.")
  fi
  steps+=(
    "Apply this release's realm policy to the running Keycloak realm."
    "Run the checks of ./luma verify production."
  )
  echo "Nothing was changed. ./luma deploy production --confirm will:"
  for index in "${!steps[@]}"; do
    printf '  %d. %s\n' "$((index + 1))" "${steps[index]}"
  done
  echo "Commands:"
  printf 'docker compose'
  printf ' %q' "${compose[@]}" "${up[@]}"
  printf '\ndocker compose'
  printf ' %q' "${compose[@]}" "${edge_up[@]}"
  printf '\nbun --no-env-file %q reconcile --project-name %q\n' "$ROOT/platform/cli/realm.js" "$project_name"
  exit 0
fi

[[ "${LUMA_DEPLOY_CONFIRMED:-}" == 1 ]] || {
  echo "production deployment requires luma deploy production --confirm" >&2
  exit 1
}

# `--yes` is Compose's supported noninteractive trust flag for remote Compose
# artifacts. Luma has already required an explicit --confirm and completed
# preflight, so there is no second prompt that could print interpolated secrets.
# It would also accept Compose's "recreate volume (data will be lost)" prompt,
# which is why preflight refuses any volume whose definition changed.
docker compose "${compose[@]}" "${up[@]}"
docker compose "${compose[@]}" "${edge_up[@]}"
docker compose "${compose[@]}" ps
if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  # Setup leaves the descriptor-bound Pin bundle in an owner-only staging
  # namespace. The new Center fails closed while the old pointer is active;
  # switch it only after Compose reports the exact new services ready, then run
  # one complete verification over the combined server-and-Pin release.
  bun --no-env-file "$ROOT/platform/deploy/pin/acquire-release.mjs" --activate --json
fi
# Keycloak imports the realm seed only when it creates the realm, so apply this
# release's realm policy to the running realm, which `up --wait` left healthy.
bun --no-env-file "$ROOT/platform/cli/realm.js" reconcile --project-name "$project_name"
"$SCRIPT_DIR/verify.sh" --env-file "$env_file" --project-name "$project_name"
printf 'Luma release %s is deployed and passed production verification.\n' "$LUMA_RELEASE_ID"
