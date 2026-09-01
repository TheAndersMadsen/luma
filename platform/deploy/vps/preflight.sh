#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${REVIVAL_ENV_FILE:?REVIVAL_ENV_FILE is required}"
operator_compose="${REVIVAL_CONFIG_DIR:?REVIVAL_CONFIG_DIR is required}/production/operator.compose.yaml"
application="${REVIVAL_COMPOSE_APPLICATION:?REVIVAL_COMPOSE_APPLICATION is required}"
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
for file in "$env_file" "$operator_compose"; do
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || {
    echo "production input is not a readable regular file: $file" >&2
    exit 1
  }
done
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "invalid Compose project name: $project_name" >&2
  exit 1
}
[[ "$application" =~ ^oci://ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || {
  echo "production application must be an immutable oci://ghcr.io/...@sha256 reference" >&2
  exit 1
}
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
compose_version="$(docker compose version --short)" || {
  echo "Docker Compose 2.34.0 or newer is required" >&2
  exit 1
}
if [[ ! "$compose_version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]] ||
   (( 10#${BASH_REMATCH[1]:-0} < 2 )) ||
   (( 10#${BASH_REMATCH[1]:-0} == 2 && 10#${BASH_REMATCH[2]:-0} < 34 )); then
  echo "Docker Compose 2.34.0 or newer is required; observed ${compose_version:-unknown}" >&2
  exit 1
fi

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$application"
  -f "$operator_compose"
)

docker compose "${compose[@]}" config --quiet

public_host="${REVIVAL_PUBLIC_ORIGIN#https://}"
public_host="${public_host%%/*}"
if command -v getent >/dev/null 2>&1 && ! getent ahosts "$public_host" >/dev/null 2>&1; then
  echo "public DNS name $public_host does not resolve from this server" >&2
  echo "Create or correct its A or AAAA record, wait for DNS propagation, then rerun ./revival doctor production." >&2
  exit 1
fi

# A running Traefik container in this project already owns the ports during a
# normal update. Otherwise, fail before Compose reaches a vague bind error.
if ! docker compose "${compose[@]}" ps --status running --services traefik 2>/dev/null |
    grep -qx traefik; then
  listeners=""
  if command -v ss >/dev/null; then
    listeners="$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/')"
  else
    listeners="$(awk '
      NR > 1 && $4 == "0A" {
        split($2, address, ":")
        if (address[2] == "0050" || address[2] == "01BB") print FILENAME ":" $0
      }
    ' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
  fi
  if [[ -n "$listeners" ]]; then
    echo "host ports 80 or 443 are already in use:" >&2
    echo "$listeners" >&2
    echo "Stop or reconfigure the owning service (commonly Nginx, Apache, Caddy, or another Compose stack), then rerun. Ai Pin Revival will not stop it automatically." >&2
    exit 1
  fi
fi
printf 'Production configuration is complete for %s (%s).\n' "$project_name" "$REVIVAL_RELEASE_ID"
