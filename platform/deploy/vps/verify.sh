#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

env_file="${LUMA_ENV_FILE:?LUMA_ENV_FILE is required}"
operator_compose="${LUMA_CONFIG_DIR:?LUMA_CONFIG_DIR is required}/production/operator.compose.yaml"
application="${LUMA_COMPOSE_APPLICATION:?LUMA_COMPOSE_APPLICATION is required}"
project_name="${COMPOSE_PROJECT_NAME:-luma}"

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
  -f "$application"
  -f "$operator_compose"
)

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
docker compose "${compose[@]}" config --services | sort -u > "$temporary/expected"
docker compose "${compose[@]}" ps --status running --services | sort -u > "$temporary/running"
stopped="$(comm -23 "$temporary/expected" "$temporary/running")"
unexpected="$(comm -13 "$temporary/expected" "$temporary/running")"
if [[ -n "$stopped" || -n "$unexpected" ]]; then
  if [[ -n "$stopped" ]]; then
    echo "these configured production services are not running:" >&2
    printf '  %s\n' $stopped >&2
  fi
  if [[ -n "$unexpected" ]]; then
    echo "these running services are not part of this release:" >&2
    printf '  %s\n' $unexpected >&2
  fi
  echo "Start this release with ./luma deploy production --confirm (it also removes services the release no longer has)." >&2
  echo "To see why a service stopped: docker compose -p $project_name logs --tail 100 SERVICE" >&2
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
  if [[ -z "$health" ]]; then
    echo "warning: production container $container defines no healthcheck; only its running state was verified" >&2
  fi
  container_release="$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.luma.release"}}' "$container")"
  container_revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")"
  container_environment="$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.luma.environment"}}' "$container")"
  if [[ "$container_release" != "$LUMA_RELEASE_ID" || "$container_revision" != "$LUMA_RELEASE_ID" ||
        "$container_environment" != production ]]; then
    echo "production container $container has release/environment labels ${container_release:-missing}/${container_revision:-missing}/${container_environment:-missing}" >&2
    exit 1
  fi
done < <(docker compose "${compose[@]}" ps --quiet)

# Cosmos requires `sub` in the Bearer Center forwards. Read-only, this is the
# client-scope check the confirmed deploy's realm reconcile applies: without the
# `basic` default scope, Center's access tokens carry no `sub`.
bun --no-env-file "$ROOT/platform/cli/realm.js" check --project-name "$project_name"

expected_pin_release_id=""
expected_pin_manifest_sha256=""
if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  # The path travels as argv, never inside a quoted program string: $ROOT may
  # contain a single quote.
  expected_pin_release_id="$(bun --no-env-file -e 'console.log(require(process.argv[1]).pin.releaseId)' "$ROOT/platform/distribution/version.json")"
  expected_pin_manifest_sha256="$(bun --no-env-file -e 'console.log(require(process.argv[1]).pin.manifestSha256)' "$ROOT/platform/distribution/version.json")"
fi

bun --no-env-file - "$LUMA_PUBLIC_ORIGIN" "$COSMOS_OIDC_ISSUER" "$LUMA_RELEASE_ID" production \
  "$expected_pin_release_id" "$expected_pin_manifest_sha256" <<'NODE'
const { createHash } = require('node:crypto');
const [origin, issuer, expectedRelease, expectedEnvironment, expectedPinRelease, expectedPinManifest] = process.argv.slice(2);
// Right after a confirmed deploy Traefik may still be obtaining the first
// Let's Encrypt certificate, so that run waits for the first answer.
const FIRST_ANSWER_WITHIN_MS = process.env.LUMA_DEPLOY_CONFIRMED === '1' ? 120_000 : 0;
const RETRY_EVERY_MS = 2_000;

// Name the network or TLS failure and what the owner can do about it.
function networkProblem(error) {
  const cause = error?.cause ?? error;
  // Bun's fetch timeout is a DOMException named TimeoutError whose numeric
  // `code` (23) names nothing useful, so the name wins.
  const rawCode = error?.name === 'TimeoutError' || cause?.name === 'TimeoutError'
    ? 'TimeoutError'
    : String(cause?.code || '');
  const code = rawCode === 'ConnectionRefused' ? 'ECONNREFUSED' : rawCode;
  if (!code) return null;
  const host = new URL(origin).hostname;
  let hint;
  if (/^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA)$/u.test(code)) {
    hint = `${host} does not resolve from this server; point its DNS A record at this server's public IPv4 ` +
      'and wait for DNS to update';
  } else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|TLS|SSL/u.test(code)) {
    hint = `${host} presented a certificate that is not valid for it yet. Right after the first deploy Let's ` +
      'Encrypt may still be issuing it: wait a few minutes and run ./luma verify production. If it stays, the ' +
      'domain does not point at this server or port 80 is closed, which Let\'s Encrypt needs';
  } else if (/^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|TimeoutError)$/u.test(code)) {
    hint = `nothing answered at ${origin}; open ports 80 and 443 in the server provider's firewall, and check ` +
      'that the traefik container is running';
  } else {
    return null;
  }
  const detail = cause?.message && cause.message !== code ? `${code}: ${cause.message}` : code;
  return { detail, hint };
}

async function firstAnswer(url) {
  const deadline = Date.now() + FIRST_ANSWER_WITHIN_MS;
  let reported = '';
  for (;;) {
    try {
      return await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      const problem = networkProblem(error);
      if (!problem || Date.now() + RETRY_EVERY_MS > deadline) throw error;
      if (problem.detail !== reported) {
        console.error(`waiting up to ${FIRST_ANSWER_WITHIN_MS / 1000}s for ${origin} to answer (${problem.detail})`);
        reported = problem.detail;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
    }
  }
}

async function check() {
  const version = await firstAnswer(`${origin}/api/version`);
  if (!version.ok) throw new Error(`Center version endpoint returned ${version.status}`);
  const identity = await version.json();
  if (identity.release !== expectedRelease) {
    throw new Error(`Center release mismatch: expected ${expectedRelease}, received ${identity.release}`);
  }
  if (identity.environment !== expectedEnvironment) {
    throw new Error(`Center environment mismatch: expected ${expectedEnvironment}, received ${identity.environment}`);
  }
  if (!version.headers.has('ratelimit-policy') || !version.headers.has('ratelimit')) {
    throw new Error('Center version endpoint omitted RateLimit fields');
  }

  // The whole front door: an anonymous visitor is redirected to the sign-in
  // page, which must render substantial content server-side.
  const frontDoor = await fetch(`${origin}/`, {
    headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10_000),
  });
  if (!frontDoor.ok || !new URL(frontDoor.url).pathname.endsWith('/login')) {
    throw new Error(`the anonymous front door answered ${frontDoor.status} at ${frontDoor.url}, expected the sign-in redirect`);
  }
  const frontDoorBody = await frontDoor.text();
  if (!frontDoorBody.includes('<h1') || frontDoorBody.length < 500) {
    throw new Error('the sign-in page did not contain substantial server-rendered content');
  }

  for (const [path, contentType] of [
    ['/llms.txt', 'text/markdown'],
    ['/robots.txt', 'text/plain'],
    ['/sitemap.xml', 'application/xml'],
  ]) {
    const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith(contentType)) {
      throw new Error(`public resource ${path} returned ${response.status}/${response.headers.get('content-type')}`);
    }
  }

  const openApiResponse = await fetch(`${origin}/openapi.json`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!openApiResponse.ok) throw new Error(`OpenAPI endpoint returned ${openApiResponse.status}`);
  const openApi = await openApiResponse.json();
  const operationIds = Object.values(openApi.paths || {}).flatMap((path) =>
    Object.values(path || {}).map((operation) => operation?.operationId).filter(Boolean));
  if (!String(openApi.openapi || '').startsWith('3.1.') || operationIds.length !== new Set(operationIds).size) {
    throw new Error('OpenAPI document is missing a 3.1 version or unique operation IDs');
  }

  const pinRelease = await fetch(`${origin}/api/pin/releases/current`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (expectedPinRelease) {
    if (pinRelease.status !== 200) {
      throw new Error(`current Pin release endpoint returned ${pinRelease.status}, expected 200`);
    }
    const bytes = Buffer.from(await pinRelease.arrayBuffer());
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.releaseId !== expectedPinRelease || manifest.artifacts?.length !== 5 ||
        createHash('sha256').update(bytes).digest('hex') !== expectedPinManifest) {
      throw new Error('current Pin release does not match the operator release identity and manifest digest');
    }
  } else if (pinRelease.status !== 404) {
    throw new Error(`current Pin release endpoint returned ${pinRelease.status}, expected 404 without the pin profile`);
  }

  // An unknown path answers a real 404, Markdown when asked, with
  // cache-safe Vary, never the signed-in app shell.
  const missing = await fetch(`${origin}/.luma-verification-missing`, {
    headers: { accept: 'text/markdown' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (missing.status !== 404) throw new Error(`unknown public path returned ${missing.status}, expected 404`);
  if (!missing.headers.get('content-type')?.startsWith('text/markdown')) {
    throw new Error(`unknown public path returned ${missing.headers.get('content-type')}, expected text/markdown`);
  }
  const vary = (missing.headers.get('vary') || '').toLowerCase().split(',').map((value) => value.trim());
  if (!vary.includes('accept') || !vary.includes('accept-encoding')) {
    throw new Error(`unknown public path returned incomplete Vary: ${vary.join(', ')}`);
  }

  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!discovery.ok) throw new Error(`OIDC discovery returned ${discovery.status}`);
  const metadata = await discovery.json();
  if (metadata.issuer !== issuer) throw new Error(`OIDC issuer mismatch: ${metadata.issuer}`);
  // The Pin's capture upload is the only Cosmos route on the public domain. A
  // forged capability must reach ai-bus and be refused there, not land on
  // Center or fail inside the stack.
  const upload = await fetch(`${origin}/capture/luma-verification-forged-capability`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body: 'luma verification',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (upload.status !== 403) {
    throw new Error(`capture upload route returned ${upload.status}, expected 403 for a forged capability`);
  }
  // The capture read API is internal. An internet caller who names a wearer is
  // never answered from it.
  const read = await fetch(`${origin}/capture/memories`, {
    headers: { 'x-forwarded-client-cert': 'U:luma-verification' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (read.ok || read.status >= 500) {
    throw new Error(`public capture read returned ${read.status}; the capture API must not be public`);
  }
}
check().catch((error) => {
  const problem = networkProblem(error);
  console.error(problem ? `fetch failed (${problem.detail})\n${problem.hint}` : error.message);
  process.exit(1);
});
NODE

if [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]]; then
  command -v openssl >/dev/null || { echo "openssl is required to verify Pin TLS" >&2; exit 1; }
  : "${LUMA_DEVICE_EDGE_IPV4:?LUMA_DEVICE_EDGE_IPV4 is required for the pin profile}"
  expected_ca="${LUMA_CONFIG_DIR:?LUMA_CONFIG_DIR is required}/production/edge-root/edge-ca.crt"
  expected_server="${LUMA_CONFIG_DIR}/production/edge-server.crt"
  # Verify the host's SNI route directly. Servers behind NAT commonly cannot
  # hairpin through their own public IPv4 even when inbound Pin traffic works.
  timeout 10 openssl s_client -connect 127.0.0.1:443 -servername api.cosmos.humane.cloud \
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

printf 'Verified healthy services, Center identity and public discovery, OIDC with Center tokens that carry sub, and capture routing%s.\n' \
  "$( [[ ",${COMPOSE_PROFILES:-}," == *,pin,* ]] && printf ', plus the configured Pin certificate chain' || true )"
