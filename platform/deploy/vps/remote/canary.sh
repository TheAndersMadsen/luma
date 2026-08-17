#!/usr/bin/env bash
set -euo pipefail
remote_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$remote_dir/common.sh"
source "$remote_dir/domain.sh"

release_id=""
baseline=""
crud=0
cookie_file="$PRIVATE_DIR/canary.cookies"
image_evidence=""
require_remote_tts=0
require_owner_spotify=0
require_wearer_plane=0
wearer_plane_optional=0
quiesced_loopback=0
expect_bridge_ready=0
legacy_dashboard_origin=0
json=0
implicit_current=0
current_record=""

usage() {
  echo "usage: canary [--release-id SHA256] [--baseline DIR] [--image-evidence FILE] [--require-remote-tts] [--require-owner-spotify] [--require-wearer-plane] [--wearer-plane-optional] [--quiesced-loopback] [--expect-bridge-ready] [--legacy-dashboard-origin] [--cookie-file FILE] [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --release-id) (($# >= 2)) || usage; release_id="$2"; shift 2 ;;
    --baseline) (($# >= 2)) || usage; baseline="$2"; shift 2 ;;
    --crud) crud=1; shift ;;
    --image-evidence) (($# >= 2)) || usage; image_evidence="$2"; shift 2 ;;
    --require-remote-tts) require_remote_tts=1; shift ;;
    --require-owner-spotify) require_owner_spotify=1; shift ;;
    --require-wearer-plane) require_wearer_plane=1; shift ;;
    # The ONE way to run this canary without the sealed-bearer wearer plane, and
    # it exists for an operator at a terminal during an incident — not for a
    # script. No deploy or rollback path passes it, and
    # platform/deploy/acceptance/canary-wearer-plane.test.mjs fails if one starts
    # to: an escape hatch that ends up wired into the automation is just the old
    # warn-and-pass default wearing a longer name.
    --wearer-plane-optional) wearer_plane_optional=1; shift ;;
    --quiesced-loopback) quiesced_loopback=1; shift ;;
    --expect-bridge-ready) expect_bridge_ready=1; shift ;;
    --legacy-dashboard-origin) legacy_dashboard_origin=1; shift ;;
    --cookie-file) (($# >= 2)) || usage; cookie_file="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
((crud == 0)) || fail "mutating CRUD canaries are disabled; this canary is read-only"

assert_target
assert_remote_root
for command in docker curl python3 openssl sha256sum readlink; do need "$command"; done
if [[ -z "$release_id" ]]; then
  implicit_current=1
  current="$(safe_release_pointer "$REMOTE_ROOT/current")" || fail "canonical current pointer is missing"
  release_id="$(basename "$current")"
fi
((implicit_current == 0 || legacy_dashboard_origin == 0)) \
  || fail "an accepted canonical deployment cannot use the legacy dashboard origin"
dashboard_host=center.andersmadsen.dk
dashboard_origin=https://center.andersmadsen.dk
if ((legacy_dashboard_origin)); then
  dashboard_host=carry.andersmadsen.dk
  dashboard_origin=https://carry.andersmadsen.dk
fi
if ((legacy_dashboard_origin)); then
  [[ "$dashboard_origin" == "$DOMAIN_LEGACY_ORIGIN" ]] || fail "legacy dashboard origin differs from the domain transaction"
else
  [[ "$dashboard_origin" == "$DOMAIN_CANONICAL_ORIGIN" ]] || fail "Center origin differs from the domain transaction"
fi
validate_release_id "$release_id"
release_dir="$RELEASES_DIR/$release_id"
[[ -d "$release_dir" ]] || fail "release directory is missing"
if ((implicit_current)); then
  current_record="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment")" \
    || fail "canonical current deployment pointer is missing"
  [[ -f "$current_record/SUCCEEDED" && -f "$current_record/INGRESS_ACTIVATED" \
    && -f "$current_record/POINTER_TRANSACTION_COMMITTED" \
    && "$(tr -d '\r\n' <"$current_record/release-id")" == "$release_id" ]] \
    || fail "canonical current deployment has not completed ingress acceptance"
  verify_keycloak_post_migration_evidence "$current_record" \
    || fail "canonical current deployment has invalid Keycloak post-migration evidence"
fi
load_compose_command "$release_dir"
if [[ -n "$image_evidence" ]]; then
  resolved_evidence="$(readlink -f -- "$image_evidence")"
  [[ "$resolved_evidence" == "$DEPLOYMENTS_DIR/"* && -f "$resolved_evidence" ]] \
    || fail "image evidence must be a deployment-record file"
  verify_image_evidence "$resolved_evidence" "$release_dir"
fi

expected_services=(connectivity ai-bus account contacts feature-flags notable-events provisioning postgres keycloak edge center spotify-adapter searxng prometheus grafana)
if ((quiesced_loopback)); then
  unready_service=""
  unready_reason=""
  for attempt in $(seq 1 90); do
    ready=1
    for service in "${expected_services[@]}"; do
      container="$("${COMPOSE[@]}" ps --all -q "$service")"
      [[ -n "$container" && "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == true ]] \
        || { ready=0; unready_service="$service"; unready_reason="not running"; break; }
      [[ "$service" == spotify-adapter ]] && continue
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
      [[ "$health" == none || "$health" == healthy ]] \
        || { ready=0; unready_service="$service"; unready_reason="health=$health"; break; }
    done
    ((ready)) && break
    sleep 2
  done
  if ((ready == 0)); then
    # Name the blocking service and surface its own evidence: this runs inside
    # the quiesced window, where the stack is torn down immediately afterwards.
    if [[ -n "$unready_service" ]]; then
      container="$("${COMPOSE[@]}" ps --all -q "$unready_service" 2>/dev/null || true)"
      if [[ -n "$container" ]]; then
        { echo "--- $unready_service ($unready_reason) ---"
          docker inspect --format '{{if .State.Health}}{{json .State.Health}}{{end}}' "$container" 2>/dev/null | tail -c 1200
          echo
          docker logs --tail 30 "$container" 2>&1 | tail -30; } >&2 || true
      fi
    fi
    fail "quiesced production services did not become ready: ${unready_service:-unknown} (${unready_reason:-unknown})"
  fi
else
  wait_for_services "$release_dir" || fail "production services did not become healthy"
fi
if ((implicit_current)); then
  domain_nginx_verify_desired "$current_record" \
    || fail "canonical current deployment has public Center Nginx drift"
  domain_keycloak_verify_desired "$current_record" "$RUNTIME_ENV" 8088 \
    || fail "canonical current deployment has Center Keycloak client drift"
fi
for service in "${expected_services[@]}"; do
  container="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$container" ]] || fail "service has no container: $service"
  project_label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
  release_label="$(docker inspect --format '{{index .Config.Labels "dk.andersmadsen.ai-pin-revival.release"}}' "$container")"
  [[ "$project_label" == "$PROJECT" ]] || fail "service is outside the canonical project: $service"
  [[ "$release_label" == "$release_id" ]] || fail "service has release drift: $service"
done

for service in ai-bus account contacts feature-flags notable-events provisioning connectivity; do
  container="$("${COMPOSE[@]}" ps -q "$service")"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == "ai-pin-revival/cosmos:$release_id" ]] \
    || fail "Cosmos workload image drift: $service"
done
center_container="$("${COMPOSE[@]}" ps -q center)"
[[ "$(docker inspect --format '{{.Config.Image}}' "$center_container")" == "ai-pin-revival/center:$release_id" ]] \
  || fail "Center image drift"
spotify_container="$("${COMPOSE[@]}" ps -q spotify-adapter)"
[[ "$(docker inspect --format '{{.Config.Image}}' "$spotify_container")" == "ai-pin-revival/spotify-adapter:$release_id" ]] \
  || fail "Spotify adapter image drift"

assert_durable_inputs
assert_active_durable_mounts
postgres="$("${COMPOSE[@]}" ps -q postgres)"
ai_bus="$("${COMPOSE[@]}" ps -q ai-bus)"
provisioning="$("${COMPOSE[@]}" ps -q provisioning)"
for pair in "$postgres:$PG_VOLUME:/var/lib/postgresql/data" "$ai_bus:$STATE_VOLUME:/var/lib/carry" "$provisioning:$STATE_VOLUME:/var/lib/carry"; do
  IFS=: read -r container expected_volume destination <<<"$pair"
  actual="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" "$container")"
  [[ "$actual" == "$expected_volume" ]] || fail "durable mount identity changed at $destination"
done
center_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$center_container")"
[[ "$center_source" == "$CENTER_DATA_DIR" ]] || fail "Center data mount changed"
if ((legacy_dashboard_origin == 0)); then
  python3 - "$center_container" "$PIN_RELEASE_DIR" <<'PY'
import json,subprocess,sys
container,expected_source=sys.argv[1:]
body=json.loads(subprocess.check_output(["docker","inspect",container],text=True))[0]
environment=dict(item.split("=",1) for item in body["Config"].get("Env",[]) if "=" in item)
assert environment.get("REVIVAL_PIN_RELEASE_DIR")=="/var/lib/ai-pin-revival/pin-releases"
assert environment.get("REVIVAL_PIN_SETUP_ORIGIN")=="https://center.andersmadsen.dk"
mounts=[item for item in body.get("Mounts",[])
        if item.get("Destination")=="/var/lib/ai-pin-revival/pin-releases"]
assert len(mounts)==1
mount=mounts[0]
assert mount.get("Type")=="bind" and mount.get("Source")==expected_source and mount.get("RW") is False
PY
fi

if [[ -n "$baseline" ]]; then
  [[ "$baseline" == "$BACKUP_ROOT/"* ]] || fail "baseline must be under the canonical backup root"
  verify_invariants "$baseline/invariants.tsv"
fi

# Both device connectivity authorities are intentionally cleartext and never redirect.
for host in connectivity-check.carry.humane.cloud n.carry.humane.cloud; do
  if ((quiesced_loopback)); then
    expect_status 204 -H "Host: $host" http://127.0.0.1:18085/
    expect_status 204 -I -H "Host: $host" http://127.0.0.1:18085/
    expect_status 405 -X POST -H "Host: $host" http://127.0.0.1:18085/
    expect_status 404 -H "Host: $host" http://127.0.0.1:18085/not-a-connectivity-check
  else
    expect_status 204 -H "Host: $host" http://127.0.0.1/
    expect_status 204 -I -H "Host: $host" http://127.0.0.1/
    expect_status 405 -X POST -H "Host: $host" http://127.0.0.1/
    expect_status 404 -H "Host: $host" http://127.0.0.1/not-a-connectivity-check
  fi
done
expect_status 204 http://127.0.0.1:18085/readyz
expect_status 204 http://127.0.0.1:18086/readyz
expect_status 200 http://127.0.0.1:14000/api/version
expect_status 200 http://127.0.0.1:8088/realms/humane/.well-known/openid-configuration
# 13001 is Grafana (common.sh pins grafana to 3000,13001 and center to 4000,14000).
# It sits in this loopback block purely as an observability liveness check and has
# never had anything to do with Center. The probe that reads Center's own
# /api/health on 14000 is in the wearer-plane block below, and it runs ONLY
# under --require-wearer-plane — a credential-free one is impossible, because
# /api/health answers 401 without a session. So on any run without that flag
# there is no Center health coverage at all, which the warn beside that block
# states outright. Naming this line stops the next reader from taking it as
# Center coverage the way three shipped outages did.
expect_status 200 http://127.0.0.1:13001/api/health  # grafana, not Center
if ((quiesced_loopback == 0)); then
  systemctl is-active --quiet penumbra-center-bridge.service || fail "existing Pin bridge stopped during deployment"
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || fail "existing Pin bridge port 18080 is unavailable"
fi
expect_status 200 http://10.0.7.1:18081/healthz
if ((quiesced_loopback)); then
  if ((expect_bridge_ready)); then
    expect_status 200 http://10.0.7.1:18081/readyz
  else
    expect_status 503 http://10.0.7.1:18081/readyz
  fi
else
  expect_status 200 http://10.0.7.1:18081/readyz
fi

# A host-side probe is not proof that Center can reach the adapter. The adapter
# deliberately binds the private spotify-control gateway while Center is the
# only container on that internal network; the host INPUT policy can still
# reject that one hop even when both endpoints are individually healthy. Run
# the readiness request from Center's own network namespace so the deployment
# cannot publish the exact split-brain state the browser would see.
center_adapter_expected=200
if ((quiesced_loopback && expect_bridge_ready == 0)); then
  center_adapter_expected=503
fi
if ! docker exec -i "$center_container" node - "$center_adapter_expected" <<'NODE'
const expected = Number(process.argv[2]);
const configured = process.env.REVIVAL_SPOTIFY_ADAPTER_URL ?? "";
let origin;
try {
  origin = new URL(configured).origin;
} catch {
  process.exit(1);
}
(async () => {
  const response = await fetch(`${origin}/readyz`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== expected) process.exit(1);
})().catch(() => process.exit(1));
NODE
then
  fail "Center cannot reach the private Pin adapter readiness endpoint"
fi

work="$(mktemp -d)"
cleanup_work() { rm -rf -- "$work"; }
trap cleanup_work EXIT

# SearXNG is private to ai-bus and the egress-only search network. Validate
# secret scoping and a bounded live JSON response without logging query or
# result content.
searxng_container="$("${COMPOSE[@]}" ps -q searxng)"
python3 - "$searxng_container" "$ai_bus" <<'PY'
import json,subprocess,sys
searxng,ai_bus=sys.argv[1:]
def env(container):
    body=json.loads(subprocess.check_output(["docker","inspect",container],text=True))[0]
    return dict(item.split("=",1) for item in body["Config"].get("Env",[]) if "=" in item)
search_env=env(searxng); bus_env=env(ai_bus)
assert len(search_env.get("SEARXNG_SECRET","")) >= 32
assert bus_env.get("CARRY_SEARXNG_BASE_URL") == "http://searxng:8080"
assert "SEARXNG_SECRET" not in bus_env
def networks(container):
    body=json.loads(subprocess.check_output(["docker","inspect",container],text=True))[0]
    return set((body.get("NetworkSettings",{}).get("Networks") or {}).keys())
search_service="ai-pin-revival_search-service"; search_egress="ai-pin-revival_search-egress"
bus_networks=networks(ai_bus); search_networks=networks(searxng)
assert search_service in bus_networks and search_egress not in bus_networks
assert search_networks == {search_service,search_egress}
egress=json.loads(subprocess.check_output(["docker","network","inspect",search_egress],text=True))[0]
members=set((egress.get("Containers") or {}).keys())
assert members == {searxng}
PY
for service in "${expected_services[@]}"; do
  [[ "$service" == searxng ]] && continue
  container="$("${COMPOSE[@]}" ps -q "$service")"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | awk -F= '$1=="SEARXNG_SECRET"{found=1} END{exit found?1:0}' \
    || fail "SearXNG secret escaped its service scope: $service"
done
docker exec "$ai_bus" curl --silent --show-error --fail --max-time 30 --max-filesize 1000000 \
  'http://searxng:8080/search?q=ai+pin+revival+canary&format=json&language=en' >"$work/search.json"
docker exec "$ai_bus" curl --silent --show-error --fail --max-time 30 --max-filesize 1000000 \
  'http://searxng:8080/search?q=%21resulthunter+%21yandex+%21searchch+ai+pin+revival+canary&format=json&language=en' >"$work/search-fallback.json"
python3 - "$work/search.json" "$work/search-fallback.json" <<'PY'
import json,os,sys
def read_results(path):
    assert 2 <= os.path.getsize(path) <= 1_000_000
    body=json.load(open(path,encoding="utf-8"))
    assert isinstance(body,dict)
    results=body.get("results")
    assert isinstance(results,list) and results
    return results
def attributed_engines(results):
    return {engine for item in results
            for engine in ([item.get("engine")]+(item.get("engines") or [])) if engine}
engines=attributed_engines(read_results(sys.argv[1]))
assert engines <= {"bing","resulthunter","searchch","yandex"}
assert "bing" in engines
assert engines & {"resulthunter","searchch","yandex"}
fallback_engines=attributed_engines(read_results(sys.argv[2]))
assert fallback_engines
assert fallback_engines <= {"resulthunter","searchch","yandex"}
PY
rm -f -- "$work/search.json" "$work/search-fallback.json"

# Provider credentials must stay in ai-bus, and the credential selected by the
# model adapter must match the endpoint it is about to call. In particular, a
# harmless local-Ollama placeholder in CARRY_LLM_API_KEY must never shadow the
# deployment-scoped OpenRouter key when the main endpoint is OpenRouter.
python3 - "$ai_bus" <<'PY'
import json,subprocess,sys,urllib.parse

ai_bus=sys.argv[1]
def inspect(container):
    return json.loads(subprocess.check_output(["docker","inspect",container],text=True))[0]
def env(container):
    return dict(item.split("=",1) for item in inspect(container)["Config"].get("Env",[]) if "=" in item)

body=inspect(ai_bus); bus=env(ai_bus)
base=bus.get("CARRY_LLM_BASE_URL","").strip()
model=bus.get("CARRY_LLM_MODEL","").strip()
generic=bus.get("CARRY_LLM_API_KEY","").strip()
openrouter=bus.get("CARRY_OPENROUTER_API_KEY","").strip()
assert base and model and (generic or openrouter)
host=urllib.parse.urlsplit(base).hostname
if host == "openrouter.ai":
    assert openrouter and not generic

provider_secrets={
    "CARRY_LLM_API_KEY","CARRY_OPENROUTER_API_KEY","CARRY_SERPAPI_KEY",
    "CARRY_GOOGLE_MAPS_KEY","CARRY_PIRATE_WEATHER_KEY","CARRY_WOLFRAM_APP_ID",
    "CARRY_PPLX_API_KEY","AZURE_SPEECH_KEY","CARRY_AZURE_SPEECH_KEY",
    "CARRY_INTERSTITIAL_API_KEY","CARRY_SHOPPING_API_KEY",
}
ids=subprocess.check_output([
    "docker","ps","-q","--filter","label=com.docker.compose.project=ai-pin-revival"
],text=True).split()
for container in ids:
    candidate=inspect(container)
    service=(candidate.get("Config",{}).get("Labels",{}) or {}).get(
        "com.docker.compose.service",container[:12]
    )
    if service == "ai-bus":
        continue
    candidate_env=env(container)
    assert not any(candidate_env.get(name,"").strip() for name in provider_secrets)

interstitial_base=bus.get("CARRY_INTERSTITIAL_BASE_URL","").strip()
if interstitial_base:
    assert bus.get("CARRY_INTERSTITIAL_MODEL","").strip()
    interstitial_host=urllib.parse.urlsplit(interstitial_base).hostname
    assert interstitial_host
    networks=set((body.get("NetworkSettings",{}).get("Networks") or {}).keys())
    if interstitial_host == "carry-ollama":
        assert "humane-carry-clone_carry-local" in networks
        subprocess.check_call(
            ["docker","exec",ai_bus,"getent","hosts","carry-ollama"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
PY

# Bind the protected Center bridge configuration to the one exact durable
# pairing and to a Keycloak subject ID. Pair values stay in mode-0600 files and
# are never printed.
paired_identity="$(derive_paired_identity "$postgres")"
IFS=$'\t' read -r paired_device paired_owner <<<"$paired_identity"
configured_device="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_DEVICE_ID)"
configured_owner="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_OWNER_SUB)"
[[ "$paired_device" == "$configured_device" && "$paired_owner" == "$configured_owner" ]] \
  || fail "Center bridge identity does not match the durable Pin roster"
# Compose interpolates from --env-file runtime, cosmos, providers, center in
# that order, and the LAST file that defines a key wins. Resolve shared secrets
# the same way, or the canary authenticates with a value the running workload
# never received.
resolved_env_value() {
  local key="$1" file value
  for file in "$CENTER_ENV" "$PROVIDER_ENV" "$COSMOS_ENV" "$RUNTIME_ENV"; do
    [[ -f "$file" ]] || continue
    value="$(read_env_value "$file" "$key" 2>/dev/null || true)"
    [[ -n "$value" ]] || continue
    printf '%s\n' "$value"
    return 0
  done
  return 1
}
admin_token="$(resolved_env_value CARRY_ADMIN_TOKEN)"
[[ -n "$admin_token" ]] || fail "admin roster token is unavailable"
printf 'authorization: Bearer %s\n' "$admin_token" >"$work/admin.headers"
printf 'x-forwarded-client-cert: U:%s\nx-carry-web-projection-token: %s\n' \
  "$paired_owner" "$(resolved_env_value CARRY_CENTER_PROJECTION_TOKEN)" \
  >"$work/projection.headers"
chmod 600 "$work/admin.headers" "$work/projection.headers"
curl --silent --show-error --fail --max-time 20 -H @"$work/admin.headers" \
  http://127.0.0.1:18086/demo-api/admin/devices >"$work/device-roster.json"
python3 - "$work/device-roster.json" "$paired_device" "$paired_owner" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); pairs=body.get("pairings",[])
matches=[p for p in pairs if p.get("device_id")==sys.argv[2] and p.get("account_sub")==sys.argv[3]]
assert len(matches)==1
PY
unset admin_token paired_identity paired_device paired_owner configured_device configured_owner

# Public version, OIDC, Wi-Fi and assets. During a guarded cutover, exercise
# the same routes directly while every public/device ingress remains stopped.
if ((quiesced_loopback)); then
  center_base=http://127.0.0.1:14000
  oidc_url=http://127.0.0.1:8088/realms/humane/.well-known/openid-configuration
else
  center_base=https://center.andersmadsen.dk
  ((legacy_dashboard_origin == 0)) || center_base=https://carry.andersmadsen.dk
  [[ "$center_base" == "$dashboard_origin" ]] || fail "dashboard canary origin selection drift"
  oidc_url="$dashboard_origin/realms/humane/.well-known/openid-configuration"
fi
# The wearer plane is Center's OWN data plane, so it is always addressed as the
# canonical Center authority rather than as whatever origin this run happens to
# be auditing. The legacy compatibility host answers 307 to every path and the
# quiesced window has no public ingress at all, so both of those runs reach
# Center directly on loopback; a canonical public run keeps the full nginx and
# Cloudflare hops, which is where the 4k header buffer once turned every
# successful login into a 502.
wearer_host=center.andersmadsen.dk
if ((quiesced_loopback || legacy_dashboard_origin)); then
  wearer_base=http://127.0.0.1:14000
else
  wearer_base="$center_base"
fi
curl --silent --show-error --fail --max-time 20 -H "Host: $dashboard_host" \
  -H 'X-Forwarded-Proto: https' \
  "$center_base/api/version" >"$work/version.json"
python3 - "$work/version.json" "$release_id" <<'PY'
import json,sys
body=json.load(open(sys.argv[1], encoding="utf-8"))
assert body.get("product") == "Ai Pin Revival Center"
assert body.get("release") == sys.argv[2]
PY
curl --silent --show-error --fail --max-time 20 -H "Host: $dashboard_host" \
  -H 'X-Forwarded-Proto: https' \
  "$oidc_url" >"$work/oidc.json"
python3 - "$work/oidc.json" "$dashboard_origin/realms/humane" <<'PY'
import json,sys
body=json.load(open(sys.argv[1], encoding="utf-8"))
assert body.get("issuer") == sys.argv[2]
assert body.get("authorization_endpoint") and body.get("jwks_uri")
PY

# Exercise the complete unauthenticated half of the OIDC ceremony. This proves
# Center emits one canonical callback, binds state/nonce, derives a real S256
# challenge from its verifier, rejects a mismatched callback before token
# exchange, and emits the exact RP-initiated logout target. Completing an
# authenticated authorization-code exchange requires wearer credentials and is
# therefore kept as an explicit physical/public acceptance boundary.
if ((legacy_dashboard_origin == 0)); then
  oidc_start_status="$(curl --silent --show-error --max-time 20 --max-redirs 0 \
    -D "$work/oidc-start.headers" -o /dev/null -w '%{http_code}' \
    -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' \
    "$center_base/api/auth/login/start?next=%2Fwifi")"
  [[ "$oidc_start_status" == 307 ]] || fail "Center OIDC start did not return HTTP 307"
  python3 - "$work/oidc-start.headers" "$dashboard_origin" \
    "$work/oidc-start-cookie.headers" <<'PY'
import base64
import hashlib
import re
import sys
import urllib.parse

headers_path, origin, cookie_header_path = sys.argv[1:]
lines = open(headers_path, encoding="latin1").read().splitlines()
locations = [line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("location:")]
assert len(locations) == 1
location = urllib.parse.urlsplit(locations[0])
expected = urllib.parse.urlsplit(origin)
assert (location.scheme, location.netloc) == (expected.scheme, expected.netloc)
assert location.path == "/realms/humane/protocol/openid-connect/auth"
query = urllib.parse.parse_qs(location.query, keep_blank_values=True, strict_parsing=True)
assert set(query) == {
    "response_type", "client_id", "redirect_uri", "scope", "state", "nonce",
    "code_challenge", "code_challenge_method",
}
assert all(len(values) == 1 for values in query.values())
assert query["response_type"] == ["code"]
assert query["client_id"] == ["center"]
assert query["redirect_uri"] == [f"{origin}/api/auth/callback/humane"]
assert {"openid", "email", "profile"}.issubset(set(query["scope"][0].split()))
assert query["code_challenge_method"] == ["S256"]
for name in ("state", "nonce", "code_challenge"):
    assert re.fullmatch(r"[A-Za-z0-9_-]{20,128}", query[name][0])

expected_cookies = {"oidc_state", "oidc_nonce", "oidc_verifier", "oidc_next"}
cookies = {}
raw_cookie_pairs = []
for line in lines:
    if not line.lower().startswith("set-cookie:"):
        continue
    value = line.split(":", 1)[1].strip()
    parts = [part.strip() for part in value.split(";")]
    name, separator, raw_value = parts[0].partition("=")
    assert separator
    if name not in expected_cookies:
        continue
    assert name not in cookies
    attributes = {}
    flags = set()
    for part in parts[1:]:
        key, marker, item = part.partition("=")
        if marker:
            attributes[key.lower()] = item
        else:
            flags.add(key.lower())
    cookies[name] = (urllib.parse.unquote(raw_value), attributes, flags)
    raw_cookie_pairs.append(parts[0])
assert set(cookies) == expected_cookies
for _, attributes, flags in cookies.values():
    assert {"httponly", "secure"}.issubset(flags)
    assert attributes.get("path") == "/"
    assert attributes.get("max-age") == "600"
    assert attributes.get("samesite", "").lower() == "lax"
state = cookies["oidc_state"][0]
nonce = cookies["oidc_nonce"][0]
verifier = cookies["oidc_verifier"][0]
assert state == query["state"][0] and nonce == query["nonce"][0]
assert cookies["oidc_next"][0] == "/wifi"
assert re.fullmatch(r"[A-Za-z0-9_-]{43}", verifier)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
assert challenge == query["code_challenge"][0]
with open(cookie_header_path, "w", encoding="ascii") as target:
    target.write("cookie: " + "; ".join(raw_cookie_pairs) + "\n")
PY
  chmod 600 "$work/oidc-start-cookie.headers"

  oidc_callback_status="$(curl --silent --show-error --max-time 20 --max-redirs 0 \
    -D "$work/oidc-callback.headers" -o /dev/null -w '%{http_code}' \
    -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' \
    -H @"$work/oidc-start-cookie.headers" \
    "$center_base/api/auth/callback/humane?code=untrusted-canary&state=deliberately-wrong")"
  [[ "$oidc_callback_status" == 307 ]] || fail "Center OIDC callback rejection did not return HTTP 307"
  python3 - "$work/oidc-callback.headers" "$dashboard_origin/login?error=state" <<'PY'
import sys
lines=open(sys.argv[1],encoding="latin1").read().splitlines()
locations=[line.split(":",1)[1].strip() for line in lines if line.lower().startswith("location:")]
assert locations == [sys.argv[2]]
PY

  oidc_logout_status="$(curl --silent --show-error --max-time 20 --max-redirs 0 \
    -D "$work/oidc-logout.headers" -o /dev/null -w '%{http_code}' \
    -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' \
    "$center_base/api/auth/logout")"
  [[ "$oidc_logout_status" == 307 ]] || fail "Center OIDC logout did not return HTTP 307"
  python3 - "$work/oidc-logout.headers" "$dashboard_origin" <<'PY'
import sys
import urllib.parse
lines=open(sys.argv[1],encoding="latin1").read().splitlines()
locations=[line.split(":",1)[1].strip() for line in lines if line.lower().startswith("location:")]
assert len(locations)==1
location=urllib.parse.urlsplit(locations[0]); origin=urllib.parse.urlsplit(sys.argv[2])
assert (location.scheme,location.netloc)==(origin.scheme,origin.netloc)
assert location.path=="/realms/humane/protocol/openid-connect/logout"
query=urllib.parse.parse_qs(location.query,keep_blank_values=True,strict_parsing=True)
assert query=={"client_id":["center"],"post_logout_redirect_uri":[f"{sys.argv[2]}/login"]}
cookies=[line.split(":",1)[1].strip().lower() for line in lines if line.lower().startswith("set-cookie:")]
assert any(value.startswith("carry_session=") and "max-age=0" in value for value in cookies)
PY
  if ((quiesced_loopback == 0)); then
    # The trailing clause used to read "this read-only canary has no wearer
    # credentials". That stopped being true when the sealed-bearer block landed,
    # and it is the one line in this run an operator would misread as "the wearer
    # plane was not proven" — the exact sentence the old warn-and-pass default
    # used. What is genuinely unexercised is narrower: the browser's
    # authorization-code redirect, which cannot be driven without a browser.
    warn "authenticated OIDC code exchange remains unknown: the browser authorization-code redirect cannot be driven headlessly, so the sealed-bearer block below covers the session it produces, not the exchange itself"
  fi
fi
# /login may legitimately answer 200 or a redirect (an already-authenticated
# browser is bounced onward), so the tolerant set stays for it alone.
login_status="$(http_status -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' "$center_base/login")"
[[ "$login_status" == 200 || "$login_status" == 307 || "$login_status" == 302 ]] \
  || fail "Center asset failed: /login ($login_status)"

# Large-header exchange, end to end through whatever hops $center_base traverses.
#
# The sealed Keycloak token cookies are the largest header block Center handles,
# and nginx's 4k default turned every successful login into a 502 while a
# REJECTED login — which sets no cookies — still answered 401, so nothing that
# only exercises the unauthenticated half could see it. That fix is currently
# protected by regexes over the nginx template and compose.yaml
# (platform/deploy/acceptance/center-domain-contract.test.mjs) and by nothing
# that puts bytes on the wire.
#
# This covers the REQUEST half only: a browser echoing the whole cookie set on
# every navigation. It proves large_client_header_buffers and Node's
# --max-http-header-size are live on the deployed path. The RESPONSE half — the
# ~14 KB Set-Cookie block that actually caused the 502 — stays file-asserted,
# because the only response that large is a successful OIDC callback and this
# canary holds no wearer credential. Do not "fix" that by adding a Center route
# that emits a synthetic 14 KB cookie block: a new unauthenticated-shaped surface
# doing that is more risk than the coverage buys.
#
# The budget is read from the release under test rather than hardcoded, so
# widening the token budget in auth.ts cannot outgrow the edge unnoticed here
# either.
center_auth_source="$release_dir/center/src/server/auth.ts"
[[ -f "$center_auth_source" ]] || fail "release is missing Center's session cookie definitions"
large_header_bytes="$(python3 - "$center_auth_source" "$work/large-cookie.headers" <<'PY'
import re,sys
source_path,output_path=sys.argv[1:]
source=open(source_path,encoding="utf-8").read()
def constant(name):
    found=re.search(rf"{name} = (\d+)",source)
    assert found, f"{name} is not defined in Center's auth module"
    return int(found.group(1))
chunk_bytes=constant("TOKEN_COOKIE_CHUNK_BYTES")
max_chunks=constant("TOKEN_COOKIE_MAX_CHUNKS")
# The same arithmetic the file-level regression test uses: every chunk plus its
# "carry_tokens_N=" name and "; " separator, plus room for the manifest and
# session cookies.
budget=max_chunks*(chunk_bytes+16)+600
pairs=[f"carry_tokens_{index}=" + "A"*chunk_bytes for index in range(max_chunks)]
pairs.append("carry_tokens=" + "A"*64)
pairs.append("carry_session=" + "A"*128)
line="cookie: " + "; ".join(pairs)
# Pad to the full budget so the probe measures the contract, not today's
# incidental sizes, and never silently shrinks below it.
if len(line) < budget + 8:
    line += "; carry_canary_padding=" + "A"*(budget + 8 - len(line) - len("; carry_canary_padding="))
assert len(line) >= budget
with open(output_path,"w",encoding="ascii") as target:
    target.write(line + "\n")
print(len(line))
PY
)"
chmod 600 "$work/large-cookie.headers"
large_header_status="$(curl --silent --show-error --connect-timeout 4 --max-time 20 \
  --max-redirs 0 -o /dev/null -w '%{http_code}' \
  -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' \
  -H @"$work/large-cookie.headers" "$center_base/login")"
[[ "$large_header_status" == "$login_status" ]] \
  || fail "a full-size cookie header changed /login from $login_status to $large_header_status (400/431/494 is an nginx buffer, 502 is Node's header cap)"
rm -f -- "$work/large-cookie.headers"
log "large-header request accepted end to end: ${large_header_bytes} byte cookie line on /login"
if ((quiesced_loopback)); then
  warn "the large-header exchange was proven against the Center origin only; the public nginx/Cloudflare hops are still closed in this quiesced run"
fi
# The other three are pinned to exactly 200 on the canonical origin. middleware.ts
# puts /wifi in the always-open set on purpose — it is the one public page, it
# reads no account data, and it exists for the moment a Pin is off the network,
# which is exactly when its owner may not be able to sign in. /favicon.ico and
# /manifest.json are excluded from the middleware matcher entirely. Accepting
# 302/307 here made the canary tolerate precisely the regression that would
# break all three: an always-open path falling out of the allow-list and
# redirecting to /login. A soft redirect carrying a 200 status cannot slip past
# either, hence the location check.
#
# The legacy compatibility origin is exempt because a 307 to the canonical
# origin is its correct answer for every path, so status alone says nothing
# there.
for path in /wifi /favicon.ico /manifest.json; do
  status="$(curl --silent --show-error --connect-timeout 4 --max-time 20 --max-redirs 0 \
    -D "$work/public-path.headers" -o /dev/null -w '%{http_code}' \
    -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' "$center_base$path")"
  if ((legacy_dashboard_origin)); then
    [[ "$status" == 200 || "$status" == 307 || "$status" == 302 ]] \
      || fail "legacy Center asset failed: $path ($status)"
    continue
  fi
  [[ "$status" == 200 ]] || fail "Center always-open path must answer 200: $path ($status)"
  ! grep -qi '^location:' "$work/public-path.headers" \
    || fail "Center always-open path emitted a redirect target: $path"
done
rm -f -- "$work/public-path.headers"
curl --silent --show-error --fail --max-time 20 -H "Host: $dashboard_host" \
  -H 'X-Forwarded-Proto: https' \
  "$center_base/login" >"$work/login.html"
python3 - "$work/login.html" >"$work/assets.txt" <<'PY'
from html.parser import HTMLParser
import sys
class P(HTMLParser):
    def __init__(self): super().__init__(); self.urls=set()
    def handle_starttag(self, tag, attrs):
        values=dict(attrs)
        for key in ("src","href"):
            value=values.get(key, "")
            if value.startswith("/_next/"): self.urls.add(value)
p=P(); p.feed(open(sys.argv[1], encoding="utf-8").read())
for value in sorted(p.urls): print(value)
PY
while IFS= read -r asset; do
  [[ -n "$asset" ]] || continue
  expect_status 200 -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' "$center_base$asset"
done <"$work/assets.txt"

# Carry is now a compatibility entry point only. The redirect must preserve the
# exact path and query and must never become a second serving authority.
if ((quiesced_loopback == 0 && legacy_dashboard_origin == 0)); then
  legacy_origin=https://carry.andersmadsen.dk
  [[ "$legacy_origin" == "$DOMAIN_LEGACY_ORIGIN" ]] \
    || fail "legacy Carry canary origin differs from the domain transaction"
  legacy_request_path='/login?legacy-canary=1&next=%2Fwifi'
  legacy_status="$(curl --silent --show-error --max-time 20 --max-redirs 0 \
    -D "$work/legacy-redirect.headers" -o /dev/null -w '%{http_code}' \
    "$legacy_origin$legacy_request_path")"
  [[ "$legacy_status" == 307 ]] || fail "legacy Carry origin did not return HTTP 307"
  python3 - "$work/legacy-redirect.headers" "$DOMAIN_CANONICAL_ORIGIN$legacy_request_path" <<'PY'
import sys

lines = open(sys.argv[1], encoding="latin1").read().splitlines()
locations = [line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("location:")]
assert locations == [sys.argv[2]], "legacy Carry redirect did not preserve the exact path and query"
PY
fi

# The Setup UI and release API are same-origin. An empty operator-managed
# release directory is an honest 404; a published manifest is verified without
# downloading or mutating any APK.
if ((legacy_dashboard_origin == 0)); then
  pin_release_url="$center_base/api/pin/releases/current"
  pin_get_status="$(curl --silent --show-error --connect-timeout 3 --max-time 20 \
    --max-filesize 65536 -D "$work/pin-release-get.headers" -o "$work/pin-release-get.json" \
    -w '%{http_code}' -H 'Host: center.andersmadsen.dk' -H 'X-Forwarded-Proto: https' \
    -H 'Origin: https://center.andersmadsen.dk' "$pin_release_url")"
  pin_head_result="$(curl --silent --show-error --connect-timeout 3 --max-time 20 \
    --max-filesize 65536 --head -D "$work/pin-release-head.headers" \
    -o /dev/null -w '%{http_code}\t%{size_download}' \
    -H 'Host: center.andersmadsen.dk' -H 'X-Forwarded-Proto: https' \
    -H 'Origin: https://center.andersmadsen.dk' "$pin_release_url")"
  python3 - "$pin_get_status" "$pin_head_result" "$work/pin-release-get.headers" \
    "$work/pin-release-head.headers" "$work/pin-release-get.json" \
    <<'PY'
import json,os,re,sys
get_status,head_result,get_headers,head_headers,get_body=sys.argv[1:]
head_status,head_size=head_result.split("\t")
assert get_status==head_status and get_status in {"200","404"}
assert os.path.getsize(get_body)<=65536 and float(head_size)==0
def headers(path):
    values={}
    for line in open(path,encoding="latin1"):
        name,separator,value=line.partition(":")
        if separator: values.setdefault(name.strip().lower(),[]).append(value.strip())
    return values
for path in (get_headers,head_headers):
    values=headers(path)
    assert values.get("cache-control")==["no-store, max-age=0"]
    assert values.get("x-content-type-options")==["nosniff"]
    assert values.get("access-control-allow-origin")==["https://center.andersmadsen.dk"]
body=json.load(open(get_body,encoding="utf-8"))
if get_status=="404":
    assert body=={"error":"Pin release not found."}
else:
    assert isinstance(body,dict) and set(body)=={"schemaVersion","releaseId","version","artifacts"}
    assert body["schemaVersion"]==1 and re.fullmatch(r"[0-9a-f]{64}",body["releaseId"])
    assert isinstance(body["version"],str) and 1<=len(body["version"])<=32
    artifacts=body["artifacts"]
    roles=["installer","bootstrap","hook","server","hook-injector"]
    assert isinstance(artifacts,list) and [item.get("role") for item in artifacts]==roles
    for role,item in zip(roles,artifacts):
        assert item.get("url")==f'./{body["releaseId"]}/{role}.apk'
        assert isinstance(item.get("size"),int) and 0<item["size"]<=512*1024*1024
        assert re.fullmatch(r"[0-9a-f]{64}",str(item.get("sha256","")))
PY
  if [[ "$pin_get_status" == 404 ]]; then
    warn "no operator Pin release is published yet; Setup will remain unavailable"
  fi
fi

# Read-only Cosmos status and flag delivery state.
curl --silent --show-error --fail --max-time 20 http://127.0.0.1:18086/demo-api/status >"$work/status.json"
mesh_summary="$(python3 - "$work/status.json" <<'PY'
import json,sys
body=json.load(open(sys.argv[1], encoding="utf-8"))
assert body.get("assistant") is True
assert body.get("speech") is True
mesh=body.get("mesh") or {}
# `reachable`/`total` are live tonic_health probes to each peer on :15051, so
# 7/7 means seven processes are serving health. It does NOT mean an
# authenticated method is reachable: auth.rs short-circuits /grpc.health.v1.Health/
# before authentication. The Center data-plane block below is what exercises an
# authenticated path.
#
# `services` and `methods` are deliberately NOT asserted here. http.rs computes
# both by filtering cosmos_core::registry::SERVICES, a `pub const` table, so they
# are identical for every run of a given binary and can only change by
# recompiling. As a deploy gate they were vacuous, and printed beside a real
# liveness number they lent it false authority. That invariant belongs to a Rust
# unit test in cosmos/crates/core, which fails at build time if the registry
# shrinks.
assert mesh.get("reachable") == mesh.get("total") == 7
print(f"{mesh.get('reachable')}/{mesh.get('total')} processes serving health")
PY
)"
log "mesh: $mesh_summary"
curl --silent --show-error --fail --max-time 20 http://127.0.0.1:18086/demo-api/flags >"$work/flags-after.json"
python3 - "$work/flags-after.json" "$require_remote_tts" <<'PY'
import json,sys
items=json.load(open(sys.argv[1],encoding="utf-8")); assert isinstance(items,list) and items
by_name={item.get("name"):item.get("effective") for item in items}
if sys.argv[2]=="1":
    assert by_name.get("server_side_speech_synthesis_streaming_enabled") is True
    timeout=by_name.get("server_side_speech_synthesis_timeout_millis")
    assert isinstance(timeout,int) and 0 < timeout <= 60000
PY
if [[ -n "$baseline" && -f "$baseline/flags-before.json" ]]; then
  python3 - "$baseline/flags-before.json" "$work/flags-after.json" <<'PY'
import json,sys
def overrides(path):
    body=json.load(open(path, encoding="utf-8"))
    assert isinstance(body,list) and body
    return {str(item["name"]):item.get("effective") for item in body if item.get("overridden") is True}
before,after=overrides(sys.argv[1]),overrides(sys.argv[2])
assert before == after, f"feature overrides changed: {sorted(before)} -> {sorted(after)}"
PY
fi

# Exercise Azure synthesis outside the strictly read-only live cutover. The
# selected candidate already performs this proof against its restored staging
# state, and deploy performs a provider byte-level precheck before quiescence.
if ((quiesced_loopback == 0)); then
  curl --silent --show-error --fail --connect-timeout 5 --max-time 40 \
    -D "$work/speech.headers" -o "$work/speech.mp3" \
    -H 'content-type: application/json' --data '{"text":"Ai Pin Revival deployment canary."}' \
    http://127.0.0.1:18086/demo-api/speech
  python3 - "$work/speech.headers" "$work/speech.mp3" <<'PY'
import os,sys
headers=open(sys.argv[1],encoding="latin1").read().lower()
audio=open(sys.argv[2],"rb").read()
assert "content-type: audio/mpeg" in headers
assert 1024 <= len(audio) <= 2_000_000
assert audio.startswith(b"ID3") or (len(audio)>2 and audio[0] == 0xff and audio[1] & 0xe0 == 0xe0)
PY
fi

# Prove the wearer projection resolves the paired account and does not serve a fixture.
curl --silent --show-error --fail --max-time 20 \
  -H @"$work/projection.headers" \
  http://127.0.0.1:18086/capture/memories >"$work/memories.json"
curl --silent --show-error --fail --max-time 20 \
  -H @"$work/projection.headers" \
  http://127.0.0.1:18086/notes >"$work/notes.json"
python3 - "$work/memories.json" "$work/notes.json" >"$work/projection-target.tsv" <<'PY'
import json,sys
memories=json.load(open(sys.argv[1],encoding="utf-8")); notes=json.load(open(sys.argv[2],encoding="utf-8"))
for body in (memories,notes):
    assert isinstance(body,dict) and isinstance(body.get("content"),list)
    assert body.get("totalElements",-1) >= 0
for note in notes["content"]:
    assert note.get("sealed") is False
    assert isinstance(note.get("text"),str)
photos=[item for item in memories["content"] if item.get("type")=="PHOTO" and item.get("uploadComplete") is True]
if photos:
    photo=photos[0]
    assert photo.get("frameCount")==3 and photo.get("thumbnailCount",0)>=3
    best=photo.get("bestFrameIndex"); assert isinstance(best,int) and 0 <= best < 3
    assert isinstance(photo.get("bestFrameMethod"),str) and photo.get("bestFrameMethod")
    for index in range(3): print(f"{photo['uuid']}\t{index}\t{best}")
PY
if [[ -s "$work/projection-target.tsv" ]]; then
  while IFS=$'\t' read -r memory_uuid thumbnail_index best_index; do
    curl --silent --show-error --fail --max-time 20 \
      -D "$work/media.headers" -o "$work/media.image" -H @"$work/projection.headers" \
      "http://127.0.0.1:18086/capture/memory/$memory_uuid/thumbnail/$thumbnail_index"
    python3 - "$work/media.headers" "$work/media.image" <<'PY'
import sys
headers=open(sys.argv[1],encoding="latin1").read().lower(); data=open(sys.argv[2],"rb").read()
assert "x-carry-projection: opened" in headers
assert "content-type: image/" in headers and len(data)>100
PY
    curl --silent --show-error --fail --max-time 20 \
      -D "$work/media.headers" -o "$work/media.image" -H @"$work/projection.headers" \
      "http://127.0.0.1:18086/capture/memory/$memory_uuid/file/$thumbnail_index"
    python3 - "$work/media.headers" "$work/media.image" <<'PY'
import sys
headers=open(sys.argv[1],encoding="latin1").read().lower(); data=open(sys.argv[2],"rb").read()
assert "x-carry-projection: opened" in headers
assert "content-type: image/" in headers and len(data)>100
PY
  done <"$work/projection-target.tsv"
fi

# A reachable TLS listener that returns no HTTP without a client certificate is
# the negative mTLS boundary. A refused TCP connection is not accepted as proof.
for authority in api.carry.humane.cloud onboarding.carry.humane.cloud; do
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18443' 2>/dev/null || fail "mTLS edge is not listening"
  if curl --insecure --silent --show-error --connect-timeout 3 --max-time 8 \
      --resolve "$authority:18443:127.0.0.1" -o /dev/null "https://$authority:18443/"; then
    fail "mTLS edge accepted a client without a certificate: $authority"
  fi
done

# ── THE SEALED-BEARER WEARER PLANE ───────────────────────────────────────────
#
# This is the gate two 100%-wearer-facing outages walked through. Everything
# above either bypasses Center entirely (the Cosmos probes dial ai-bus on
# 127.0.0.1:18086 with a synthesized x-forwarded-client-cert) or asks Center only
# unauthenticated questions, and Center answers a broken wearer plane with 200
# and an honest `degraded` body. So a deployment where every wearer saw an empty
# dashboard passed every check on this page.
#
# What closes it is the one thing no credential-free probe can have: a real
# Keycloak bearer, sealed by this deployment's own Center, riding this
# deployment's own cookie path. write_wearer_canary_jar signs a dedicated canary
# identity in through POST /api/auth/login — the same route the browser posts to
# — so the jar it returns exercises sealTokens on the way in and
# readTokenCookie -> openTokens -> requestBearer -> Keycloak JWKS ->
# CARRY_EDGE_TOKEN on the way back out. Break any link in that chain and the
# assertions below fail, which is exactly what did not happen twice.
#
# IT RUNS BY DEFAULT, ON EVERY INVOCATION, INCLUDING ROLLBACK. The previous
# arrangement made the wearer plane opt-in behind --require-wearer-plane and
# warned when it was off, which meant every rollback canary and every
# pre-cutover run was blind by construction and said so in a line nobody read as
# a refusal. A gate whose safe mode is the one you have to remember to ask for is
# not a gate. The refusal to run without a credential is therefore the default
# and --wearer-plane-optional is the deliberate, unautomated exception.
#
# It also mints its own jar rather than consuming --cookie-file. That is forced
# by the cross-release rule in common.sh: canary.sh is regularly invoked out of a
# PENDING release's tree by an OLDER deploy.sh, which would hand it a jar minted
# by write_owner_canary_cookie — session only, no bearer. A gate that depended on
# its caller supplying new-shaped material would fail closed on precisely the
# recovery path that must not deadlock. Producing its own is what the rule
# demands of new code, and it makes this coverage arrive for every existing
# caller with no interface change at all.
#
# The credential never enters this script as a value: common.sh hands back a
# short-lived jar and nothing else. Nothing below prints a cookie, a token, or a
# body — failures name a route and a state.
wearer_plane_proven=0
if wearer_canary_secret_present; then
  wearer_jar="$work/wearer.cookies"
  write_wearer_canary_jar "$wearer_jar" \
    || fail "the canary wearer could not obtain a sealed bearer from this deployment's Center"
  wearer_cookie_header="$work/wearer-cookie.headers"
  # Reassemble the jar into one request header. curl would do this from the jar
  # itself, but the header form is what every other authenticated probe in this
  # file uses, and it keeps the full chunked set on one code path.
  python3 - "$wearer_jar" "$wearer_cookie_header" <<'PY'
import sys
jar_path,output_path=sys.argv[1:]
pairs=[]
seen=set()
for line in open(jar_path,encoding="ascii"):
    fields=line.rstrip("\n").split("\t")
    if len(fields)!=7: continue
    name,value=fields[5],fields[6]
    if name in seen: continue
    seen.add(name); pairs.append(f"{name}={value}")
assert "carry_session" in seen and "carry_tokens" in seen
with open(output_path,"w",encoding="ascii") as target:
    target.write("cookie: " + "; ".join(pairs) + "\n")
PY
  chmod 600 "$wearer_cookie_header"

  # A canary that signed in AS THE WEARER would prove the plane and hand an
  # attacker who reads this host the paired account. It must be a different
  # subject, and that is checked here rather than trusted to the runbook.
  wearer_subject="$(wearer_canary_jar_subject "$wearer_jar")" \
    || fail "the canary wearer session carries no usable subject"
  wearer_owner_sub="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_OWNER_SUB || true)"
  [[ -n "$wearer_owner_sub" && "$wearer_subject" != "$wearer_owner_sub" ]] \
    || fail "the canary wearer credential is the paired Pin owner; provision a dedicated canary identity"

  # Least privilege, proven at runtime. middleware.ts answers an operator path
  # with 401 for no session and 403 for a session that is not an operator, so
  # 403 is the only passing answer: 401 would mean the jar is not being read at
  # all, and 200 would mean the operator provisioned an operator.
  wearer_admin_status="$(http_status -H "Host: $wearer_host" -H 'X-Forwarded-Proto: https' \
    -H @"$wearer_cookie_header" "$wearer_base/api/admin/overview" || true)"
  [[ "$wearer_admin_status" == 403 ]] \
    || fail "the canary wearer is not a least-privilege wearer: /api/admin/overview answered $wearer_admin_status (403 is the only correct answer)"

  # `live` below must be earned by the bearer and by nothing else.
  # CARRY_PRINCIPAL is cosmos.ts's identity fallback for the device-only demo;
  # a deployment that set it would make every gRPC call resolve without any
  # wearer identity at all, and this whole block would pass while proving
  # nothing. Production must never set it — one key and one partition per wearer.
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$center_container" \
    | awk -F= '$1=="CARRY_PRINCIPAL" && length($2)>0 {found=1} END{exit found?1:0}' \
    || fail "Center injects CARRY_PRINCIPAL, so a live wearer plane would prove nothing about the bearer chain"

  for surface in health:/api/health notes:/api/capture/notes \
    memories:/api/capture/memories features:/api/settings/features wifi:/api/settings/wifi; do
    name="${surface%%:*}"
    route="${surface#*:}"
    surface_status="$(curl --silent --show-error --connect-timeout 4 --max-time 25 \
      --max-redirs 0 -D "$work/sealed-$name.headers" -o "$work/sealed-$name.json" \
      -w '%{http_code}' -H "Host: $wearer_host" -H 'X-Forwarded-Proto: https' \
      -H @"$wearer_cookie_header" "$wearer_base$route" || true)"
    # curl writes 000 and exits non-zero on a refused or timed-out connection,
    # and without the `|| true` that kills this script at the assignment through
    # `set -e` — leaving the operator curl's own message and no named gate, the
    # exact failure expect_status was fixed for.
    #
    # 401 here is the sealed-bearer failure mode with a name: Center answers it
    # when a session's Keycloak grant has died under it, which for a jar minted
    # seconds ago means the refresh or JWKS path is broken.
    [[ "$surface_status" == 200 ]] \
      || fail "Center wearer surface must answer 200 for a sealed-bearer session: $route ($surface_status)"
  done
  python3 - "$work" <<'PY'
import json,sys
root=sys.argv[1]
def body(name): return json.load(open(f"{root}/sealed-{name}.json",encoding="utf-8"))
def state(name):
    for line in open(f"{root}/sealed-{name}.headers",encoding="latin1"):
        key,separator,value=line.partition(":")
        if separator and key.strip().lower()=="x-data-state": return value.strip()
    return None

# An error-shaped 200 is the thing this gate exists to refuse. Every route below
# reports failure inside a 200 body, so status is not evidence of anything.
for name in ("health","notes","memories","features","wifi"):
    payload=body(name)
    if isinstance(payload,dict):
        assert "error" not in payload, f"{name} answered 200 with an error body: {payload.get('error')}"
        assert payload.get("reauthenticate") is None, (
            f"{name} asked a seconds-old sealed session to re-authenticate: the refresh or JWKS path is broken"
        )

health=body("health")
assert health.get("carryConfigured") is True, "Center reports no carry backend at all"
planes=health.get("planes") or {}
assert set(planes)=={"grpc","webapi"}, "Center health lost one half of the data plane"
for half in ("grpc","webapi"):
    plane=planes[half]
    assert plane.get("configured") is True, f"Center has no endpoint configured for the {half} plane"
    # THE ASSERTION THE OUTAGES NEEDED. With a real bearer both halves resolve,
    # so `degraded` here is a genuine wearer-visible outage rather than the
    # correct answer for an identity-less call.
    assert plane.get("state")=="live", f"the {half} wearer plane is not live: {plane.get('detail')}"
assert health.get("state")=="live" and health.get("reachable") is True, (
    f"Center's merged data-plane state is not live: {health.get('detail')}"
)
assert health.get("source")=="carry", "Center is serving this wearer from fixtures"

# Collection routes must agree with the badge. A route that claims live in the
# body while its header says otherwise is the same lie in the other direction.
assert state("notes")=="live", "the notes REST projection is not live for a sealed-bearer session"
notes=body("notes")
assert isinstance(notes.get("content"),list) and isinstance(notes.get("totalElements"),int), (
    "the notes projection answered 200 without a page body"
)
for note in notes["content"]:
    assert isinstance(note.get("text"),str) or note.get("sealed") is True

assert state("memories")=="live", "the memories aggregate is not live for a sealed-bearer session"
memories=body("memories")
provenance=memories.get("provenance") or {}
assert set(provenance)=={"captures","notes","aiMic","music","calls"}, (
    "the memories aggregate lost a provenance part"
)
for part,detail in provenance.items():
    # captures and notes are REST; aiMic, music and calls are gRPC. With a bearer
    # every one of them resolves, so a single degraded part is one wearer surface
    # that is dark — which is how both outages presented.
    assert detail.get("state")=="live", f"a wearer data part is not live: {part} ({detail.get('degraded')})"
for key in ("photos","aiSessions","playTrackEvents","notes","phoneCalls","health"):
    assert isinstance(memories.get(key),list), f"the memories aggregate is missing {key}"

# Wi-Fi with a bearer is a LIVE read. An empty `networks` is still the right
# answer — Center cannot open device-sealed envelopes and must not try — so the
# substance is `sealedCount`, which only a real backend answer produces.
assert state("wifi")=="live", "the Wi-Fi pane did not resolve for a sealed-bearer session"
wifi=body("wifi")
assert wifi.get("state")=="live" and wifi.get("unavailable") is None, (
    "the Wi-Fi pane reported an unavailable read inside a 200"
)
assert wifi.get("networks")==[], "Center returned decoded Wi-Fi networks it cannot hold the key for"
assert isinstance(wifi.get("sealedCount"),int) and wifi["sealedCount"]>=0, (
    "the Wi-Fi pane answered without the sealed-envelope count that proves a real read"
)

# Features rides the admin token rather than the wearer bearer, so it proves
# Center -> ai-bus /demo-api/flags end to end. Deliberately not required to be
# non-empty: which flags a deployment has registered is not a deploy gate's
# business.
features=body("features")
assert isinstance(features,list), "the features pane did not receive a list"
assert all(isinstance(item.get("name"),str) for item in features)
PY
  rm -f -- "$work"/sealed-*.json "$work"/sealed-*.headers "$wearer_cookie_header" "$wearer_jar"
  unset wearer_subject wearer_owner_sub wearer_cookie_header wearer_jar
  wearer_plane_proven=1
  log "sealed-bearer wearer plane proven against $wearer_base for a dedicated canary identity"
  # Said out loud because it is the one link in the chain above that a fresh
  # login cannot reach: requestBearer only calls refreshTokens inside the last
  # 60 seconds of an access token's life, and this jar is seconds old. A grant
  # that Keycloak would refuse to rotate therefore still passes here, and shows
  # up later as a wearer being signed out mid-session.
  warn "the token REFRESH path is not exercised: this jar is newly minted, so refreshTokens/rotation is only reached by a session near expiry"
else
  ((wearer_plane_optional)) \
    || fail "the canary wearer credential is absent ($WEARER_CANARY_SECRET) and the sealed-bearer wearer plane cannot be proven; provision it (docs/operations.md, 'The canary wearer credential') or pass --wearer-plane-optional to accept a deploy that cannot see a 100%-degraded wearer plane"
  warn "RUNNING WITHOUT WEARER-PLANE COVERAGE by explicit request: no canary wearer credential is provisioned, so a broken openTokens/refreshTokens/JWKS/CARRY_EDGE_TOKEN path is invisible to this run and a 100%-degraded wearer plane would pass it"
fi

# When an owner-scoped protected cookie jar is available, exercise the complete
# read-only Center -> roster -> adapter -> Pin Spotify status path. Its absence
# does not weaken the unauthenticated infrastructure canary above; it is
# reported as an explicit acceptance boundary.
if [[ -f "$cookie_file" ]]; then
  cookie_mode="$(stat -c '%a' "$cookie_file")"
  [[ "$cookie_mode" == 400 || "$cookie_mode" == 600 ]] || fail "Center canary cookie jar has an unsafe mode"
  # The jar names one owner session for every host a canary dials (loopback
  # plus both dashboard origins), so several rows are expected — but they must
  # all carry the exact same session value.
  cookie_value="$(awk -F '\t' '
    $6=="carry_session" { count += 1; values[$7] = 1; value = $7 }
    END {
      if (count < 1) exit 1
      distinct = 0
      for (each in values) distinct += 1
      if (distinct != 1) exit 1
      print value
    }
  ' "$cookie_file")" || fail "Center canary cookie jar does not contain one owner session"
  [[ "$cookie_value" =~ ^[A-Za-z0-9_.-]+$ && ${#cookie_value} -le 4096 ]] \
    || fail "Center canary cookie jar has an invalid owner session"
  printf 'cookie: carry_session=%s\n' "$cookie_value" >"$work/owner-cookie.headers"
  chmod 600 "$work/owner-cookie.headers"
  curl --silent --show-error --fail --max-time 20 -H "Host: $dashboard_host" \
    -H 'X-Forwarded-Proto: https' -H @"$work/owner-cookie.headers" \
    "$center_base/api/settings/services/spotify" >"$work/spotify-status.json"
  unset cookie_value
  python3 - "$work/spotify-status.json" "$require_owner_spotify" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); assert isinstance(body,dict)
assert body.get("state") in {"disabled","not_configured","pairing","ready","error","unavailable"}
assert isinstance(body.get("enabled"),bool)
if sys.argv[2]=="1":
    # The owner surface must resolve the paired wearer rather than fall back to
    # a generic setup card. A Pin that is simply powered off or off-network is a
    # device-liveness fact, not a cloud-deployment defect, so that exact
    # reported reason is an accepted boundary and is reported to the operator.
    #
    # "error" is NOT in the accepted set: spotifyBridge.ts defines it as one of
    # the five real SpotifyPinState values — a failure the Pin reported, not an
    # absence — so swallowing it as a pass hides a live wearer-visible fault.
    # It follows the same warn-don't-fail shape as pin_unavailable, because the
    # fault is on the device rather than in the deployment.
    state=body.get("state")
    if state=="unavailable" and body.get("unavailable_reason")=="pin_unavailable":
        print("PIN_OFFLINE", file=sys.stderr)
    elif state=="error":
        print("PIN_SPOTIFY_ERROR", file=sys.stderr)
        assert "fallback_setup" not in body
    else:
        assert state in {"disabled","not_configured","pairing","ready"}
        assert "fallback_setup" not in body
for forbidden in ("token","secret","password","authorization","cookie","url","device_id","account_sub"):
    assert forbidden not in {str(key).lower() for key in body}
PY
  if ((require_owner_spotify)); then
    owner_spotify_state="$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); print(b.get("state",""))' "$work/spotify-status.json")"
    owner_spotify_reason="$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); print(b.get("unavailable_reason",""))' "$work/spotify-status.json")"
    if [[ "$owner_spotify_reason" == pin_unavailable ]]; then
      warn "the paired Pin is not reachable over the bridge; Spotify owner state stays unavailable until the device is online"
    elif [[ "$owner_spotify_state" == error ]]; then
      warn "the paired Pin reports a Spotify error; owner Spotify state is error"
    fi
    unset owner_spotify_state owner_spotify_reason
  fi

  # The authenticated Center DATA plane.
  #
  # Every other Cosmos probe in this canary bypasses Center and dials ai-bus
  # directly on 127.0.0.1:18086 with a synthesized x-forwarded-client-cert, and
  # the one owner-cookie request above goes to /api/settings/services/spotify —
  # a route whose module imports node:fs/promises and nothing from
  # center/src/server/cosmos.ts. So breaking CARRY_GRPC_ENDPOINT,
  # CARRY_WEBAPI_BASE_URL, or Center's contracts directory left every wearer
  # surface degraded-with-empty-data while every canary invocation exited 0.
  # That is the shape of the already-fixed session-expiry bug with the gate
  # still blind to it.
  #
  # What this jar can and cannot prove, stated plainly because reading more into
  # it is exactly how those outages shipped green: write_owner_canary_cookie
  # mints a `carry_session` only. Center reassembles the wearer bearer from the
  # SEPARATE `carry_tokens` cookie set — the `carry_tokens` manifest plus its
  # `carry_tokens.0`/`carry_tokens.1` chunks (center/src/server/auth.ts) — which
  # the jar deliberately does not carry (a canary must not hold a wearer
  # credential); that is also the exact name the grep below refuses. So requestBearer()
  # returns null and, with CARRY_PRINCIPAL unset in production, every gRPC call
  # goes out with no wearer identity and the workload refuses it.
  #
  # That makes the honest contract, not "live", the thing to assert — and it is
  # still a real gate, because the two planes fail differently:
  #
  #   * webapi (REST): capture_api::principal_for falls back to the demo
  #     account when nobody identified themselves, so a HEALTHY REST plane
  #     answers 200 and Center reports `live`. If CARRY_WEBAPI_BASE_URL is
  #     wrong, ai-bus's HTTP surface is down, or Center's bearer plumbing throws,
  #     this flips to `degraded`. That is the 100%-degraded symptom, caught with
  #     no credential at all.
  #   * gRPC: the workload rejects a call with no principal, so `degraded` with
  #     "authenticated edge principal required" is the CORRECT answer here. A
  #     dead endpoint, an unloadable contracts directory or an unregistered
  #     service produce a different detail, which is what is asserted.
  #
  # The one regression this cannot see is a revoked CARRY_EDGE_TOKEN: config.rs
  # answers a bad token with the same EdgeAuthenticationError::Missing as a
  # missing principal. Named here rather than implied away.
  if ((require_wearer_plane)); then
    if grep -q 'carry_tokens' "$cookie_file"; then
      fail "the canary cookie jar carries wearer token material; this gate is built for a credential-free session"
    fi
    for surface in health:/api/health notes:/api/capture/notes \
      memories:/api/capture/memories features:/api/settings/features wifi:/api/settings/wifi; do
      name="${surface%%:*}"
      route="${surface#*:}"
      surface_status="$(curl --silent --show-error --connect-timeout 4 --max-time 25 \
        --max-redirs 0 -D "$work/plane-$name.headers" -o "$work/plane-$name.json" \
        -w '%{http_code}' -H "Host: $dashboard_host" -H 'X-Forwarded-Proto: https' \
        -H @"$work/owner-cookie.headers" "$center_base$route")"
      [[ "$surface_status" == 200 ]] \
        || fail "Center wearer surface must answer 200 with an owner session: $route ($surface_status)"
    done
    python3 - "$work" <<'PY'
import json,sys
root=sys.argv[1]
def body(name): return json.load(open(f"{root}/plane-{name}.json",encoding="utf-8"))
def state(name):
    for line in open(f"{root}/plane-{name}.headers",encoding="latin1"):
        key,separator,value=line.partition(":")
        if separator and key.strip().lower()=="x-data-state": return value.strip()
    return None

health=body("health")
assert health.get("carryConfigured") is True, "Center reports no carry backend at all"
planes=health.get("planes") or {}
grpc=planes.get("grpc") or {}
webapi=planes.get("webapi") or {}
assert set(planes)=={"grpc","webapi"}, "Center health lost one half of the data plane"

# REST: reachable without a wearer bearer, so this must be live.
assert webapi.get("configured") is True, "Center has no CARRY_WEBAPI_BASE_URL"
assert webapi.get("state")=="live", f"Center REST data plane is not live: {webapi.get('detail')}"

# gRPC: configured, reachable, and correctly refusing an identity-less call.
assert grpc.get("configured") is True, "Center has no CARRY_GRPC_ENDPOINT"
detail=str(grpc.get("detail") or "")
assert grpc.get("state")=="degraded", (
    "the gRPC plane answered "
    f"{grpc.get('state')} for a session that carries no wearer bearer; either the "
    "jar gained token material or this deployment injects CARRY_PRINCIPAL, which "
    "production must never do (one key and one partition for every wearer)"
)
assert "authenticated edge principal required" in detail, (
    "the gRPC plane did not fail for the expected reason (missing wearer identity); "
    f"it answered: {detail}"
)
# The whole point of that string: a workload that is DOWN, an endpoint pointing
# nowhere, or a contracts directory Center cannot load all produce a different
# sentence, and each of those is a real outage this gate now fails on.
for broken in ("ENOENT","ECONNREFUSED","UNIMPLEMENTED","protocol definitions"):
    assert broken not in detail, f"Center gRPC plane is genuinely broken: {detail}"

# Collection routes must agree with the badge rather than quietly claim live.
assert state("notes")=="live", "the notes REST projection is not live"
notes=body("notes")
assert isinstance(notes.get("content"),list) and isinstance(notes.get("totalElements"),int)

assert state("memories")=="degraded", (
    "the memories aggregate claimed a state its identity-less gRPC parts cannot support"
)
memories=body("memories")
provenance=memories.get("provenance") or {}
assert set(provenance)=={"captures","notes","aiMic","music","calls"}
for part in ("captures","notes"):
    assert provenance[part].get("state")=="live", f"REST-backed provenance part is not live: {part}"
for part in ("aiMic","music","calls"):
    assert provenance[part].get("state")=="degraded", f"gRPC-backed provenance part should be degraded: {part}"
for key in ("photos","aiSessions","playTrackEvents","notes","phoneCalls","health"):
    assert isinstance(memories.get(key),list)

# Wi-Fi is the honest-failure contract in its purest form: a session with no
# sealed tokens must get 200 + degraded, never a 500 and never a silently live
# fixture.
assert state("wifi")=="degraded", "the Wi-Fi pane did not honestly report a degraded read"
assert body("wifi").get("networks")==[], "a degraded Wi-Fi read returned a network list"

# Features rides the admin token, not the wearer bearer, so it resolves on this
# jar and proves Center -> ai-bus /demo-api/flags end to end. The 200 above is
# the proof: the route answers 503 when the admin fetch fails, so the body only
# has to be the shape the pane reads. It is deliberately NOT required to be
# non-empty — which flags a deployment has registered is not a deploy gate's
# business, and blocking a cutover on it would be a gate lying about its subject.
features=body("features")
assert isinstance(features,list), "the features pane did not receive a list"
assert all(isinstance(item.get("name"),str) for item in features)
PY
    rm -f -- "$work"/plane-*.json "$work"/plane-*.headers
    # This block's own subject is the honest-degraded contract, and it remains
    # blind to the bearer chain by construction. It no longer has to be the last
    # word on the wearer plane: the sealed-bearer block above runs on every
    # invocation and refuses the deploy when it cannot. Only when that block was
    # explicitly waived does this warning still describe the whole run.
    ((wearer_plane_proven)) \
      || warn "the sealed-bearer wearer plane is NOT proven: this canary holds no wearer credential, so a broken openTokens/refreshTokens/JWKS/CARRY_EDGE_TOKEN path is still invisible to it"
  else
    # Without the flag, this run does not touch Center's data plane AT ALL, and
    # that has to be said rather than left to silence — silence is what a reader
    # turns into "the canary passed, so wearers are fine".
    #
    # Nothing above reaches it. Center's /api/health answers 401 to a request
    # with no session (middleware.ts keeps only /login, /wifi, /api/version,
    # /api/auth/*, and the share routes always-open), so no credential-free
    # probe can substitute; and the one owner-cookie request this branch does
    # make goes to /api/settings/services/spotify, a route whose module imports
    # nothing from center/src/server/cosmos.ts. The Cosmos probes all bypass
    # Center entirely on 127.0.0.1:18086.
    #
    # This is the state of EVERY rollback canary and of the pre-cutover runs.
    # The gate is deliberately not armed on rollback rather than accidentally
    # missing there: --require-wearer-plane pins the exact refusal sentence the
    # CURRENT release's Center emits, and a rollback runs this canary against an
    # OLDER Center that may word it differently. Blocking a recovery on a
    # vocabulary mismatch would be worse than the gap. Leaving the gap unnamed
    # would not.
    #
    # The sealed-bearer block above has no such vocabulary problem — it asserts
    # `live`, which every release spells the same way — so it IS armed on
    # rollback, and it is what makes this branch a gap in one contract rather
    # than a hole where the wearer plane should be. Say which is which, because
    # the previous unqualified sentence is now false whenever that block ran.
    if ((wearer_plane_proven)); then
      warn "the credential-free honest-degraded contract was not exercised in this run (--require-wearer-plane is off): /api/health, /api/capture/notes, /api/capture/memories, /api/settings/wifi and /api/settings/features were not requested with a bearer-less session, so a route that answers 500 instead of a degraded 200 would pass this canary"
    else
      warn "Center's own data plane was not exercised in this run (--require-wearer-plane is off): /api/health, /api/capture/notes, /api/capture/memories, /api/settings/wifi and /api/settings/features were never requested, so a 100%-degraded wearer plane would pass this canary"
    fi
  fi
  rm -f -- "$work/owner-cookie.headers"
else
  ((require_owner_spotify == 0)) || fail "owner-authenticated Spotify canary cookie jar is required for deployment"
  ((require_wearer_plane == 0)) || fail "owner-authenticated Center data-plane canary cookie jar is required for deployment"
  warn "owner-authenticated Spotify status was not exercised: protected canary cookie jar is absent"
fi

trap - EXIT
cleanup_work
if ((json)); then
  # `wearerPlane` is part of the result rather than only a log line: a machine
  # reader that treats ok:true as "wearers are fine" is the failure this whole
  # change is about, and it cannot make that mistake without ignoring a field
  # that says `unproven` in words.
  python3 - "$release_id" "$crud" "$wearer_plane_proven" <<'PY'
import json,sys
print(json.dumps({
    "ok":True,"releaseId":sys.argv[1],"mode":"read-only",
    "wearerPlane":"sealed-bearer" if sys.argv[3]=="1" else "unproven",
},separators=(",",":")))
PY
else
  log "release $release_id passed the read-only production canary"
fi
