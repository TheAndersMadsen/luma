#!/usr/bin/env bash
# Restore one verified backup into a disposable, host-isolated copy of the
# production data plane and prove the candidate images can start against it.
#
# This deliberately does not use Compose: the production model names durable
# volumes and publishes loopback ports. Every Docker object below has a unique,
# project-scoped name and is removed by the EXIT trap.
set -euo pipefail
# Temporary deploy-time xtrace: the staging smoke runs in the quiesced window and
# a latent early failure here is otherwise invisible. PS4 carries the line number
# so the deploy-preserved transcript pinpoints the exact failing command.
if [[ "${REVIVAL_STAGING_SMOKE_TRACE:-0}" == 1 ]]; then
  export PS4='+ staging-smoke:${LINENO}: '
  set -x
fi
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

# Keep the staging consumer deliberately smaller than the backup producer.  The
# versioned manifest, archive inventory, invariant, and channel-key validators
# live in common.sh; staging must consume those exact functions instead of
# maintaining a second interpretation of the backup format.
staging_validate_backup_contract() {
  local root="$1" backup_id archive_name
  [[ -d "$root" && ! -L "$root" ]] || fail "staging backup root is unavailable"
  [[ -f "$root/SHA256SUMS" && ! -L "$root/SHA256SUMS" ]] \
    || fail "staging backup checksum manifest is unavailable"
  (
    cd -- "$root"
    sha256sum -c SHA256SUMS >/dev/null
  ) || fail "staging backup checksum verification failed"
  # SHA256SUMS is transport evidence for BACKUP_MANIFEST itself. Require exact
  # coverage so deleting a checksum row cannot silently weaken that evidence.
  python3 - "$root" <<'PY'
import json,os,re,stat,sys
root=sys.argv[1]; checksum=os.path.join(root,"SHA256SUMS")
rows={}
for number,raw in enumerate(open(checksum,encoding="utf-8"),1):
    line=raw.rstrip("\n")
    match=re.fullmatch(r"([0-9a-f]{64})  (.+)",line)
    if not match: raise SystemExit(f"malformed SHA256SUMS row at line {number}")
    relative=match.group(2)
    if (not relative or relative in rows or relative.startswith("/") or "\\" in relative
            or ".." in relative.split("/") or any(ord(char)<32 or ord(char)==127 for char in relative)):
        raise SystemExit("unsafe or duplicate SHA256SUMS path")
    rows[relative]=match.group(1)
actual=set()
for directory,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    for name in [*dirs,*files]:
        path=os.path.join(directory,name); metadata=os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode): raise SystemExit("backup checksum tree contains a symlink")
    for name in files:
        relative=os.path.relpath(os.path.join(directory,name),root)
        if relative!="SHA256SUMS": actual.add(relative)
if set(rows)!=actual:
    raise SystemExit(f"SHA256SUMS coverage differs; missing={sorted(actual-set(rows))}, unknown={sorted(set(rows)-actual)}")
def unique_pairs(values):
    result={}
    for key,value in values:
        if key in result: raise ValueError(f"duplicate JSON field: {key}")
        result[key]=value
    return result
for relative in (
    "BACKUP_MANIFEST.json","cosmos-state.inventory.json","center-data.inventory.json",
    "prometheus-data.inventory.json","grafana-data.inventory.json",
    "postgres-data.inventory.json","protected-inventory.json",
):
    try:
        with open(os.path.join(root,relative),encoding="utf-8") as source:
            json.load(source,object_pairs_hook=unique_pairs)
    except (OSError,json.JSONDecodeError,ValueError) as error:
        raise SystemExit(f"strict backup JSON validation failed for {relative}: {error}")
PY
  verify_backup_artifact_manifest "$root"
  IFS= read -r backup_id <"$root/BACKUP_ID"
  [[ "$backup_id" =~ ^[A-Za-z0-9._-]{8,96}$ && "$(basename -- "$root")" == "$backup_id" ]] \
    || fail "staging backup directory and BACKUP_ID differ"
  for archive_name in cosmos-state.tar.gz center-data.tar.gz prometheus-data.tar.gz \
    grafana-data.tar.gz postgres-data.tar.gz protected.tar.gz \
    postgres-globals.sql.gz cosmos.sql.gz keycloak.sql.gz; do
    gzip -t "$root/$archive_name" || fail "staging backup archive is invalid: $archive_name"
  done
}

staging_validate_protected_contract() {
  local root="$1"
  validate_archive_inventory "$root/protected-inventory.json"
  python3 - "$root" "$PRIVATE_DIR" <<'PY'
import json,os,posixpath,sys
root,private=sys.argv[1:]
def safe_absolute(value):
    return (isinstance(value,str) and value.startswith("/") and value!="/" and "\\" not in value
            and not any(ord(char)<32 or ord(char)==127 for char in value)
            and ".." not in value.split("/") and posixpath.normpath(value)==value)
def tsv(path,width):
    rows=[]
    for number,raw in enumerate(open(path,encoding="utf-8"),1):
        fields=raw.rstrip("\n").split("\t")
        if len(fields)!=width: raise SystemExit(f"malformed protected contract row at line {number}")
        rows.append(fields)
    return rows
security_rows=tsv(os.path.join(root,"active-security-roots.tsv"),2)
security={}
for label,value in security_rows:
    if label in security or not safe_absolute(value): raise SystemExit("invalid or duplicate active security root")
    security[label]=value
if set(security)!={"attestation","device-user"}: raise SystemExit("active security-root schema differs")
allowed={
    "attestation":{private+"/attest","/home/anders/cosmos-attest"},
    "device-user":{private+"/duc","/home/anders/cosmos-duc"},
}
for label,value in security.items():
    if value not in allowed[label]: raise SystemExit(f"unsupported active security root: {label}")
if len(set(security.values()))!=2: raise SystemExit("active security roots overlap")
required={
    security["attestation"],security["device-user"],
    "/etc/nginx/nginx.conf","/etc/nginx/sites-available","/etc/nginx/sites-enabled",
    "/etc/systemd/system/penumbra-center-bridge.service","/etc/penumbra","/var/lib/penumbra-center",
}
optional={
    "/home/anders/humane-cosmos-clone/.env","/home/anders/cosmos-backends.env",
    "/home/anders/cosmos-center.env","/home/anders/cosmos-edge",
    "/home/anders/keycloak-themes/humane",private,"/etc/nginx/conf.d",
    "/etc/cloudflared","/home/anders/.cloudflared",
}
presence={}
for classification,state,path in tsv(os.path.join(root,"protected-presence.tsv"),3):
    if path in presence or not safe_absolute(path): raise SystemExit("invalid or duplicate protected presence path")
    if classification not in {"required","optional"} or state not in {"present","absent"}:
        raise SystemExit("unknown protected presence field")
    presence[path]=(classification,state)
if set(presence)!=required|optional: raise SystemExit("protected presence path allowlist differs")
for path in required:
    if presence[path]!=("required","present"): raise SystemExit("required protected path is not declared present")
for path in optional:
    if presence[path][0]!="optional": raise SystemExit("optional protected path classification differs")
    if presence[path][1]=="absent" and any(child.startswith(path+"/") and state=="present"
            for child,(_,state) in presence.items()):
        raise SystemExit("absent protected path contains a declared-present descendant")
present=sorted((path for path,(_,state) in presence.items() if state=="present"),key=lambda item:(item.count("/"),item))
selected=[]
for path in present:
    if any(path==parent or path.startswith(parent+"/") for parent in selected): continue
    selected.append(path)
declared=[]
for number,raw in enumerate(open(os.path.join(root,"protected.paths"),encoding="utf-8"),1):
    relative=raw.rstrip("\n")
    value="/"+relative.strip("/")
    if not relative or relative.startswith("/") or not safe_absolute(value):
        raise SystemExit(f"invalid protected.paths row at line {number}")
    declared.append(value)
if declared!=selected or len(declared)!=len(set(declared)):
    raise SystemExit("protected.paths differs from the declared presence contract")
inventory=json.load(open(os.path.join(root,"protected-inventory.json"),encoding="utf-8"))
paths={item["path"]:item for item in inventory}
if "." not in paths: raise SystemExit("protected archive root metadata is missing")
for selected_path in selected:
    relative=selected_path.removeprefix("/")
    if relative not in paths: raise SystemExit(f"declared protected root is missing from archive: {selected_path}")
for label,security_path in security.items():
    item=paths.get(security_path.removeprefix("/"))
    if not item or item.get("type")!="5": raise SystemExit(f"active {label} root is not an archived directory")
PY
}

staging_security_root_path() {
  local root="$1" label="$2"
  [[ "$label" == attestation || "$label" == device-user ]] || fail "unknown staging security-root label"
  awk -F $'\t' -v wanted="$label" '$1==wanted {print $2}' "$root/active-security-roots.tsv"
}

staging_project_protected_root_inventory() {
  local inventory="$1" protected_root="$2" output="$3"
  validate_archive_inventory "$inventory"
  python3 - "$inventory" "$protected_root" "$output" <<'PY'
import json,posixpath,sys
source,root,output=sys.argv[1:]
if (not root.startswith("/") or root=="/" or "\\" in root or ".." in root.split("/")
        or posixpath.normpath(root)!=root): raise SystemExit("unsafe protected projection root")
prefix=root.removeprefix("/"); projected=[]
for item in json.load(open(source,encoding="utf-8")):
    path=item["path"]
    if path!=prefix and not path.startswith(prefix+"/"): continue
    copy=dict(item); copy["path"]="." if path==prefix else path.removeprefix(prefix+"/")
    projected.append(copy)
if sum(item["path"]=="." for item in projected)!=1:
    raise SystemExit("protected projection root is missing or duplicated")
root_item=next(item for item in projected if item["path"]==".")
if root_item.get("type")!="5": raise SystemExit("protected projection root is not a directory")
projected.sort(key=lambda item:item["path"])
open(output,"w",encoding="utf-8").write(json.dumps(projected,sort_keys=True,separators=(",",":")))
PY
  chmod 600 "$output"
  validate_archive_inventory "$output"
}

staging_write_runtime_center_inventory() {
  local invariants="$1" inventory="$2" output="$3" runtime_uid="$4" runtime_gid="$5"
  validate_backup_invariants "$invariants"
  validate_archive_inventory "$inventory"
  [[ "$runtime_uid" =~ ^[0-9]+$ && "$runtime_gid" =~ ^[0-9]+$ ]] \
    || fail "invalid disposable Center runtime owner"
  python3 - "$invariants" "$inventory" "$output" "$runtime_uid" "$runtime_gid" <<'PY'
import json,sys
invariants,inventory,output,uid,gid=sys.argv[1:]
rows={}
for raw in open(invariants,encoding="utf-8"):
    key,value=raw.rstrip("\n").split("\t",1); rows[key]=value
items=json.load(open(inventory,encoding="utf-8")); matches=[item for item in items if item["path"]=="channel-key.json"]
presence=rows["center.channel_key.presence"]
if presence=="present":
    if len(matches)!=1: raise SystemExit("present Center channel key inventory is ambiguous")
    item=matches[0]
    if f'{item["uid"]}:{item["gid"]}'!=rows["center.channel_key.owner"]:
        raise SystemExit("Center channel key backup owner differs from invariant")
    item["uid"]=int(uid); item["gid"]=int(gid)
elif presence=="absent":
    if matches: raise SystemExit("absent Center channel key appears in inventory")
else: raise SystemExit("unsupported Center channel presence")
if sum(item["path"]=="." for item in items)!=1: raise SystemExit("Center archive root metadata is missing")
open(output,"w",encoding="utf-8").write(json.dumps(items,sort_keys=True,separators=(",",":")))
PY
  chmod 600 "$output"
  validate_archive_inventory "$output"
}

staging_parse_runtime_owner() {
  local specification="$1" uid gid
  [[ "$specification" =~ ^([0-9]+):([0-9]+)$ ]] \
    || fail "candidate Center image must declare a numeric uid:gid runtime user"
  uid="${BASH_REMATCH[1]}"; gid="${BASH_REMATCH[2]}"
  ((10#$uid > 0 && 10#$gid > 0)) \
    || fail "candidate Center image must declare a non-root uid and gid"
  printf '%s\t%s\n' "$uid" "$gid"
}

if [[ "${REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY:-0}" == 1 ]]; then
  return 0 2>/dev/null || exit 0
fi

release_id=""
backup_arg=""
env_dir=""
attest_dir=""
duc_dir=""
keycloak_theme_dir=""
spotify_token_file=""

usage() {
  echo "usage: staging-smoke --release-id SHA256 --backup BACKUP_ID_OR_PATH --env-dir DIR --attest-dir DIR --duc-dir DIR --keycloak-theme-dir DIR --spotify-token-file FILE" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --release-id) (($# >= 2)) || usage; release_id="$2"; shift 2 ;;
    --backup) (($# >= 2)) || usage; backup_arg="$2"; shift 2 ;;
    --env-dir) (($# >= 2)) || usage; env_dir="$2"; shift 2 ;;
    --attest-dir) (($# >= 2)) || usage; attest_dir="$2"; shift 2 ;;
    --duc-dir) (($# >= 2)) || usage; duc_dir="$2"; shift 2 ;;
    --keycloak-theme-dir) (($# >= 2)) || usage; keycloak_theme_dir="$2"; shift 2 ;;
    --spotify-token-file) (($# >= 2)) || usage; spotify_token_file="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$release_id" && -n "$backup_arg" && -n "$env_dir" && -n "$attest_dir" \
  && -n "$duc_dir" && -n "$keycloak_theme_dir" && -n "$spotify_token_file" ]] || usage
validate_release_id "$release_id"

assert_target
assert_remote_root
for command in docker python3 gzip sha256sum openssl readlink awk sed stat grep tr date sleep dirname basename wc sudo tar; do need "$command"; done
[[ "$(docker network connect --help)" == *--gw-priority* ]] \
  || fail "Docker must support explicit network gateway priority for private search staging"

backup_root_real="$(readlink -f -- "$BACKUP_ROOT")"
if [[ "$backup_arg" == /* ]]; then
  backup_dir="$(readlink -f -- "$backup_arg")"
else
  [[ "$backup_arg" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage
  backup_dir="$(readlink -f -- "$BACKUP_ROOT/$backup_arg")"
fi
[[ "$backup_dir" == "$backup_root_real/"* && -d "$backup_dir" ]] \
  || fail "backup must be an existing directory under the canonical backup root"
staging_validate_backup_contract "$backup_dir"
staging_validate_protected_contract "$backup_dir"
backup_attest_root="$(staging_security_root_path "$backup_dir" attestation)"
backup_duc_root="$(staging_security_root_path "$backup_dir" device-user)"
[[ -n "$backup_attest_root" && -n "$backup_duc_root" ]] \
  || fail "backup does not declare both active security roots"

env_dir="$(readlink -f -- "$env_dir")"
[[ "$env_dir" == "$DEPLOYMENTS_DIR/"* && -d "$env_dir" ]] || fail "staged env directory is outside deployments"
stage_root="$(readlink -f -- "$(dirname -- "$env_dir")")"
[[ "$stage_root" == "$DEPLOYMENTS_DIR/"* && "$(basename -- "$env_dir")" == env ]] \
  || fail "staged env directory is not the candidate stage env"
smoke_runtime_env="$env_dir/runtime.env"
smoke_cosmos_env="$env_dir/cosmos.env"
smoke_provider_env="$env_dir/providers.env"
smoke_center_env="$env_dir/center.env"
for file in "$smoke_runtime_env" "$smoke_cosmos_env" "$smoke_provider_env" "$smoke_center_env"; do
  [[ -f "$file" ]] || fail "staging environment file is missing"
done
attest_dir="$(sudo -n readlink -f -- "$attest_dir")"
duc_dir="$(sudo -n readlink -f -- "$duc_dir")"
keycloak_theme_dir="$(sudo -n readlink -f -- "$keycloak_theme_dir")"
spotify_token_file="$(readlink -f -- "$spotify_token_file")"
[[ "$attest_dir" == "$stage_root/assets/attest" && "$duc_dir" == "$stage_root/assets/duc" \
  && "$keycloak_theme_dir" == "$stage_root/assets/keycloak-theme" \
  && "$spotify_token_file" == "$stage_root/spotify-token" ]] \
  || fail "staging assets must be the exact passed candidate stage assets"
sudo -n test -f "$attest_dir/ca.crt" && sudo -n test -f "$attest_dir/ca.key" \
  || fail "staging attestation CA is unavailable"
sudo -n test -f "$duc_dir/duc-ca.crt" && sudo -n test -f "$duc_dir/duc-ca.key" \
  || fail "staging DeviceUser CA is unavailable"
sudo -n test -d "$keycloak_theme_dir" && [[ -f "$spotify_token_file" ]] \
  || fail "staging identity or Spotify asset is unavailable"
spotify_token_bytes="$(tr -d '\r\n' <"$spotify_token_file" | wc -c | tr -d '[:space:]')"
((spotify_token_bytes >= 32 && spotify_token_bytes <= 512)) || fail "staging Spotify token has invalid length"

release_dir="$RELEASES_DIR/$release_id"
[[ -d "$release_dir" ]] || fail "candidate release directory is missing"
searxng_settings_file="$release_dir/cosmos/search/settings.yml"
[[ -f "$searxng_settings_file" && ! -L "$searxng_settings_file" ]] \
  || fail "candidate release lacks its packaged SearXNG settings"
load_compose_command_with_env "$release_dir" "$smoke_runtime_env" "$smoke_cosmos_env" "$smoke_provider_env" "$smoke_center_env"
cosmos_image="ai-pin-revival/cosmos:$release_id"
center_image="ai-pin-revival/center:$release_id"
spotify_image="ai-pin-revival/spotify-adapter:$release_id"
postgres_image="$("${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["postgres"]["image"])')"
keycloak_image="$("${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["keycloak"]["image"])')"
searxng_image="$("${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["searxng"]["image"])')"
helper_image="$HELPER_IMAGE"
[[ "$postgres_image" == *@sha256:* && "$keycloak_image" == *@sha256:* \
  && "$searxng_image" == *@sha256:* && "$helper_image" == *@sha256:* ]] \
  || fail "staging third-party images must be digest-pinned"
for image in "$cosmos_image" "$center_image" "$spotify_image" "$postgres_image" "$keycloak_image" "$searxng_image" "$helper_image"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "required staging image is unavailable: $image"
done

assert_candidate_image() {
  local image="$1" actual
  actual="$(docker image inspect --format '{{index .Config.Labels "dk.andersmadsen.ai-pin-revival.release"}}' "$image")"
  [[ "$actual" == "$release_id" ]] || fail "candidate image label does not match the requested release: $image"
}
assert_candidate_image "$cosmos_image"
assert_candidate_image "$center_image"
assert_candidate_image "$spotify_image"
center_runtime_owner="$(staging_parse_runtime_owner \
  "$(docker image inspect --format '{{.Config.User}}' "$center_image")")"
IFS=$'\t' read -r center_runtime_uid center_runtime_gid <<<"$center_runtime_owner"
[[ -n "$center_runtime_uid" && -n "$center_runtime_gid" ]] \
  || fail "candidate Center runtime owner could not be resolved"
unset center_runtime_owner

# The random component prevents a concurrent smoke run from sharing anything;
# the PID and timestamp make the owning process obvious during incident review.
scope="ai-pin-revival-smoke-${release_id:0:12}-$(date -u +%s)-$$-$(openssl rand -hex 4)"
network="${scope}-network"
searxng_egress_network="${scope}-searxng-egress"
state_volume="${scope}-cosmos-state"
center_volume="${scope}-center-data"
pin_release_volume="${scope}-pin-releases"
postgres_volume="${scope}-postgres"
attest_volume="${scope}-attest"
duc_volume="${scope}-duc"
theme_volume="${scope}-keycloak-theme"
spotify_secret_volume="${scope}-spotify-secret"
postgres_container="${scope}-postgres"
keycloak_container="${scope}-keycloak"
ai_bus_container="${scope}-ai-bus"
provisioning_container="${scope}-provisioning"
connectivity_container="${scope}-connectivity"
account_container="${scope}-account"
contacts_container="${scope}-contacts"
feature_flags_container="${scope}-feature-flags"
notable_events_container="${scope}-notable-events"
center_container="${scope}-center"
# The same Center image and the same restored state, started a second time with
# the exact environment production runs — COSMOS_PRINCIPAL absent. See the
# two-pass block near the end of this script.
center_production_identity_container="${scope}-center-production-identity"
spotify_stub_container="${scope}-spotify-stub"
spotify_adapter_container="${scope}-spotify-adapter"
searxng_container="${scope}-searxng"
temporary_password="$(openssl rand -hex 32)"
projection_work=""
session_file=""

created_containers=()
created_volumes=()
created_networks=()

cleanup() {
  local status=$? container volume network_name index cleanup_failed=0
  local leftovers=()
  trap - EXIT HUP INT TERM
  set +e
  for ((index=${#created_containers[@]}-1; index>=0; index--)); do
    container="${created_containers[$index]}"
    if docker container inspect "$container" >/dev/null 2>&1; then
      docker rm --force --volumes "$container" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  for ((index=${#created_volumes[@]}-1; index>=0; index--)); do
    volume="${created_volumes[$index]}"
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  for ((index=${#created_networks[@]}-1; index>=0; index--)); do
    network_name="${created_networks[$index]}"
    if docker network inspect "$network_name" >/dev/null 2>&1; then
      docker network rm "$network_name" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  mapfile -t leftovers < <(docker ps -aq --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")
  ((${#leftovers[@]} == 0)) || docker rm --force --volumes "${leftovers[@]}" >/dev/null 2>&1 || cleanup_failed=1
  mapfile -t leftovers < <(docker volume ls -q --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")
  ((${#leftovers[@]} == 0)) || docker volume rm "${leftovers[@]}" >/dev/null 2>&1 || cleanup_failed=1
  mapfile -t leftovers < <(docker network ls -q --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")
  ((${#leftovers[@]} == 0)) || docker network rm "${leftovers[@]}" >/dev/null 2>&1 || cleanup_failed=1
  unset temporary_password
  [[ -z "$projection_work" || ! -d "$projection_work" ]] || rm -rf -- "$projection_work"
  [[ -z "$projection_work" || ! -e "$projection_work" ]] || cleanup_failed=1
  [[ -z "$(docker ps -aq --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")" ]] || cleanup_failed=1
  [[ -z "$(docker volume ls -q --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")" ]] || cleanup_failed=1
  [[ -z "$(docker network ls -q --filter "label=dk.andersmadsen.ai-pin-revival.smoke-scope=$scope")" ]] || cleanup_failed=1
  if ((cleanup_failed)); then
    warn "isolated staging cleanup failed for scope $scope"
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

object_labels=(
  --label "dk.andersmadsen.ai-pin-revival.product=Ai Pin Revival"
  --label "dk.andersmadsen.ai-pin-revival.release=$release_id"
  --label "dk.andersmadsen.ai-pin-revival.temporary=staging-smoke"
  --label "dk.andersmadsen.ai-pin-revival.smoke-scope=$scope"
)

created_networks+=("$network")
docker network create --internal "${object_labels[@]}" "$network" >/dev/null
created_networks+=("$searxng_egress_network")
docker network create "${object_labels[@]}" "$searxng_egress_network" >/dev/null
for volume in "$state_volume" "$center_volume" "$pin_release_volume" "$postgres_volume" "$attest_volume" "$duc_volume" "$theme_volume" "$spotify_secret_volume"; do
  created_volumes+=("$volume")
  docker volume create "${object_labels[@]}" "$volume" >/dev/null
done

run_helper() {
  local purpose="$1"
  shift
  local name="${scope}-helper-${purpose}"
  # Every helper starts from a zero-capability root. Restore and copy helpers
  # must read operator-restricted (0600/0700) inputs and recreate the exact
  # recorded numeric owners and modes, which requires the classic file
  # capabilities and nothing else; inventory helpers only need to read
  # mixed-owner volume trees. no-new-privileges and the resource caps hold.
  local -a capability_flags=(--cap-drop ALL)
  case "$purpose" in
    restore-*|copy-*|center-owner)
      capability_flags+=(--cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH \
        --cap-add CHOWN --cap-add FOWNER --cap-add SETFCAP)
      ;;
    inventory-*)
      # reads mixed-owner volume trees and writes its archive into the
      # operator-owned 0700 projection workspace
      capability_flags+=(--cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH)
      ;;
    metrics-*|center-key-*)
      capability_flags+=(--cap-add DAC_READ_SEARCH)
      ;;
  esac
  created_containers+=("$name")
  docker run --name "$name" --rm --network none --log-driver none \
    --memory 256m --pids-limit 128 --cpus 1 "${capability_flags[@]}" \
    --security-opt no-new-privileges:true \
    "${object_labels[@]}" "$@"
}

volume_inventory() {
  local purpose="$1" volume="$2" output="$3"
  local archive="$projection_work/${purpose}.tar.gz"
  run_helper "inventory-${purpose}" -v "$volume:/source:ro" -v "$projection_work:/out" \
    "$helper_image" sh -euc "tar -czpf '/out/${purpose}.tar.gz' -C /source ."
  archive_inventory "$archive" "$output"
  rm -f -- "$archive"
}

directory_inventory() {
  local purpose="$1" directory="$2" output="$3"
  local archive="$projection_work/${purpose}.tar.gz"
  sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
    -czpf "$archive" -C "$directory" .
  sudo -n chown "$(id -u):$(id -g)" "$archive"
  chmod 600 "$archive"
  archive_inventory "$archive" "$output"
  rm -f -- "$archive"
}

projection_work="$(mktemp -d)"
chmod 700 "$projection_work"

# The stage was copied before quiescence from the same active roots named by
# the backup. Prove full content and metadata identity against the protected
# archive, rather than treating the presence of four familiar filenames as a
# trust-root proof.
staging_project_protected_root_inventory "$backup_dir/protected-inventory.json" \
  "$backup_attest_root" "$projection_work/attest-backup.inventory.json"
staging_project_protected_root_inventory "$backup_dir/protected-inventory.json" \
  "$backup_duc_root" "$projection_work/duc-backup.inventory.json"
directory_inventory attest-staged "$attest_dir" "$projection_work/attest-staged.inventory.json"
directory_inventory duc-staged "$duc_dir" "$projection_work/duc-staged.inventory.json"
compare_archive_inventories "$projection_work/attest-backup.inventory.json" \
  "$projection_work/attest-staged.inventory.json"
compare_archive_inventories "$projection_work/duc-backup.inventory.json" \
  "$projection_work/duc-staged.inventory.json"

# Restore archives without attaching either live durable volume. Numeric owners
# are retained exactly as recorded by backup.sh.
run_helper restore-state \
  -v "$state_volume:/restore" \
  -v "$backup_dir/cosmos-state.tar.gz:/backup/archive.tar.gz:ro" \
  "$helper_image" sh -euc \
  'tar -xzpf /backup/archive.tar.gz -C /restore'
run_helper restore-center \
  -v "$center_volume:/restore" \
  -v "$backup_dir/center-data.tar.gz:/backup/archive.tar.gz:ro" \
  "$helper_image" sh -euc \
  'tar -xzpf /backup/archive.tar.gz -C /restore'

run_helper copy-attest \
  -v "$attest_dir:/source:ro" -v "$attest_volume:/restore" \
  "$helper_image" sh -euc 'cp -a /source/. /restore/'
run_helper copy-duc \
  -v "$duc_dir:/source:ro" -v "$duc_volume:/restore" \
  "$helper_image" sh -euc 'cp -a /source/. /restore/'
run_helper copy-theme \
  -v "$keycloak_theme_dir:/source:ro" -v "$theme_volume:/restore" \
  "$helper_image" sh -euc 'cp -a /source/. /restore/'
run_helper copy-spotify-secret \
  -v "$spotify_token_file:/source/token:ro" -v "$spotify_secret_volume:/restore" \
  "$helper_image" sh -euc 'install -o 1000 -g 1001 -m 0400 /source/token /restore/spotify_adapter_token'

volume_inventory state-restored "$state_volume" "$projection_work/state-restored.inventory.json"
volume_inventory center-restored "$center_volume" "$projection_work/center-restored.inventory.json"
volume_inventory attest-restored "$attest_volume" "$projection_work/attest-restored.inventory.json"
volume_inventory duc-restored "$duc_volume" "$projection_work/duc-restored.inventory.json"
compare_archive_inventories "$backup_dir/cosmos-state.inventory.json" \
  "$projection_work/state-restored.inventory.json"
compare_archive_inventories "$backup_dir/center-data.inventory.json" \
  "$projection_work/center-restored.inventory.json"
compare_archive_inventories "$projection_work/attest-backup.inventory.json" \
  "$projection_work/attest-restored.inventory.json"
compare_archive_inventories "$projection_work/duc-backup.inventory.json" \
  "$projection_work/duc-restored.inventory.json"

created_containers+=("$postgres_container")
docker run --detach \
  --name "$postgres_container" \
  --network "$network" --network-alias postgres \
  --restart no \
  --memory 1g --pids-limit 256 --cpus 2 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  "${object_labels[@]}" \
  --env POSTGRES_USER=revival_restore_bootstrap \
  --env POSTGRES_DB=postgres \
  --env "POSTGRES_PASSWORD=$temporary_password" \
  --volume "$postgres_volume:/var/lib/postgresql/data" \
  --health-cmd 'pg_isready -U revival_restore_bootstrap -d postgres' \
  --health-interval 2s --health-timeout 3s --health-start-period 3s --health-retries 45 \
  "$postgres_image" >/dev/null

wait_healthy() {
  local container="$1" attempts="${2:-90}" state attempt
  for ((attempt=1; attempt<=attempts; attempt++)); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    [[ "$state" == exited || "$state" == dead ]] && break
    sleep 2
  done
  # The cleanup trap removes temporary containers, so surface the failing
  # container's last log lines and health probe output now or lose them.
  {
    echo "--- staging-smoke diagnostics: $container (state: ${state:-unknown}) ---"
    docker inspect --format '{{json .State.Health}}' "$container" 2>/dev/null | tail -c 2000
    echo
    docker logs --tail 120 "$container" 2>&1 | tail -c 8000
    echo "--- end diagnostics: $container ---"
  } >&2 || true
  fail "temporary service did not become healthy: $container"
}
wait_healthy "$postgres_container" 60

# capture_postgres_data, capture_postgres_schema and capture_postgres_security
# are DELIBERATELY NOT DEFINED HERE.
#
# They live in common.sh, which this file sources at line 16, and staging
# consumes those exact functions — see the header note above about not
# maintaining a second interpretation of the backup format. Every comparison
# below sets one of their outputs against a file backup.sh produced, so a local
# body would be a second definition of the format that only agrees with the
# producer's until one of them is edited. That is not hypothetical, twice over:
#
#   * A stale THREE-argument copy of capture_postgres_data used to sit at this
#     spot. Bash keeps the LAST definition, so it shadowed the canonical one and
#     silently discarded the `columns_source` fourth argument that the call
#     sites below already pass. `to_jsonb(t)` encodes the SCHEMA as well as the
#     data, so cosmos/migrations/0004_listing.sql adding
#     `cosmos_memory.thumbnail_count` (`ADD COLUMN IF NOT EXISTS` — additive, and
#     explicitly permitted by this project's migration policy) rewrote every
#     row's JSON and failed the deploy with "candidate startup changed
#     PostgreSQL relation data" while every wearer byte stood still.
#   * capture_postgres_schema and capture_postgres_security were then each
#     defined both here and in backup.sh, and the two schema bodies diverged
#     (this side grew the retained-.sql behaviour) while still emitting a
#     matching digest line — agreement by luck, until it wasn't.
#
# The staging captures pass `"$projection_work"` so the security scratch
# workspace lands inside this run's 0700 cleanup-swept directory, and
# `retain-sql` so the canonical pg_dump text is kept beside each digest line for
# classify_schema_delta in common.sh, which refuses to classify text that does
# not re-hash to the digest the gate compared.
# data-mutation-gates.test.mjs refuses a redefinition of any common.sh helper
# in this file or in backup.sh.

gunzip -c "$backup_dir/postgres-globals.sql.gz" \
  | docker exec -i "$postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
gunzip -c "$backup_dir/cosmos.sql.gz" \
  | docker exec -i "$postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
gunzip -c "$backup_dir/keycloak.sql.gz" \
  | docker exec -i "$postgres_container" psql -X -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d postgres >/dev/null
capture_postgres_security "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-security.restored.json" "$projection_work"
cmp -s "$backup_dir/postgres-security.json" "$projection_work/postgres-security.restored.json" \
  || fail "restored PostgreSQL roles, ownership, or grants differ from backup"
# COMPARISON (a) OF TWO — RESTORE FIDELITY. "Did the backup survive the round
# trip into this isolated cluster?" Production's manifest vs the freshly restored
# cluster, before any candidate code has started. Nothing has run yet, so any
# difference here arrived with the RESTORE and the candidate cannot be implicated.
#
# It is captured over THE FIDELITY MANIFEST'S OWN column sets. Both sides of this
# comparison must be digested over the same columns or it answers a question about
# column lists instead of about bytes — but they must be the FULL columns, because
# a restore that mangled a column is a broken backup no matter when that column
# arrived. backup_fidelity_data_manifest picks the unprojected manifest for the
# post-candidate backups deploy.sh takes projected, and postgres-data.tsv itself —
# which is the full live list — for every other backup. It is not a loosening: the
# restored schema is compared to the backup's byte-exactly three lines below, and a
# column that VANISHED in the restore breaks the projection and fails this capture
# outright.
#
# The `.columns` sidecar this writes — postgres-data.restored.tsv.columns — is
# what comparison (b) below projects onto. Do not merge (a) and (b): see the note
# at (b) for why they are different questions.
restore_fidelity_manifest="$(backup_fidelity_data_manifest "$backup_dir")"
capture_postgres_data "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-data.restored.tsv" "$restore_fidelity_manifest.columns"
cmp -s "$restore_fidelity_manifest" "$projection_work/postgres-data.restored.tsv" \
  || fail "restore fidelity: restored PostgreSQL relation data differs from the backup (the difference arrived with the RESTORE, before any candidate code ran; the candidate is not implicated)"
capture_postgres_schema "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-schema.restored.tsv" retain-sql
cmp -s "$backup_dir/postgres-schema.tsv" "$projection_work/postgres-schema.restored.tsv" \
  || fail "restore fidelity: restored PostgreSQL schema semantics differ from the backup (the difference arrived with the RESTORE, before any candidate code ran; the candidate is not implicated)"

smoke_db_count() {
  local database="$1" table="$2" exists
  [[ "$database" == cosmos || "$database" == keycloak ]] || fail "invalid smoke database"
  [[ "$table" =~ ^[a-z_]+$ ]] || fail "invalid smoke invariant table"
  exists="$(docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d "$database" -Atc \
    "select to_regclass('public.$table') is not null" | tr -d '[:space:]')"
  if [[ "$exists" == t ]]; then
    docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d "$database" -Atc \
      "select count(*) from $table" | tr -d '[:space:]'
  else
    printf '%s\n' -1
  fi
}

volume_metrics() {
  local purpose="$1" volume="$2"
  run_helper "$purpose" -v "$volume:/source:ro" "$helper_image" sh -euc \
    'files=$(find /source -type f | wc -l); bytes=$(find /source -type f -exec stat -c %s {} + | awk "{s+=\$1} END{print s+0}"); printf "%s %s\n" "$files" "$bytes"'
}

center_key_contract() {
  local purpose="$1"
  run_helper "center-key-${purpose}" -v "$center_volume:/source:ro" "$helper_image" sh -euc '
    if test -e /source/channel-key.json || test -L /source/channel-key.json; then
      test -f /source/channel-key.json && test ! -L /source/channel-key.json
      printf "present\t%s\t%s\t%s\n" \
        "$(sha256sum /source/channel-key.json | awk "{print \$1}")" \
        "$(stat -c %a /source/channel-key.json)" "$(stat -c %u:%g /source/channel-key.json)"
    else
      printf "absent\t-\t-\t-\n"
    fi'
}

compare_backup_invariants() {
  local phase="$1" owner_model="${2:-backup}" state_files state_bytes
  local center_presence center_digest center_mode center_owner key expected actual table
  [[ "$owner_model" == backup || "$owner_model" == runtime ]] \
    || fail "unknown Center invariant owner model"
  read -r state_files state_bytes < <(volume_metrics "metrics-${phase}" "$state_volume")
  IFS=$'\t' read -r center_presence center_digest center_mode center_owner \
    < <(center_key_contract "$phase")
  while IFS=$'\t' read -r key expected; do
    [[ -n "$key" ]] || continue
    case "$key" in
      contract.schema) actual="$BACKUP_INVARIANT_KIND" ;;
      contract.version) actual="$BACKUP_INVARIANT_VERSION" ;;
      db.*)
        table="${key#db.}"
        actual="$(smoke_db_count cosmos "$table")"
        ;;
      state.files) actual="$state_files" ;;
      state.bytes) actual="$state_bytes" ;;
      center.channel_key.presence) actual="$center_presence" ;;
      center.channel_key.sha256) actual="$center_digest" ;;
      center.channel_key.mode) actual="$center_mode" ;;
      center.channel_key.owner)
        actual="$center_owner"
        if [[ "$owner_model" == runtime && "$center_presence" == present ]]; then
          expected="$center_runtime_uid:$center_runtime_gid"
        fi
        ;;
      *) fail "unsupported backup invariant: $key" ;;
    esac
    [[ "$actual" == "$expected" ]] \
      || fail "$phase invariant changed: $key (expected $expected, got $actual)"
  done <"$backup_dir/invariants.tsv"
}

cosmos_tables="$(docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d cosmos -Atc \
  "select count(*) from pg_tables where schemaname='public'" | tr -d '[:space:]')"
keycloak_tables="$(docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d keycloak -Atc \
  "select count(*) from pg_tables where schemaname='public'" | tr -d '[:space:]')"
((cosmos_tables >= 10)) || fail "restored Cosmos database has too few tables"
((keycloak_tables >= 50)) || fail "restored Keycloak database has too few tables"

keycloak_realms_before="$(smoke_db_count keycloak realm)"
keycloak_users_before="$(smoke_db_count keycloak user_entity)"
keycloak_clients_before="$(smoke_db_count keycloak client)"
[[ "$keycloak_realms_before" != -1 && "$keycloak_realms_before" -gt 0 ]] \
  || fail "restored Keycloak database has no realms"
humane_realm_count="$(docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d keycloak -Atc \
  "select count(*) from realm where name='humane'" | tr -d '[:space:]')"
[[ "$humane_realm_count" == 1 ]] || fail "restored Keycloak database lacks the humane realm"

compare_backup_invariants restored

# The question this must answer is "did bringing the candidate up change any
# wearer DATA?" — but `to_jsonb(t)` encodes the SCHEMA too, so an additive
# migration rewrote every row's JSON and failed the deploy without a single
# wearer byte moving. That is not a hypothetical: `ADD COLUMN IF NOT EXISTS` is
# exactly what this project's migration policy permits, and store_postgres.rs
# asserts every migration is non-destructive and additive — so the two
# invariants contradicted each other and no schema change was deployable.
#
# The AFTER pass is therefore projected onto the columns that existed BEFORE.
# A new column is invisible; any change to a value that already existed, or a
# row appearing or disappearing, still changes the digest. Passing the before
# columns in also means a DROPPED column fails loudly (the projection errors)
# rather than quietly shrinking the comparison.
capture_wearer_fingerprints() {
  local output="$1" columns_source="${2:-}" key expected table digest columns
  : >"$output"
  : >"$output.columns"
  while IFS=$'\t' read -r key expected; do
    [[ "$key" == db.* ]] || continue
    table="${key#db.}"
    [[ "$table" =~ ^[a-z_]+$ ]] || fail "unsafe wearer table in backup invariant"
    if [[ "$expected" == -1 ]]; then
      printf '%s\tabsent\n' "$table" >>"$output"
      continue
    fi
    if [[ -n "$columns_source" ]]; then
      columns="$(awk -F'\t' -v want="$table" '$1 == want { print $2 }' "$columns_source")"
      [[ -n "$columns" ]] || fail "no recorded column set for wearer table $table"
    else
      columns="$(docker exec "$postgres_container" psql -X -qAt -v ON_ERROR_STOP=1 \
        -U revival_restore_bootstrap -d cosmos \
        -c "select string_agg(quote_ident(attname), ',' order by attnum)
              from pg_attribute
             where attrelid = '$table'::regclass and attnum > 0 and not attisdropped")"
    fi
    [[ "$columns" =~ ^[A-Za-z0-9_\",]+$ ]] || fail "unsafe wearer column list for $table"
    printf '%s\t%s\n' "$table" "$columns" >>"$output.columns"
    digest="$(docker exec "$postgres_container" psql -X -qAt -v ON_ERROR_STOP=1 \
      -U revival_restore_bootstrap -d cosmos \
      -c "set statement_timeout='10s'; select to_jsonb(x)::text from (select $columns from $table) x order by 1" \
      | sha256sum | awk '{print $1}')"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "wearer table fingerprint failed"
    # One digest PER ROW beside the whole-table one. When the table digest moves,
    # this is what turns "something in cosmos_memory changed" into "one row was
    # rewritten" or "a row vanished" — the difference between a diagnosis and
    # another deploy cycle spent guessing. Digests only, never values: this is
    # copied into a deployment record, and a wearer's rows do not belong there.
    # md5() is core PostgreSQL; sha256 would need pgcrypto, which is not
    # installed here. Errors are NOT silenced: a diagnostic that fails quietly
    # is how the previous attempt at this produced an empty evidence directory.
    if [[ -n "${WEARER_ROW_EVIDENCE:-}" ]]; then
      mkdir -p "$WEARER_ROW_EVIDENCE"
      docker exec "$postgres_container" psql -X -qAt -v ON_ERROR_STOP=1 \
        -U revival_restore_bootstrap -d cosmos \
        -c "set statement_timeout='30s'; select md5(to_jsonb(x)::text) from (select $columns from $table) x" \
        | LC_ALL=C sort >"$WEARER_ROW_EVIDENCE/$table.rows" \
        || fail "wearer row evidence failed for $table"
    fi
    printf '%s\t%s\n' "$table" "$digest" >>"$output"
  done <"$backup_dir/invariants.tsv"
  chmod 600 "$output" "$output.columns"
}
mkdir -p "$projection_work/rows-before" "$projection_work/rows-after"
WEARER_ROW_EVIDENCE="$projection_work/rows-before" \
  capture_wearer_fingerprints "$projection_work/wearer-fingerprints.before.tsv"

smoke_identity="$(docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U revival_restore_bootstrap -d cosmos -AtF $'\t' -c \
  'select device_id, account_sub from cosmos_device_account order by paired_at_epoch, device_id')"
[[ -n "$smoke_identity" && "$(printf '%s\n' "$smoke_identity" | sed '/^$/d' | wc -l | tr -d '[:space:]')" == 1 ]] \
  || fail "isolated restore has an ambiguous Pin roster"
IFS=$'\t' read -r smoke_device smoke_owner <<<"$smoke_identity"
keycloak_owner_count="$(docker exec -i "$postgres_container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -v "owner=$smoke_owner" -U revival_restore_bootstrap -d keycloak <<'SQL'
select count(*)
from user_entity u
join realm r on r.id=u.realm_id
where u.id=:'owner' and u.enabled is true and r.name='humane';
SQL
)"
keycloak_owner_count="$(printf '%s' "$keycloak_owner_count" | tr -d '[:space:]')"
[[ "$keycloak_owner_count" == 1 ]] \
  || fail "the exact paired owner is not an enabled user in the restored humane realm"
smoke_center_runtime="$projection_work/center.env"
# Compose env files provide interpolation, not wholesale container injection.
# Materialize the exact resolved production environment for each staged
# service, then apply only staging topology substitutions.
resolved_compose="$projection_work/resolved-compose.json"
"${COMPOSE[@]}" config --format json >"$resolved_compose"
chmod 600 "$resolved_compose"
python3 - "$resolved_compose" "$projection_work" "$smoke_owner" "$smoke_device" \
  "$searxng_settings_file" "$REMOTE_ROOT/data/pin-releases" <<'PY'
import json,os,re,sys
source,output,owner,device,searxng_settings,pin_release_source=sys.argv[1:]
body=json.load(open(source,encoding="utf-8")); services=body.get("services",{})
selected=["connectivity","ai-bus","account","contacts","feature-flags","notable-events","provisioning","center","keycloak","searxng"]
missing=[name for name in selected if name not in services]
if missing: raise SystemExit("resolved production Compose lacks a required staging service")
searxng=services["searxng"]
mounts=searxng.get("volumes") or []
if len(mounts)!=1:
    raise SystemExit("resolved SearXNG must have exactly one settings mount")
mount=mounts[0]
if (mount.get("type")!="bind" or os.path.realpath(str(mount.get("source", "")))!=os.path.realpath(searxng_settings)
        or mount.get("target")!="/etc/searxng/settings.yml" or mount.get("read_only") is not True):
    raise SystemExit("resolved SearXNG settings bind differs from the packaged release contract")
if set((searxng.get("networks") or {}).keys())!={"search-service","search-egress"}:
    raise SystemExit("resolved SearXNG network topology differs from the private-search contract")
ai_bus_networks=set((services["ai-bus"].get("networks") or {}).keys())
if "search-service" not in ai_bus_networks or "search-egress" in ai_bus_networks:
    raise SystemExit("resolved ai-bus search network topology bypasses private SearXNG")
environments={}
for name in selected:
    raw=services[name].get("environment") or {}
    env={str(k):str(v) for k,v in raw.items() if v is not None}
    if any("\n" in value or "\r" in value for value in env.values()):
        raise SystemExit("resolved service environment contains a newline")
    environments[name]=env
if not environments["searxng"].get("SEARXNG_SECRET"):
    raise SystemExit("resolved SearXNG secret is missing")
if any(environments[name].get("SEARXNG_SECRET") for name in selected if name!="searxng"):
    raise SystemExit("SearXNG secret escaped its service scope")
if environments["ai-bus"].get("COSMOS_SEARXNG_BASE_URL")!="http://searxng:8080":
    raise SystemExit("ai-bus does not use the private SearXNG alias")
edge_services=["ai-bus","account","contacts","feature-flags","notable-events","provisioning","center"]
edge_values={environments[name].get("COSMOS_EDGE_TOKEN","") for name in edge_services}
if len(edge_values)!=1 or "" in edge_values:
    raise SystemExit("Center and Cosmos do not share one resolved edge token")
provider=re.compile(r"^(?:AZURE_|COSMOS_AZURE_|COSMOS_LLM_|COSMOS_SERPAPI_KEY$|COSMOS_GOOGLE_MAPS_KEY$|COSMOS_PIRATE_WEATHER_KEY$|COSMOS_WOLFRAM_APP_ID$|COSMOS_PPLX_|COSMOS_MUSICBRAINZ_|COSMOS_SHOPPING_|OPENAI_|OPENROUTER_)")
for name in selected:
    if name!="ai-bus" and any(provider.match(key) and value for key,value in environments[name].items()):
        raise SystemExit("provider credentials escaped ai-bus scope")
provisioning=environments["provisioning"]
if provisioning.get("COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT")!="1" or not provisioning.get("COSMOS_OPAQUE_SEED"):
    raise SystemExit("resolved provisioning environment is not production-ready")
center=environments["center"]
if center.get("REVIVAL_PIN_BRIDGE_OWNER_SUB")!=owner or center.get("REVIVAL_PIN_BRIDGE_DEVICE_ID")!=device:
    raise SystemExit("resolved Center owner or device binding differs from durable pairing")
if center.get("REVIVAL_PIN_RELEASE_DIR")!="/var/lib/ai-pin-revival/pin-releases":
    raise SystemExit("resolved Center Pin release directory differs from the runtime contract")
if center.get("REVIVAL_PIN_SETUP_ORIGIN")!="https://center.andersmadsen.dk":
    raise SystemExit("resolved Center Pin Setup origin differs from the public Center origin")
pin_mounts=[mount for mount in services["center"].get("volumes") or []
            if mount.get("target")=="/var/lib/ai-pin-revival/pin-releases"]
if len(pin_mounts)!=1:
    raise SystemExit("resolved Center must have exactly one Pin release mount")
pin_mount=pin_mounts[0]
if (pin_mount.get("type")!="bind"
        or os.path.realpath(str(pin_mount.get("source", "")))!=os.path.realpath(pin_release_source)
        or pin_mount.get("read_only") is not True):
    raise SystemExit("resolved Center Pin release bind differs from the canonical read-only contract")
center["REVIVAL_SPOTIFY_ADAPTER_URL"]="http://spotify-adapter:18081"
center["REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE"]="/run/secrets/spotify_adapter_token"
# COSMOS_PRINCIPAL is a STAGING-ONLY injection and the second Center below runs
# without it. Center's requestMetadata() is a three-way branch — verified bearer,
# else this static principal, else anonymous — and no production deployment sets
# this variable (neither compose.yaml nor platform/compose/production.yaml does).
# With it set, the smoke exercises branch 2 while production runs branch 1 or 3,
# so a completely dead wearer bearer chain satisfied every `x-data-state == live`
# assertion here. Both projections are written so the difference between the two
# configurations becomes an asserted fact instead of an invisible one.
production_identity={key:value for key,value in center.items() if key!="COSMOS_PRINCIPAL"}
center["COSMOS_PRINCIPAL"]="U:"+owner
for name,env in environments.items():
    path=os.path.join(output,name+".env")
    with open(path,"w",encoding="utf-8") as target:
        for key in sorted(env): target.write(f"{key}={env[key]}\n")
    os.chmod(path,0o600)
production_identity_path=os.path.join(output,"center-production-identity.env")
with open(production_identity_path,"w",encoding="utf-8") as target:
    for key in sorted(production_identity): target.write(f"{key}={production_identity[key]}\n")
os.chmod(production_identity_path,0o600)
if "COSMOS_PRINCIPAL" in production_identity:
    raise SystemExit("the production Center projection still carries a static principal")
PY
rm -f -- "$resolved_compose"
env_files_for_center=(--env-file "$smoke_center_runtime")

created_containers+=("$keycloak_container")
docker run --detach \
  --name "$keycloak_container" \
  --network "$network" --network-alias keycloak \
  --restart no --init \
  --memory 1g --pids-limit 512 --cpus 2 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  --security-opt no-new-privileges:true \
  "${object_labels[@]}" \
  --env-file "$projection_work/keycloak.env" \
  --volume "$theme_volume:/opt/keycloak/themes/humane:ro" \
  --health-cmd "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q '\"status\"[[:space:]]*:[[:space:]]*\"UP\"' <&3" \
  --health-interval 3s --health-timeout 5s --health-start-period 30s --health-retries 40 \
  "$keycloak_image" start >/dev/null
wait_healthy "$keycloak_container" 90

created_containers+=("$searxng_container")
docker run --detach \
  --name "$searxng_container" --network "$network" --network-alias searxng \
  --user 977:977 --restart no --init --read-only \
  --tmpfs /tmp:size=64m,mode=1777,uid=977,gid=977 \
  --tmpfs /var/cache/searxng:size=128m,mode=0750,uid=977,gid=977 \
  --memory 512m --pids-limit 128 --cpus 1 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "${object_labels[@]}" \
  --env-file "$projection_work/searxng.env" \
  --volume "$searxng_settings_file:/etc/searxng/settings.yml:ro" \
  --health-cmd 'wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz' \
  --health-interval 3s --health-timeout 5s --health-start-period 15s --health-retries 30 \
  "$searxng_image" >/dev/null
docker network connect --gw-priority 1 "$searxng_egress_network" "$searxng_container"
wait_healthy "$searxng_container" 75
docker exec "$searxng_container" sh -euc '
  # SearXNG 2025.5 ignores one-shot `engines=`/`enabled_engines=` query
  # parameters here. Bang syntax is the engine selector its parser actually
  # enforces, so this proof must require GitHub attribution rather than merely
  # receiving results from the default ensemble. healthz can become ready just
  # before the first outbound engine request succeeds, so allow two short warm-up
  # retries without weakening the result or attribution requirements.
  github_probe_ok=0
  for attempt in 1 2 3; do
    if wget -q -T 20 -O /tmp/search-canary.json "http://127.0.0.1:8080/search?q=%21github+penumbraos&format=json"; then
      bytes=$(wc -c </tmp/search-canary.json)
      if test "$bytes" -gt 1 -a "$bytes" -le 1048576 \
        && python -c "import json; body=json.load(open(\"/tmp/search-canary.json\")); results=body.get(\"results\"); assert isinstance(results,list) and results; engines={engine for item in results for engine in ([item.get(\"engine\")]+(item.get(\"engines\") or [])) if engine}; assert engines == {\"github\"}"; then
        github_probe_ok=1
        break
      fi
    fi
    [ "$attempt" -ge 3 ] || sleep 2
  done
  if [ "$github_probe_ok" -ne 1 ]; then
    python -c "import json,sys; body=json.load(open(\"/tmp/search-canary.json\")); results=body.get(\"results\"); engines=sorted({engine for item in (results or []) for engine in ([item.get(\"engine\")]+(item.get(\"engines\") or [])) if engine}); print(\"github probe failed: results=%s engines=%s unresponsive=%s\" % (len(results) if isinstance(results,list) else None, engines, body.get(\"unresponsive_engines\")), file=sys.stderr)" || true
    exit 1
  fi
  wget -q -T 20 -O /tmp/search-default.json "http://127.0.0.1:8080/search?q=ai+pin+revival+canary&format=json&language=en"
  bytes=$(wc -c </tmp/search-default.json)
  test "$bytes" -gt 1 -a "$bytes" -le 1048576
  python -c "import json; body=json.load(open(\"/tmp/search-default.json\")); results=body.get(\"results\"); assert isinstance(results,list) and results; engines={engine for item in results for engine in ([item.get(\"engine\")]+(item.get(\"engines\") or [])) if engine}; assert engines <= {\"bing\",\"resulthunter\",\"searchch\",\"yandex\"}; assert \"bing\" in engines; assert engines & {\"resulthunter\",\"searchch\",\"yandex\"}"
  wget -q -T 20 -O /tmp/search-fallback.json "http://127.0.0.1:8080/search?q=%21resulthunter+%21yandex+%21searchch+ai+pin+revival+canary&format=json&language=en"
  bytes=$(wc -c </tmp/search-fallback.json)
  test "$bytes" -gt 1 -a "$bytes" -le 1048576
  python -c "import json; body=json.load(open(\"/tmp/search-fallback.json\")); results=body.get(\"results\"); assert isinstance(results,list) and results; engines={engine for item in results for engine in ([item.get(\"engine\")]+(item.get(\"engines\") or [])) if engine}; assert engines and engines <= {\"resulthunter\",\"searchch\",\"yandex\"}"
  rm -f /tmp/search-canary.json
  rm -f /tmp/search-default.json
  rm -f /tmp/search-fallback.json
'

cosmos_command='
/usr/local/bin/cosmos &
server_pid=$!
socat TCP-LISTEN:15051,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:50051 & grpc_proxy_pid=$!
socat TCP-LISTEN:18080,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:8080 & http_proxy_pid=$!
stop_all() {
  kill -TERM "$server_pid" "$grpc_proxy_pid" "$http_proxy_pid" 2>/dev/null || true
  wait "$server_pid" "$grpc_proxy_pid" "$http_proxy_pid" 2>/dev/null || true
}
trap stop_all INT TERM
set +e
wait "$server_pid"
status=$?
stop_all
exit "$status"'

common_cosmos_run=(
  --network "$network"
  --restart no --init --read-only
  --tmpfs /tmp:size=16m,mode=1777
  --cap-drop ALL --security-opt no-new-privileges:true
  --memory 768m --pids-limit 128 --cpus 1
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1
  "${object_labels[@]}"
  --env "REVIVAL_RELEASE_ID=$release_id"
  # Cosmos service-path revision is a DNS-label-style token capped at 63
  # characters; the full 64-hex release id does not fit. Use the same short
  # prefix the deploy stages as REVIVAL_REVISION.
  --env "COSMOS_REVISION=${release_id:0:16}"
  --volume "$state_volume:/var/lib/cosmos"
  --health-cmd 'curl --fail --silent --show-error --output /dev/null http://127.0.0.1:18080/readyz && socat -T1 - TCP:127.0.0.1:15051 </dev/null >/dev/null'
  --health-interval 3s --health-timeout 3s --health-start-period 5s --health-retries 30
  --entrypoint /bin/sh
)

created_containers+=("$ai_bus_container")
docker run --detach \
  --name "$ai_bus_container" --network-alias ai-bus \
  "${common_cosmos_run[@]}" \
  --memory 1536m \
  --env-file "$projection_work/ai-bus.env" \
  --env "COSMOS_INSTANCE_ID=ai-bus-smoke-${release_id:0:12}" \
  --env "COSMOS_POD_NAME=ai-bus-smoke-${release_id:0:12}" \
  --env COSMOS_WORKLOAD=ai-bus \
  --env COSMOS_ATTEST_CA_CERT=/etc/cosmos-attest/ca.crt \
  --env COSMOS_ATTEST_CA_KEY=/etc/cosmos-attest/ca.key \
  --volume "$attest_volume:/etc/cosmos-attest:ro" \
  "$cosmos_image" -ec "$cosmos_command" >/dev/null

created_containers+=("$provisioning_container")
docker run --detach \
  --name "$provisioning_container" --network-alias provisioning \
  "${common_cosmos_run[@]}" \
  --env-file "$projection_work/provisioning.env" \
  --env "COSMOS_INSTANCE_ID=provisioning-smoke-${release_id:0:12}" \
  --env "COSMOS_POD_NAME=provisioning-smoke-${release_id:0:12}" \
  --env COSMOS_WORKLOAD=provisioning \
  --env COSMOS_DUC_CA_CERT=/etc/cosmos-duc/duc-ca.crt \
  --env COSMOS_DUC_CA_KEY=/etc/cosmos-duc/duc-ca.key \
  --volume "$duc_volume:/etc/cosmos-duc:ro" \
  "$cosmos_image" -ec "$cosmos_command" >/dev/null

wait_healthy "$ai_bus_container" 75
wait_healthy "$provisioning_container" 75
ai_bus_user="$(docker inspect --format '{{.Config.User}}' "$ai_bus_container")"
provisioning_user="$(docker inspect --format '{{.Config.User}}' "$provisioning_container")"
[[ -n "$ai_bus_user" && -n "$provisioning_user" ]] || fail "candidate Cosmos image must declare a non-root runtime user"
docker exec --user "$ai_bus_user" "$ai_bus_container" sh -euc \
  'test -r /etc/cosmos-attest/ca.crt && test -r /etc/cosmos-attest/ca.key'
docker exec --user "$provisioning_user" "$provisioning_container" sh -euc \
  'test -r /etc/cosmos-duc/duc-ca.crt && test -r /etc/cosmos-duc/duc-ca.key'

start_plain_cosmos_workload() {
  local container="$1" alias="$2" workload="$3"
  created_containers+=("$container")
  docker run --detach \
    --name "$container" --network-alias "$alias" \
    "${common_cosmos_run[@]}" \
    --env-file "$projection_work/$workload.env" \
    --env "COSMOS_INSTANCE_ID=${workload}-smoke-${release_id:0:12}" \
    --env "COSMOS_POD_NAME=${workload}-smoke-${release_id:0:12}" \
    --env "COSMOS_WORKLOAD=$workload" \
    "$cosmos_image" -ec "$cosmos_command" >/dev/null
  wait_healthy "$container" 75
}
start_plain_cosmos_workload "$connectivity_container" connectivity connectivity
start_plain_cosmos_workload "$account_container" account account
start_plain_cosmos_workload "$contacts_container" contacts contacts
start_plain_cosmos_workload "$feature_flags_container" feature-flags feature-flags
start_plain_cosmos_workload "$notable_events_container" notable-events notable-events

# A closed synthetic Pin bridge exercises the exact adapter route/auth contract
# without touching the host bridge or any physical Pin. The adapter shares only
# this stub's network namespace; nothing is published to the host.
created_containers+=("$spotify_stub_container")
docker run --detach \
  --name "$spotify_stub_container" --network "$network" --network-alias spotify-adapter \
  --restart no --init --read-only --tmpfs /tmp:size=8m,mode=1777 \
  --memory 96m --pids-limit 64 --cpus 0.5 --log-driver none \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "${object_labels[@]}" \
  "$helper_image" node -e \
  "require('node:http').createServer((q,s)=>{if(q.method==='GET'&&q.url==='/api/spotify/status'){s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({enabled:true,experimental_acknowledged:true,state:'ready',device_name:'Staging Ai Pin',username:'staging',engine_ready:true}))}else{s.writeHead(404,{'content-type':'application/json'});s.end('{\"error\":\"not_found\"}')}}).listen(18080,'127.0.0.1')" \
  >/dev/null
spotify_stub_ip="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$spotify_stub_container")"
[[ "$spotify_stub_ip" =~ ^[0-9a-fA-F:.]+$ ]] || fail "synthetic Spotify bridge has no isolated address"

created_containers+=("$spotify_adapter_container")
docker run --detach \
  --name "$spotify_adapter_container" --network "container:$spotify_stub_container" \
  --restart no --init --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --memory 128m --pids-limit 128 --cpus 1 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "${object_labels[@]}" \
  --env "REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS=$spotify_stub_ip" \
  --env REVIVAL_SPOTIFY_ADAPTER_PORT=18081 \
  --env REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS=3000 \
  --env REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE=/run/secrets/spotify_adapter_token \
  --volume "$spotify_secret_volume:/run/secrets:ro" \
  --health-cmd 'node src/healthcheck.mjs' \
  --health-interval 2s --health-timeout 5s --health-start-period 3s --health-retries 30 \
  "$spotify_image" >/dev/null
wait_healthy "$spotify_adapter_container" 45
docker exec "$spotify_adapter_container" node -e \
  "fetch('http://'+process.env.REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS+':18081/api/spotify/status').then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$spotify_adapter_container" node -e \
  "const fs=require('node:fs');const token=fs.readFileSync('/run/secrets/spotify_adapter_token','utf8').trim();fetch('http://'+process.env.REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS+':18081/api/spotify/status',{headers:{authorization:'Bearer '+token}}).then(async r=>{const b=await r.json();if(!r.ok||b.state!=='ready'||b.engine_ready!==true)process.exit(1)}).catch(()=>process.exit(1))"

# The old installation may have recorded the channel key with root ownership.
# Correct only the disposable copy so the candidate Center's non-root user can
# prove decryption-key readability; archive bytes and all file invariants stay
# unchanged.
run_helper center-owner -v "$center_volume:/restore" "$helper_image" sh -euc \
  'if test -f /restore/channel-key.json; then chown "$1:$2" /restore/channel-key.json; fi' \
  sh "$center_runtime_uid" "$center_runtime_gid"
staging_write_runtime_center_inventory "$backup_dir/invariants.tsv" \
  "$backup_dir/center-data.inventory.json" "$projection_work/center-runtime.expected.json" \
  "$center_runtime_uid" "$center_runtime_gid"
volume_inventory center-runtime "$center_volume" "$projection_work/center-runtime.inventory.json"
compare_archive_inventories "$projection_work/center-runtime.expected.json" \
  "$projection_work/center-runtime.inventory.json"

created_containers+=("$center_container")
docker run --detach \
  --name "$center_container" \
  --network "$network" --network-alias center \
  --restart no --init --read-only \
  --user "$center_runtime_uid:$center_runtime_gid" \
  --tmpfs "/tmp:size=64m,mode=1777,uid=$center_runtime_uid,gid=$center_runtime_gid" \
  --tmpfs "/app/.next/cache:size=128m,mode=0750,uid=$center_runtime_uid,gid=$center_runtime_gid" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --pids-limit 256 --cpus 2 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  "${object_labels[@]}" \
  "${env_files_for_center[@]}" \
  --env "REVIVAL_RELEASE_ID=$release_id" \
  --env COSMOS_CHANNEL_KEY_FILE=/data/channel-key.json \
  --volume "$center_volume:/data" \
  --volume "$pin_release_volume:/var/lib/ai-pin-revival/pin-releases:ro" \
  --volume "$spotify_secret_volume:/run/secrets:ro" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:4000/api/version').then(r=>r.json()).then(v=>{if(v.release!==process.env.REVIVAL_RELEASE_ID)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 3s --health-timeout 5s --health-start-period 10s --health-retries 30 \
  "$center_image" >/dev/null
wait_healthy "$center_container" 75

assert_isolated_container() {
  local container="$1"
  shift
  docker inspect "$container" | python3 -c '
import json, sys

expected_network, scope, *allowed_volumes = sys.argv[1:]
body = json.load(sys.stdin)[0]
name = body.get("Name", "").lstrip("/")
if not name.startswith(scope + "-"):
    raise SystemExit("temporary container escaped its naming scope")
labels = body.get("Config", {}).get("Labels") or {}
if labels.get("dk.andersmadsen.ai-pin-revival.smoke-scope") != scope:
    raise SystemExit("temporary container lost its smoke-scope label")
bindings = body.get("HostConfig", {}).get("PortBindings") or {}
if bindings:
    raise SystemExit("temporary container publishes a host port")
host=body.get("HostConfig",{})
if int(host.get("Memory") or 0)<=0 or int(host.get("PidsLimit") or 0)<=0 or int(host.get("NanoCpus") or 0)<=0:
    raise SystemExit("temporary workload lacks resource bounds")
log=host.get("LogConfig") or {}; driver=log.get("Type")
if driver not in {"none","json-file"}: raise SystemExit("temporary workload has an unbounded log driver")
if driver=="json-file" and (log.get("Config") or {}).get("max-size")!="2m":
    raise SystemExit("temporary workload log size is not bounded")
networks = set((body.get("NetworkSettings", {}).get("Networks") or {}).keys())
if networks != {expected_network}:
    raise SystemExit("temporary container joined a non-smoke network")
allowed = set(allowed_volumes)
for mount in body.get("Mounts") or []:
    if mount.get("Type") == "tmpfs":
        continue
    if mount.get("Type") != "volume" or mount.get("Name") not in allowed:
        raise SystemExit("temporary workload uses a bind or non-smoke volume")
' "$network" "$scope" "$@"
}

assert_center_pin_release_mount() {
  docker inspect "$center_container" | python3 -c '
import json,sys
expected_volume=sys.argv[1]
body=json.load(sys.stdin)[0]
environment={entry.partition("=")[0]:entry.partition("=")[2]
             for entry in body.get("Config",{}).get("Env") or [] if "=" in entry}
if environment.get("REVIVAL_PIN_RELEASE_DIR")!="/var/lib/ai-pin-revival/pin-releases":
    raise SystemExit("temporary Center lost its Pin release directory contract")
if environment.get("REVIVAL_PIN_SETUP_ORIGIN")!="https://center.andersmadsen.dk":
    raise SystemExit("temporary Center lost its public Pin Setup origin")
mounts=[mount for mount in body.get("Mounts") or []
        if mount.get("Destination")=="/var/lib/ai-pin-revival/pin-releases"]
if len(mounts)!=1:
    raise SystemExit("temporary Center must have exactly one Pin release mount")
mount=mounts[0]
if mount.get("Type")!="volume" or mount.get("Name")!=expected_volume or mount.get("RW") is not False:
    raise SystemExit("temporary Center Pin release mount is not the scoped read-only volume")
' "$pin_release_volume"
}

assert_searxng_container() {
  docker inspect "$searxng_container" | python3 -c '
import json,os,re,sys
service_network,egress_network,scope,settings=sys.argv[1:]
body=json.load(sys.stdin)[0]
name=body.get("Name","").lstrip("/")
labels=body.get("Config",{}).get("Labels") or {}
host=body.get("HostConfig",{})
if not name.startswith(scope+"-") or labels.get("dk.andersmadsen.ai-pin-revival.smoke-scope")!=scope:
    raise SystemExit("temporary SearXNG escaped its smoke scope")
if (body.get("Config",{}).get("User")!="977:977" or not host.get("ReadonlyRootfs")
        or host.get("PortBindings")):
    raise SystemExit("temporary SearXNG lost its private non-root runtime contract")
if int(host.get("Memory") or 0)<=0 or int(host.get("PidsLimit") or 0)<=0 or int(host.get("NanoCpus") or 0)<=0:
    raise SystemExit("temporary SearXNG lacks resource bounds")
log=host.get("LogConfig") or {}
if log.get("Type")!="json-file" or (log.get("Config") or {}).get("max-size")!="2m":
    raise SystemExit("temporary SearXNG log is not bounded")
network_details=body.get("NetworkSettings",{}).get("Networks") or {}
networks=set(network_details)
if networks!={service_network,egress_network}:
    raise SystemExit("temporary SearXNG network topology differs from staging")
if int(network_details[egress_network].get("GwPriority") or 0)!=1:
    raise SystemExit("temporary SearXNG does not prefer its scoped egress gateway")
mounts=body.get("Mounts") or []
binds=[m for m in mounts if m.get("Type")=="bind"]
volumes=[m for m in mounts if m.get("Type")=="volume"]
if [m for m in mounts if m.get("Type") not in ("bind","volume")] or len(binds)!=1:
    raise SystemExit("temporary SearXNG has an unexpected mount")
# The searxng image declares VOLUME /etc/searxng; Docker materializes it as an
# anonymous local volume that the read-only settings bind is layered onto. This
# is identical in production, so permit exactly that image-declared anonymous
# volume and nothing named or foreign.
for volume in volumes:
    if (volume.get("Destination")!="/etc/searxng" or volume.get("Driver")!="local"
            or not re.fullmatch(r"[0-9a-f]{64}", str(volume.get("Name","")))):
        raise SystemExit("temporary SearXNG has an unexpected mount")
mount=binds[0]
if (os.path.realpath(str(mount.get("Source","")))!=os.path.realpath(settings)
        or mount.get("Destination")!="/etc/searxng/settings.yml" or mount.get("RW") is not False):
    raise SystemExit("temporary SearXNG does not use the packaged read-only settings file")
' "$network" "$searxng_egress_network" "$scope" "$searxng_settings_file"

  docker network inspect "$searxng_egress_network" | python3 -c '
import json,sys
expected=sys.argv[1]
containers=(json.load(sys.stdin)[0].get("Containers") or {})
if set(containers)!={expected}:
    raise SystemExit("SearXNG egress network is shared by another staging workload")
' "$(docker inspect --format '{{.Id}}' "$searxng_container")"
}

assert_shared_network_container() {
  local container="$1" owner="$2"
  shift 2
  docker inspect "$container" | python3 -c '
import json,sys
owner,scope,*allowed=sys.argv[1:]
body=json.load(sys.stdin)[0]; labels=body.get("Config",{}).get("Labels") or {}
if labels.get("dk.andersmadsen.ai-pin-revival.smoke-scope")!=scope: raise SystemExit("shared-network workload lost smoke label")
host=body.get("HostConfig",{})
if not str(host.get("NetworkMode","")).startswith("container:"): raise SystemExit("adapter did not share only its synthetic bridge namespace")
if int(host.get("Memory") or 0)<=0 or int(host.get("PidsLimit") or 0)<=0 or int(host.get("NanoCpus") or 0)<=0: raise SystemExit("adapter lacks resource bounds")
if host.get("PortBindings"): raise SystemExit("adapter publishes a host port")
if host.get("LogConfig",{}).get("Config",{}).get("max-size")!="2m": raise SystemExit("adapter log is not bounded")
allowed=set(allowed)
for mount in body.get("Mounts") or []:
    if mount.get("Type")!="volume" or mount.get("Name") not in allowed: raise SystemExit("adapter uses a non-smoke mount")
' "$owner" "$scope" "$@"
  owner_id="$(docker inspect --format '{{.Id}}' "$owner")"
  network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")"
  [[ "$network_mode" == "container:$owner_id" ]] || fail "adapter shares an unexpected network namespace"
}

assert_isolated_container "$postgres_container" "$postgres_volume"
assert_isolated_container "$keycloak_container" "$theme_volume"
assert_searxng_container
assert_isolated_container "$ai_bus_container" "$state_volume" "$attest_volume"
assert_isolated_container "$provisioning_container" "$state_volume" "$duc_volume"
assert_isolated_container "$connectivity_container" "$state_volume"
assert_isolated_container "$account_container" "$state_volume"
assert_isolated_container "$contacts_container" "$state_volume"
assert_isolated_container "$feature_flags_container" "$state_volume"
assert_isolated_container "$notable_events_container" "$state_volume"
assert_isolated_container "$spotify_stub_container"
assert_shared_network_container "$spotify_adapter_container" "$spotify_stub_container" "$spotify_secret_volume"
assert_isolated_container "$center_container" "$center_volume" "$pin_release_volume" "$spotify_secret_volume"
assert_center_pin_release_mount

docker exec "$ai_bus_container" curl --fail --silent --show-error --output /dev/null \
  http://127.0.0.1:8080/readyz
docker exec "$provisioning_container" curl --fail --silent --show-error --output /dev/null \
  http://127.0.0.1:8080/readyz
docker exec "$provisioning_container" sh -euc '
  test "$COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT" = 1
  test -n "$COSMOS_DATABASE_URL" -a -n "$COSMOS_ENROLLMENT_PINCODE" -a -n "$COSMOS_ENROLLMENT_USER_ID"
  decoded=$(printf %s "$COSMOS_OPAQUE_SEED" | base64 -d 2>/dev/null | wc -c)
  test "$decoded" = 32
'
opaque_schema_count="$(docker exec "$postgres_container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U revival_restore_bootstrap -d cosmos -c \
  "select count(*) from (values (to_regclass('public.cosmos_opaque_setup')),(to_regclass('public.cosmos_opaque_password_file')),(to_regclass('public.cosmos_opaque_login')),(to_regclass('public.cosmos_opaque_session'))) t(v) where v is not null" \
  | tr -d '[:space:]')"
[[ "$opaque_schema_count" == 4 ]] || fail "provisioning did not initialize its durable OPAQUE schema"
for container in "$connectivity_container" "$account_container" "$contacts_container" "$feature_flags_container" "$notable_events_container"; do
  docker exec "$container" curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8080/readyz
done
docker exec "$center_container" node -e \
  "Promise.all([fetch('http://127.0.0.1:4000/api/version').then(r=>r.json()),fetch('http://keycloak:8080/realms/humane/.well-known/openid-configuration').then(r=>{if(!r.ok)throw Error('oidc');return r.json()})]).then(([v,o])=>{if(v.release!==process.env.REVIVAL_RELEASE_ID||typeof o.issuer!=='string'||!o.issuer.startsWith('https://'))process.exit(1)}).catch(()=>process.exit(1))"
docker exec "$center_container" node -e \
  "(async()=>{const url='http://127.0.0.1:4000/api/pin/releases/current';for(const method of ['HEAD','GET']){const response=await fetch(url,{method,signal:AbortSignal.timeout(10000)});const bytes=Buffer.from(await response.arrayBuffer());if(response.status!==404||response.headers.get('cache-control')!=='no-store, max-age=0'||response.headers.get('x-content-type-options')!=='nosniff'||bytes.length>1024)throw Error('pin release boundary');if(method==='HEAD'&&bytes.length!==0)throw Error('pin release HEAD body');if(method==='GET'&&JSON.parse(bytes.toString()).error!=='Pin release not found.')throw Error('pin release empty-store response')}})().catch(()=>process.exit(1))"
if [[ "$(awk -F $'\t' '$1=="center.channel_key.presence" {print $2}' "$backup_dir/invariants.tsv")" == present ]]; then
  docker exec "$center_container" node -e \
    "const fs=require('node:fs');const body=JSON.parse(fs.readFileSync(process.env.COSMOS_CHANNEL_KEY_FILE,'utf8'));if(typeof body.kid!=='string'||!body.kid||typeof body.key!=='string'||Buffer.from(body.key,'base64').length!==16)process.exit(1)"
fi

# Mint a short-lived local Center session for the exact restored owner without
# contacting Keycloak or retaining any bearer token. The session and all wearer
# response bodies remain inside the mode-0700 smoke directory/container tmpfs.
session_file="$projection_work/session.jwt"
python3 - "$smoke_center_runtime" "$smoke_owner" "$session_file" <<'PY'
import base64,hashlib,hmac,json,sys,time
env_path,owner,output=sys.argv[1:]
values={}
for line in open(env_path,encoding="utf-8"):
    key,sep,value=line.rstrip("\n").partition("=")
    if sep: values[key]=value
secret=values.get("AUTH_SESSION_SECRET","")
if not secret: raise SystemExit("staged Center session secret is missing")
enc=lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
now=int(time.time())
header=enc(json.dumps({"alg":"HS256"},separators=(",",":")).encode())
payload=enc(json.dumps({"sub":owner,"email":"staging@invalid.local","name":"Staging owner","operator":True,"iat":now,"exp":now+600},separators=(",",":")).encode())
body=header+b"."+payload
token=body+b"."+enc(hmac.new(secret.encode(),body,hashlib.sha256).digest())
open(output,"wb").write(token+b"\n")
PY
chmod 600 "$session_file"
docker exec -i "$center_container" sh -euc 'umask 077; cat > /tmp/session.jwt' <"$session_file"
docker exec -i "$center_container" node >/dev/null <<'NODE'
const fs=require('node:fs');
const token=fs.readFileSync('/tmp/session.jwt','utf8').trim();
const cookie='cosmos_session='+token;
const endpoints={health:'/api/health',notes:'/api/capture/notes',memories:'/api/capture/memories',features:'/api/settings/features',spotify:'/api/settings/services/spotify'};
(async()=>{
  for(const [name,path] of Object.entries(endpoints)){
    const response=await fetch('http://127.0.0.1:4000'+path,{headers:{cookie},signal:AbortSignal.timeout(10000)});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!response.ok||bytes.length>2*1024*1024)throw Error('bounded Center read failed');
    if((name==='notes'||name==='memories')&&response.headers.get('x-data-state')!=='live')throw Error('Center data degraded');
    fs.writeFileSync('/tmp/smoke-'+name+'.json',bytes,{mode:0o600});
  }
})().catch(()=>process.exit(1));
NODE
for name in health notes memories features spotify; do
  docker exec "$center_container" sh -euc "cat /tmp/smoke-$name.json" >"$projection_work/$name.json"
  chmod 600 "$projection_work/$name.json"
done
expected_notes="$(awk -F $'\t' '$1=="db.cosmos_note"{print $2}' "$backup_dir/invariants.tsv")"
expected_memories="$(awk -F $'\t' '$1=="db.cosmos_memory"{print $2}' "$backup_dir/invariants.tsv")"
python3 - "$projection_work" "$expected_notes" "$expected_memories" <<'PY'
import json,sys
root,expected_notes,expected_memories=sys.argv[1:]
load=lambda name: json.load(open(root+"/"+name+".json",encoding="utf-8"))
health,notes,memories,features,spotify=map(load,("health","notes","memories","features","spotify"))
assert health.get("reachable") is True and health.get("state")=="live"
assert health.get("planes",{}).get("grpc",{}).get("state")=="live"
assert health.get("planes",{}).get("webapi",{}).get("state")=="live"
assert isinstance(notes.get("content"),list)
for key in ("photos","aiSessions","playTrackEvents","notes","phoneCalls","health"):
    assert isinstance(memories.get(key),list)
assert all(part.get("state")=="live" for part in memories.get("provenance",{}).values())
if int(expected_notes) > 0: assert notes.get("totalElements",0) > 0 and len(memories["notes"])>0
if int(expected_memories) > 0: assert sum(len(memories[key]) for key in ("photos","aiSessions","playTrackEvents","notes","phoneCalls"))>0
for note in notes["content"]:
    # Sealed rows are a legitimate durable state (content encrypted under a key
    # this deployment does not hold) and deliberately omit title and text; an
    # opened row must contain its decrypted text.
    assert note.get("sealed") in (True, False)
    if note.get("sealed") is False:
        assert isinstance(note.get("text"),str)
photos=[item for item in memories["photos"] if item.get("type")=="PHOTO" and item.get("uploadComplete") is True]
if photos:
    photo=photos[0]; assert photo.get("frameCount")==3 and photo.get("thumbnailCount",0)>=3
    assert isinstance(photo.get("bestFrameIndex"),int) and 0 <= photo["bestFrameIndex"] < 3
assert isinstance(features,list) and len(features)>0 and all(isinstance(item.get("name"),str) for item in features)
assert spotify.get("state")=="ready" and spotify.get("engine_ready") is True
PY
docker exec "$center_container" sh -euc 'rm -f /tmp/session.jwt /tmp/smoke-*.json'

# Pass 2: the SAME restored state, the SAME image, read through the exact Center
# environment production runs.
#
# Pass 1 above is the only `x-data-state == live` gate this deployment has, and
# it runs with COSMOS_PRINCIPAL injected into Center's environment — an identity
# no production deployment has. requestMetadata() is a three-way branch (verified
# bearer, else that static principal, else anonymous), so pass 1 exercises branch
# 2 while production takes branch 1 or 3: the wearer bearer chain could be 100%
# dead and every assertion above would still pass, satisfied by the static
# principal alone. That is the same failure shape as the already-fixed
# SessionExpiredError bug.
#
# A real sealed Keycloak bearer would let this pass assert `live` too. There
# isn't one — a staging gate must not hold a wearer credential — so this asserts
# the HONEST-FAILURE contract instead, which is still a real gate because the two
# planes fail differently without an identity:
#
#   * The REST (webapi) plane must stay LIVE: capture_api::principal_for falls
#     back to the demo account when nobody identified themselves, so a healthy
#     REST plane answers 200. A wrong COSMOS_WEBAPI_BASE_URL, a dead ai-bus HTTP
#     surface, or Center bearer plumbing that throws all flip it to degraded.
#   * The gRPC plane must be DEGRADED for the one specific reason "authenticated
#     edge principal required" — the workload correctly refusing an
#     identity-less call. A dead endpoint, an unloadable contracts directory or
#     an unregistered service produce different prose, and each of those is a
#     real outage this now fails on.
#
# The Center volume is mounted read-only here so this second reader cannot
# perturb the zero-delta inventory comparisons below. It cannot want to write
# anyway: channelKey() returns null before touching the key file when
# COSMOS_PRINCIPAL is unset, which is the production behaviour being reproduced.
created_containers+=("$center_production_identity_container")
docker run --detach \
  --name "$center_production_identity_container" \
  --network "$network" \
  --restart no --init --read-only \
  --user "$center_runtime_uid:$center_runtime_gid" \
  --tmpfs "/tmp:size=64m,mode=1777,uid=$center_runtime_uid,gid=$center_runtime_gid" \
  --tmpfs "/app/.next/cache:size=128m,mode=0750,uid=$center_runtime_uid,gid=$center_runtime_gid" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --pids-limit 256 --cpus 2 \
  --log-driver json-file --log-opt max-size=2m --log-opt max-file=1 \
  "${object_labels[@]}" \
  --env-file "$projection_work/center-production-identity.env" \
  --env "REVIVAL_RELEASE_ID=$release_id" \
  --env COSMOS_CHANNEL_KEY_FILE=/data/channel-key.json \
  --volume "$center_volume:/data:ro" \
  --volume "$pin_release_volume:/var/lib/ai-pin-revival/pin-releases:ro" \
  --volume "$spotify_secret_volume:/run/secrets:ro" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:4000/api/version').then(r=>r.json()).then(v=>{if(v.release!==process.env.REVIVAL_RELEASE_ID)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 3s --health-timeout 5s --health-start-period 10s --health-retries 30 \
  "$center_image" >/dev/null
wait_healthy "$center_production_identity_container" 75
assert_isolated_container "$center_production_identity_container" \
  "$center_volume" "$pin_release_volume" "$spotify_secret_volume"
docker exec "$center_production_identity_container" sh -euc \
  'test -z "${COSMOS_PRINCIPAL:-}"' \
  || fail "the production-identity Center still has a static principal"
# Minted fresh rather than reused: the pass-1 session is deliberately short-lived
# (10 minutes) and starting a second container can consume a good part of that.
# An expired session would answer 401 and be read here as the degraded-contract
# failure this pass exists to detect, which is exactly the kind of
# almost-right gate this whole change is about removing.
python3 - "$projection_work/center-production-identity.env" "$smoke_owner" "$session_file" <<'PY'
import base64,hashlib,hmac,json,sys,time
env_path,owner,output=sys.argv[1:]
values={}
for line in open(env_path,encoding="utf-8"):
    key,sep,value=line.rstrip("\n").partition("=")
    if sep: values[key]=value
secret=values.get("AUTH_SESSION_SECRET","")
if not secret: raise SystemExit("staged Center session secret is missing")
enc=lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
now=int(time.time())
header=enc(json.dumps({"alg":"HS256"},separators=(",",":")).encode())
payload=enc(json.dumps({"sub":owner,"email":"staging@invalid.local","name":"Staging owner","operator":True,"iat":now,"exp":now+600},separators=(",",":")).encode())
body=header+b"."+payload
token=body+b"."+enc(hmac.new(secret.encode(),body,hashlib.sha256).digest())
open(output,"wb").write(token+b"\n")
PY
chmod 600 "$session_file"
docker exec -i "$center_production_identity_container" sh -euc 'umask 077; cat > /tmp/session.jwt' <"$session_file"
docker exec -i "$center_production_identity_container" node >/dev/null <<'NODE'
const fs=require('node:fs');
const token=fs.readFileSync('/tmp/session.jwt','utf8').trim();
const cookie='cosmos_session='+token;
const endpoints={health:'/api/health',notes:'/api/capture/notes',memories:'/api/capture/memories',features:'/api/settings/features',wifi:'/api/settings/wifi'};
(async()=>{
  for(const [name,path] of Object.entries(endpoints)){
    const response=await fetch('http://127.0.0.1:4000'+path,{headers:{cookie},signal:AbortSignal.timeout(10000)});
    const bytes=Buffer.from(await response.arrayBuffer());
    // A wearer surface with a valid session and no sealed tokens answers 200 and
    // says so in the provenance header. A 401 or a 500 here is the failure this
    // pass exists to catch.
    if(response.status!==200||bytes.length>2*1024*1024)throw Error('honest degraded read failed: '+path+' -> '+response.status);
    fs.writeFileSync('/tmp/production-identity-'+name+'.json',JSON.stringify({
      state:response.headers.get('x-data-state'),
      body:JSON.parse(bytes.toString()),
    }),{mode:0o600});
  }
})().catch((error)=>{console.error(String(error && error.message));process.exit(1)});
NODE
for name in health notes memories features wifi; do
  docker exec "$center_production_identity_container" sh -euc "cat /tmp/production-identity-$name.json" \
    >"$projection_work/production-identity-$name.json"
  chmod 600 "$projection_work/production-identity-$name.json"
done
python3 - "$projection_work" <<'PY'
import json,sys
root=sys.argv[1]
load=lambda name: json.load(open(f"{root}/production-identity-{name}.json",encoding="utf-8"))
health,notes,memories,features,wifi=map(load,("health","notes","memories","features","wifi"))

planes=health["body"].get("planes") or {}
grpc=planes.get("grpc") or {}
webapi=planes.get("webapi") or {}
assert health["body"].get("cosmosConfigured") is True
assert set(planes)=={"grpc","webapi"}
assert webapi.get("configured") is True and webapi.get("state")=="live", (
    f"the REST plane is not live without a static principal: {webapi.get('detail')}"
)
assert grpc.get("configured") is True
detail=str(grpc.get("detail") or "")
assert grpc.get("state")=="degraded", (
    f"the gRPC plane answered {grpc.get('state')} with no wearer identity at all"
)
assert "authenticated edge principal required" in detail, (
    f"the gRPC plane did not degrade for the missing-identity reason: {detail}"
)
for broken in ("ENOENT","ECONNREFUSED","UNIMPLEMENTED","protocol definitions"):
    assert broken not in detail, f"the gRPC plane is genuinely broken: {detail}"

assert notes["state"]=="live", "the notes REST projection is not live"
assert memories["state"]=="degraded", (
    "the memories aggregate claimed a state its identity-less gRPC parts cannot support"
)
provenance=memories["body"].get("provenance") or {}
assert set(provenance)=={"captures","notes","aiMic","music","calls"}
for part in ("captures","notes"):
    assert provenance[part].get("state")=="live", f"REST-backed provenance part is not live: {part}"
for part in ("aiMic","music","calls"):
    assert provenance[part].get("state")=="degraded", f"gRPC-backed part should be degraded: {part}"

# The honest-failure contract in its purest form: a session with no sealed tokens
# gets 200 + degraded, never a 500 and never a silently "live" empty list.
assert wifi["state"]=="degraded", "the Wi-Fi pane did not honestly report a degraded read"
assert wifi["body"].get("networks")==[], "a degraded Wi-Fi read returned a network list"

# Features rides the admin token rather than the wearer bearer, so it resolves in
# both passes and proves this second Center really is wired to the same ai-bus.
# Pass 1 already asserts the restored deployment has flags; the 200 status is
# what matters here, since the route answers 503 when the admin fetch fails.
assert isinstance(features["body"],list), "the features pane did not receive a list"

# And the identity genuinely selects the partition: with the owner principal
# removed, the notes read resolves to the demo account, so it cannot return the
# same rows pass 1 returned. If it did, pass 1 never depended on the identity it
# was injecting and its "live" verdict proved nothing about a wearer.
pass_one=json.load(open(f"{root}/notes.json",encoding="utf-8"))
owner_uuids={item.get("uuid") for item in pass_one.get("content") or []}
if owner_uuids:
    fallback_uuids={item.get("uuid") for item in notes["body"].get("content") or []}
    assert owner_uuids!=fallback_uuids, (
        "the notes read returned the owner's rows with no owner identity present"
    )
PY
docker exec "$center_production_identity_container" sh -euc 'rm -f /tmp/session.jwt /tmp/production-identity-*.json'
# Removed as soon as it has answered, so the durable-state comparisons below run
# against the same single-reader footprint they always have. It stays registered
# in created_containers; the cleanup trap inspects before removing, so a
# second removal is a no-op.
docker rm --force --volumes "$center_production_identity_container" >/dev/null
warn "staging proves the honest-degraded contract without a wearer bearer; a sealed-bearer 'live' read remains unproven in the production identity projection"
unset smoke_identity smoke_device smoke_owner

[[ "$(smoke_db_count keycloak realm)" == "$keycloak_realms_before" ]] \
  || fail "Keycloak realm rows changed during isolated startup"
[[ "$(smoke_db_count keycloak user_entity)" == "$keycloak_users_before" ]] \
  || fail "Keycloak user rows changed during isolated startup"
[[ "$(smoke_db_count keycloak client)" == "$keycloak_clients_before" ]] \
  || fail "Keycloak client rows changed during isolated startup"
compare_backup_invariants healthy runtime
WEARER_ROW_EVIDENCE="$projection_work/rows-after" \
  capture_wearer_fingerprints "$projection_work/wearer-fingerprints.after.tsv" \
  "$projection_work/wearer-fingerprints.before.tsv.columns"
# Name the table that moved. The bare message cost a full deploy cycle to
# diagnose: it proves a wearer row changed but not which table, so the operator
# has to reason backwards from the whole candidate stack.
if ! cmp -s "$projection_work/wearer-fingerprints.before.tsv" \
            "$projection_work/wearer-fingerprints.after.tsv"; then
  # join needs sorted input; these are written in invariants.tsv order.
  changed_tables="$(join -t$'\t' -j 1 \
      <(sort "$projection_work/wearer-fingerprints.before.tsv") \
      <(sort "$projection_work/wearer-fingerprints.after.tsv") 2>/dev/null \
    | awk -F'\t' '$2 != $3 { printf "%s ", $1 }')"
  fail "candidate startup changed wearer table content: ${changed_tables:-<table set itself differs>}"
fi
# Byte-exact, deliberately, and NOT given the additive allowance the two gates
# around it get. An appended column and a new non-UNIQUE index are both invisible
# to capture_postgres_security — it enumerates relations of kind r/p/v/m/S/f, and
# an index is kind 'i', and it records column ACLs only where attacl is set, which
# a freshly added column has not — so a permitted additive migration does not move
# this file and there is nothing here to project or classify. A brand-new TABLE
# would move it (a new relation, and the composite type pg_type gains with it),
# and that is left to fail loudly: who owns a new relation and who may read it is
# a security decision, and nothing in this file proves a particular answer safe.
capture_postgres_security "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-security.after.json" "$projection_work"
cmp -s "$backup_dir/postgres-security.json" "$projection_work/postgres-security.after.json" \
  || fail "candidate startup changed PostgreSQL roles, ownership, grants, or schema metadata"
# COMPARISON (b) OF TWO — CANDIDATE MUTATION. "Did CANDIDATE STARTUP change
# data?" The baseline is the RESTORED cluster captured at (a), not production's
# backup manifest.
#
# Why the two are different questions, and must not be re-merged: this comparison
# used to run against "$backup_dir/postgres-data.tsv" — production — which spans
# the restore boundary and therefore answers "restored AND started, vs
# production", conflating a restore defect with a candidate defect. (a) already
# answers the restore half, and answers it first, so by the time control reaches
# here "restored == backup" is established. Baselining on the restored capture
# leaves exactly one variable — the candidate — so this failure can name the
# candidate without hedging. Merging them back means a restore bug and a
# candidate bug produce the same message again.
#
# Projected onto the columns the RESTORED capture was taken over, so an additive
# migration is not mistaken for the candidate rewriting wearer rows: `to_jsonb`
# encodes the schema too, and 0004_listing.sql's `ADD COLUMN IF NOT EXISTS
# cosmos_memory.thumbnail_count` would otherwise rewrite every row's JSON without a
# wearer byte moving. A changed value, a vanished row, and a DROPPED column all
# still fail — the projection only hides columns that did not exist before.
capture_postgres_data "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-data.after.tsv" \
  "$projection_work/postgres-data.restored.tsv.columns"
if ! cmp -s "$projection_work/postgres-data.restored.tsv" "$projection_work/postgres-data.after.tsv"; then
  # Keep the two manifests. They are the only evidence of WHICH value moved, and
  # $projection_work is a mktemp dir that vanishes with the run — so without this
  # a failure here proves something changed and then destroys the proof, which
  # costs a whole deploy cycle to re-observe.
  if [[ -n "${REVIVAL_STAGING_SMOKE_EVIDENCE:-}" ]]; then
    mkdir -p "$REVIVAL_STAGING_SMOKE_EVIDENCE" 2>/dev/null || true
    # "before" here means the RESTORED baseline this comparison is against, not
    # production's manifest — that is the pair whose difference is the candidate's
    # doing. Production's is kept too, as postgres-data.backup.tsv, so a reader of
    # the record can still see the restore half without re-running anything.
    cp -f "$projection_work/postgres-data.restored.tsv" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-data.before.tsv" 2>/dev/null || true
    cp -f "$projection_work/postgres-data.after.tsv" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-data.after.tsv" 2>/dev/null || true
    cp -f "$projection_work/postgres-data.restored.tsv.columns" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-data.before.tsv.columns" 2>/dev/null || true
    cp -f "$backup_dir/postgres-data.tsv" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-data.backup.tsv" 2>/dev/null || true
    # Which rows moved, as digests. Two counts and a per-row diff turn "something
    # changed" into "this many rows appeared, vanished, or were rewritten".
    for rows_before in "$projection_work"/rows-before/*.rows; do
      [[ -e "$rows_before" ]] || continue
      relation_name="$(basename "$rows_before" .rows)"
      rows_after="$projection_work/rows-after/$relation_name.rows"
      [[ -e "$rows_after" ]] || continue
      if ! cmp -s "$rows_before" "$rows_after"; then
        {
          printf 'relation\t%s\n' "$relation_name"
          printf 'rows_before\t%s\n' "$(wc -l <"$rows_before" | tr -d ' ')"
          printf 'rows_after\t%s\n' "$(wc -l <"$rows_after" | tr -d ' ')"
          printf 'only_before\t%s\n' "$(comm -23 "$rows_before" "$rows_after" | wc -l | tr -d ' ')"
          printf 'only_after\t%s\n' "$(comm -13 "$rows_before" "$rows_after" | wc -l | tr -d ' ')"
        } >"$REVIVAL_STAGING_SMOKE_EVIDENCE/$relation_name.rowdiff.tsv" 2>/dev/null || true
      fi
    done
    chmod 600 "$REVIVAL_STAGING_SMOKE_EVIDENCE"/*.rowdiff.tsv 2>/dev/null || true
    chmod 600 "$REVIVAL_STAGING_SMOKE_EVIDENCE"/postgres-data.* 2>/dev/null || true
  fi
  changed_relations="$(join -t$'\t' -j 1 \
      <(awk -F'\t' '{ printf "%s.%s.%s\t%s\t%s\n", $1, $2, $3, $5, $6 }' "$projection_work/postgres-data.restored.tsv" | sort) \
      <(awk -F'\t' '{ printf "%s.%s.%s\t%s\t%s\n", $1, $2, $3, $5, $6 }' "$projection_work/postgres-data.after.tsv" | sort) \
      2>/dev/null | awk -F'\t' '$2 != $4 || $3 != $5 { printf "%s ", $1 }')"
  fail "candidate mutation: candidate startup changed PostgreSQL relation data or sequence state: ${changed_relations:-<relation set itself differs>} (the difference arrived with the CANDIDATE, not the restore — the restore was proved byte-identical to the backup earlier in this run, and this comparison is against that restored baseline, projected onto its columns, so an additive migration is already excluded)"
fi
# Same two-questions split as the relation-data pair above: the restore half is
# already answered, against the backup, before any candidate code ran. Baseline
# this one on the RESTORED capture so its failure names the candidate and only
# the candidate.
#
# NOTE — this gate is NOT the same call as the relation-data gate above. There,
# projecting the AFTER capture onto the BEFORE columns is sound because the
# question is about VALUES: a column that did not exist cannot have held a
# wearer's byte. Here the schema IS the subject, so there is nothing to project
# away.
#
# The equality comparison below is unchanged and is still what decides whether
# anything moved. What follows it is the explicit decision the previous note in
# this spot asked for: an ADDITIVE-SCHEMA ALLOWANCE, classify_schema_delta (hoisted
# into common.sh with the full rationale, because deploy.sh's pre-commit zero-delta
# comparison and rollback.sh's legacy-eligibility check need exactly the same
# decision). It runs only after equality has already failed, and it either proves
# the delta is non-destructive — a column appended to an existing table with every
# pre-existing column byte-identical and in place, an entirely new table, a new
# non-UNIQUE index — and says so by name, or refuses and names the offending
# object. It is not a substring test and not a subset test: everything it does not
# prove additive is refused, including any change at all in keycloak.
capture_postgres_schema "$postgres_container" revival_restore_bootstrap \
  "$projection_work/postgres-schema.after.tsv" retain-sql
if ! cmp -s "$projection_work/postgres-schema.restored.tsv" "$projection_work/postgres-schema.after.tsv"; then
  # Same reasoning as the relation-data gate: $projection_work is a mktemp dir
  # that vanishes with the run, so a gate that proves the schema moved and then
  # destroys the dumps costs a whole deploy cycle to re-observe. The retained
  # pg_dump text is what makes the delta readable at all.
  if [[ -n "${REVIVAL_STAGING_SMOKE_EVIDENCE:-}" ]]; then
    mkdir -p "$REVIVAL_STAGING_SMOKE_EVIDENCE" 2>/dev/null || true
    cp -f "$projection_work/postgres-schema.restored.tsv" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-schema.before.tsv" 2>/dev/null || true
    cp -f "$projection_work/postgres-schema.after.tsv" \
      "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-schema.after.tsv" 2>/dev/null || true
    for schema_database in cosmos keycloak; do
      cp -f "$projection_work/postgres-schema.restored.tsv.$schema_database.sql" \
        "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-schema.before.tsv.$schema_database.sql" 2>/dev/null || true
      cp -f "$projection_work/postgres-schema.after.tsv.$schema_database.sql" \
        "$REVIVAL_STAGING_SMOKE_EVIDENCE/postgres-schema.after.tsv.$schema_database.sql" 2>/dev/null || true
    done
    chmod 600 "$REVIVAL_STAGING_SMOKE_EVIDENCE"/postgres-schema.* 2>/dev/null || true
  fi
  schema_allowance="$(classify_schema_delta \
    "$projection_work/postgres-schema.restored.tsv" \
    "$projection_work/postgres-schema.after.tsv")" \
    || fail "candidate mutation: candidate startup changed PostgreSQL schema semantics in a way that is NOT provably additive — the classifier's refusal above names the offending object and why it was refused (the difference arrived with the CANDIDATE, not the restore: the restore was proved schema-identical to the backup earlier in this run)"
  # Reached only when every difference was proved non-destructive. The classifier
  # composes the sentence itself so the deploy record states exactly which objects
  # were allowed, not merely that something was.
  log "candidate mutation: $schema_allowance"
fi

# Full post-start inventories include every entry's type, mode, uid, gid, size,
# content digest, and link target. Center's only allowed delta is the explicitly
# modeled disposable channel-key ownership correction above.
volume_inventory state-healthy "$state_volume" "$projection_work/state-healthy.inventory.json"
compare_archive_inventories "$backup_dir/cosmos-state.inventory.json" \
  "$projection_work/state-healthy.inventory.json"
volume_inventory center-healthy "$center_volume" "$projection_work/center-healthy.inventory.json"
compare_archive_inventories "$projection_work/center-runtime.expected.json" \
  "$projection_work/center-healthy.inventory.json"

log "isolated staging smoke passed for release $release_id using backup $(basename -- "$backup_dir")"
log "scope validated: restored databases/files, seven Cosmos workloads, SearXNG, Keycloak, Spotify adapter, and Center; no host ports or live durable volumes"
warn "staging smoke does not exercise the public edge, provider egress, a physical Pin, or a browser login flow"
