#!/usr/bin/bash
set -euo pipefail
source "${REVIVAL_HELD_COMMON:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh}"
source "${REVIVAL_HELD_DOMAIN:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/domain.sh}"

target_candidate=""
target_candidate_id=""
pin_local_docker_daemon() {
  local -a inherited=("${!DOCKER_@}")
  local docker_config="$REMOTE_ROOT/private/docker-cli-empty"
  if ((${#inherited[@]} != 0)); then
    [[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock \
      && "${DOCKER_CONFIG:-}" == "$docker_config" \
      && "$(printf '%s\n' "${inherited[@]}" | LC_ALL=C sort)" == $'DOCKER_CONFIG\nDOCKER_HOST' ]] \
      || fail "refusing ambient Docker daemon/config selection: ${inherited[*]}"
  fi
  if [[ ! -e "$docker_config" && ! -L "$docker_config" ]]; then
    mkdir -m 700 -- "$docker_config"
  fi
  [[ -d "$docker_config" && ! -L "$docker_config" \
    && "$(readlink -f -- "$docker_config")" == "$docker_config" \
    && "$(stat -c '%a:%u:%g' "$docker_config")" == "700:$(id -u):$(id -g)" \
    && -z "$(find "$docker_config" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
    || fail "Docker configuration anchor must be an empty owner-owned mode-0700 directory"
  export DOCKER_HOST=unix:///var/run/docker.sock
  export DOCKER_CONFIG="$docker_config"
}
apply_retained_candidate_image_override() {
  [[ "${revival_candidate_authority_required:-0}" == 1 \
    && "${revival_candidate_override_sha256:-}" =~ ^[0-9a-f]{64}$ \
    && "${revival_candidate_authority_receipt_sha256:-}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "rollback retained candidate authority is incomplete"
  "${COMPOSE[@]}" config --quiet
}
read_record_candidate_id() {
  local selected_record="$1" id_file="$1/candidate-id" path_file="$1/candidate-path" selected_id selected_path
  if [[ ! -e "$id_file" && ! -L "$id_file" && ! -e "$path_file" && ! -L "$path_file" ]]; then
    return 1
  fi
  [[ -d "$selected_record" && ! -L "$selected_record" \
    && "$(readlink -f -- "$selected_record")" == "$selected_record" \
    && "$(stat -c '%a:%u:%g' "$selected_record")" == "700:$(id -u):$(id -g)" ]] \
    || fail "candidate deployment record authority is unsafe"
  for evidence in "$id_file" "$path_file"; do
    [[ -f "$evidence" && ! -L "$evidence" \
      && "$(stat -c '%a:%u:%g:%h' "$evidence")" == "600:$(id -u):$(id -g):1" ]] \
      || fail "candidate deployment identity evidence is unsafe"
  done
  selected_id="$(tr -d '\r\n' <"$id_file")"
  selected_path="$(tr -d '\r\n' <"$path_file")"
  [[ "$selected_id" =~ ^[0-9a-f]{64}$ \
    && "$selected_path" == "$REMOTE_ROOT/release-candidates/$selected_id" ]] \
    || fail "candidate deployment identity evidence is inconsistent"
  printf '%s\n' "$selected_id"
}
verify_candidate_release_authority() {
  local helper="$1" selected_record="$2" selected_candidate_id="$3" selected_release_id="$4" output
  release_material_file_is_safe "$helper" || fail "candidate release authority helper is missing"
  output="$(python3 -I "$helper" --root "$REMOTE_ROOT" --candidate-id "$selected_candidate_id" \
    --release-id "$selected_release_id" --record "$selected_record")" \
    || fail "retained candidate refused release/manifest authority"
  node -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||v.releaseId!==process.argv[2]||!["existing","published"].includes(v.state))process.exit(1)' \
    "$output" "$selected_release_id" || fail "candidate release authority returned invalid evidence"
}

deployment_id=""
json=0
usage() { echo "usage: rollback --deployment ID [--json]" >&2; exit 64; }
while (($#)); do
  case "$1" in
    --deployment) (($# >= 2)) || usage; deployment_id="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$deployment_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage

assert_target
assert_remote_root
for command in docker flock node python3 sha256sum systemctl curl readlink openssl pgrep cmp stat find; do need "$command"; done
ensure_layout
pin_local_docker_daemon
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another deployment or backup holds the lock"

record="$DEPLOYMENTS_DIR/$deployment_id"
resuming_operation=0
resuming_pointer_transaction=0
resuming_accepted_transaction=0
authority_transaction_driver="${REVIVAL_HELD_TRANSACTION:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/transaction.py}"
release_material_file_is_safe "$authority_transaction_driver" \
  || fail "global authority transaction helper is missing or unsafe"
inventory_json="$(python3 "$authority_transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
  || fail "global authority transaction inventory is invalid"
pending_identity="$(python3 - "$inventory_json" <<'PY'
import json,sys
body=json.loads(sys.argv[1]); active=body.get("active")
assert body.get("schemaVersion")==1 and isinstance(active,list) and len(active)<=1
print("" if not active else f'{active[0]["namespace"]}\t{active[0]["record"]}')
PY
)"
if [[ -n "$pending_identity" ]]; then
  IFS=$'\t' read -r pending_namespace pending_record <<<"$pending_identity"
  [[ "$pending_namespace" == rollback && "$pending_record" == "$record" ]] \
    || fail "a foreign authority transaction is pending and must be reconciled first"
  [[ ! -f "$record/ROLLBACK_OPERATION_TRANSACTION_PREPARED" \
    || -f "$record/ROLLBACK_OPERATION_TRANSACTION_COMPLETED" \
    || -f "$record/ROLLBACK_OPERATION_TRANSACTION_ABORTED" ]] \
    || resuming_operation=1
  [[ ! -f "$record/ROLLBACK_POINTER_TRANSACTION_PREPARED" ]] \
    || resuming_pointer_transaction=1
  ((resuming_operation || resuming_pointer_transaction)) \
    || fail "rollback inventory returned no recognizable operation authority"
  [[ ! -f "$record/ROLLBACK_INGRESS_ACTIVATED" ]] || resuming_accepted_transaction=1
fi
[[ -d "$record" && ! -L "$record" && -f "$record/SUCCEEDED" && ! -f "$record/MANUAL_ROLLBACK" \
  && -f "$record/INGRESS_ACTIVATED" && -f "$record/POINTER_TRANSACTION_COMMITTED" \
  && -f "$record/release-id" && -f "$record/old-current" && -f "$record/old-current-deployment" \
  && -f "$record/running-images.tsv" && -f "$record/config-digests.tsv" ]] \
  || fail "only an explicit current successful deployment record can be rolled back"
# A durably aborted rollback pointer transaction is final: transaction.py refuses
# to reopen one at all ("transaction was durably aborted"), so prepare_target_commit
# further down cannot succeed for this record no matter what the operator does.
# Refuse it HERE, while nothing has been touched and the EXIT trap is not yet
# installed. The refusal used to be discovered at prepare_target_commit instead,
# by which point rollback_started is already 1 — so a doomed retry fell into
# finish_rollback's recovery arm and paid for its own refusal with a real
# quiesce, container restart, restore and two canaries: a wearer-visible outage
# caused by a command that was never going to proceed. The way forward from an
# aborted rollback is a deploy of the intended release, not a second rollback of
# this record. A resume never lands here: an aborted transaction is not in
# transaction.py's inventory, so nothing above it can have set resuming_*.
if ((resuming_pointer_transaction == 0)) && [[ -f "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED" ]]; then
  fail "this deployment's rollback authority was durably aborted and cannot be reopened"
fi
if ((resuming_pointer_transaction == 0)); then
  current_record="$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment")" \
    || fail "canonical current-deployment pointer is missing"
  [[ "$current_record" == "$record" ]] || fail "requested deployment is not the authoritative current deployment"
fi

current_release_id="$(tr -d '\r\n' <"$record/release-id")"
validate_release_id "$current_release_id"
current_release="$RELEASES_DIR/$current_release_id"
if ((resuming_pointer_transaction == 0)); then
  [[ "$(safe_release_pointer "$REMOTE_ROOT/current")" == "$current_release" ]] \
    || fail "current release and deployment record disagree"
fi
rollback_release_logical_root="${REVIVAL_HELD_RELEASE_LOGICAL_ROOT:-}"
rollback_driver="${BASH_SOURCE[0]}"
rollback_common="${REVIVAL_HELD_COMMON:-}"
rollback_domain="${REVIVAL_HELD_DOMAIN:-}"
rollback_domain_helper="${REVIVAL_HELD_DOMAIN_PY:-}"
[[ "$rollback_release_logical_root" == "$current_release" \
  && "${REVIVAL_HELD_RELEASE_ID:-}" == "$current_release_id" \
  && "${REVIVAL_HELD_EXEC:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
  || fail "rollback driver is stale relative to the locked current release"
current_manifest="$MANIFESTS_DIR/$current_release_id.json"
current_verifier="${REVIVAL_HELD_RELEASE_VERIFIER:-$current_release/platform/deploy/vps/verify-release.py}"
current_release_store="${REVIVAL_HELD_RELEASE_STORE:-$current_release/platform/deploy/vps/remote/release-store.py}"
transaction_driver="${REVIVAL_HELD_TRANSACTION:-$current_release/platform/deploy/vps/remote/transaction.py}"
release_material_file_is_safe "$transaction_driver" \
  || fail "current release transaction helper is missing"
current_candidate_id=""
[[ -e "$record/candidate-id" || -L "$record/candidate-id" \
  || -e "$record/candidate-path" || -L "$record/candidate-path" ]] \
  || fail "rollback requires the current deployment's retained offline candidate"
current_candidate_id="$(read_record_candidate_id "$record")" \
  || fail "current candidate identity evidence could not be read"
current_candidate="$REMOTE_ROOT/release-candidates/$current_candidate_id"
verify_candidate_release_authority "$current_release_store" "$record" \
  "$current_candidate_id" "$current_release_id"
if ((resuming_pointer_transaction)); then
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --reconcile --prepare-only
fi
if ((resuming_operation)); then
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --operation-action verify
fi
if ((resuming_pointer_transaction == 0)); then
  verify_image_evidence "$record/running-images.tsv" "$current_release"
  verify_configuration_evidence "$record/config-digests.tsv" "$current_release"
  [[ -f "$record/CHANNEL_KEY_METADATA_TRANSACTION.json" \
    && -f "$record/CHANNEL_KEY_METADATA_COMMITTED" ]] \
    || fail "current deployment lacks its backup-bound channel-key metadata transaction"
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action verify-desired
  domain_nginx_verify_desired "$record" \
    || fail "current deployment has public Center Nginx drift"
  domain_cloudflared_verify_desired "$record" \
    || fail "current deployment has public Center Cloudflare route drift"
  assert_managed_cloudflared_topology \
    || fail "current deployment is not using the exact allowlisted Cloudflare connectors"
  verify_keycloak_post_migration_evidence "$record" \
    || fail "current deployment has invalid Keycloak migration evidence"
  domain_sudo python3 "$DOMAIN_HELPER" client-check-marker --record "$record" --state applied \
    || fail "current deployment lacks its applied Center Keycloak marker"
fi
verify_exact_carry_security_identity "$record/carry-security-identity.json"

target_release="$(tr -d '\r\n' <"$record/old-current")"
target_record="$(tr -d '\r\n' <"$record/old-current-deployment")"
target_kind=canonical
target_release_id=""
carry_baseline_id=""
if [[ -z "$target_release" && -z "$target_record" ]]; then
  [[ -f "$record/carry-baseline-id" && ! -L "$record/carry-baseline-id" \
    && "$(stat -c '%a:%u:%g:%h' "$record/carry-baseline-id")" == "600:$(id -u):$(id -g):1" ]] \
    || fail "legacy rollback lacks its one-time adopted-live-carry-v1 binding"
  carry_baseline_id="$(tr -d '\r\n' <"$record/carry-baseline-id")"
  [[ "$carry_baseline_id" =~ ^[0-9a-f]{64}$ ]] \
    || fail "legacy rollback baseline identity is invalid"
  current_authority_sha256="$(tr -d '\r\n' <"$record/hosted-vps-authority.sha256")"
  [[ "$current_authority_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || fail "first-cutover deployment authority digest is invalid"
  # This authority is an observation, not a release candidate. It is admitted
  # only when it is bound to the exact current first-cutover candidate and its
  # retained containers are stopped with byte-identical image/config/resource
  # identity. It can never enter the normal canonical target branch below.
  verify_adopted_live_carry "$carry_baseline_id" stopped \
    "$current_candidate_id" "$current_release_id" "$current_authority_sha256" \
    || fail "retained Carry predecessor differs from its sealed first-cutover authority"
  [[ -f "$record/before/running-containers.txt" \
    && -f "$record/before/running-identities.tsv" \
    && -f "$record/before/mounts.tsv" \
    && -f "$record/before/semantic-baseline.tsv" ]] \
    || fail "legacy rollback lacks its exact first-cutover application evidence"
  target_kind=legacy
elif [[ -z "$target_release" || -z "$target_record" ]]; then
  fail "recorded rollback lineage is internally inconsistent"
else
  [[ "$target_release" == "$RELEASES_DIR/"* && -d "$target_release" && ! -L "$target_release" \
    && "$(readlink -f -- "$target_release")" == "$target_release" ]] || fail "recorded target release is unsafe or missing"
  [[ "$target_record" == "$DEPLOYMENTS_DIR/"* && -d "$target_record" && ! -L "$target_record" \
    && "$(readlink -f -- "$target_record")" == "$target_record" ]] || fail "recorded target deployment is unsafe or missing"
  [[ -f "$target_record/SUCCEEDED" && ! -f "$target_record/MANUAL_ROLLBACK" \
    && -f "$target_record/INGRESS_ACTIVATED" && -f "$target_record/POINTER_TRANSACTION_COMMITTED" \
    && -f "$target_record/release-id" && -f "$target_record/running-images.tsv" \
    && -f "$target_record/config-digests.tsv" ]] || fail "target deployment evidence is incomplete"
  target_release_id="$(basename "$target_release")"
  validate_release_id "$target_release_id"
  [[ "$(tr -d '\r\n' <"$target_record/release-id")" == "$target_release_id" ]] \
    || fail "target release and deployment evidence disagree"

  [[ -e "$target_record/candidate-id" || -L "$target_record/candidate-id" \
    || -e "$target_record/candidate-path" || -L "$target_record/candidate-path" ]] \
    || fail "rollback target has no retained offline candidate bundle"
  target_candidate_id="$(read_record_candidate_id "$target_record")" \
    || fail "target candidate identity evidence could not be read"
  target_candidate="$REMOTE_ROOT/release-candidates/$target_candidate_id"
  [[ "$target_candidate_id" =~ ^[0-9a-f]{64}$ \
    && -d "$target_candidate" && ! -L "$target_candidate" \
    && -f "$target_candidate/images.tar" && ! -L "$target_candidate/images.tar" \
    && -f "$target_candidate/image-receipt.json" && ! -L "$target_candidate/image-receipt.json" ]] \
    || fail "target candidate rollback bundle is unsafe or incomplete"
  [[ "${REVIVAL_HELD_CANDIDATE_VERIFIER:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
    || fail "current release lacks its trusted candidate verifier"
  target_candidate_verification="$(run_held_candidate_verifier verify --candidate "$target_candidate" --expect-id "$target_candidate_id" --json)" \
    || fail "target candidate failed filesystem-only rollback verification"
  node -e 'const value=JSON.parse(process.argv[1]);if(value.ok!==true||value.candidateId!==process.argv[2]||value.releaseId!==process.argv[3]||value.productionCompatible!==true)process.exit(1)' \
    "$target_candidate_verification" "$target_candidate_id" "$target_release_id" \
    || fail "target candidate does not bind the requested rollback release and Carry contract"
  verify_candidate_release_authority "$current_release_store" "$target_record" \
    "$target_candidate_id" "$target_release_id"
  verify_exact_carry_security_identity "$target_record/carry-security-identity.json"
  cmp -s "$record/carry-security-identity.json" "$target_record/carry-security-identity.json" \
    || fail "canonical rollback records disagree about the immutable Carry security identity"
fi
target_center_domain=0
if [[ "$target_kind" == canonical \
    && -f "$target_record/domain-cutover/keycloak/APPLIED.json" ]]; then
  target_center_domain=1
fi
target_cloudflared_record="$record"
target_cloudflared_state=before
if ((target_center_domain)); then
  target_cloudflared_record="$target_record"
  target_cloudflared_state=desired
fi
target_origin_args=()
((target_center_domain)) || target_origin_args+=(--legacy-dashboard-origin)
validate_nginx_transaction_snapshot "$record" 1 || fail "target Nginx rollback snapshot is incomplete"
[[ -f "$record/public-edge-discovery.json" ]] \
  || fail "target Center domain discovery evidence is missing"
domain_sudo python3 "$DOMAIN_HELPER" nginx-snapshot --record "$record" \
  --discovery "$record/public-edge-discovery.json" \
  || fail "target Center Nginx rollback snapshot is incomplete"

managed_names=(runtime.env cosmos.env providers.env center.env edge-envoy.yaml spotify-token)
managed_paths=("$RUNTIME_ENV" "$COSMOS_ENV" "$PROVIDER_ENV" "$CENTER_ENV" "$PRIVATE_DIR/edge/envoy.yaml" "$PRIVATE_DIR/spotify-adapter/token")

validate_config_snapshot() {
  local snapshot="$1"
  python3 - "$snapshot" "${managed_names[@]}" -- "${managed_paths[@]}" <<'PY'
import hashlib,os,stat,sys
root=sys.argv[1]; marker=sys.argv.index("--"); names=sys.argv[2:marker]; paths=sys.argv[marker+1:]
assert len(names)==len(paths)==6
rows={}
for raw in open(os.path.join(root,"presence.tsv"),encoding="utf-8"):
    fields=raw.rstrip("\n").split("\t"); assert len(fields)==6
    state,name,path,mode,owner,digest=fields; assert name not in rows
    rows[name]=(state,path,mode,owner,digest)
assert set(rows)==set(names)
for name,path in zip(names,paths):
    state,recorded_path,mode,owner,digest=rows[name]; assert recorded_path==path
    saved=os.path.join(root,name)
    if state=="absent":
        assert (mode,owner,digest)==("-","-","-") and not os.path.lexists(saved)
        continue
    assert state=="present" and os.path.isfile(saved) and not os.path.islink(saved)
    meta=os.stat(saved); actual_owner=f"{meta.st_uid}:{meta.st_gid}"
    assert format(stat.S_IMODE(meta.st_mode),"o")==mode and actual_owner==owner
    assert hashlib.sha256(open(saved,"rb").read()).hexdigest()==digest
PY
}

snapshot_current_config() {
  local snapshot="$1" index name path
  mkdir -p "$snapshot"
  chmod 700 "$snapshot"
  : >"$snapshot/presence.tsv"
  for index in "${!managed_names[@]}"; do
    name="${managed_names[$index]}"; path="${managed_paths[$index]}"
    if [[ -f "$path" && ! -L "$path" ]]; then
      cp -a -- "$path" "$snapshot/$name"
      printf 'present\t%s\t%s\t%s\t%s\t%s\n' "$name" "$path" \
        "$(stat -c '%a' "$path")" "$(stat -c '%u:%g' "$path")" \
        "$(sha256sum "$path" | awk '{print $1}')" >>"$snapshot/presence.tsv"
    elif [[ ! -e "$path" && ! -L "$path" ]]; then
      printf 'absent\t%s\t%s\t-\t-\t-\n' "$name" "$path" >>"$snapshot/presence.tsv"
    else
      return 1
    fi
  done
  chmod 600 "$snapshot/presence.tsv"
  validate_config_snapshot "$snapshot"
}

restore_config_snapshot() {
  local snapshot="$1" state name path mode owner digest parent temporary
  validate_config_snapshot "$snapshot" || return 1
  while IFS=$'\t' read -r state name path mode owner digest; do
    parent="$(dirname -- "$path")"; mkdir -p -- "$parent"
    if [[ "$state" == present ]]; then
      temporary="$(mktemp "$parent/.rollback.XXXXXX")"
      cp -a -- "$snapshot/$name" "$temporary" || { rm -f -- "$temporary"; return 1; }
      [[ "$(stat -c '%a' "$temporary")" == "$mode" \
        && "$(stat -c '%u:%g' "$temporary")" == "$owner" \
        && "$(sha256sum "$temporary" | awk '{print $1}')" == "$digest" ]] \
        || { rm -f -- "$temporary"; return 1; }
      mv -f -- "$temporary" "$path" || return 1
    else
      rm -f -- "$path" || return 1
    fi
  done <"$snapshot/presence.tsv"
  validate_config_snapshot "$snapshot" || return 1
  while IFS=$'\t' read -r state name path mode owner digest; do
    if [[ "$state" == present ]]; then
      [[ -f "$path" && ! -L "$path" && "$(stat -c '%a' "$path")" == "$mode" \
        && "$(stat -c '%u:%g' "$path")" == "$owner" \
        && "$(sha256sum "$path" | awk '{print $1}')" == "$digest" ]] || return 1
    else
      [[ ! -e "$path" && ! -L "$path" ]] || return 1
    fi
  done <"$snapshot/presence.tsv"
}

snapshot_current_nginx() {
  local destination="$1" staging manifest label path filename type live_identity saved_identity
  mkdir -p "$destination/nginx-install"
  chmod 700 "$destination/nginx-install"
  staging="$(mktemp -d "$destination/nginx-install/.snapshot.XXXXXX")"
  manifest="$staging/PRESENCE.COMPLETE"
  printf 'schema\tai-pin-revival-nginx-presence-v1\n' >"$manifest"
  while IFS=$'\t' read -r label path filename; do
    type="$(nginx_snapshot_object_type "$path")" || return 1
    printf '%s.target\t%s\n' "$label" "$path" >>"$manifest"
    if [[ "$type" == absent ]]; then
      printf '%s.present\t0\n%s.type\tabsent\n%s.snapshot\t-\n%s.identity_sha256\t-\n' \
        "$label" "$label" "$label" "$label" >>"$manifest"
    else
      sudo -n cp -a -- "$path" "$staging/$filename" || return 1
      live_identity="$(nginx_snapshot_object_identity "$path" "$type")" || return 1
      saved_identity="$(nginx_snapshot_object_identity "$staging/$filename" "$type")" || return 1
      [[ "$live_identity" == "$saved_identity" ]] || return 1
      printf '%s.present\t1\n%s.type\t%s\n%s.snapshot\t%s\n%s.identity_sha256\t%s\n' \
        "$label" "$label" "$type" "$label" "$filename" "$label" "$saved_identity" >>"$manifest"
    fi
  done <<'EOF'
available	/etc/nginx/sites-available/ai-pin-revival-connectivity	available.before
enabled	/etc/nginx/sites-enabled/ai-pin-revival-connectivity	enabled.before
EOF
  printf 'complete\t1\n' >>"$manifest"
  chmod 400 "$manifest"
  mv -- "$staging" "$destination/nginx-install/snapshot"
  validate_nginx_transaction_snapshot "$destination" 0
}

verify_target_images_for_compose() {
  local evidence="$1"
  python3 - "$evidence" 3< <("${COMPOSE[@]}" config --format json) <<'PY'
import json,os,subprocess,sys
expected={}; image_ids={}
docker_env={"DOCKER_CONFIG":"/home/anders/ai-pin-revival/private/docker-cli-empty",
            "DOCKER_HOST":"unix:///var/run/docker.sock","HOME":"/nonexistent",
            "LANG":"C.UTF-8","LC_ALL":"C.UTF-8","PATH":"/usr/bin:/usr/sbin","TZ":"UTC"}
for number,line in enumerate(open(sys.argv[1],encoding="utf-8"),1):
    fields=line.rstrip("\n").split("\t"); assert len(fields)>=3 and all(fields[:3])
    service,image,image_id=fields[:3]; assert service not in expected
    expected[service]=(image,image_id)
    if image in image_ids: assert image_ids[image]==image_id
    image_ids[image]=image_id
with os.fdopen(3,encoding="utf-8") as rendered: model=json.load(rendered)
services=model.get("services") or {}
assert set(services)==set(expected)
for service,(image,image_id) in expected.items(): assert services[service].get("image")==image
for image,image_id in image_ids.items():
    actual=subprocess.check_output(["/usr/bin/docker","image","inspect","--format","{{.Id}}",image],
                                   text=True,env=docker_env).strip()
    assert actual==image_id
PY
}

target_config="$record/config-before"
validate_config_snapshot "$target_config" || fail "target protected configuration snapshot is invalid"
if [[ "$target_kind" == canonical ]]; then
  load_compose_command_with_env "$target_release" "$target_config/runtime.env" "$target_config/cosmos.env" \
    "$target_config/providers.env" "$target_config/center.env"
  activate_retained_candidate_authority "$target_release" "$target_record" "$record" \
    rollback-candidate "$target_config/runtime.env" "$target_config/cosmos.env" \
    "$target_config/providers.env" "$target_config/center.env" \
    || fail "rollback target candidate/model authority could not be activated"
  [[ "$(docker image inspect --format '{{.Id}}' "$HELPER_IMAGE")" == "$HELPER_IMAGE" ]] \
    || fail "rollback helper image has no exact loaded local candidate binding"
  apply_retained_candidate_image_override
  "${COMPOSE[@]}" config --quiet
  assert_compose_ports
  verify_target_images_for_compose "$target_record/running-images.tsv"
  target_rendered_digest="$("${COMPOSE[@]}" config --format json \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")))' \
    | sha256sum | awk '{print $1}')"
  python3 - "$target_record/config-digests.tsv" "$target_rendered_digest" <<'PY'
import re,sys
matches=[]
for number,raw in enumerate(open(sys.argv[1],encoding="utf-8"),1):
    fields=raw.rstrip("\n").split("\t")
    if len(fields)!=5: raise SystemExit(f"malformed target configuration evidence at line {number}")
    if fields[:2]==["rendered","compose.json"]: matches.append(fields[2])
assert len(matches)==1 and re.fullmatch(r"[0-9a-f]{64}",matches[0]) and matches[0]==sys.argv[2]
PY
  python3 - "$record/config-digests.tsv" "$target_record/config-digests.tsv" <<'PY'
import sys
def protected(path):
    rows={}
    for line in open(path,encoding="utf-8"):
        fields=line.rstrip("\n").split("\t")
        if len(fields)>=3 and fields[0]=="protected": rows[fields[1]]=fields[2]
    return rows
current,target=protected(sys.argv[1]),protected(sys.argv[2])
for mutable in ("edge.security","bridge.state"):
    current.pop(mutable,None); target.pop(mutable,None)
assert current and current==target
PY
  target_edge_digest="$(awk -F '\t' '$1=="protected" && $2=="edge.security" {print $3}' "$target_record/config-digests.tsv")"
  [[ "$target_edge_digest" =~ ^[0-9a-f]{64}$ ]] || fail "target edge security evidence is missing"
  sudo -n python3 - "$PRIVATE_DIR/edge" "$target_config/edge-envoy.yaml" "$target_edge_digest" <<'PY'
import hashlib,os,stat,sys
root,old_envoy=map(os.path.abspath,sys.argv[1:3]); expected=sys.argv[3]
digest=hashlib.sha256()
def add(value):
    data=value if isinstance(value,bytes) else str(value).encode()
    digest.update(len(data).to_bytes(8,"big")); digest.update(data)
def visit(path,relative):
    source=old_envoy if relative=="./envoy.yaml" else path
    metadata=os.lstat(source); mode=metadata.st_mode
    add(relative); add(stat.S_IFMT(mode)); add(stat.S_IMODE(mode)); add(metadata.st_uid); add(metadata.st_gid)
    if stat.S_ISREG(mode):
        add(metadata.st_size)
        with open(source,"rb") as handle:
            while chunk:=handle.read(1024*1024): digest.update(chunk)
    elif stat.S_ISLNK(mode): add(os.readlink(source))
    elif stat.S_ISDIR(mode):
        for name in sorted(os.listdir(path)): visit(os.path.join(path,name),os.path.join(relative,name))
    else: raise SystemExit("unsupported target edge object")
visit(root,".")
assert digest.hexdigest()==expected
PY
  python3 - "$target_config" "$record/nginx-install/snapshot" "$target_record/config-digests.tsv" <<'PY'
import hashlib,os,stat,sys
config,nginx,evidence_path=sys.argv[1:]
evidence={}
for raw in open(evidence_path,encoding="utf-8"):
    fields=raw.rstrip("\n").split("\t")
    if len(fields)==5: evidence[(fields[0],fields[1])]=tuple(fields[2:])
names={
    "runtime.env":"runtime.env","cosmos.env":"cosmos.env","providers.env":"providers.env",
    "center.env":"center.env","edge-envoy.yaml":"edge.envoy","spotify-token":"spotify.token",
}
for filename,label in names.items():
    path=os.path.join(config,filename); metadata=os.lstat(path)
    assert stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
    actual=(hashlib.sha256(open(path,"rb").read()).hexdigest(),f"{stat.S_IMODE(metadata.st_mode):o}",f"{metadata.st_uid}:{metadata.st_gid}")
    assert evidence.get(("file",label))==actual
available=os.path.join(nginx,"available.before"); metadata=os.lstat(available)
assert stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
actual=(hashlib.sha256(open(available,"rb").read()).hexdigest(),f"{stat.S_IMODE(metadata.st_mode):o}",f"{metadata.st_uid}:{metadata.st_gid}")
assert evidence.get(("file","nginx.connectivity"))==actual
enabled=os.path.join(nginx,"enabled.before"); metadata=os.lstat(enabled)
assert stat.S_ISLNK(metadata.st_mode)
actual=(hashlib.sha256((os.readlink(enabled)+"\n").encode()).hexdigest(),f"{stat.S_IMODE(metadata.st_mode):o}",f"{metadata.st_uid}:{metadata.st_gid}")
assert evidence.get(("symlink","nginx.enabled"))==actual
PY
fi

if ((resuming_pointer_transaction)); then
  [[ -f "$record/ROLLBACK_POINTER_TRANSACTION.json" && ! -L "$record/ROLLBACK_POINTER_TRANSACTION.json" ]] \
    || fail "rollback resume journal is unsafe"
  previous_pointer="$(python3 - "$record/ROLLBACK_POINTER_TRANSACTION.json" "$record" <<'PY'
import json,sys
path,record=sys.argv[1:]; body=json.load(open(path,encoding="utf-8"))
assert body.get("schemaVersion")==1 and body.get("namespace")=="rollback" and body.get("record")==record
value=body.get("oldPrevious"); assert isinstance(value,str); print(value)
PY
)"
else
  previous_pointer="$(safe_release_pointer "$REMOTE_ROOT/previous" 2>/dev/null || true)"
fi
work_pointer="$record/rollback-active-work"
if ((resuming_pointer_transaction)); then
  [[ -f "$work_pointer" && ! -L "$work_pointer" ]] || fail "rollback resume lacks its durable work pointer"
  work="$(tr -d '\r\n' <"$work_pointer")"
  [[ "$work" == "$record/manual-rollback-"* && -d "$work" && ! -L "$work" \
    && "$(readlink -f -- "$work")" == "$work" ]] || fail "rollback work pointer is unsafe"
  validate_config_snapshot "$work/current-config" || fail "rollback resume lost the exact current configuration snapshot"
  validate_nginx_transaction_snapshot "$work" 0 || fail "rollback resume lost the exact current Nginx snapshot"
else
  work="$record/manual-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
  mkdir -p "$work"
  chmod 700 "$work"
  printf '%s\n' "$work" >"$work_pointer.tmp"
  chmod 600 "$work_pointer.tmp"
  mv "$work_pointer.tmp" "$work_pointer"
  sync -f "$work_pointer"
  : >"$work/executing-code.tsv"
  for spec in "remote.rollback:$rollback_driver" "remote.common:$rollback_common" \
    "remote.domain:$rollback_domain" "remote.domain-helper:$rollback_domain_helper" \
    "release.verifier:$current_verifier"; do
    label="${spec%%:*}"; path="${spec#*:}"
    release_material_file_is_safe "$path" || fail "executing rollback material is missing or unsafe: $label"
    printf '%s\t%s\t%s\n' "$label" "$(sha256sum "$path" | awk '{print $1}')" "$(stat -Lc '%a' "$path")" \
      >>"$work/executing-code.tsv"
  done
  for common_name in paths ingress release_transactions configuration compose backup database canary drift; do
    common_key="REVIVAL_HELD_COMMON_LIB_${common_name^^}"
    common_key="${common_key//-/_}"
    common_lib="${!common_key:-}"
    release_material_file_is_safe "$common_lib" || fail "common library material is missing or unsafe"
    printf 'remote.common-lib.%s.sh\t%s\t%s\n' "$common_name" \
      "$(sha256sum "$common_lib" | awk '{print $1}')" "$(stat -Lc '%a' "$common_lib")" \
      >>"$work/executing-code.tsv"
  done
  chmod 600 "$work/executing-code.tsv"
  snapshot_current_config "$work/current-config" || fail "could not snapshot exact current protected configuration"
  snapshot_current_nginx "$work" || fail "could not snapshot exact current Nginx state"
fi

rollback_started=0
pointers_changed=0
rollback_committed=0
target_committed=0
fresh_backup=""
target_stage=""
ingress_evidence="$work/ingress-active.tsv"
ingress_quiesced=0
live_cloudflared_record="$record"
live_cloudflared_state=desired
if ((resuming_pointer_transaction)); then
  target_route_matches=0
  if [[ "$target_cloudflared_state" == desired ]]; then
    domain_cloudflared_verify_desired "$target_cloudflared_record" >/dev/null 2>&1 && target_route_matches=1
  else
    domain_cloudflared_verify_before "$target_cloudflared_record" >/dev/null 2>&1 && target_route_matches=1
  fi
  if ((target_route_matches)); then
    live_cloudflared_record="$target_cloudflared_record"
    live_cloudflared_state="$target_cloudflared_state"
  elif ! domain_cloudflared_verify_desired "$record" >/dev/null 2>&1; then
    fail "rollback resume cannot bind the live Cloudflare route to current or target authority"
  fi
fi
owner_canary_cookie="$work/owner-canary.cookies"
cleanup_work_secrets() {
  # Both paths are derived from $work, never from the late-bound $target_stage
  # variable, so every resume disposition reaches the same cleanup.  Security
  # roots never enter this tree: only copied environment/theme/token rehearsal
  # material may be present.
  [[ ! -e "$work/current-config" ]] || rm -rf -- "$work/current-config"
  if [[ -e "$work/target-stage" ]]; then sudo -n rm -rf -- "$work/target-stage"; fi
  rm -f -- "$owner_canary_cookie"
}
restore_pointer() {
  local name="$1" target="$2"
  if [[ -n "$target" ]]; then
    ln -sfn "$target" "$REMOTE_ROOT/.${name}.rollback-tmp"
    mv -Tf "$REMOTE_ROOT/.${name}.rollback-tmp" "$REMOTE_ROOT/$name"
  else
    rm -f -- "$REMOTE_ROOT/$name"
  fi
}
complete_target_commit() {
  if [[ "$target_kind" == canonical ]]; then
    desired_current="$target_release"
    desired_deployment="$target_record"
  else
    desired_current=""
    desired_deployment=""
  fi
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" --namespace rollback \
    --old-current "$current_release" --old-previous "$previous_pointer" \
    --old-current-deployment "$record" --desired-current "$desired_current" \
    --desired-previous "$current_release" --desired-current-deployment "$desired_deployment" || return 1
  [[ -f "$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED" ]] || return 1
  if [[ "$target_kind" == canonical ]]; then
    [[ "$(safe_release_pointer "$REMOTE_ROOT/current")" == "$target_release" \
      && "$(safe_deployment_pointer "$REMOTE_ROOT/current-deployment")" == "$target_record" ]] || return 1
  else
    [[ ! -e "$REMOTE_ROOT/current" && ! -L "$REMOTE_ROOT/current" \
      && ! -e "$REMOTE_ROOT/current-deployment" && ! -L "$REMOTE_ROOT/current-deployment" ]] || return 1
  fi
  if [[ ! -f "$record/ROLLBACK_APPLICATION_COMMITTED" ]]; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_APPLICATION_COMMITTED" || return 1
    chmod 600 "$record/ROLLBACK_APPLICATION_COMMITTED" || return 1
  fi
  sync -f "$record/ROLLBACK_APPLICATION_COMMITTED"
}

prepare_target_commit() {
  if [[ "$target_kind" == canonical ]]; then
    desired_current="$target_release"; desired_deployment="$target_record"
  else
    desired_current=""; desired_deployment=""
  fi
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" --namespace rollback \
    --old-current "$current_release" --old-previous "$previous_pointer" \
    --old-current-deployment "$record" --desired-current "$desired_current" \
    --desired-previous "$current_release" --desired-current-deployment "$desired_deployment" --prepare-only
}

target_keycloak_runtime() {
  if [[ -f "$target_config/runtime.env" ]]; then
    printf '%s\n' "$target_config/runtime.env"
  else
    printf '%s\n' "$work/current-config/runtime.env"
  fi
}

verify_target_domain_state() {
  local runtime request_host
  runtime="$(target_keycloak_runtime)" || return 1
  if ((target_center_domain)); then
    domain_nginx_verify_desired "$target_record" || return 1
    domain_cloudflared_verify_desired "$target_record" || return 1
    domain_keycloak_verify_desired "$target_record" "$runtime" 8088 center.andersmadsen.dk
  else
    domain_nginx_verify_before "$record" || return 1
    domain_cloudflared_verify_before "$record" || return 1
    domain_keycloak_verify_before "$record" "$runtime" 8088 carry.andersmadsen.dk
  fi
}

restore_target_keycloak_state() {
  local runtime request_host
  runtime="$(target_keycloak_runtime)" || return 1
  request_host=carry.andersmadsen.dk
  ((target_center_domain == 0)) || request_host=center.andersmadsen.dk
  domain_keycloak_wait 8088 "$request_host" || return 1
  domain_keycloak_restore "$record" "$runtime" 8088 "$request_host" || return 1
  verify_target_domain_state
}

reprove_target_acceptance() {
  local accepted_ingress="$record/rollback-ingress-active.tsv"
  local cookie="$record/.rollback-finish.cookies" canary_args status
  [[ -f "$record/ROLLBACK_INGRESS_ACTIVATED" ]] || return 1
  validate_ingress_evidence "$accepted_ingress" || return 1
  assert_ingress_matches_recorded "$accepted_ingress" || return 1
  verify_target_domain_state || return 1
  if [[ "$target_kind" == canonical ]]; then
    [[ -f "$record/rollback-target-config-evidence.tsv" ]] || return 1
    verify_image_evidence "$target_record/running-images.tsv" "$target_release" || return 1
    verify_configuration_evidence "$record/rollback-target-config-evidence.tsv" "$target_release" || return 1
    write_owner_canary_cookie "$target_release" "$cookie" || return 1
    canary_args=(--release-id "$target_release_id" --image-evidence "$target_record/running-images.tsv" \
      --require-remote-tts --require-owner-spotify --cookie-file "$cookie")
    ((target_center_domain)) || canary_args+=(--legacy-dashboard-origin)
    [[ -z "$fresh_backup" || ! -f "$fresh_backup/invariants.tsv" ]] || canary_args+=(--baseline "$fresh_backup")
    run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 "${canary_args[@]}" >/dev/null
    status=$?
    rm -f -- "$cookie"
    ((status == 0)) || return 1
  else
    verify_legacy_application "$record/before" || return 1
  fi
  assert_ingress_matches_recorded "$accepted_ingress"
}

if ((resuming_accepted_transaction)); then
  resume_ingress="$record/rollback-ingress-active.tsv"
  resume_cookie="$record/.rollback-resume.cookies"
  validate_ingress_evidence "$resume_ingress" \
    || fail "rollback pointer transaction lacks an exact ingress snapshot"
  assert_ingress_matches_recorded "$resume_ingress" \
    || fail "rollback target ingress no longer matches its accepted state"
  expected_desired_release="$target_release"
  expected_desired_record="$target_record"
  [[ "$target_kind" == canonical ]] || { expected_desired_release=""; expected_desired_record=""; }
  [[ -f "$record/ROLLBACK_POINTER_TRANSACTION.json" && ! -L "$record/ROLLBACK_POINTER_TRANSACTION.json" ]] \
    || fail "rollback pointer transaction journal is unsafe"
  python3 - "$record/ROLLBACK_POINTER_TRANSACTION.json" "$record" \
    "$expected_desired_release" "$expected_desired_record" "$current_release" <<'PY'
import json,sys
path,record,desired_release,desired_record,current_release=sys.argv[1:]
body=json.load(open(path,encoding="utf-8"))
assert body.get("schemaVersion")==1 and body.get("namespace")=="rollback" and body.get("record")==record
assert body.get("oldCurrent")==current_release and body.get("oldCurrentDeployment")==record
assert body.get("desiredCurrent")==desired_release and body.get("desiredCurrentDeployment")==desired_record
assert body.get("desiredPrevious")==current_release
PY
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action restore
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action verify-old
  verify_target_domain_state \
    || fail "accepted rollback target domain state drifted"
  if [[ "$target_kind" == canonical ]]; then
    [[ -f "$record/rollback-target-config-evidence.tsv" ]] \
      || fail "rollback target configuration acceptance evidence is missing"
    verify_image_evidence "$target_record/running-images.tsv" "$target_release"
    verify_configuration_evidence "$record/rollback-target-config-evidence.tsv" "$target_release"
    write_owner_canary_cookie "$target_release" "$resume_cookie"
    resume_canary=(--release-id "$target_release_id" \
      --image-evidence "$target_record/running-images.tsv" --require-remote-tts \
      --require-owner-spotify --cookie-file "$resume_cookie")
    ((target_center_domain)) || resume_canary+=(--legacy-dashboard-origin)
    run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 "${resume_canary[@]}"
  else
    verify_legacy_application "$record/before" \
      || fail "accepted legacy rollback target no longer matches its recorded application"
  fi
  assert_ingress_matches_recorded "$resume_ingress" \
    || fail "rollback target ingress changed during resumed acceptance"
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --reconcile
  if [[ ! -f "$record/ROLLBACK_APPLICATION_COMMITTED" ]]; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_APPLICATION_COMMITTED.tmp"
    chmod 600 "$record/ROLLBACK_APPLICATION_COMMITTED.tmp"
    mv "$record/ROLLBACK_APPLICATION_COMMITTED.tmp" "$record/ROLLBACK_APPLICATION_COMMITTED"
    sync -f "$record/ROLLBACK_APPLICATION_COMMITTED"
  fi
  if [[ ! -f "$record/MANUAL_ROLLBACK" ]]; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/MANUAL_ROLLBACK.tmp"
    chmod 600 "$record/MANUAL_ROLLBACK.tmp"
    mv "$record/MANUAL_ROLLBACK.tmp" "$record/MANUAL_ROLLBACK"
    sync -f "$record/MANUAL_ROLLBACK"
  fi
  if [[ -f "$record/ROLLBACK_OPERATION_TRANSACTION_PREPARED" ]]; then
    python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
      --namespace rollback --operation-action complete
  fi
  rm -f -- "$resume_cookie"
  cleanup_work_secrets
  target_label="$target_release_id"; [[ "$target_kind" == canonical ]] || target_label=legacy
  if ((json)); then
    python3 - "$deployment_id" "$target_label" "$target_kind" <<'PY'
import json,sys
print(json.dumps({"ok":True,"deploymentId":sys.argv[1],"target":sys.argv[2],"targetKind":sys.argv[3],"resumed":True,"databaseRestored":False},separators=(",",":")))
PY
  else
    log "completed interrupted rollback of deployment $deployment_id to $target_kind target $target_label"
  fi
  exit 0
fi

finish_rollback() {
  local status=$? recovery_ok=1 operation_terminal=0
  # Same disposition rules as deploy.sh's finish_reconcile, and for the same
  # reason: this handler restores public ingress and can run for minutes, over a
  # plain ssh. `trap - EXIT HUP INT TERM` restored the DEFAULT (terminate) for the
  # three signals, so a dropped connection killed the restore mid-flight; and the
  # handler's own warnings write to that same dead channel, which raises SIGPIPE.
  # The signals are installed BEFORE EXIT is cleared so nothing lands in the gap,
  # and they are trapped to commands rather than to '' — SIG_IGN survives execve
  # and would make this handler's docker and systemctl children unkillable.
  #
  # This path has no reopen fallback of its own, so being killed part-way is the
  # whole outage: there is nothing downstream to bring the edge back.
  trap 'warn "signal received while the rollback is restoring public ingress; finishing the restore first"' HUP INT TERM
  trap ':' PIPE
  trap - EXIT
  [[ ! -f "$record/MANUAL_ROLLBACK" ]] || rollback_committed=1
  [[ ! -f "$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED" ]] || target_committed=1
  if [[ -f "$record/ROLLBACK_POINTER_TRANSACTION_PREPARED" \
    && -f "$record/ROLLBACK_INGRESS_ACTIVATED" && ! -f "$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED" ]]; then
    if reprove_target_acceptance && complete_target_commit; then target_committed=1; else status=1; fi
  fi
  if ((target_committed || rollback_committed)); then
    assert_ingress_matches_recorded "$ingress_evidence" || status=1
    verify_target_domain_state || status=1
    if ((status == 0)) && [[ ! -f "$record/MANUAL_ROLLBACK" ]]; then
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/MANUAL_ROLLBACK.tmp" || status=1
      chmod 600 "$record/MANUAL_ROLLBACK.tmp" || status=1
      if ((status == 0)); then mv "$record/MANUAL_ROLLBACK.tmp" "$record/MANUAL_ROLLBACK" || status=1; fi
    fi
    if ((status == 0)) && [[ -f "$record/ROLLBACK_OPERATION_TRANSACTION_PREPARED" \
        && ! -f "$record/ROLLBACK_OPERATION_TRANSACTION_COMPLETED" ]]; then
      python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
        --namespace rollback --operation-action complete || status=1
    fi
    if ((status != 0 && rollback_committed == 0)); then
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_ACTIVATION_FAILED"
      chmod 600 "$record/ROLLBACK_ACTIVATION_FAILED"
    fi
    if [[ ! -f "$record/ROLLBACK_OPERATION_TRANSACTION_PREPARED" \
        || -f "$record/ROLLBACK_OPERATION_TRANSACTION_COMPLETED" \
        || -f "$record/ROLLBACK_OPERATION_TRANSACTION_ABORTED" ]]; then
      cleanup_work_secrets
    else
      warn "preserving rollback staging for the pending operation"
    fi
    exit "$status"
  fi
  if ((rollback_started == 0)); then cleanup_work_secrets; exit "$status"; fi
  warn "manual rollback failed; proving recovery of the exact current deployment"
  set +e
  quiesce_ingress_services "$ingress_evidence" 0 "$live_cloudflared_record" "$live_cloudflared_state" \
    || recovery_ok=0
  if assert_ingress_quiesced; then ingress_quiesced=1; else recovery_ok=0; fi
  stop_project_containers "$LEGACY_PROJECT" || recovery_ok=0
  stop_project_containers "$PROJECT" || recovery_ok=0
  remove_project_containers "$PROJECT" || recovery_ok=0
  restore_config_snapshot "$work/current-config" || recovery_ok=0
  restore_nginx_transaction_snapshot "$work" 0 validate-only || recovery_ok=0
  domain_nginx_reapply "$record" validate-only || recovery_ok=0
  domain_cloudflared_install "$record" || recovery_ok=0
  live_cloudflared_record="$record"
  live_cloudflared_state=desired
  domain_cloudflared_verify_desired "$record" || recovery_ok=0
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action apply || recovery_ok=0
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --channel-key-action verify-desired || recovery_ok=0
  if ((pointers_changed)); then
    restore_pointer current "$current_release" || recovery_ok=0
    restore_pointer previous "$previous_pointer" || recovery_ok=0
    restore_pointer current-deployment "$record" || recovery_ok=0
  fi
  if activate_retained_candidate_authority "$current_release" "$record" "$record" \
      rollback-recovery-current; then
    load_compose_command "$current_release"
    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans || recovery_ok=0
    wait_for_services "$current_release" || recovery_ok=0
  domain_keycloak_apply "$record" "$work/current-config/runtime.env" 8088 center.andersmadsen.dk \
    || recovery_ok=0
  domain_nginx_verify_desired "$record" || recovery_ok=0
  domain_keycloak_verify_desired "$record" "$work/current-config/runtime.env" 8088 \
    center.andersmadsen.dk || recovery_ok=0
  verify_keycloak_post_migration_evidence "$record" || recovery_ok=0
  (verify_configuration_evidence "$record/config-digests.tsv" "$current_release") || recovery_ok=0
  (verify_image_evidence "$record/running-images.tsv" "$current_release") || recovery_ok=0
  start_recorded_ingress_service "$ingress_evidence" penumbra-center-bridge.service || recovery_ok=0
  write_owner_canary_cookie "$current_release" "$owner_canary_cookie" || recovery_ok=0
  recovery_canary=(--release-id "$current_release_id" --image-evidence "$record/running-images.tsv" \
    --require-remote-tts --require-owner-spotify --quiesced-loopback --expect-bridge-ready \
    --cookie-file "$owner_canary_cookie")
  if [[ -n "$fresh_backup" && -f "$fresh_backup/invariants.tsv" ]]; then recovery_canary+=(--baseline "$fresh_backup"); fi
  run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 "${recovery_canary[@]}" >/dev/null || recovery_ok=0
  restore_ingress_services "$ingress_evidence" "$record" desired || recovery_ok=0
  domain_cloudflared_verify_desired "$record" || recovery_ok=0
  assert_ingress_matches_recorded "$ingress_evidence" || recovery_ok=0
    if ((recovery_ok)); then
      ingress_quiesced=0
      public_recovery_canary=(--release-id "$current_release_id" \
        --image-evidence "$record/running-images.tsv" --require-remote-tts --require-owner-spotify \
        --cookie-file "$owner_canary_cookie")
      [[ -z "$fresh_backup" || ! -f "$fresh_backup/invariants.tsv" ]] \
        || public_recovery_canary+=(--baseline "$fresh_backup")
      run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 "${public_recovery_canary[@]}" >/dev/null \
        || recovery_ok=0
    fi
  else
    # Never fall back to ambient tags/cache after retained bundle activation
    # fails.  Leave ingress closed and preserve the prepared staging tree for a
    # later exact-authority resume or operator inspection.
    recovery_ok=0
  fi
  if ((recovery_ok)); then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$work/CURRENT_RECOVERED"
    chmod 600 "$work/CURRENT_RECOVERED"
    # The pointer transaction is terminated on what this recovery just PROVED,
    # not on how far the rollback had got before it failed. Every step above ran
    # under recovery_ok: the exact current protected configuration, Nginx,
    # Cloudflare route, channel key and containers are back, the recorded ingress
    # bitmap is restored and matches, and both the quiesced owner canary and the
    # public canary passed against $current_release. The target is serving nobody,
    # and the authority pointers never moved either — pointers_changed is set only
    # immediately before the commit — so ABORTED is the literal truth on disk. It
    # is also the terminal marker the state-retention command's own second-opinion
    # classifier already expects to see paired with ROLLBACK_ACTIVATION_ARMED.
    #
    # This used to be conditioned on `! -f ROLLBACK_INGRESS_ACTIVATED`, which
    # withheld the abort exactly when the rollback had got FURTHEST: the target was
    # accepted publicly, and then one of the two re-proofs below that acceptance
    # failed, or a TERM landed in the window. finish_rollback re-proves acceptance
    # first (above), and only when THAT fails does it drag the system back here —
    # so by the time we are writing CURRENT_RECOVERED, the accepted target is gone.
    # Leaving the transaction PREPARED with no terminal marker kept the rollback
    # namespace globally active in transaction.py's inventory, and that inventory is
    # the gate on everything: `./revival deploy` refused at preflight, the
    # protected-configuration adoption command refused on the same inventory, and
    # `./revival rollback` re-entered the resume path — which cannot run against
    # the deployment this handler just restored, because the resume asserts the
    # TARGET's world. Production kept serving while no supported
    # command could either finish or unwind the transaction, and the only exit was
    # hand-writing this marker, which nothing in the repo will write for you.
    #
    # COMMITTED stays excluded and must: transaction.py:241 dies on a transaction
    # that is both aborted and committed, and that verdict is global — it would
    # take every other command down with it. That case is covered by the
    # preservation guard below instead.
    if [[ -f "$record/ROLLBACK_POINTER_TRANSACTION_PREPARED" \
      && ! -f "$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED" \
      && ! -f "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED" ]]; then
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_POINTER_TRANSACTION_ABORTED.tmp"
      chmod 600 "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED.tmp"
      mv "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED.tmp" "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED"
      sync -f "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED"
    fi
    if [[ -f "$record/ROLLBACK_OPERATION_TRANSACTION_PREPARED" \
        && ! -f "$record/ROLLBACK_OPERATION_TRANSACTION_COMPLETED" \
        && ! -f "$record/ROLLBACK_OPERATION_TRANSACTION_ABORTED" ]]; then
      python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
        --namespace rollback --operation-action abort || recovery_ok=0
    fi
  else
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$work/RECOVERY_FAILED"
    chmod 600 "$work/RECOVERY_FAILED"
  fi
  # Same rule as the committed arm's staging guard above, applied to the other
  # transaction: never delete the only material a resume can be completed from
  # while a resume is still the only way out. cleanup_work_secrets removes
  # $work/current-config and $work/target-stage, and the resume path hard-requires
  # both — it dies at "rollback resume lost the exact current configuration
  # snapshot" and "rollback resume lost its isolated target rehearsal material".
  # The abort above makes this arm's ordinary case terminal, so this normally
  # cleans up; what it catches is the case the abort deliberately cannot take —
  # COMMITTED written by the driver while complete_target_commit still reported
  # failure. That record stays globally active, an operator has nothing but the
  # resume path to reason from, and this handler used to delete its inputs on the
  # way out. Keeping them is necessary, not sufficient: that record also has its
  # pointers restored underneath a committed journal, which the reconcile will
  # read as drift. Deleting the evidence would remove the only way to see that.
  #
  # The test is transaction.py's own "still active" verdict for this namespace,
  # spelled the way its second-opinion classifier spells it: prepared, not
  # aborted, and not (committed AND its MANUAL_ROLLBACK success marker). Deriving it from the same
  # markers rather than from a local variable is deliberate — every variable in
  # this handler describes what THIS process did, and an interrupted process is
  # exactly the case that matters.
  if ((recovery_ok)); then
    if [[ -f "$record/ROLLBACK_POINTER_TRANSACTION_PREPARED" \
      && ! -f "$record/ROLLBACK_POINTER_TRANSACTION_ABORTED" ]] \
      && [[ ! -f "$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED" \
        || ! -f "$record/MANUAL_ROLLBACK" ]]; then
      warn "preserving rollback staging for the pending pointer transaction"
    else
      cleanup_work_secrets || true
    fi
  fi
  exit 1
}
trap finish_rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ((resuming_pointer_transaction)) && [[ ! -f "$record/ROLLBACK_ACTIVATION_ARMED" ]]; then
  # Pointer intent was durable before quiescence, but target activation never
  # armed. Drive the normal exact-current recovery path; it canaries the owner
  # loopback path, restores the recorded ingress bitmap, runs the public canary,
  # and only then aborts operation and pointer authority.
  rollback_started=1
  exit 75
fi

fresh_backup_pointer="$record/rollback-backup-path"
if ((resuming_pointer_transaction)); then
  [[ -f "$fresh_backup_pointer" && ! -L "$fresh_backup_pointer" ]] \
    || fail "rollback resume lacks its restore-tested backup pointer"
  fresh_backup="$(tr -d '\r\n' <"$fresh_backup_pointer")"
  [[ "$fresh_backup" == "$BACKUP_ROOT/"* && -d "$fresh_backup" && ! -L "$fresh_backup" \
    && "$(readlink -f -- "$fresh_backup")" == "$fresh_backup" \
    && -f "$fresh_backup/SHA256SUMS" && -f "$fresh_backup/invariants.tsv" ]] \
    || fail "rollback resume backup is unsafe or incomplete"
  (cd "$fresh_backup" && sha256sum -c SHA256SUMS >/dev/null)
  verify_backup_artifact_manifest "$fresh_backup"
  rollback_started=1
  if ! assert_ingress_quiesced; then
    quiesce_ingress_services "$ingress_evidence" 0 "$live_cloudflared_record" "$live_cloudflared_state" \
      || fail "rollback resume could not close ingress before reactivation"
  fi
  ingress_quiesced=1
  if [[ "$target_kind" == canonical ]]; then
    target_stage="$work/target-stage"
    [[ -d "$target_stage/env" && -d "$target_stage/assets/keycloak-theme" \
      && -f "$target_stage/spotify-token" ]] \
      || fail "rollback resume lost its isolated target rehearsal material"
    verify_exact_carry_security_identity "$target_record/carry-security-identity.json"
  fi
else
  rollback_backup_id="rollback-${deployment_id:0:54}-$(date -u +%Y%m%dT%H%M%SZ)"
  fresh_backup="$BACKUP_ROOT/$rollback_backup_id"
  rollback_started=1
  record_ingress_services "$ingress_evidence"
  domain_cloudflared_verify_desired "$record" \
    || fail "rollback ingress snapshot does not match current Cloudflare authority"
  prepare_target_commit
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --operation-action prepare \
    --operation-ingress-evidence "$ingress_evidence"
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --operation-action quiescing
  run_held_release_program "$current_release" platform/deploy/vps/remote/backup.sh bash 0 \
    --backup-id "$rollback_backup_id" --leave-quiesced --already-locked \
    --cloudflared-record "$record" --cloudflared-state desired --ingress-evidence "$ingress_evidence"
  python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --namespace rollback --operation-action quiesced
  [[ -f "$fresh_backup/BRIDGE_QUIESCED" ]] || fail "rollback backup did not retain Pin ingress quiescence"
  quiesce_ingress_services "$ingress_evidence" 1 "$record" desired
  assert_ingress_quiesced || fail "managed ingress reopened before rollback rehearsal"
  ingress_quiesced=1
  [[ -f "$fresh_backup/SHA256SUMS" && -f "$fresh_backup/invariants.tsv" ]] || fail "fresh rollback backup is incomplete"
  (cd "$fresh_backup" && sha256sum -c SHA256SUMS >/dev/null)
  verify_backup_artifact_manifest "$fresh_backup"
  printf '%s\n' "$fresh_backup" >"$fresh_backup_pointer.tmp"
  chmod 600 "$fresh_backup_pointer.tmp"
  mv "$fresh_backup_pointer.tmp" "$fresh_backup_pointer"
  sync -f "$fresh_backup_pointer"

# A canonical predecessor is restore-rehearsed from exact staged copies. A
# legacy predecessor has no canonical release to rehearse, so it is eligible
# only when the complete mutable compatibility state is byte-identical to the
# restore-tested backup taken immediately before the first cutover.
if [[ "$target_kind" == canonical ]]; then
  target_stage="$work/target-stage"
  mkdir -p "$target_stage/env" "$target_stage/assets"
  chmod 700 "$target_stage" "$target_stage/env" "$target_stage/assets"
  for name in runtime.env cosmos.env providers.env center.env; do
    [[ -f "$target_config/$name" && ! -L "$target_config/$name" ]] \
      || fail "target staging environment is incomplete: $name"
    install -m 600 "$target_config/$name" "$target_stage/env/$name"
    [[ "$(sha256sum "$target_stage/env/$name" | awk '{print $1}')" \
      == "$(sha256sum "$target_config/$name" | awk '{print $1}')" ]] \
      || fail "target staging environment copy changed: $name"
  done
  verify_exact_carry_security_identity "$target_record/carry-security-identity.json"
  sudo -n test -d "$PRODUCTION_KEYCLOAK_THEME_DIR" \
    && ! sudo -n test -L "$PRODUCTION_KEYCLOAK_THEME_DIR" \
    || fail "target staging Keycloak theme is missing or unsafe"
  sudo -n cp -a -- "$PRODUCTION_KEYCLOAK_THEME_DIR" "$target_stage/assets/keycloak-theme"
  [[ -f "$target_config/spotify-token" && ! -L "$target_config/spotify-token" ]] \
    || fail "target staging Spotify token is missing"
  install -m 600 "$target_config/spotify-token" "$target_stage/spotify-token"
  run_held_release_program "$current_release" platform/deploy/vps/remote/staging-smoke.sh bash 0 \
    --release-id "$target_release_id" --backup "$fresh_backup" --env-dir "$target_stage/env" \
    --attest-dir "$PRODUCTION_ATTEST_DIR" --duc-dir "$PRODUCTION_DUC_DIR" \
    --security-identity "$target_record/carry-security-identity.json" \
    --keycloak-theme-dir "$target_stage/assets/keycloak-theme" \
    --spotify-token-file "$target_stage/spotify-token"
else
  original_backup="$BACKUP_ROOT/$deployment_id"
  [[ -d "$original_backup" && ! -L "$original_backup" \
    && "$(readlink -f -- "$original_backup")" == "$original_backup" \
    && -f "$original_backup/SHA256SUMS" ]] \
    || fail "original first-cutover legacy backup is unavailable"
  (cd "$original_backup" && sha256sum -c SHA256SUMS >/dev/null)
  verify_backup_artifact_manifest "$original_backup"
  verify_keycloak_post_migration_evidence "$record" \
    || fail "legacy rollback lacks the migration-bound database boundary"
  # Both sides of this one are POST-migration — the record's capture was taken
  # right after the candidate's Keycloak migration, the fresh backup just now on
  # the same cluster — so an additive migration cannot move it and no projection
  # applies. It answers "has anything written since that boundary?", not "did the
  # candidate migrate?".
  cmp -s "$record/keycloak-post-migration-data.tsv" "$fresh_backup/postgres-data.tsv" \
    || fail "legacy rollback refused because durable database state changed after the Center domain migration"
  # $original_backup was taken BEFORE the first cutover; $fresh_backup was taken
  # just now, with the canonical stack running and its migrations applied. That
  # makes this the same pre-vs-post shape as deploy.sh's zero-delta comparison,
  # and the same distinction applies to what an ADDITIVE migration moves:
  #
  #   postgres-security.json, cosmos-state.inventory.json and the two bridge
  #   inventories do not move for an appended column or a new non-UNIQUE index —
  #   an index is relkind 'i' and a new column has no ACL, so
  #   capture_postgres_security never sees either, and the inventories describe
  #   files rather than the database. They stay byte-exact. A brand-new TABLE
  #   would move postgres-security.json, and that is left to fail: a new
  #   relation's owner and grants are a security decision nothing here proves.
  immutable_legacy_state=(
    postgres-security.json
    cosmos-state.inventory.json
    bridge-inventory.before.json
    bridge-inventory.after.json
  )
  for name in "${immutable_legacy_state[@]}"; do
    [[ -f "$original_backup/$name" && -f "$fresh_backup/$name" ]] \
      || fail "legacy state comparison evidence is missing: $name"
    cmp -s "$original_backup/$name" "$fresh_backup/$name" \
      || fail "legacy rollback refused because durable state changed since first cutover: $name"
  done
  # postgres-schema.tsv DOES move for an additive migration, so it goes through
  # the classifier rather than a bare cmp: byte equality still decides first, and
  # a delta is admitted only if classify_schema_delta can prove every part of it
  # non-destructive and name it. Refusing a legacy rollback because the release
  # being rolled back legitimately added a column would close the recovery path
  # exactly when it is needed.
  compare_schema_manifests "$original_backup/postgres-schema.tsv" "$fresh_backup/postgres-schema.tsv" \
    "legacy rollback refused because the schema changed non-additively since first cutover"
  python3 - "$original_backup/center-data.inventory.json" "$fresh_backup/center-data.inventory.json" \
    "$record/CHANNEL_KEY_METADATA_TRANSACTION.json" <<'PY'
import json,sys
before={item["path"]:item for item in json.load(open(sys.argv[1],encoding="utf-8"))}
after={item["path"]:item for item in json.load(open(sys.argv[2],encoding="utf-8"))}
journal=json.load(open(sys.argv[3],encoding="utf-8")); assert set(before)==set(after)
for name in before:
    old,new=before[name],after[name]
    if name=="channel-key.json":
        assert old.get("sha256")==new.get("sha256")==journal["contentSha256"]
        assert (old.get("mode"),old.get("uid"),old.get("gid"))==(oct(journal["oldMode"]),journal["oldUid"],journal["oldGid"])
        assert (new.get("mode"),new.get("uid"),new.get("gid"))==(oct(journal["desiredMode"]),journal["desiredUid"],journal["desiredGid"])
        for key in set(old)|set(new):
            if key not in {"mode","uid","gid"}: assert old.get(key)==new.get(key)
    else: assert old==new
PY
fi

fi

printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_ACTIVATION_ARMED.tmp"
chmod 600 "$record/ROLLBACK_ACTIVATION_ARMED.tmp"
mv "$record/ROLLBACK_ACTIVATION_ARMED.tmp" "$record/ROLLBACK_ACTIVATION_ARMED"
sync -f "$record/ROLLBACK_ACTIVATION_ARMED"

activate_retained_candidate_authority "$current_release" "$record" "$record" \
  rollback-stop-current
load_compose_command "$current_release"
"${COMPOSE[@]}" down --remove-orphans
stop_project_containers "$PROJECT"

restore_config_snapshot "$target_config"
restore_nginx_transaction_snapshot "$record" 1 validate-only
domain_nginx_restore "$record" validate-only
domain_cloudflared_restore "$record" \
  || fail "target Cloudflare configuration preimage could not be restored while connectors were stopped"
live_cloudflared_record="$target_cloudflared_record"
live_cloudflared_state="$target_cloudflared_state"
if [[ "$target_cloudflared_state" == desired ]]; then
  domain_cloudflared_verify_desired "$target_cloudflared_record" \
    || fail "canonical rollback target Cloudflare route does not match its desired transaction"
else
  domain_cloudflared_verify_before "$target_cloudflared_record" \
    || fail "legacy rollback target Cloudflare route does not match the exact preimage"
fi
sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --channel-key-action restore
sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --channel-key-action verify-old
if [[ "$target_kind" == canonical ]]; then
  sudo -n python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
    --trust-root-action record --staged-attest "$PRODUCTION_ATTEST_DIR" \
    --staged-duc "$PRODUCTION_DUC_DIR" --live-attest "$PRODUCTION_ATTEST_DIR" \
    --live-duc "$PRODUCTION_DUC_DIR"
  verify_exact_carry_security_identity "$target_record/carry-security-identity.json"
  activate_retained_candidate_authority "$target_release" "$target_record" "$record" \
    rollback-activate-target
  load_compose_command "$target_release"
  "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans
  wait_for_services "$target_release"
  restore_target_keycloak_state \
    || fail "target Center domain and Keycloak state could not be restored"
  verify_image_evidence "$target_record/running-images.tsv" "$target_release"
  live_bridge_digest="$(protected_path_digest /var/lib/penumbra-center)"
  python3 - "$target_record/config-digests.tsv" "$live_bridge_digest" "$work/target-config-evidence.tsv" <<'PY'
import sys
target=[line.rstrip("\n").split("\t") for line in open(sys.argv[1],encoding="utf-8")]
bridge=["protected","bridge.state",sys.argv[2],"-","-"]
target=[bridge if row[:2]==["protected","bridge.state"] else row for row in target]
assert sum(row[:2]==["protected","bridge.state"] for row in target)==1
target.sort(key=lambda row:"\t".join(row))
open(sys.argv[3],"w",encoding="utf-8").write("".join("\t".join(row)+"\n" for row in target))
PY
  chmod 600 "$work/target-config-evidence.tsv"
  verify_configuration_evidence "$work/target-config-evidence.tsv" "$target_release"
  run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 --release-id "$target_release_id" \
    --baseline "$fresh_backup" --image-evidence "$target_record/running-images.tsv" \
    --require-remote-tts --quiesced-loopback "${target_origin_args[@]}"
  assert_ingress_quiesced || fail "managed ingress reopened during rollback canary"
else
  verify_exact_carry_security_identity "$record/carry-security-identity.json"
  verify_adopted_live_carry "$carry_baseline_id" stopped \
    "$current_candidate_id" "$current_release_id" "$current_authority_sha256" absent \
    || fail "Carry predecessor identity changed at the legacy activation boundary"
  start_recorded_containers "$record/before/running-containers.txt"
  restore_target_keycloak_state \
    || fail "legacy Cosmos domain and Keycloak state could not be restored"
  legacy_postgres="$(find_postgres_container)"
  # A legacy rollback restores containers and configuration; it does NOT restore
  # the PostgreSQL volume, so the cluster still carries whatever the canonical
  # release migrated onto it. This capture is therefore POST-migration while
  # $original_backup is PRE, and `to_jsonb(t)` encodes the schema as well as the
  # data — an appended column would fail this comparison without a wearer byte
  # moving. Project onto the columns the original backup was digested over so the
  # question stays "is the pre-cutover DATA intact?". A changed value, a vanished
  # row and a dropped column all still fail; if that backup predates the sidecar
  # the capture falls back to the live columns and refuses, which is the safe
  # direction.
  capture_postgres_data "$legacy_postgres" "$LEGACY_DATABASE_USER" "$work/legacy-restored-postgres-data.tsv" \
    "$original_backup/postgres-data.tsv.columns"
  cmp -s "$original_backup/postgres-data.tsv" "$work/legacy-restored-postgres-data.tsv" \
    || fail "legacy rollback refused because the exact pre-cutover database state was not restored"
fi
if [[ "$target_kind" == canonical ]]; then
  start_recorded_ingress_service "$ingress_evidence" penumbra-center-bridge.service
  ingress_quiesced=0
  wait_for_services "$target_release"
  write_owner_canary_cookie "$target_release" "$owner_canary_cookie"
  run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 --release-id "$target_release_id" \
    --image-evidence "$target_record/running-images.tsv" \
    --require-remote-tts --require-owner-spotify --quiesced-loopback --expect-bridge-ready \
    --cookie-file "$owner_canary_cookie" "${target_origin_args[@]}"
else
  :
fi
restore_ingress_services "$ingress_evidence" "$target_cloudflared_record" "$target_cloudflared_state"
if [[ "$target_cloudflared_state" == desired ]]; then
  domain_cloudflared_verify_desired "$target_cloudflared_record" \
    || fail "canonical rollback target Cloudflare route drifted after connector activation"
else
  domain_cloudflared_verify_before "$target_cloudflared_record" \
    || fail "legacy rollback target Cloudflare route drifted after connector activation"
fi
assert_ingress_matches_recorded "$ingress_evidence" || fail "rollback ingress differs from its recorded state"
if [[ "$target_kind" == canonical ]]; then
  run_held_release_program "$current_release" platform/deploy/vps/remote/canary.sh bash 0 --release-id "$target_release_id" \
    --image-evidence "$target_record/running-images.tsv" \
    --require-remote-tts --require-owner-spotify --cookie-file "$owner_canary_cookie" \
    "${target_origin_args[@]}"
else
  verify_legacy_application "$record/before" \
    || fail "legacy application did not recover with its exact recorded identity and semantics"
fi
install -m 600 "$ingress_evidence" "$record/rollback-ingress-active.tsv"
if [[ "$target_kind" == canonical ]]; then
  install -m 600 "$work/target-config-evidence.tsv" "$record/rollback-target-config-evidence.tsv"
fi
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/ROLLBACK_INGRESS_ACTIVATED.tmp"
chmod 600 "$record/ROLLBACK_INGRESS_ACTIVATED.tmp"
mv "$record/ROLLBACK_INGRESS_ACTIVATED.tmp" "$record/ROLLBACK_INGRESS_ACTIVATED"
sync -f "$record/ROLLBACK_INGRESS_ACTIVATED"
assert_ingress_matches_recorded "$ingress_evidence" || fail "rollback ingress changed after public acceptance"
verify_target_domain_state || fail "rollback target domain state changed after public acceptance"
pointers_changed=1
complete_target_commit || fail "accepted rollback pointer transaction could not be completed"
target_committed=1
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record/MANUAL_ROLLBACK.tmp"
chmod 600 "$record/MANUAL_ROLLBACK.tmp"
mv "$record/MANUAL_ROLLBACK.tmp" "$record/MANUAL_ROLLBACK"
sync -f "$record/MANUAL_ROLLBACK"
rollback_committed=1
python3 "$transaction_driver" --root "$REMOTE_ROOT" --record "$record" \
  --namespace rollback --operation-action complete
trap - EXIT HUP INT TERM
cleanup_work_secrets

target_label="$target_release_id"
[[ "$target_kind" == canonical ]] || target_label=legacy
if ((json)); then
  python3 - "$deployment_id" "$target_label" "$target_kind" "$fresh_backup" <<'PY'
import json,sys
print(json.dumps({"ok":True,"deploymentId":sys.argv[1],"target":sys.argv[2],"targetKind":sys.argv[3],"freshBackup":sys.argv[4],"databaseRestored":False},separators=(",",":")))
PY
else
  # State the boundary and where the other side of it is written down. This
  # line is the only place an operator is told that post-cutover writes survived
  # the rollback, and it used to end there, leaving "then how do I undo them?"
  # unanswered at the one moment it is being asked.
  log "rolled back deployment $deployment_id to $target_kind target $target_label; databases were not restored (manual restore procedure: docs/recovery.md)"
fi
