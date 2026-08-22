#!/usr/bin/bash
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
  revival_compose_release="$release_dir"
  COMPOSE=()
  while IFS= read -r -d '' part; do COMPOSE+=("$part"); done < <(compose_command "$release_dir")
  wrap_compose_with_candidate_authority
}

load_compose_command_with_env() {
  local release_dir="$1" runtime="$2" cosmos="$3" provider="$4" center="$5"
  revival_compose_release="$release_dir"
  COMPOSE=()
  while IFS= read -r -d '' part; do COMPOSE+=("$part"); done < <(compose_command_with_env "$release_dir" "$runtime" "$cosmos" "$provider" "$center")
  wrap_compose_with_candidate_authority
}

wrap_compose_with_candidate_authority() {
  local override="${revival_candidate_override_path:-}" digest="${revival_candidate_override_sha256:-}"
  if [[ -z "$override$digest" ]]; then
    [[ "${revival_candidate_authority_required:-0}" == 0 ]] \
      || fail "candidate-era Compose use has no retained bundle authority"
    return 0
  fi
  [[ -n "$override" && "$override" == "$DEPLOYMENTS_DIR/"* \
    && "$digest" =~ ^[0-9a-f]{64}$ \
    && "${revival_candidate_id:-}" =~ ^[0-9a-f]{64}$ \
    && "${revival_candidate_path:-}" == "$REMOTE_ROOT/release-candidates/${revival_candidate_id:-}" \
    && "${revival_candidate_authority_record:-}" == "$DEPLOYMENTS_DIR/"* \
    && "${revival_candidate_authority_receipt_name:-}" =~ ^[A-Za-z0-9._-]+-compose-authority\.json$ \
    && "${revival_candidate_authority_receipt_sha256:-}" =~ ^[0-9a-f]{64}$ \
    && "${revival_candidate_compose_model_sha256:-}" =~ ^[0-9a-f]{64}$ \
    && "${revival_candidate_authority_release:-}" == "${revival_compose_release:-}" \
    && "${REVIVAL_HELD_COMPOSE:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ \
    && "${REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
    || fail "held candidate Compose authority is incomplete"
  local release_id manifest
  release_id="$(basename -- "$revival_compose_release")"
  validate_release_id "$release_id"
  [[ "$revival_compose_release" == "$RELEASES_DIR/$release_id" ]] \
    || fail "candidate Compose release is outside the immutable release store"
  manifest="$MANIFESTS_DIR/$release_id.json"
  local -a base=("${COMPOSE[@]}")
  COMPOSE=("$REVIVAL_HOST_PYTHON" -I -B "$REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC" \
    --candidate "$revival_candidate_path" --candidate-id "$revival_candidate_id" \
    --release-id "$release_id" --record "$revival_candidate_authority_record" \
    --receipt-name "$revival_candidate_authority_receipt_name" \
    --expect-receipt-sha256 "$revival_candidate_authority_receipt_sha256" \
    --program "$REVIVAL_HELD_COMPOSE" -- \
    --candidate-id "$revival_candidate_id" --override-name "${override##*/}" --sha256 "$digest" \
    --release "$revival_compose_release" --manifest "$manifest" --release-id "$release_id" \
    -- "${base[@]}")
}

clear_candidate_compose_authority() {
  unset revival_candidate_override_path revival_candidate_override_sha256
  unset revival_candidate_authority_release
  unset revival_candidate_id revival_candidate_path revival_candidate_authority_record
  unset revival_candidate_authority_receipt_name revival_candidate_authority_receipt_sha256
  unset revival_candidate_compose_model_sha256
  revival_candidate_authority_required=0
  HELPER_IMAGE="$CANDIDATE_HELPER_REFERENCE"
  export revival_candidate_authority_required HELPER_IMAGE
}

activate_retained_candidate_authority() {
  local selected_release="$1" source_record="$2" authority_record="$3" prefix="$4"
  shift 4
  local selected_release_id candidate_id candidate_path id_file path_file
  local runtime_json runtime_fields evidence_digest override_digest model_digest authority_digest
  selected_release_id="$(basename -- "$selected_release")"
  validate_release_id "$selected_release_id"
  [[ "$selected_release" == "$RELEASES_DIR/$selected_release_id" \
    && "$source_record" == "$DEPLOYMENTS_DIR/"* && -d "$source_record" && ! -L "$source_record" \
    && "$authority_record" == "$DEPLOYMENTS_DIR/"* && -d "$authority_record" && ! -L "$authority_record" \
    && "$prefix" =~ ^[A-Za-z0-9._-]{1,64}$ ]] \
    || fail "retained candidate authority request is outside protected stores"
  id_file="$source_record/candidate-id"; path_file="$source_record/candidate-path"
  if [[ ! -e "$id_file" && ! -L "$id_file" && ! -e "$path_file" && ! -L "$path_file" ]]; then
    fail "retained candidate authority is mandatory for offline Compose use"
  fi
  for evidence in "$id_file" "$path_file"; do
    [[ -f "$evidence" && ! -L "$evidence" \
      && "$(stat -c '%a:%u:%g:%h' "$evidence")" == "600:$(id -u):$(id -g):1" ]] \
      || fail "retained candidate identity evidence is unsafe"
  done
  candidate_id="$(tr -d '\r\n' <"$id_file")"
  candidate_path="$(tr -d '\r\n' <"$path_file")"
  [[ "$candidate_id" =~ ^[0-9a-f]{64}$ \
    && "$candidate_path" == "$REMOTE_ROOT/release-candidates/$candidate_id" ]] \
    || fail "retained candidate identity evidence is inconsistent"
  [[ "${REVIVAL_HELD_CANDIDATE_VERIFIER:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ \
    && "${REVIVAL_HELD_CANDIDATE_RUNTIME:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ \
    && "${REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
    || fail "current trusted candidate runtime authority is unavailable"
  local verification
  verification="$(run_held_candidate_verifier verify --candidate "$candidate_path" \
    --expect-id "$candidate_id" --json)" \
    || fail "retained candidate failed filesystem-only verification"
  "$REVIVAL_HOST_NODE" -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||v.candidateId!==process.argv[2]||v.releaseId!==process.argv[3]||v.productionCompatible!==true)process.exit(1)' \
    "$verification" "$candidate_id" "$selected_release_id" \
    || fail "retained candidate does not bind the requested release"

  clear_candidate_compose_authority
  if (($# != 0 && $# != 4)); then
    fail "retained candidate authority received an invalid env-file set"
  fi
  runtime_json="$("$REVIVAL_HOST_PYTHON" -I -B "$REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC" \
    --candidate "$candidate_path" --candidate-id "$candidate_id" --release-id "$selected_release_id" \
    --record "$authority_record" --receipt-name "$prefix-compose-authority.json" \
    --program "$REVIVAL_HELD_CANDIDATE_RUNTIME" -- \
    --candidate-id "$candidate_id" --release-id "$selected_release_id" \
    --evidence-name "$prefix-images.tsv" --override-name "$prefix-images.override.json" \
    --helper-reference "$CANDIDATE_HELPER_REFERENCE")" \
    || fail "retained candidate image transaction failed"
  runtime_fields="$("$REVIVAL_HOST_NODE" -e '
const value=JSON.parse(process.argv[1]);
if(value.ok!==true||!/^sha256:[0-9a-f]{64}$/.test(value.helperReference)||!/^[0-9a-f]{64}$/.test(value.evidenceSha256)||!/^[0-9a-f]{64}$/.test(value.overrideSha256)||!/^[0-9a-f]{64}$/.test(value.composeModelSha256)||!/^[0-9a-f]{64}$/.test(value.authorityReceiptSha256))process.exit(1);
process.stdout.write(`${value.helperReference}\t${value.evidenceSha256}\t${value.overrideSha256}\t${value.composeModelSha256}\t${value.authorityReceiptSha256}`);
' "$runtime_json")" || fail "retained candidate runtime returned invalid evidence"
  IFS=$'\t' read -r HELPER_IMAGE evidence_digest override_digest model_digest authority_digest <<<"$runtime_fields"
  revival_candidate_override_path="$authority_record/$prefix-images.override.json"
  revival_candidate_override_sha256="$override_digest"
  revival_candidate_id="$candidate_id"
  revival_candidate_path="$candidate_path"
  revival_candidate_authority_record="$authority_record"
  revival_candidate_authority_receipt_name="$prefix-compose-authority.json"
  revival_candidate_authority_receipt_sha256="$authority_digest"
  revival_candidate_compose_model_sha256="$model_digest"
  revival_candidate_authority_release="$selected_release"
  revival_candidate_authority_required=1
  export HELPER_IMAGE revival_candidate_override_path revival_candidate_override_sha256
  export revival_candidate_id revival_candidate_path revival_candidate_authority_record
  export revival_candidate_authority_receipt_name revival_candidate_authority_receipt_sha256
  export revival_candidate_compose_model_sha256
  export revival_candidate_authority_release revival_candidate_authority_required
  if (($# == 0)); then
    load_compose_command "$selected_release"
  else
    load_compose_command_with_env "$selected_release" "$1" "$2" "$3" "$4"
  fi
  "${COMPOSE[@]}" config --quiet
  [[ "$(docker image inspect --format '{{.Id}}' "$HELPER_IMAGE")" == "$HELPER_IMAGE" ]] \
    || fail "retained backup helper content ID is unavailable"
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
