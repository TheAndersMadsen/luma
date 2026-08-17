#!/usr/bin/env bash
# Compose invocation, container/volume lookup, service waits, and HTTP
# probes.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

compose_command_with_env() {
  local release_dir="$1" runtime="$2" cosmos="$3" provider="$4" center="$5"
  [[ -f "$release_dir/compose.yaml" ]] || fail "release lacks compose.yaml"
  [[ -f "$release_dir/platform/compose/production.yaml" ]] || fail "release lacks production Compose model"
  local file
  for file in "$runtime" "$cosmos" "$provider" "$center"; do [[ -f "$file" ]] || fail "Compose env file is missing"; done
  printf '%s\0' docker compose --project-name "$PROJECT" \
    --env-file "$runtime" --env-file "$cosmos" --env-file "$provider" --env-file "$center" \
    -f "$release_dir/compose.yaml" -f "$release_dir/platform/compose/production.yaml"
}

compose_command() {
  local release_dir="$1"
  compose_command_with_env "$release_dir" "$RUNTIME_ENV" "$COSMOS_ENV" "$PROVIDER_ENV" "$CENTER_ENV"
}

load_compose_command() {
  local release_dir="$1"
  COMPOSE=()
  while IFS= read -r -d '' part; do COMPOSE+=("$part"); done < <(compose_command "$release_dir")
}

load_compose_command_with_env() {
  local release_dir="$1" runtime="$2" cosmos="$3" provider="$4" center="$5"
  COMPOSE=()
  while IFS= read -r -d '' part; do COMPOSE+=("$part"); done < <(compose_command_with_env "$release_dir" "$runtime" "$cosmos" "$provider" "$center")
}

find_project_container() {
  local project="$1" service="$2"
  local found
  found="$(docker ps -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" | head -n 1)"
  if [[ -z "$found" ]]; then
    found="$(docker ps -aq \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service" | head -n 1)"
  fi
  printf '%s\n' "$found"
}

find_postgres_container() {
  local id project
  for project in "$PROJECT" "$LEGACY_PROJECT"; do
    id="$(docker ps -q --filter "label=com.docker.compose.project=$project" \
      --filter 'label=com.docker.compose.service=postgres' | head -n 1)"
    [[ -z "$id" ]] || { printf '%s\n' "$id"; return 0; }
  done
  fail "no active project Postgres container found"
}

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

active_service_container() {
  local service="$1" container
  container="$(find_project_container "$PROJECT" "$service")"
  if [[ -z "$container" || "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]]; then
    container="$(find_project_container "$LEGACY_PROJECT" "$service")"
  fi
  [[ -n "$container" && "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == true ]] \
    || fail "active production service is missing: $service"
  printf '%s\n' "$container"
}

stop_project_containers() {
  local project="$1" names=()
  mapfile -t names < <(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}' | LC_ALL=C sort)
  ((${#names[@]} == 0)) || docker stop --time 30 "${names[@]}" >/dev/null
}

remove_project_containers() {
  local project="$1" names=()
  mapfile -t names < <(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Names}}' | LC_ALL=C sort)
  ((${#names[@]} == 0)) || docker rm --force "${names[@]}" >/dev/null
}

start_recorded_containers() {
  local file="$1" names=() name
  [[ -f "$file" ]] || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] && names+=("$name")
  done <"$file"
  ((${#names[@]} > 0)) || return 1
  docker start "${names[@]}" >/dev/null
}

wait_for_services() {
  local release_dir="$1" attempt service container state failed
  load_compose_command "$release_dir"
  for attempt in $(seq 1 90); do
    failed=0
    for service in connectivity ai-bus account contacts feature-flags notable-events provisioning postgres keycloak edge center spotify-adapter searxng prometheus grafana; do
      container="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
      [[ -n "$container" ]] || { failed=1; break; }
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
      [[ "$state" == healthy || "$state" == running ]] || { failed=1; break; }
    done
    [[ "$failed" == 0 ]] && return 0
    sleep 2
  done
  "${COMPOSE[@]}" ps >&2 || true
  return 1
}

assert_compose_ports() {
  "${COMPOSE[@]}" config --format json | python3 -c '
import json,sys
body=json.load(sys.stdin); services=body.get("services",{})
expected={"connectivity":(18080,18085),"ai-bus":(18080,18086),"center":(4000,14000),"keycloak":(8080,8088),"edge":(8443,18443),"grafana":(3000,13001)}
for service,(target,published) in expected.items():
    ports=services.get(service,{}).get("ports") or []
    matches=[p for p in ports if int(p.get("target",-1))==target and int(p.get("published",-1))==published and p.get("host_ip")=="127.0.0.1"]
    if len(matches)!=1: raise SystemExit(f"unexpected loopback port mapping for {service}")
adapter=services.get("spotify-adapter",{})
if adapter.get("ports"): raise SystemExit("spotify-adapter must not publish a Docker port")
'
}

http_status() {
  curl --silent --show-error --connect-timeout 4 --max-time 20 --output /dev/null --write-out '%{http_code}' "$@"
}

expect_status() {
  local expected="$1"
  shift
  local actual argument target=""
  # Name the endpoint. Fifteen call sites share this helper across Center
  # (14000), ai-bus (18086), connectivity (18085), Grafana (13001), Keycloak
  # (8088) and the Pin bridge (18081), and a bare "expected 200 but received
  # 404" sends the reader to whichever layer they happen to suspect — the same
  # mistake in miniature as the Grafana probe that read as Center's for three
  # outages. Only the URL is echoed, never a header value: the admin roster and
  # web-projection tokens travel through -H on other requests.
  for argument in "$@"; do
    case "$argument" in
      http://*|https://*) target="$argument"; break ;;
    esac
  done
  # A refused or timed-out connection must arrive as this named failure rather
  # than killing the script at the assignment through `set -e`, where curl's own
  # message is the only thing the operator gets and no gate is named. curl
  # writes 000 for those, which can never equal an expected status, so nothing
  # passes vacuously.
  actual="$(http_status "$@" || true)"
  [[ "$actual" == "$expected" ]] \
    || fail "HTTP canary expected $expected but received $actual: ${target:-unknown target}"
}
