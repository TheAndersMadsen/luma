#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${REVIVAL_ENV_FILE:?REVIVAL_ENV_FILE is required}"
operator_compose="${REVIVAL_CONFIG_DIR:?REVIVAL_CONFIG_DIR is required}/production/operator.compose.yaml"
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
"$SCRIPT_DIR/preflight.sh" --env-file "$env_file" --project-name "$project_name"

compose=(
  --project-directory "$ROOT"
  --project-name "$project_name"
  --env-file "$env_file"
  -f "$ROOT/compose.yaml"
  -f "$ROOT/platform/compose/production.yaml"
  -f "$operator_compose"
)

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
docker compose "${compose[@]}" config --services | sort -u > "$temporary/expected"
docker compose "${compose[@]}" ps --status running --services | sort -u > "$temporary/running"
if ! diff -u "$temporary/expected" "$temporary/running"; then
  echo "not every configured production service is running" >&2
  exit 1
fi
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  state="$(docker inspect --format '{{.State.Status}}' "$container")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
  if [[ "$state" != running || ( -n "$health" && "$health" != healthy ) ]]; then
    echo "production container $container is state=$state health=${health:-not-defined}" >&2
    exit 1
  fi
  container_release="$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.ai-pin-revival.release"}}' "$container")"
  container_revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")"
  container_environment="$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.ai-pin-revival.environment"}}' "$container")"
  if [[ "$container_release" != "$REVIVAL_RELEASE_ID" || "$container_revision" != "$REVIVAL_RELEASE_ID" ||
        "$container_environment" != production ]]; then
    echo "production container $container has release/environment labels ${container_release:-missing}/${container_revision:-missing}/${container_environment:-missing}" >&2
    exit 1
  fi
done < <(docker compose "${compose[@]}" ps --quiet)

node - "$REVIVAL_PUBLIC_ORIGIN" "$COSMOS_OIDC_ISSUER" "$REVIVAL_RELEASE_ID" production <<'NODE'
const [origin, issuer, expectedRelease, expectedEnvironment] = process.argv.slice(2);
async function check() {
  const version = await fetch(`${origin}/api/version`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!version.ok) throw new Error(`Center version endpoint returned ${version.status}`);
  const identity = await version.json();
  if (identity.release !== expectedRelease) {
    throw new Error(`Center release mismatch: expected ${expectedRelease}, received ${identity.release}`);
  }
  if (identity.environment !== expectedEnvironment) {
    throw new Error(`Center environment mismatch: expected ${expectedEnvironment}, received ${identity.environment}`);
  }
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!discovery.ok) throw new Error(`OIDC discovery returned ${discovery.status}`);
  const metadata = await discovery.json();
  if (metadata.issuer !== issuer) throw new Error(`OIDC issuer mismatch: ${metadata.issuer}`);
  const capture = await fetch(`${origin}/capture/memories`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (capture.status === 404 || capture.status >= 500) {
    throw new Error(`capture route returned ${capture.status}`);
  }
}
check().catch((error) => { console.error(error.message); process.exit(1); });
NODE

if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  command -v openssl >/dev/null || { echo "openssl is required to verify Pin TLS" >&2; exit 1; }
  edge_ipv4="${REVIVAL_DEVICE_EDGE_IPV4:?REVIVAL_DEVICE_EDGE_IPV4 is required for the pin profile}"
  expected_ca="${REVIVAL_CONFIG_DIR:?REVIVAL_CONFIG_DIR is required}/production/edge-ca.crt"
  expected_server="${REVIVAL_CONFIG_DIR}/production/edge-server.crt"
  timeout 10 openssl s_client -connect "$edge_ipv4:443" -servername api.cosmos.humane.cloud \
    -showcerts </dev/null >"$temporary/pin-handshake" 2>&1 || true
  awk '/-----BEGIN CERTIFICATE-----/{copy=1} copy{print} /-----END CERTIFICATE-----/{exit}' \
    "$temporary/pin-handshake" >"$temporary/pin-server.crt"
  if ! openssl x509 -in "$temporary/pin-server.crt" -noout >/dev/null 2>&1; then
    echo "Pin SNI did not reach the configured mTLS server certificate" >&2
    exit 1
  fi
  remote_fingerprint="$(openssl x509 -in "$temporary/pin-server.crt" -noout -fingerprint -sha256)"
  expected_fingerprint="$(openssl x509 -in "$expected_server" -noout -fingerprint -sha256)"
  [[ "$remote_fingerprint" == "$expected_fingerprint" ]] || {
    echo "Pin SNI served a certificate other than the configured production edge certificate" >&2
    exit 1
  }
  openssl verify -CAfile "$expected_ca" -verify_hostname api.cosmos.humane.cloud \
    "$temporary/pin-server.crt" >/dev/null || {
    echo "Pin edge certificate does not chain to the configured production root" >&2
    exit 1
  }
fi

printf 'Verified healthy services, exact Center release identity, OIDC, and capture routing%s.\n' \
  "$( [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]] && printf ', plus the configured Pin certificate chain' || true )"
