#!/usr/bin/bash
set -euo pipefail
source "${REVIVAL_HELD_COMMON:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh}"
source "${REVIVAL_HELD_DOMAIN:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/domain.sh}"

leave_quiesced=0
already_locked=0
public_ingress_quiesced=0
cloudflared_record=""
cloudflared_state=""
ingress_evidence=""
json=0
# The relation-column sidecar this backup's data manifest is projected onto.
# Empty means "every column, in attnum order, as the cluster has them now",
# which is what a first/baseline backup wants. deploy.sh passes the PRE-candidate
# backup's sidecar when it takes the POST-candidate backup, so the two manifests
# are digested over the same column sets and an ADDITIVE migration between them
# cannot move a digest without a value moving. See capture_postgres_data.
data_columns_source=""
backup_id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
usage() {
  echo "usage: backup [--backup-id ID] [--leave-quiesced] [--already-locked] [--public-ingress-quiesced] [--cloudflared-record PATH --cloudflared-state recorded|before|desired --ingress-evidence PATH] [--data-columns-source PATH] [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --backup-id) (($# >= 2)) || usage; backup_id="$2"; shift 2 ;;
    --data-columns-source) (($# >= 2)) || usage; data_columns_source="$2"; shift 2 ;;
    --leave-quiesced) leave_quiesced=1; shift ;;
    --already-locked) already_locked=1; shift ;;
    --public-ingress-quiesced) public_ingress_quiesced=1; shift ;;
    --cloudflared-record) (($# >= 2)) || usage; cloudflared_record="$2"; shift 2 ;;
    --cloudflared-state) (($# >= 2)) || usage; cloudflared_state="$2"; shift 2 ;;
    --ingress-evidence) (($# >= 2)) || usage; ingress_evidence="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$backup_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage
if [[ -n "$cloudflared_record$cloudflared_state$ingress_evidence" ]]; then
  [[ -n "$cloudflared_record" && -n "$cloudflared_state" && -n "$ingress_evidence" ]] || usage
  [[ "$cloudflared_record" == "$DEPLOYMENTS_DIR/"* && -d "$cloudflared_record" \
    && ! -L "$cloudflared_record" && -f "$ingress_evidence" && ! -L "$ingress_evidence" ]] || usage
  case "$cloudflared_state" in recorded|before|desired) ;; *) usage ;; esac
elif ((public_ingress_quiesced)); then
  usage
fi
if [[ -n "$data_columns_source" ]]; then
  # Only ever another verified backup's own sidecar. A projection source decides
  # which columns a digest covers, so accepting an arbitrary path would be a way
  # to narrow every relation digest in this manifest from outside.
  data_columns_source="$(readlink -f -- "$data_columns_source")"
  [[ "$data_columns_source" == "$(readlink -f -- "$BACKUP_ROOT")/"*/postgres-data.tsv.columns ]] \
    || fail "--data-columns-source must be a backup's own relation column sidecar"
fi

assert_target
assert_remote_root
for command in docker python3 tar gzip sha256sum openssl flock curl systemctl timeout pgrep readlink; do need "$command"; done
[[ -z "$data_columns_source" ]] || validate_relation_column_sidecar "$data_columns_source"
if ((already_locked)); then
  assert_inherited_deploy_lock || fail "--already-locked requires the inherited canonical deployment lock"
fi
docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || fail "the digest-pinned helper image must be pulled before quiescing writers"
assert_durable_inputs
assert_active_durable_mounts
active_attest_dir="$(active_attestation_root)"
active_duc_dir="$(active_device_user_root)"
if ((already_locked == 0)); then
  ensure_layout
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "another deployment or backup holds the lock"
fi

destination="$BACKUP_ROOT/$backup_id"
[[ ! -e "$destination" ]] || fail "backup id already exists"
mkdir -p "$destination"
chmod 700 "$destination"

release_root="${REVIVAL_HELD_RELEASE_LOGICAL_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
driver_path="${BASH_SOURCE[0]}"
common_path="${REVIVAL_HELD_COMMON:-$release_root/platform/deploy/vps/remote/common.sh}"
domain_path="${REVIVAL_HELD_DOMAIN:-$release_root/platform/deploy/vps/remote/domain.sh}"
domain_helper_path="${REVIVAL_HELD_DOMAIN_PY:-$release_root/platform/deploy/vps/remote/domain.py}"
release_verifier="${REVIVAL_HELD_RELEASE_VERIFIER:-$release_root/platform/deploy/vps/verify-release.py}"
: >"$destination/executing-code.tsv"
for spec in "remote.backup:$driver_path" "remote.common:$common_path" "remote.domain:$domain_path" \
  "remote.domain-helper:$domain_helper_path" "release.verifier:$release_verifier"; do
  label="${spec%%:*}"; path="${spec#*:}"
  release_material_file_is_safe "$path" || fail "backup execution material is missing or unsafe"
  printf '%s\t%s\t%s\n' "$label" "$(sha256sum "$path" | awk '{print $1}')" "$(stat -Lc '%a' "$path")" \
    >>"$destination/executing-code.tsv"
done
for common_name in paths ingress release_transactions configuration compose backup database canary drift; do
  common_key="REVIVAL_HELD_COMMON_LIB_${common_name^^}"
  common_key="${common_key//-/_}"
  common_lib="${!common_key:-$release_root/platform/deploy/vps/remote/lib/$common_name.sh}"
  release_material_file_is_safe "$common_lib" || fail "common library material is missing or unsafe"
  printf 'remote.common-lib.%s.sh\t%s\t%s\n' "$common_name" \
    "$(sha256sum "$common_lib" | awk '{print $1}')" "$(stat -Lc '%a' "$common_lib")" \
    >>"$destination/executing-code.tsv"
done
chmod 600 "$destination/executing-code.tsv"

quiesced=0
bridge_was_active=0
bridge_stopped=0
postgres_stopped=0
verify_scope="ai-pin-revival-backup-verify-$(date -u +%s)-$$-$(openssl rand -hex 4)"
verify_postgres_container="${verify_scope}-postgres"
verify_postgres_volume="${verify_scope}-pgdata"
verify_physical_postgres_container="${verify_scope}-physical-postgres"
verify_physical_postgres_volume="${verify_scope}-physical-pgdata"
verify_volumes=()
protected_restore=""
center_restore=""
security_work_dirs=()
flag_work_files=()

wait_container_healthy() {
  local name="$1" attempt running health has_health
  for ((attempt=1; attempt<=90; attempt++)); do
    running="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)"
    has_health="$(docker inspect --format '{{if .Config.Healthcheck}}yes{{else}}no{{end}}' "$name" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [[ "$running" == true && ( "$has_health" == no || "$health" == healthy ) ]]; then return 0; fi
    sleep 2
  done
  return 1
}

prove_bridge_healthy() {
  systemctl is-active --quiet penumbra-center-bridge.service || return 1
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || return 1
}

restart_bridge_strict() {
  ((bridge_was_active)) || return 0
  sudo -n systemctl start penumbra-center-bridge.service || return 1
  local attempt
  for ((attempt=1; attempt<=30; attempt++)); do
    if prove_bridge_healthy; then bridge_stopped=0; return 0; fi
    sleep 1
  done
  return 1
}

restart_postgres_strict() {
  ((postgres_stopped)) || return 0
  if [[ "$(docker inspect --format '{{.State.Running}}' "$postgres" 2>/dev/null || true)" != true ]]; then
    docker start "$postgres" >/dev/null || return 1
  fi
  wait_container_healthy "$postgres" || return 1
  postgres_stopped=0
}

write_effective_flags() {
  local output="$1" raw
  raw="$(mktemp)"
  flag_work_files+=("$raw")
  curl --silent --show-error --fail --max-time 10 \
    http://127.0.0.1:18086/demo-api/flags >"$raw"
  python3 - "$raw" "$output" <<'PY'
import json,sys
source,output=sys.argv[1:]
with open(source,encoding="utf-8") as stream: body=json.load(stream)
with open(output,"w",encoding="utf-8",newline="\n") as stream:
    json.dump(body,stream,sort_keys=True,separators=(",",":")); stream.write("\n")
PY
  chmod 600 "$output"
  rm -f -- "$raw"
}

verify_effective_flags() {
  local current
  [[ -f "$destination/flags-before.json" ]] || return 0
  current="$(mktemp)"
  flag_work_files+=("$current")
  write_effective_flags "$current" || return 1
  cmp -s "$destination/flags-before.json" "$current" || return 1
  rm -f -- "$current"
}

restart_recorded_strict() {
  local names=() name failed=0
  [[ -f "$destination/quiesced-containers.txt" ]] || return 0
  while IFS= read -r name; do [[ -n "$name" ]] && names+=("$name"); done <"$destination/quiesced-containers.txt"
  if ((${#names[@]})); then
    docker start "${names[@]}" >/dev/null || failed=1
    for name in "${names[@]}"; do
      wait_container_healthy "$name" || failed=1
    done
  fi
  if ((failed == 0)); then
    if [[ -f "$destination/invariants.tsv" ]]; then
      if ((public_ingress_quiesced)); then
        verify_quiesced_application "$destination/application-before" "$destination" || failed=1
      else
        verify_legacy_application "$destination/application-before" "$destination" || failed=1
      fi
    else
      if ((public_ingress_quiesced)); then
        verify_quiesced_application "$destination/application-before" || failed=1
      else
        verify_legacy_application "$destination/application-before" || failed=1
      fi
    fi
  fi
  ((failed)) || verify_effective_flags || failed=1
  ((failed == 0))
}
cleanup_verify_strict() {
  local failed=0 volume work
  local leftovers=()
  if docker container inspect "$verify_postgres_container" >/dev/null 2>&1; then
    docker rm --force --volumes "$verify_postgres_container" >/dev/null 2>&1 || failed=1
  fi
  if docker container inspect "$verify_physical_postgres_container" >/dev/null 2>&1; then
    docker rm --force "$verify_physical_postgres_container" >/dev/null 2>&1 || failed=1
  fi
  if docker volume inspect "$verify_postgres_volume" >/dev/null 2>&1; then
    docker volume rm "$verify_postgres_volume" >/dev/null 2>&1 || failed=1
  fi
  if docker volume inspect "$verify_physical_postgres_volume" >/dev/null 2>&1; then
    docker volume rm "$verify_physical_postgres_volume" >/dev/null 2>&1 || failed=1
  fi
  for volume in "${verify_volumes[@]}"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume" >/dev/null 2>&1 || failed=1
    fi
  done
  if [[ -n "$protected_restore" && -d "$protected_restore" ]]; then
    sudo -n rm -rf -- "$protected_restore" >/dev/null 2>&1 || failed=1
  fi
  if [[ -n "$center_restore" && -d "$center_restore" ]]; then
    sudo -n rm -rf -- "$center_restore" >/dev/null 2>&1 || failed=1
  fi
  for work in "${security_work_dirs[@]}"; do
    [[ ! -e "$work" ]] || rm -rf -- "$work" >/dev/null 2>&1 || failed=1
  done
  for work in "${flag_work_files[@]}"; do
    [[ ! -e "$work" ]] || rm -f -- "$work" >/dev/null 2>&1 || failed=1
  done
  mapfile -t leftovers < <(docker ps -aq --filter "label=dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope")
  ((${#leftovers[@]} == 0)) || docker rm --force --volumes "${leftovers[@]}" >/dev/null 2>&1 || failed=1
  mapfile -t leftovers < <(docker volume ls -q --filter "label=dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope")
  ((${#leftovers[@]} == 0)) || docker volume rm "${leftovers[@]}" >/dev/null 2>&1 || failed=1
  [[ -z "$(docker ps -aq --filter "label=dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope")" ]] || failed=1
  [[ -z "$(docker volume ls -q --filter "label=dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope")" ]] || failed=1
  [[ -z "$protected_restore" || ! -e "$protected_restore" ]] || failed=1
  [[ -z "$center_restore" || ! -e "$center_restore" ]] || failed=1
  for work in "${security_work_dirs[@]}"; do [[ ! -e "$work" ]] || failed=1; done
  for work in "${flag_work_files[@]}"; do [[ ! -e "$work" ]] || failed=1; done
  ((failed == 0))
}
finish_backup() {
  local status=$?
  # This handler restarts PostgreSQL, the Pin bridge and the recorded containers,
  # so being killed part-way leaves the stack down. Same rules as deploy.sh's
  # handlers: signals installed before EXIT is cleared so nothing lands in the
  # gap; trapped to a command rather than '' so the SIG_IGN does not survive
  # execve into its own docker children; and PIPE trapped because the warnings
  # below write to an ssh channel that a dropped connection has already closed.
  trap 'warn "signal received while the backup is restoring the stack; finishing the restore first"' HUP INT TERM
  trap ':' PIPE
  trap - EXIT
  if ! cleanup_verify_strict; then
    warn "backup verification cleanup did not remove every temporary object"
    status=1
  fi
  if ((postgres_stopped)); then
    if ! restart_postgres_strict; then
      warn "backup recovery could not restart PostgreSQL"
      status=1
    fi
  fi
  if ((bridge_stopped)) && ((status != 0 || leave_quiesced == 0)); then
    if ! restart_bridge_strict; then
      warn "backup recovery could not restore the Pin bridge"
      status=1
    fi
  fi
  if ((quiesced)) && ((status != 0 || leave_quiesced == 0)); then
    if ! restart_recorded_strict; then
      warn "backup recovery could not restart every recorded container"
      status=1
    fi
  fi
  exit "$status"
}
trap finish_backup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

postgres="$(find_postgres_container)"
[[ "$(docker inspect --format '{{.State.Running}}' "$postgres")" == true ]] || fail "Postgres is not running"
prove_bridge_healthy || fail "the Pin bridge must be active and listening before backup"
bridge_was_active=1
if ((public_ingress_quiesced)); then
  assert_public_ingress_quiesced \
    || fail "public-ingress-quiesced backup requires both exact Cloudflare connectors and Nginx to remain stopped"
  verify_cloudflared_activation_state "$ingress_evidence" "$cloudflared_record" "$cloudflared_state" \
    || fail "public-ingress-quiesced backup has unbound Cloudflare route or unit state"
elif [[ -n "$cloudflared_record" ]]; then
  assert_managed_cloudflared_topology \
    || fail "backup Cloudflare processes are not the exact allowlisted system and user units"
  verify_cloudflared_activation_state "$ingress_evidence" "$cloudflared_record" "$cloudflared_state" \
    || fail "backup has unbound Cloudflare route or unit state"
  assert_ingress_matches_recorded "$ingress_evidence" \
    || fail "backup ingress does not match its durable exact-unit evidence"
else
  domain_cloudflared_assert_ready || fail "Cloudflare ingress configuration is not valid"
  assert_managed_cloudflared_topology \
    || fail "backup Cloudflare processes are not the exact allowlisted system and user units"
fi

if [[ -n "$cloudflared_record" ]]; then
  cloudflared_binding="$destination/cloudflared"
  mkdir -p "$cloudflared_binding"
  chmod 700 "$cloudflared_binding"
  cloudflared_source="$cloudflared_record/domain-cutover/cloudflared"
  for name in before.yml desired.yml JOURNAL.json; do
    [[ -f "$cloudflared_source/$name" && ! -L "$cloudflared_source/$name" ]] \
      || fail "Cloudflare transaction evidence is incomplete: $name"
    install -m 600 "$cloudflared_source/$name" "$cloudflared_binding/$name"
  done
  case "$cloudflared_state" in
    desired) marker=INSTALLED.json ;;
    before) marker=RESTORED.json ;;
    recorded) marker="" ;;
  esac
  if [[ -n "$marker" ]]; then
    [[ -f "$cloudflared_source/$marker" && ! -L "$cloudflared_source/$marker" ]] \
      || fail "Cloudflare transaction route-state marker is missing"
    install -m 600 "$cloudflared_source/$marker" "$cloudflared_binding/$marker"
  fi
  install -m 600 "$ingress_evidence" "$cloudflared_binding/ingress-evidence.tsv"
  printf '%s\n' "$cloudflared_state" >"$cloudflared_binding/route-state"
  chmod 600 "$cloudflared_binding/route-state"
fi

# Capture the exact running container/image/mount identity and the observable
# application contract before stopping a writer. Recovery must reproduce both;
# an unauthenticated Center endpoint is intentionally not used as a proxy for
# health because legacy Center correctly protects those routes.
record_project_state "$destination/application-before"
if ((public_ingress_quiesced)); then
  write_quiesced_semantic_evidence "$destination/application-before/semantic-baseline.tsv" \
    || fail "the running application does not satisfy the quiesced loopback recovery baseline"
else
  write_legacy_semantic_evidence "$destination/application-before/semantic-baseline.tsv" \
    || fail "the running application does not satisfy the recovery baseline"
fi

# Capture the effective flag state while the application plane is still serving.
ai_bus="$(find_project_container "$PROJECT" ai-bus)"
[[ -n "$ai_bus" ]] || ai_bus="$(find_project_container "$LEGACY_PROJECT" ai-bus)"
[[ -n "$ai_bus" && "$(docker inspect --format '{{.State.Running}}' "$ai_bus")" == true ]] \
  || fail "the ai-bus must be running before backup"
write_effective_flags "$destination/flags-before.json"

# Stop every database client plus every actual non-PostgreSQL RW holder of a
# reviewed durable root. The mount-derived set covers future workloads and is
# authoritative over the compatibility service list.
writer_names=()
for project in "$PROJECT" "$LEGACY_PROJECT"; do
  for service in connectivity center ai-bus account contacts feature-flags notable-events provisioning edge keycloak prometheus grafana; do
    id="$(find_project_container "$project" "$service")"
    if [[ -n "$id" && "$(docker inspect --format '{{.State.Running}}' "$id")" == true ]]; then
      writer_names+=("$(docker inspect --format '{{.Name}}' "$id" | sed 's#^/##')")
    fi
  done
done
mapfile -t durable_writer_names < <(running_durable_writer_names "$postgres" "$active_attest_dir" "$active_duc_dir")
assert_reviewed_durable_writer_names "${durable_writer_names[@]}"
writer_names+=("${durable_writer_names[@]}")
printf '%s\n' "${writer_names[@]}" | awk 'NF && !seen[$0]++' >"$destination/quiesced-containers.txt"
chmod 600 "$destination/quiesced-containers.txt"
quiesced=1
if ((${#writer_names[@]})); then
  mapfile -t writer_names < <(printf '%s\n' "${writer_names[@]}" | awk 'NF && !seen[$0]++')
  docker stop --time 30 "${writer_names[@]}" >/dev/null
fi
assert_durable_writers_quiesced "$postgres" "$active_attest_dir" "$active_duc_dir"

# The host bridge owns mutable state outside Docker. Stop it for the exact
# protected archive point-in-time, then restart it immediately; deployment
# rehearsals still need the bridge to remain available while app writers stay
# quiesced.
bridge_stopped=1
sudo -n systemctl stop penumbra-center-bridge.service
if systemctl is-active --quiet penumbra-center-bridge.service; then
  fail "Pin bridge did not quiesce for its protected snapshot"
fi

write_backup_invariants "$destination/invariants.tsv" "$postgres"

archive_volume() {
  local volume="$1" output="$2" helper_name="${verify_scope}-archive-${2//[^A-Za-z0-9]/-}"
  docker run --pull=never --rm --name "$helper_name" --network none --log-driver none --memory 512m --pids-limit 128 --cpus 1 \
    --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
    -v "$volume:/source:ro" -v "$destination:/backup" "$HELPER_IMAGE" sh -euc \
    "tar -czpf '/backup/${output}.tmp' -C /source . && test -s '/backup/${output}.tmp' && chown 1000:1000 '/backup/${output}.tmp' && chmod 600 '/backup/${output}.tmp'"
  mv "$destination/$output.tmp" "$destination/$output"
  tar -tzf "$destination/$output" >/dev/null
}
archive_directory() {
  local source="$1" output="$2"
  sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
    -czpf "$destination/$output.tmp" -C "$source" .
  sudo -n chown "$(id -u):$(id -g)" "$destination/$output.tmp"
  chmod 600 "$destination/$output.tmp"
  mv "$destination/$output.tmp" "$destination/$output"
  tar -tzf "$destination/$output" >/dev/null
}

# Multi-root protected backups need the canonical `.` inventory entry without
# recursively archiving the source root. Create that one directory header with
# recursion disabled, append only the reviewed path list in a second tar pass,
# then compress the completed archive atomically.
archive_selected_paths() {
  local source_root="$1" paths="$2" output="$3"
  local stem raw compressed owner
  [[ -d "$source_root" && ! -L "$source_root" ]] || fail "selected archive source root is unsafe"
  [[ -f "$paths" && ! -L "$paths" && -s "$paths" ]] || fail "selected archive path list is unsafe or empty"
  [[ "$output" == *.tar.gz ]] || fail "selected archive output must end in .tar.gz"
  stem="${output%.tar.gz}"
  raw="${stem}.tar.tmp"
  compressed="${output}.tmp"
  [[ ! -e "$raw" && ! -L "$raw" && ! -e "$compressed" && ! -L "$compressed" \
    && ! -e "$output" && ! -L "$output" ]] || fail "selected archive output already exists"

  if ! sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
      --no-recursion -cpf "$raw" -C "$source_root" .; then
    sudo -n rm -f -- "$raw" >/dev/null 2>&1 || true
    return 1
  fi
  if ! sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
      -rpf "$raw" -C "$source_root" -T "$paths"; then
    sudo -n rm -f -- "$raw" >/dev/null 2>&1 || true
    return 1
  fi
  if ! sudo -n gzip -9c "$raw" >"$compressed"; then
    sudo -n rm -f -- "$raw" >/dev/null 2>&1 || true
    rm -f -- "$compressed"
    return 1
  fi
  sudo -n rm -f -- "$raw"
  owner="$(id -u):$(id -g)"
  sudo -n chown "$owner" "$compressed"
  chmod 600 "$compressed"
  mv "$compressed" "$output"
  tar -tzf "$output" >/dev/null
}
# capture_postgres_security and capture_postgres_schema are DELIBERATELY NOT
# DEFINED HERE. They live in common.sh (sourced above), beside
# capture_postgres_data, because staging-smoke.sh compares the files this
# script writes against files produced by the same helpers on its side: two
# bodies for one format only agree until one of them is edited, and these two
# had in fact diverged while still emitting matching lines. The acceptance
# suite (data-mutation-gates.test.mjs) refuses a redefinition here.

archive_volume "$STATE_VOLUME" cosmos-state.tar.gz
archive_directory "$CENTER_DATA_DIR" center-data.tar.gz
archive_volume "$PROMETHEUS_VOLUME" prometheus-data.tar.gz
archive_volume "$GRAFANA_VOLUME" grafana-data.tar.gz

docker exec "$postgres" pg_dumpall --globals-only -U "$LEGACY_DATABASE_USER" | gzip -9 >"$destination/postgres-globals.sql.gz.tmp"
gzip -t "$destination/postgres-globals.sql.gz.tmp"
mv "$destination/postgres-globals.sql.gz.tmp" "$destination/postgres-globals.sql.gz"
docker exec "$postgres" pg_dump --clean --if-exists --create -U "$LEGACY_DATABASE_USER" -d "$LEGACY_DATABASE_NAME" | gzip -9 >"$destination/cosmos.sql.gz.tmp"
gzip -t "$destination/cosmos.sql.gz.tmp"
mv "$destination/cosmos.sql.gz.tmp" "$destination/cosmos.sql.gz"
docker exec "$postgres" pg_dump --clean --if-exists --create -U "$LEGACY_DATABASE_USER" -d keycloak | gzip -9 >"$destination/keycloak.sql.gz.tmp"
gzip -t "$destination/keycloak.sql.gz.tmp"
mv "$destination/keycloak.sql.gz.tmp" "$destination/keycloak.sql.gz"
capture_postgres_security "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-security.json"
capture_postgres_data "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-data.tsv" "$data_columns_source"
# When the authoritative manifest above is PROJECTED, keep an unprojected one
# beside it. The projection exists only for deploy.sh's pre-vs-post gate, where a
# column that did not exist at the pre-candidate boundary must not move a digest;
# every SAME-CLUSTER fidelity check below asks a different question — did the
# snapshot, the physical restore, the logical restore preserve this cluster? — and
# both of its sides are the same schema at the same instant. Comparing those
# against the projected manifest would make them blind to exactly the columns the
# projection excludes, so a `thumbnail_count` mangled by a bad restore would pass.
# backup_fidelity_data_manifest resolves which one each of them uses; with no
# --data-columns-source there is only one manifest and nothing changes.
if [[ -n "$data_columns_source" ]]; then
  capture_postgres_data "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-data.unprojected.tsv"
fi
fidelity_data_manifest="$(backup_fidelity_data_manifest "$destination")"
# retain-sql keeps the canonical pg_dump text beside each digest line. It is not
# evidence this backup checks against itself — the digest is still the whole of
# every comparison below — but deploy.sh compares THIS manifest against the
# post-candidate backup's, and only the two dumps can tell an additive migration
# from a destructive one. The pre-candidate dump cannot be re-taken once the
# candidate has migrated, so it is kept here or it does not exist.
capture_postgres_schema "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-schema.tsv" retain-sql
keycloak_live="$(docker exec "$postgres" psql -v ON_ERROR_STOP=1 -U "$LEGACY_DATABASE_USER" -d keycloak -Atc "select count(*) from user_entity" | tr -d '[:space:]')"
postgres_image_id="$(docker inspect --format '{{.Image}}' "$postgres")"
[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "active Postgres image is not content-addressed"
printf '%s\n' "$postgres_image_id" >"$destination/postgres-restore-image-id.txt"

# A physical cluster snapshot complements the portable logical dumps. Every
# network client and durable-volume peer is already stopped; now stop the exact
# PostgreSQL container cleanly and prove no RW holder remains before archiving.
postgres_stopped=1
docker stop --time 60 "$postgres" >/dev/null
[[ "$(docker inspect --format '{{.State.Running}}' "$postgres")" == false ]] \
  || fail "PostgreSQL did not stop for its exact volume snapshot"
assert_durable_writers_quiesced "" "$active_attest_dir" "$active_duc_dir"
archive_volume "$PG_VOLUME" postgres-data.tar.gz
if tar -tzf "$destination/postgres-data.tar.gz" | sed 's#^\./##' | grep -qx postmaster.pid; then
  fail "clean PostgreSQL archive unexpectedly contains postmaster.pid"
fi
restart_postgres_strict || fail "PostgreSQL did not recover after its exact volume snapshot"
capture_postgres_security "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-security.after-physical.json"
# Every self-verification capture below is projected onto the columns of the
# FIDELITY manifest — the unprojected one when this backup has both — and not onto
# the live column list. The two sides must be digested over the same columns or
# the comparison answers a question about column lists; taking them over the FULL
# list is what keeps it covering every column rather than only the ones the
# pre-vs-post projection kept. A column that VANISHED breaks the projection and
# fails the capture outright, and the schema manifests beside them are compared
# unprojected and byte-exactly.
capture_postgres_data "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-data.after-physical.tsv" \
  "$fidelity_data_manifest.columns"
capture_postgres_schema "$postgres" "$LEGACY_DATABASE_USER" "$destination/postgres-schema.after-physical.tsv"
cmp -s "$destination/postgres-security.json" "$destination/postgres-security.after-physical.json" \
  || fail "PostgreSQL security state changed across the clean physical snapshot"
cmp -s "$fidelity_data_manifest" "$destination/postgres-data.after-physical.tsv" \
  || fail "PostgreSQL data changed across the clean physical snapshot"
cmp -s "$destination/postgres-schema.tsv" "$destination/postgres-schema.after-physical.tsv" \
  || fail "PostgreSQL schema changed across the clean physical snapshot"
rm -f "$destination/postgres-security.after-physical.json" \
  "$destination/postgres-data.after-physical.tsv" "$destination/postgres-schema.after-physical.tsv"

for archive in cosmos-state center-data prometheus-data grafana-data postgres-data; do
  archive_inventory "$destination/$archive.tar.gz" "$destination/$archive.inventory.json"
done

printf 'attestation\t%s\ndevice-user\t%s\n' "$active_attest_dir" "$active_duc_dir" \
  >"$destination/active-security-roots.tsv"
chmod 600 "$destination/active-security-roots.tsv"
required_protected_paths=(
  "$active_attest_dir"
  "$active_duc_dir"
  /etc/nginx/nginx.conf
  /etc/nginx/sites-available
  /etc/nginx/sites-enabled
  /etc/systemd/system/penumbra-center-bridge.service
  /etc/penumbra
  /var/lib/penumbra-center
)
optional_protected_paths=(
  "$LEGACY_RUNTIME_ENV"
  "$LEGACY_BACKENDS_ENV"
  "$LEGACY_CENTER_ENV"
  "$LEGACY_EDGE_DIR"
  /home/anders/keycloak-themes/humane
  "$PRIVATE_DIR"
  /etc/nginx/conf.d
  /etc/cloudflared
  /home/anders/.cloudflared
)
bridge_inventory() {
  sudo -n python3 - "$1" <<'PY'
import hashlib,json,os,stat,sys
items=[]
for root in ("/etc/penumbra","/var/lib/penumbra-center"):
    if not os.path.lexists(root): continue
    paths=[root]
    if os.path.isdir(root) and not os.path.islink(root):
        for directory,dirs,files in os.walk(root,followlinks=False):
            dirs.sort(); files.sort()
            paths.extend(os.path.join(directory,name) for name in dirs)
            paths.extend(os.path.join(directory,name) for name in files)
    for path in sorted(set(paths)):
        metadata=os.lstat(path); item={"path":path,"mode":oct(stat.S_IMODE(metadata.st_mode)),"uid":metadata.st_uid,"gid":metadata.st_gid,"size":metadata.st_size}
        if stat.S_ISREG(metadata.st_mode):
            digest=hashlib.sha256()
            with open(path,"rb") as source:
                for chunk in iter(lambda:source.read(1024*1024),b""): digest.update(chunk)
            item["sha256"]=digest.hexdigest()
        elif stat.S_ISLNK(metadata.st_mode): item["symlink"]=os.readlink(path)
        items.append(item)
open(sys.argv[1],"w",encoding="utf-8").write(json.dumps(items,sort_keys=True,separators=(",",":")))
PY
  sudo -n chown "$(id -u):$(id -g)" "$1"
  chmod 600 "$1"
}
bridge_inventory "$destination/bridge-inventory.before.json"
: >"$destination/protected.paths"
: >"$destination/protected-presence.tsv"
for path in "${required_protected_paths[@]}"; do
  if ! sudo -n test -e "$path" && ! sudo -n test -L "$path"; then
    fail "required protected path is missing: $path"
  fi
  printf 'required\tpresent\t%s\n' "$path" >>"$destination/protected-presence.tsv"
  printf '%s\n' "${path#/}" >>"$destination/protected.paths"
done
for path in "${optional_protected_paths[@]}"; do
  if sudo -n test -e "$path" || sudo -n test -L "$path"; then
    printf 'optional\tpresent\t%s\n' "$path" >>"$destination/protected-presence.tsv"
    printf '%s\n' "${path#/}" >>"$destination/protected.paths"
  else
    printf 'optional\tabsent\t%s\n' "$path" >>"$destination/protected-presence.tsv"
  fi
done
python3 - "$destination/protected.paths" <<'PY'
import pathlib,sys
path=pathlib.Path(sys.argv[1]); rows=[]
for raw in path.read_text().splitlines():
    value="/"+raw.strip("/")
    if value=="/" or any(ord(char)<32 or ord(char)==127 for char in value): raise SystemExit("unsafe protected path")
    rows.append(value)
selected=[]
for value in sorted(set(rows),key=lambda item:(item.count("/"),item)):
    if any(value==parent or value.startswith(parent+"/") for parent in selected): continue
    selected.append(value)
path.write_text("".join(value.removeprefix("/")+"\n" for value in selected))
PY
[[ -s "$destination/protected.paths" ]] || fail "no protected paths were found"
chmod 600 "$destination/protected.paths" "$destination/protected-presence.tsv"
archive_selected_paths / "$destination/protected.paths" "$destination/protected.tar.gz"
archive_inventory "$destination/protected.tar.gz" "$destination/protected-inventory.json"
# The two CA private keys above are the only content of this backup that cannot
# be regenerated from anything: the attestation root is pinned inside the APKs
# already installed on the Pin. Listing their directories in
# required_protected_paths proves the directories exist, not that the keys are
# inside the archive - an empty or partially readable root archives cleanly and
# passes every inventory comparison below, because those comparisons compare the
# archive with itself. Assert membership and byte equality with the live keys
# here so the failure is loud at backup time rather than at restore time, when
# the source is already gone.
assert_key_material_captured "$destination/protected-inventory.json" \
  "$destination/protected.tar.gz" "$active_attest_dir" "$active_duc_dir"
bridge_inventory "$destination/bridge-inventory.after.json"
cmp -s "$destination/bridge-inventory.before.json" "$destination/bridge-inventory.after.json" \
  || fail "Pin bridge state changed during protected snapshot"
if ((leave_quiesced == 0)); then
  restart_bridge_strict || fail "Pin bridge did not recover after its protected snapshot"
fi

# Restore every named-volume archive into isolated targets and compare complete
# content and root ownership inventories. Center is restored separately into a
# host directory so its bind-root metadata is also proven.
for stem in state prometheus grafana; do
  verify_volumes+=("${verify_scope}-${stem}")
done
for volume in "${verify_volumes[@]}"; do
  docker volume create --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" "$volume" >/dev/null
done
archives=(cosmos-state prometheus-data grafana-data)
for index in 0 1 2; do
  archive="${archives[$index]}"
  volume="${verify_volumes[$index]}"
  docker run --pull=never --rm --name "${verify_scope}-restore-$index" --network none --log-driver none \
    --memory 256m --pids-limit 128 --cpus 1 \
    --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
    -v "$volume:/restore" -v "$destination/$archive.tar.gz:/backup/data.tar.gz:ro" \
    "$HELPER_IMAGE" sh -euc 'tar -xzpf /backup/data.tar.gz -C /restore'
  docker run --pull=never --rm --name "${verify_scope}-inventory-$index" --network none --log-driver none \
    --memory 256m --pids-limit 128 --cpus 1 \
    --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
    -v "$volume:/source:ro" -v "$destination:/backup" "$HELPER_IMAGE" sh -euc \
    "tar -czpf '/backup/${archive}.restored.tar.gz' -C /source . && chown 1000:1000 '/backup/${archive}.restored.tar.gz'"
  archive_inventory "$destination/$archive.restored.tar.gz" "$destination/$archive.restored.inventory.json"
  compare_archive_inventories "$destination/$archive.inventory.json" \
    "$destination/$archive.restored.inventory.json"
  rm -f "$destination/$archive.restored.tar.gz" "$destination/$archive.restored.inventory.json"
done

center_restore="$(mktemp -d)"
sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
  -xzpf "$destination/center-data.tar.gz" -C "$center_restore"
sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
  -czpf "$destination/center-data.restored.tar.gz" -C "$center_restore" .
sudo -n chown "$(id -u):$(id -g)" "$destination/center-data.restored.tar.gz"
archive_inventory "$destination/center-data.restored.tar.gz" "$destination/center-data.restored.inventory.json"
compare_archive_inventories "$destination/center-data.inventory.json" \
  "$destination/center-data.restored.inventory.json"
sudo -n rm -rf -- "$center_restore"
center_restore=""
rm -f "$destination/center-data.restored.tar.gz" "$destination/center-data.restored.inventory.json"

docker volume create --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  "$verify_physical_postgres_volume" >/dev/null
docker run --pull=never --rm --name "${verify_scope}-restore-physical-postgres" --network none --log-driver none \
  --memory 512m --pids-limit 128 --cpus 1 \
  --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  -v "$verify_physical_postgres_volume:/restore" \
  -v "$destination/postgres-data.tar.gz:/backup/data.tar.gz:ro" \
  "$HELPER_IMAGE" sh -euc 'tar -xzpf /backup/data.tar.gz -C /restore'
docker run --pull=never --rm --name "${verify_scope}-inventory-physical-postgres" --network none --log-driver none \
  --memory 512m --pids-limit 128 --cpus 1 \
  --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  -v "$verify_physical_postgres_volume:/source:ro" -v "$destination:/backup" "$HELPER_IMAGE" sh -euc \
  "tar -czpf /backup/postgres-data.restored.tar.gz -C /source . && chown 1000:1000 /backup/postgres-data.restored.tar.gz"
archive_inventory "$destination/postgres-data.restored.tar.gz" "$destination/postgres-data.restored.inventory.json"
compare_archive_inventories "$destination/postgres-data.inventory.json" \
  "$destination/postgres-data.restored.inventory.json"
rm -f "$destination/postgres-data.restored.tar.gz" "$destination/postgres-data.restored.inventory.json"

physical_password="$(openssl rand -hex 32)"
docker run --pull=never --detach --name "$verify_physical_postgres_container" --network none --restart no \
  --memory 1g --pids-limit 256 --cpus 2 --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  --env "POSTGRES_USER=$LEGACY_DATABASE_USER" --env "POSTGRES_PASSWORD=$physical_password" \
  --volume "$verify_physical_postgres_volume:/var/lib/postgresql/data" \
  --health-cmd "pg_isready -U $LEGACY_DATABASE_USER -d postgres" \
  --health-interval 2s --health-timeout 3s --health-start-period 3s --health-retries 45 \
  "$postgres_image_id" >/dev/null
unset physical_password
wait_container_healthy "$verify_physical_postgres_container" \
  || fail "physical PostgreSQL restore did not become healthy"
capture_postgres_security "$verify_physical_postgres_container" "$LEGACY_DATABASE_USER" \
  "$destination/postgres-security.physical-restored.json"
capture_postgres_data "$verify_physical_postgres_container" "$LEGACY_DATABASE_USER" \
  "$destination/postgres-data.physical-restored.tsv" "$fidelity_data_manifest.columns"
capture_postgres_schema "$verify_physical_postgres_container" "$LEGACY_DATABASE_USER" \
  "$destination/postgres-schema.physical-restored.tsv"
cmp -s "$destination/postgres-security.json" "$destination/postgres-security.physical-restored.json" \
  || fail "physical PostgreSQL restore security state differs from the source"
cmp -s "$fidelity_data_manifest" "$destination/postgres-data.physical-restored.tsv" \
  || fail "physical PostgreSQL restore data differs from the source"
cmp -s "$destination/postgres-schema.tsv" "$destination/postgres-schema.physical-restored.tsv" \
  || fail "physical PostgreSQL restore schema differs from the source"
rm -f "$destination/postgres-security.physical-restored.json" \
  "$destination/postgres-data.physical-restored.tsv" "$destination/postgres-schema.physical-restored.tsv"
docker rm --force "$verify_physical_postgres_container" >/dev/null

docker volume create --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  "$verify_postgres_volume" >/dev/null
verify_password="$(openssl rand -hex 32)"
docker run --pull=never --detach --name "$verify_postgres_container" --network none --restart no \
  --memory 1g --pids-limit 256 --cpus 2 --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  --label "dk.andersmadsen.ai-pin-revival.backup-verify=$verify_scope" \
  --env POSTGRES_USER=revival_restore_bootstrap --env POSTGRES_DB=postgres \
  --env "POSTGRES_PASSWORD=$verify_password" \
  --volume "$verify_postgres_volume:/var/lib/postgresql/data" \
  --health-cmd 'pg_isready -U revival_restore_bootstrap -d postgres' \
  --health-interval 2s --health-timeout 3s --health-start-period 3s --health-retries 45 \
  "$postgres_image_id" >/dev/null
unset verify_password
wait_container_healthy "$verify_postgres_container" || fail "blank-cluster restore Postgres did not become healthy"
gunzip -c "$destination/postgres-globals.sql.gz" \
  | docker exec -i "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
gunzip -c "$destination/cosmos.sql.gz" \
  | docker exec -i "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
gunzip -c "$destination/keycloak.sql.gz" \
  | docker exec -i "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
capture_postgres_security "$verify_postgres_container" revival_restore_bootstrap \
  "$destination/postgres-security.restored.json"
cmp -s "$destination/postgres-security.json" "$destination/postgres-security.restored.json" \
  || fail "blank-cluster PostgreSQL roles, owners, or grants differ from the source"
rm -f "$destination/postgres-security.restored.json"
capture_postgres_data "$verify_postgres_container" revival_restore_bootstrap \
  "$destination/postgres-data.restored.tsv" "$fidelity_data_manifest.columns"
cmp -s "$fidelity_data_manifest" "$destination/postgres-data.restored.tsv" \
  || fail "blank-cluster PostgreSQL relation data differs from the source"
rm -f "$destination/postgres-data.restored.tsv"
capture_postgres_schema "$verify_postgres_container" revival_restore_bootstrap \
  "$destination/postgres-schema.restored.tsv"
cmp -s "$destination/postgres-schema.tsv" "$destination/postgres-schema.restored.tsv" \
  || fail "blank-cluster PostgreSQL schema semantics differ from the source"
rm -f "$destination/postgres-schema.restored.tsv"

while IFS=$'\t' read -r key expected; do
  [[ "$key" == db.* ]] || continue
  table="${key#db.}"
  exists="$(docker exec "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
    -U revival_restore_bootstrap -d "$LEGACY_DATABASE_NAME" -Atc "select to_regclass('public.$table') is not null" | tr -d '[:space:]')"
  if [[ "$expected" == -1 ]]; then [[ "$exists" == f ]] || fail "restored database unexpectedly contains $table"; continue; fi
  [[ "$exists" == t ]] || fail "restored database is missing $table"
  actual="$(docker exec "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
    -U revival_restore_bootstrap -d "$LEGACY_DATABASE_NAME" -Atc "select count(*) from $table" | tr -d '[:space:]')"
  [[ "$actual" == "$expected" ]] || fail "restored row count differs for $table"
done <"$destination/invariants.tsv"
keycloak_restored="$(docker exec "$verify_postgres_container" psql -X -v ON_ERROR_STOP=1 \
  -U revival_restore_bootstrap -d keycloak -Atc "select count(*) from user_entity" | tr -d '[:space:]')"
[[ "$keycloak_restored" == "$keycloak_live" ]] || fail "restored Keycloak user count differs from the backup baseline"

protected_restore="$(mktemp -d)"
sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
  -xzpf "$destination/protected.tar.gz" -C "$protected_restore"
archive_selected_paths "$protected_restore" "$destination/protected.paths" \
  "$destination/protected-restored.tar.gz"
archive_inventory "$destination/protected-restored.tar.gz" "$destination/protected-restored.inventory.json"
compare_archive_inventories "$destination/protected-inventory.json" \
  "$destination/protected-restored.inventory.json"
# Re-hash the key material out of the archive that was rebuilt from the restored
# tree, against the live keys. The inventory comparison above proves the two
# descriptions match; this proves the extract-and-rebuild path an operator would
# actually run still yields the exact key bytes, which is the only property the
# device cares about.
assert_key_material_captured "$destination/protected-restored.inventory.json" \
  "$destination/protected-restored.tar.gz" "$active_attest_dir" "$active_duc_dir"
sudo -n rm -rf -- "$protected_restore"
protected_restore=""
rm -f "$destination/protected-restored.tar.gz" "$destination/protected-restored.inventory.json"

cleanup_verify_strict || fail "verified backup left temporary Docker or filesystem objects"
verify_volumes=()
protected_restore=""

if ((leave_quiesced)); then
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$destination/BRIDGE_QUIESCED"
fi
if ((public_ingress_quiesced)); then
  assert_ingress_quiesced \
    || fail "public-ingress-quiesced backup did not retain every exact ingress unit in the stopped state"
  verify_cloudflared_activation_state "$ingress_evidence" "$cloudflared_record" "$cloudflared_state" \
    || fail "Cloudflare route or unit identity drifted during the quiesced backup"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$destination/PUBLIC_INGRESS_QUIESCED"
fi
printf '%s\n' "$backup_id" >"$destination/BACKUP_ID"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$destination/CREATED_AT"
find "$destination" -type d -exec chmod 700 {} +
find "$destination" -type f -exec chmod 600 {} +
write_backup_artifact_manifest "$destination" "$backup_id"
(
  cd "$destination"
  python3 - <<'PY'
import hashlib,os,stat

entries=[]
for directory,dirs,files in os.walk(".",followlinks=False):
    dirs.sort(); files.sort()
    for name in [*dirs,*files]:
        relative=os.path.relpath(os.path.join(directory,name),".")
        if any(ord(char)<32 or ord(char)==127 for char in relative) or "\\" in relative:
            raise SystemExit("backup evidence path contains an unsafe character")
        metadata=os.lstat(relative)
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit("backup evidence must not contain symbolic links")
        if not stat.S_ISDIR(metadata.st_mode) and not stat.S_ISREG(metadata.st_mode):
            raise SystemExit("backup evidence contains a non-regular object")
    for name in files:
        relative=os.path.relpath(os.path.join(directory,name),".")
        if relative=="SHA256SUMS": continue
        digest=hashlib.sha256()
        with open(relative,"rb") as source:
            for chunk in iter(lambda:source.read(1024*1024),b""): digest.update(chunk)
        entries.append((relative,digest.hexdigest()))
entries.sort(key=lambda item:item[0].encode())
with open("SHA256SUMS","w",encoding="utf-8",newline="\n") as output:
    for relative,digest in entries: output.write(f"{digest}  {relative}\n")
PY
  sha256sum -c SHA256SUMS >/dev/null
)
find "$destination" -type d -exec chmod 700 {} +
find "$destination" -type f -exec chmod 600 {} +
verify_backup_artifact_manifest "$destination"

if ((leave_quiesced == 0)); then
  restart_recorded_strict || fail "backup succeeded but recorded containers did not recover"
  quiesced=0
fi

if ((json)); then
  python3 - "$backup_id" "$destination" "$keycloak_restored" <<'PY'
import json,sys
print(json.dumps({"ok":True,"backupId":sys.argv[1],"path":sys.argv[2],"restoreTest":{"keycloakUsers":int(sys.argv[3]),"volumes":5}},separators=(",",":")))
PY
else
  log "backup $backup_id passed full archive and isolated restore verification"
fi
