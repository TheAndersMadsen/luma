#!/usr/bin/bash
# Backup capture and verification: durable inputs, inventories, key
# material, invariants, and the artifact manifest.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

assert_durable_inputs() {
  local volume network_name
  for volume in "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME"; do
    volume_exists "$volume" || fail "required durable volume is missing: $volume"
  done
  network_name="$(docker network inspect --format '{{.Name}}' "$LOCAL_MODEL_NETWORK" 2>/dev/null)" \
    || fail "required local-model network is missing: $LOCAL_MODEL_NETWORK"
  [[ "$network_name" == "$LOCAL_MODEL_NETWORK" ]] \
    || fail "local-model network identity differs from the reviewed legacy resource"
  [[ -d "$CENTER_DATA_DIR" && ! -L "$CENTER_DATA_DIR" ]] \
    || fail "Center data directory is missing or unsafe"
}

# Docker's mount record proves the requested source path. This second check
# proves the running process sees that same host object at the container target.
# A replaced path or stale mount therefore cannot pass on matching strings.
assert_bind_mount_objects() {
  local container="$1" label="$2" state pid
  shift 2
  (($# >= 2 && $# % 2 == 0)) || fail "active $label bind-object check is malformed"
  state="$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$container" 2>/dev/null)" \
    || fail "active $label container state is unavailable"
  [[ "$state" =~ ^true\ [1-9][0-9]*$ ]] \
    || fail "active $label container is not running with one mount namespace"
  pid="${state#true }"
  sudo -n python3 -I -B - "$pid" "$@" <<'PY' \
    || fail "active $label container does not see the exact deployed bind objects"
import os,stat,sys

pid,*pairs=sys.argv[1:]
assert pid.isdigit() and int(pid)>0 and len(pairs)>=2 and len(pairs)%2==0
for source,destination in zip(pairs[::2],pairs[1::2]):
    assert os.path.isabs(source) and os.path.normpath(source)==source
    assert os.path.isabs(destination) and destination!="/" and os.path.normpath(destination)==destination
    host=os.lstat(source)
    mounted=os.lstat(f"/proc/{pid}/root{destination}")
    assert not stat.S_ISLNK(host.st_mode) and not stat.S_ISLNK(mounted.st_mode)
    assert stat.S_IFMT(host.st_mode) in (stat.S_IFREG,stat.S_IFDIR)
    assert (host.st_dev,host.st_ino,stat.S_IFMT(host.st_mode)) == \
           (mounted.st_dev,mounted.st_ino,stat.S_IFMT(mounted.st_mode))
PY
}

active_read_only_security_root() {
  local service="$1" first_destination="$2" second_destination="$3"
  local legacy_first_destination="$4" legacy_second_destination="$5"
  local first_name="$6" second_name="$7" canonical_root="$8" legacy_root="$9" label="${10}"
  local container project first_source second_source root
  container="$(active_service_container "$service")"
  project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
  case "$project" in
    "$PROJECT") ;;
    "$LEGACY_PROJECT")
      first_destination="$legacy_first_destination"
      second_destination="$legacy_second_destination"
      ;;
    *) fail "active $label container is outside the reviewed production projects" ;;
  esac
  first_source="$(docker inspect "$container" | python3 -c '
import json,sys
destination=sys.argv[1]; body=json.load(sys.stdin)
mounts=[item for item in body[0].get("Mounts",[]) if item.get("Destination")==destination]
assert len(mounts)==1 and mounts[0].get("Type")=="bind" and mounts[0].get("RW") is False
print(mounts[0].get("Source", ""))
' "$first_destination")" || fail "active $label certificate mount is not one reviewed read-only bind"
  second_source="$(docker inspect "$container" | python3 -c '
import json,sys
destination=sys.argv[1]; body=json.load(sys.stdin)
mounts=[item for item in body[0].get("Mounts",[]) if item.get("Destination")==destination]
assert len(mounts)==1 and mounts[0].get("Type")=="bind" and mounts[0].get("RW") is False
print(mounts[0].get("Source", ""))
' "$second_destination")" || fail "active $label key mount is not one reviewed read-only bind"
  [[ "$(basename -- "$first_source")" == "$first_name" \
    && "$(basename -- "$second_source")" == "$second_name" \
    && "$(dirname -- "$first_source")" == "$(dirname -- "$second_source")" ]] \
    || fail "active $label mounts do not share the reviewed root"
  root="$(dirname -- "$first_source")"
  [[ "$canonical_root" == "$legacy_root" && "$root" == "$canonical_root" ]] \
    || fail "active $label root is not the exact deployed legacy location"
  sudo -n test -d "$root" && ! sudo -n test -L "$root" \
    && sudo -n test -f "$first_source" && ! sudo -n test -L "$first_source" \
    && sudo -n test -f "$second_source" && ! sudo -n test -L "$second_source" \
    || fail "active $label root contains an unsafe object"
  assert_bind_mount_objects "$container" "$label security" \
    "$first_source" "$first_destination" "$second_source" "$second_destination"
  printf '%s\n' "$root"
}

active_attestation_root() {
  active_read_only_security_root ai-bus /etc/cosmos-attest/ca.crt /etc/cosmos-attest/ca.key \
    /etc/carry-attest/ca.crt /etc/carry-attest/ca.key \
    ca.crt ca.key "$PRODUCTION_ATTEST_DIR" "$LEGACY_ATTEST_DIR" attestation
}

active_device_user_root() {
  active_read_only_security_root provisioning /etc/cosmos-duc/duc-ca.crt /etc/cosmos-duc/duc-ca.key \
    /etc/carry-duc/duc-ca.crt /etc/carry-duc/duc-ca.key \
    duc-ca.crt duc-ca.key "$PRODUCTION_DUC_DIR" "$LEGACY_DUC_DIR" DeviceUser
}

active_edge_security_root() {
  local container project destination source expected
  local -a mounted_objects=()
  container="$(active_service_container edge)"
  project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
  case "$project" in "$PROJECT"|"$LEGACY_PROJECT") ;; *)
    fail "active edge container is outside the reviewed production projects" ;;
  esac
  while IFS=$'\t' read -r destination expected; do
    source="$(docker inspect "$container" | python3 -c '
import json,sys
destination=sys.argv[1]; body=json.load(sys.stdin)
mounts=[item for item in body[0].get("Mounts",[]) if item.get("Destination")==destination]
assert len(mounts)==1 and mounts[0].get("Type")=="bind" and mounts[0].get("RW") is False
print(mounts[0].get("Source", ""))
' "$destination")" || fail "active edge certificate mount is not one reviewed read-only bind"
    [[ "$source" == "$expected" ]] \
      || fail "active edge certificate mount does not use the exact deployed legacy inode path"
    mounted_objects+=("$source" "$destination")
  done <<EOF
$(if [[ "$project" == "$LEGACY_PROJECT" ]]; then
    printf '/etc/carry-edge/certs/server.crt\t%s/server.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/carry-edge/certs/server.key\t%s/server.key\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/carry-edge/certs/api-client-ca.crt\t%s/api-client-ca.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/carry-edge/certs/onboarding-client-ca.crt\t%s/onboarding-client-ca.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
  else
    printf '/etc/cosmos-edge/certs/server.crt\t%s/server.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/cosmos-edge/certs/server.key\t%s/server.key\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/cosmos-edge/certs/api-client-ca.crt\t%s/api-client-ca.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
    printf '/etc/cosmos-edge/certs/onboarding-client-ca.crt\t%s/onboarding-client-ca.crt\n' "$PRODUCTION_EDGE_CERT_DIR"
  fi)
EOF
  assert_bind_mount_objects "$container" "edge security" "${mounted_objects[@]}"
  printf '%s\n' "$LEGACY_EDGE_DIR"
}

assert_active_durable_mounts() {
  local service destination expected container type project active_project="" ai_bus network_attached
  while IFS=$'\t' read -r service destination expected type; do
    container="$(active_service_container "$service")"
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    [[ "$project" == "$PROJECT" || "$project" == "$LEGACY_PROJECT" ]] \
      || fail "active $service container is outside the reviewed production projects"
    if [[ -z "$active_project" ]]; then
      active_project="$project"
    else
      [[ "$project" == "$active_project" ]] \
        || fail "active durable services span multiple production projects"
    fi
    [[ "$destination" != '@state@' ]] || destination=/var/lib/carry
    docker inspect "$container" | python3 -c '
import json,sys
destination,kind,expected=sys.argv[1:]
body=json.load(sys.stdin)
assert isinstance(body,list) and len(body)==1
matches=[item for item in body[0].get("Mounts",[]) if item.get("Destination")==destination]
assert len(matches)==1
mount=matches[0]
assert mount.get("Type")==kind and mount.get("RW") is True
assert mount.get("Name" if kind=="volume" else "Source")==expected
' "$destination" "$type" "$expected" \
      || fail "active $service mount at $destination is not the one exact writable legacy source"
    if [[ "$type" == bind ]]; then
      assert_bind_mount_objects "$container" "$service data" "$expected" "$destination"
    fi
  done <<EOF
postgres	/var/lib/postgresql/data	$PG_VOLUME	volume
connectivity	@state@	$STATE_VOLUME	volume
ai-bus	@state@	$STATE_VOLUME	volume
account	@state@	$STATE_VOLUME	volume
contacts	@state@	$STATE_VOLUME	volume
feature-flags	@state@	$STATE_VOLUME	volume
notable-events	@state@	$STATE_VOLUME	volume
provisioning	@state@	$STATE_VOLUME	volume
prometheus	/prometheus	$PROMETHEUS_VOLUME	volume
grafana	/var/lib/grafana	$GRAFANA_VOLUME	volume
center	/data	$CENTER_DATA_DIR	bind
EOF
  ai_bus="$(active_service_container ai-bus)"
  network_attached="$(docker inspect --format "{{if index .NetworkSettings.Networks \"$LOCAL_MODEL_NETWORK\"}}$LOCAL_MODEL_NETWORK{{end}}" "$ai_bus")"
  [[ "$network_attached" == "$LOCAL_MODEL_NETWORK" ]] \
    || fail "active ai-bus is not attached to the reviewed legacy local-model network"
  active_attestation_root >/dev/null
  active_device_user_root >/dev/null
  active_edge_security_root >/dev/null
  assert_no_alternate_security_writers
  if [[ "$active_project" == "$LEGACY_PROJECT" ]]; then
    assert_global_durable_resource_holders legacy-only
  else
    assert_global_durable_resource_holders canonical-with-retained-legacy
  fi
}

assert_no_alternate_security_writers() {
  local -a containers=()
  mapfile -t containers < <(docker ps -aq --no-trunc)
  ((${#containers[@]} > 0)) || fail "production container inventory is empty"
  docker inspect "${containers[@]}" | python3 -c '
import json,os,sys
canonical,legacy=sys.argv[1:]
body=json.load(sys.stdin)
assert isinstance(body,list) and body
roots=("/home/anders/carry-edge/certs","/home/anders/carry-attest","/home/anders/carry-duc")
files={
    "edge":("server.crt","server.key","api-client-ca.crt","onboarding-client-ca.crt"),
    "ai-bus":("ca.crt","ca.key"),
    "provisioning":("duc-ca.crt","duc-ca.key"),
}
root_for={"edge":roots[0],"ai-bus":roots[1],"provisioning":roots[2]}
target_root={
    (canonical,"edge"):"/etc/cosmos-edge/certs", (legacy,"edge"):"/etc/carry-edge/certs",
    (canonical,"ai-bus"):"/etc/cosmos-attest", (legacy,"ai-bus"):"/etc/carry-attest",
    (canonical,"provisioning"):"/etc/cosmos-duc", (legacy,"provisioning"):"/etc/carry-duc",
}
allowed=set()
for (project,service),destination_root in target_root.items():
    for name in files[service]:
        allowed.add((project,service,root_for[service]+"/"+name,destination_root+"/"+name))

def overlaps(source,root):
    try: common=os.path.commonpath((source,root))
    except ValueError: return False
    return common in (source,root)

for container in body:
    labels=(container.get("Config") or {}).get("Labels") or {}
    project=labels.get("com.docker.compose.project")
    service=labels.get("com.docker.compose.service")
    for mount in container.get("Mounts") or []:
        if mount.get("Type")!="bind": continue
        source=mount.get("Source")
        if not isinstance(source,str) or not source.startswith("/"): continue
        if not any(overlaps(source,root) for root in roots): continue
        candidate=(project,service,source,mount.get("Destination"))
        assert candidate in allowed
        assert mount.get("RW") is False
' "$PROJECT" "$LEGACY_PROJECT" \
    || fail "a container has an unreviewed or writable path to deployed legacy security material"
}

# Close durable storage over the complete Docker inventory, not merely the
# active Compose view. A stopped duplicate is latent restart authority, and a
# bind of a Docker volume's host mountpoint (or any parent/child) bypasses the
# volume Name checks. Read-only alternates are refused too: production has one
# exact project/service/source/destination/RW grant for every durable holder.
assert_global_durable_resource_holders() {
  local topology="$1"
  local -a containers=()
  case "$topology" in
    legacy-only|canonical-with-retained-legacy) ;;
    *) fail "invalid durable-holder topology" ;;
  esac
  mapfile -t containers < <(docker ps -aq --no-trunc)
  ((${#containers[@]} > 0)) || fail "production container inventory is empty"
  python3 - "$PROJECT" "$LEGACY_PROJECT" "$topology" \
    "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME" \
    "$CENTER_DATA_DIR" \
    3< <(docker inspect "${containers[@]}") \
    4< <(docker volume inspect "$STATE_VOLUME" "$PG_VOLUME" \
      "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME") <<'PY' \
    || fail "a container has unreviewed or duplicate access to a legacy durable resource"
import json,os,sys

canonical,legacy,topology,state,pg,prometheus,grafana,center=sys.argv[1:]
containers=json.load(os.fdopen(3)); volume_body=json.load(os.fdopen(4))
volume_names=(state,pg,prometheus,grafana)
assert isinstance(containers,list) and containers
assert isinstance(volume_body,list) and len(volume_body)==len(volume_names)
volumes={item.get("Name"):item for item in volume_body if isinstance(item,dict)}
assert set(volumes)==set(volume_names)

def exact_absolute(value):
    return (isinstance(value,str) and value.startswith("/") and value!="/" and
            os.path.normpath(value)==value)

mountpoints={}
for name in volume_names:
    mountpoint=volumes[name].get("Mountpoint")
    assert exact_absolute(mountpoint)
    mountpoints[name]=mountpoint
assert len(set(mountpoints.values()))==len(mountpoints)
assert exact_absolute(center)

def overlaps(source,root):
    if not isinstance(source,str) or not source.startswith("/"): return False
    normalized=os.path.normpath(source)
    try: common=os.path.commonpath((normalized,root))
    except ValueError: return False
    return common in (normalized,root)

state_services=("connectivity","ai-bus","account","contacts","feature-flags",
                "notable-events","provisioning")
grants={
    "postgres":("volume",pg,"/var/lib/postgresql/data",True),
    "prometheus":("volume",prometheus,"/prometheus",True),
    "grafana":("volume",grafana,"/var/lib/grafana",True),
    "center":("bind",center,"/data",True),
}
for service in state_services:
    grants[service]=("volume",state,"/var/lib/carry",True)

allowed_projects={legacy} if topology=="legacy-only" else {canonical,legacy}
holders={}
for container in containers:
    assert isinstance(container,dict)
    identifier=container.get("Id")
    assert isinstance(identifier,str) and identifier
    labels=((container.get("Config") or {}).get("Labels") or {})
    project=labels.get("com.docker.compose.project")
    service=labels.get("com.docker.compose.service")
    relevant=0
    for mount in container.get("Mounts") or []:
        assert isinstance(mount,dict)
        kind=mount.get("Type"); name=mount.get("Name"); source=mount.get("Source")
        protected_name=kind=="volume" and name in mountpoints
        protected_path=(isinstance(source,str) and
                        (overlaps(source,center) or
                         any(overlaps(source,path) for path in mountpoints.values())))
        if not (protected_name or protected_path): continue
        relevant+=1
        assert project in allowed_projects
        assert service in grants
        expected_kind,expected_source,expected_destination,expected_rw=grants[service]
        assert kind==expected_kind and mount.get("Destination")==expected_destination
        assert mount.get("RW") is expected_rw
        if kind=="volume":
            assert name==expected_source and source==mountpoints[expected_source]
        else:
            assert source==expected_source
        key=(project,service)
        holders.setdefault(key,set()).add(identifier)
    # Every reviewed durable service owns exactly one protected mount. A second
    # exact mount in the same container is still alternate authority.
    assert relevant<=1

for (project,service),identifiers in holders.items():
    assert len(identifiers)==1
    if topology=="canonical-with-retained-legacy" and project==legacy:
        retained=[item for item in containers if item.get("Id") in identifiers]
        assert len(retained)==1 and (retained[0].get("State") or {}).get("Running") is False
PY
}

running_durable_writer_names() {
  local allowed_postgres="${1:-}" attest_root="${2:-}" duc_root="${3:-}"
  local ids=() allowed_id=""
  mapfile -t ids < <(docker ps -q)
  ((${#ids[@]})) || return 0
  if [[ -n "$allowed_postgres" ]]; then
    allowed_id="$(docker inspect --format '{{.Id}}' "$allowed_postgres")"
  fi
  [[ -n "$attest_root" ]] || attest_root="$(active_attestation_root)"
  [[ -n "$duc_root" ]] || duc_root="$(active_device_user_root)"
  python3 - "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" \
    "$GRAFANA_VOLUME" "$CENTER_DATA_DIR" "$attest_root" "$duc_root" "$allowed_id" \
    3< <(docker inspect "${ids[@]}") <<'PY'
import json,os,sys
state,pg,prometheus,grafana,center,attest,duc,allowed=sys.argv[1:]
volumes={state,pg,prometheus,grafana}; roots=[center,attest,duc]
body=json.load(os.fdopen(3)); names=[]
for container in body:
    identifier=container.get("Id",""); name=(container.get("Name") or "").removeprefix("/")
    holds=False
    for mount in container.get("Mounts",[]):
        if mount.get("RW") is not True: continue
        durable=mount.get("Type")=="volume" and mount.get("Name") in volumes
        source=mount.get("Source") or ""
        durable=durable or (mount.get("Type")=="bind" and any(source==root or source.startswith(root+os.sep) for root in roots))
        if not durable: continue
        if identifier==allowed and mount.get("Type")=="volume" and mount.get("Name")==pg: continue
        holds=True
    if holds: names.append(name)
for name in sorted(set(names)): print(name)
PY
}

assert_durable_writers_quiesced() {
  local allowed_postgres="${1:-}" attest_root="${2:-}" duc_root="${3:-}" holders
  holders="$(running_durable_writer_names "$allowed_postgres" "$attest_root" "$duc_root")"
  [[ -z "$holders" ]] || fail "durable RW holders remain active: ${holders//$'\n'/, }"
}

assert_reviewed_durable_writer_names() {
  local name project
  for name in "$@"; do
    [[ -n "$name" ]] || continue
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$name")"
    [[ "$project" == "$PROJECT" || "$project" == "$LEGACY_PROJECT" ]] \
      || fail "unreviewed container holds a production durable root: $name"
  done
}

# READ THE ARCHIVE ONCE, IN ARCHIVE ORDER. The output is unchanged — still every
# member, still sorted by member name, still the same digests — but the ACCESS
# PATTERN is the whole cost of this function on a real backup.
#
# `r:gz` over a gzip stream is random-access only by rewinding and re-inflating
# from byte zero, and iterating `sorted(getmembers())` asks for members in name
# order rather than the order they are stored in. Every out-of-order
# `extractfile` therefore replayed the decompression from the start, which is
# quadratic in the member count. It does not show on the volume archives — a few
# large files each — and it is brutal on postgres-data.tar.gz, which is a PGDATA
# tree of thousands of small relation segments: 79 SECONDS for 21 MB, measured
# twice per backup (once here, once over the re-tarred restore) and twice per
# deploy (baseline and post-candidate backups), all four of them inside the
# window where public ingress is down and the wearer's Pin is connection-refused.
#
# `r|gz` is the strictly sequential reader: one inflate pass, each member's bytes
# read while that member is current, which is exactly what hashing every member
# needs. The name sort moves to the end, over the finished items, keyed on the
# same member.name the old code sorted on — so the emitted JSON is byte-identical
# and every comparison built on it (compare_archive_inventories, the restore
# round-trips, assert_key_material_captured) asks the same question it did.
archive_inventory() {
  python3 - "$1" "$2" <<'PY'
import hashlib,json,posixpath,sys,tarfile
archive,output=sys.argv[1:]
items=[]
seen=set()
with tarfile.open(archive,"r|gz") as bundle:
    for member in bundle:
        path="." if member.name in (".","./") else member.name.removeprefix("./")
        if (not path or path.startswith("/") or "\\" in path
                or any(ord(char)<32 or 127<=ord(char)<=159 for char in path)
                or ".." in path.split("/") or posixpath.normpath(path)!=path):
            raise SystemExit(f"archive inventory contains an unsafe path: {path!r}")
        if path in seen: raise SystemExit(f"archive inventory contains a duplicate path: {path}")
        seen.add(path)
        acl={key.removeprefix("SCHILY.acl."):value for key,value in member.pax_headers.items()
            if key.startswith("SCHILY.acl.")}
        xattrs={key.removeprefix("SCHILY.xattr."):value for key,value in member.pax_headers.items()
            if key.startswith("SCHILY.xattr.")}
        item={
            "path":path,
            "type":member.type.decode("latin1") if isinstance(member.type,bytes) else str(member.type),
            "mode":oct(member.mode),
            "uid":member.uid,
            "gid":member.gid,
            "size":member.size,
            "acl":{key:acl[key] for key in sorted(acl)},
            "xattrs":{key:xattrs[key] for key in sorted(xattrs)},
        }
        if member.isfile():
            source=bundle.extractfile(member); digest=hashlib.sha256()
            for chunk in iter(lambda:source.read(1024*1024),b""): digest.update(chunk)
            source.close(); item["sha256"]=digest.hexdigest()
        elif member.issym() or member.islnk(): item["linkname"]=member.linkname
        items.append((member.name,item))
items.sort(key=lambda entry:entry[0])
items=[item for _,item in items]
if sum(item["path"]=="." for item in items)!=1:
    raise SystemExit("archive inventory must retain exactly one root '.' entry")
open(output,"w",encoding="utf-8").write(json.dumps(items,sort_keys=True,separators=(",",":")))
PY
  chmod 600 "$2"
}

validate_archive_inventory() {
  python3 - "$1" <<'PY'
import json,posixpath,re,sys
path=sys.argv[1]
try: body=json.load(open(path,encoding="utf-8"))
except (OSError,json.JSONDecodeError) as error: raise SystemExit(f"invalid archive inventory: {error}")
if not isinstance(body,list) or not body: raise SystemExit("archive inventory must be a non-empty array")
seen=set()
base={"path","type","mode","uid","gid","size","acl","xattrs"}
for item in body:
    if not isinstance(item,dict): raise SystemExit("archive inventory entry must be an object")
    keys=set(item); allowed=base|{"sha256","linkname"}
    if not base<=keys or not keys<=allowed: raise SystemExit("archive inventory entry schema mismatch")
    name=item["path"]
    if not isinstance(name,str) or not name or name in seen: raise SystemExit("archive inventory path is missing or duplicated")
    if (name.startswith("/") or "\\" in name or any(ord(char)<32 or 127<=ord(char)<=159 for char in name)
            or ".." in name.split("/") or posixpath.normpath(name)!=name):
        raise SystemExit("archive inventory path is unsafe")
    seen.add(name)
    if not isinstance(item["type"],str) or len(item["type"])!=1: raise SystemExit("archive inventory type is invalid")
    if not isinstance(item["mode"],str) or not re.fullmatch(r"0o[0-7]{1,4}",item["mode"]): raise SystemExit("archive inventory mode is invalid")
    for field in ("uid","gid","size"):
        if not isinstance(item[field],int) or isinstance(item[field],bool) or item[field]<0: raise SystemExit(f"archive inventory {field} is invalid")
    for field in ("acl","xattrs"):
        value=item[field]
        if not isinstance(value,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in value.items()):
            raise SystemExit(f"archive inventory {field} is invalid")
    if "sha256" in item and (not isinstance(item["sha256"],str) or not re.fullmatch(r"[0-9a-f]{64}",item["sha256"])):
        raise SystemExit("archive inventory digest is invalid")
    if "linkname" in item and not isinstance(item["linkname"],str): raise SystemExit("archive inventory link is invalid")
    if item["type"] in {"0","\x00"} and ("sha256" not in item or "linkname" in item):
        raise SystemExit("regular archive inventory entry has incomplete content identity")
    if item["type"] in {"1","2"} and ("linkname" not in item or "sha256" in item):
        raise SystemExit("linked archive inventory entry has incomplete target identity")
if "." not in seen: raise SystemExit("archive inventory root '.' is missing")
PY
}

compare_archive_inventories() {
  local expected="$1" actual="$2"
  validate_archive_inventory "$expected" || fail "expected archive inventory contract is invalid"
  validate_archive_inventory "$actual" || fail "actual archive inventory contract is invalid"
  cmp -s "$expected" "$actual" || fail "archive content or root metadata differs from the backup contract"
}

# sha256 of zero bytes. A digest pipeline that failed, or a file that exists but
# is empty, both land here, and both are indistinguishable from success unless
# the sentinel is rejected by name (the same collapse that makes the
# certificate/key pairing gates in preflight.sh pass having measured nothing).
EMPTY_SHA256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

# The four files whose loss is terminal for the installed Pin. The attestation
# root is pinned inside the shipped APKs, and the DeviceUser CA signs the client
# certificates Envoy checks, so neither can be re-minted after the fact: a
# device that already trusts them cannot be told to trust a replacement.
# Emitted as role<TAB>absolute path so both the presence proof and the archive
# proof read from one list.
key_material_paths() {
  local attest_root="$1" duc_root="$2"
  [[ -n "$attest_root" && -n "$duc_root" ]] || fail "key material roots are unavailable"
  printf 'attestation-ca-key\t%s/ca.key\n' "$attest_root"
  printf 'attestation-ca-cert\t%s/ca.crt\n' "$attest_root"
  printf 'device-user-ca-key\t%s/duc-ca.key\n' "$duc_root"
  printf 'device-user-ca-cert\t%s/duc-ca.crt\n' "$duc_root"
}

# Prove that an archive of the protected roots actually carries the irreplaceable
# key material, byte for byte, rather than merely containing the directories that
# ought to contain it. Archiving `$attest_dir` succeeds against an empty or
# partially readable directory, and every inventory round-trip downstream
# compares the archive with itself, so without this the backup reports success
# over a bundle that cannot rebuild the device plane. Failure here must stop the
# backup: a backup that silently lacks these keys is worse than no backup,
# because it is the thing an operator reaches for after losing the disk.
assert_key_material_captured() {
  local inventory="$1" archive="$2" attest_root="$3" duc_root="$4"
  local expected roles role path digest_line digest
  [[ -f "$inventory" && ! -L "$inventory" ]] || fail "key material inventory is missing or unsafe"
  [[ -f "$archive" && ! -L "$archive" ]] || fail "key material archive is missing or unsafe"
  validate_archive_inventory "$inventory" || fail "key material inventory contract is invalid"
  # Resolve the list before opening the temp file so a bad root fails with its
  # own message rather than as an empty expectation set.
  roles="$(key_material_paths "$attest_root" "$duc_root")" || fail "key material roots are unavailable"
  expected="$(mktemp)"
  while IFS=$'\t' read -r role path; do
    [[ -n "$role" && -n "$path" ]] || continue
    sudo -n test -f "$path" && ! sudo -n test -L "$path" \
      || { rm -f -- "$expected"; fail "irreplaceable key material is missing on the host: $role ($path)"; }
    # No pipeline here on purpose. `sudo ... | awk` reports awk's exit status,
    # so a failed read yields the empty-input digest on both sides of any later
    # comparison and the check passes having measured nothing.
    digest_line="$(sudo -n sha256sum -- "$path")" \
      || { rm -f -- "$expected"; fail "irreplaceable key material is unreadable: $role ($path)"; }
    digest="${digest_line%% *}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ && "$digest" != "$EMPTY_SHA256" ]] \
      || { rm -f -- "$expected"; fail "irreplaceable key material is empty or undigestible: $role ($path)"; }
    printf '%s\t%s\t%s\n' "$role" "${path#/}" "$digest" >>"$expected"
  done <<<"$roles"
  python3 - "$inventory" "$archive" "$expected" <<'PY' || { rm -f -- "$expected"; fail "backup does not contain the irreplaceable key material"; }
import hashlib,json,sys,tarfile
inventory,archive,expected_path=sys.argv[1:]
def normalize(name):
    return name.removeprefix("./").removeprefix("/")
expected={}
for line in open(expected_path,encoding="utf-8"):
    if not line.strip(): continue
    role,member,digest=line.rstrip("\n").split("\t")
    expected[normalize(member)]=(role,digest)
if len(expected)!=4: raise SystemExit("key material list is incomplete")
items={normalize(item["path"]):item for item in json.load(open(inventory,encoding="utf-8"))}
for member,(role,digest) in sorted(expected.items()):
    item=items.get(member)
    if item is None:
        raise SystemExit(f"irreplaceable key material is absent from the archive inventory: {role} ({member})")
    if item["type"] not in {"0","\x00"} or "sha256" not in item:
        raise SystemExit(f"archived key material is not a regular file: {role} ({member})")
    if item["size"]<=0:
        raise SystemExit(f"archived key material is empty: {role} ({member})")
    if item["sha256"]!=digest:
        raise SystemExit(f"archived key material differs from the live key: {role} ({member})")
# Read the archive itself as well. The inventory is derived from this archive,
# so an inventory-only check would confirm a copy against its own description;
# only re-hashing the member bytes proves the key is recoverable from the file
# an operator would actually restore from.
found=set()
with tarfile.open(archive,"r:gz") as bundle:
    for member in bundle:
        name=normalize(member.name)
        if name not in expected: continue
        role,digest=expected[name]
        if not member.isfile():
            raise SystemExit(f"archived key material is not a regular member: {role} ({name})")
        stream=bundle.extractfile(member); computed=hashlib.sha256()
        for chunk in iter(lambda:stream.read(1024*1024),b""): computed.update(chunk)
        stream.close()
        if computed.hexdigest()!=digest:
            raise SystemExit(f"archived key material bytes differ from the live key: {role} ({name})")
        found.add(name)
missing=sorted(set(expected)-found)
if missing: raise SystemExit(f"irreplaceable key material is absent from the archive: {missing}")
PY
  rm -f -- "$expected"
}

write_running_identity_state() {
  local output="$1" names_file="$2" name
  : >"$output"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    docker inspect --format '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Image}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.service"}}' "$name" \
      | sed 's#\t/#\t#' >>"$output"
  done <"$names_file"
  LC_ALL=C sort -o "$output" "$output"
}

write_running_mount_state() {
  local output="$1" names_file="$2" name
  : >"$output"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    docker inspect --format '{{range .Mounts}}{{.Type}}{{"\t"}}{{.Name}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\t"}}{{.RW}}{{"\n"}}{{end}}' "$name" \
      | sed "s#^#$name\t#" >>"$output"
  done <"$names_file"
  LC_ALL=C sort -o "$output" "$output"
}

record_project_state() {
  local output="$1"
  mkdir -p "$output"
  : >"$output/containers.tsv"
  : >"$output/running-containers.txt"
  local project
  for project in "$LEGACY_PROJECT" "$PROJECT"; do
    docker ps -a --filter "label=com.docker.compose.project=$project" \
      --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Labels}}' \
      >>"$output/containers.tsv"
    docker ps --filter "label=com.docker.compose.project=$project" \
      --format '{{.Names}}' >>"$output/running-containers.txt"
  done
  LC_ALL=C sort -u -o "$output/running-containers.txt" "$output/running-containers.txt"
  write_running_identity_state "$output/running-identities.tsv" "$output/running-containers.txt"
  write_running_mount_state "$output/mounts.tsv" "$output/running-containers.txt"
  for volume in "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME"; do
    docker volume inspect "$volume"
  done >"$output/volumes.json"
  chmod 600 "$output"/*
}

verify_recorded_application_identity() {
  local snapshot="$1" current project status
  for file in running-containers.txt running-identities.tsv mounts.tsv; do
    [[ -f "$snapshot/$file" ]] || return 1
  done
  current="$(mktemp -d)" || return 1
  : >"$current/running-containers.txt"
  for project in "$LEGACY_PROJECT" "$PROJECT"; do
    docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}' \
      >>"$current/running-containers.txt" || { rm -rf -- "$current"; return 1; }
  done
  LC_ALL=C sort -u -o "$current/running-containers.txt" "$current/running-containers.txt"
  cmp -s "$snapshot/running-containers.txt" "$current/running-containers.txt" \
    || { rm -rf -- "$current"; return 1; }
  write_running_identity_state "$current/running-identities.tsv" "$current/running-containers.txt" \
    || { rm -rf -- "$current"; return 1; }
  write_running_mount_state "$current/mounts.tsv" "$current/running-containers.txt" \
    || { rm -rf -- "$current"; return 1; }
  if cmp -s "$snapshot/running-identities.tsv" "$current/running-identities.tsv" \
      && cmp -s "$snapshot/mounts.tsv" "$current/mounts.tsv"; then
    status=0
  else
    status=1
  fi
  rm -rf -- "$current"
  return "$status"
}

state_file_count() {
  docker run --pull=never --rm -v "$STATE_VOLUME:/source:ro" "$HELPER_IMAGE" \
    sh -euc 'find /source -type f | wc -l' | tr -d '[:space:]'
}

state_byte_count() {
  docker run --pull=never --rm -v "$STATE_VOLUME:/source:ro" "$HELPER_IMAGE" \
    sh -euc 'find /source -type f -exec stat -c %s {} + | awk "{s+=\$1} END{print s+0}"' | tr -d '[:space:]'
}

database_count() {
  local container="$1" database="$2" table="$3"
  [[ "$table" =~ ^[a-z_]+$ ]] || fail "invalid invariant table"
  local exists
  exists="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U "$LEGACY_DATABASE_USER" -d "$database" -Atc "select to_regclass('public.$table') is not null" | tr -d '[:space:]')"
  if [[ "$exists" == t ]]; then
    docker exec "$container" psql -v ON_ERROR_STOP=1 -U "$LEGACY_DATABASE_USER" -d "$database" -Atc "select count(*) from $table" | tr -d '[:space:]'
  else
    printf '%s\n' -1
  fi
}

write_invariants() {
  local output="$1" container="$2" table count
  : >"$output"
  printf 'contract.schema\t%s\n' "$BACKUP_INVARIANT_KIND" >>"$output"
  printf 'contract.version\t%s\n' "$BACKUP_INVARIANT_VERSION" >>"$output"
  for table in carry_channel_key carry_contact carry_contact_encrypted carry_contact_tombstone \
    carry_memory carry_note carry_event carry_device_account; do
    count="$(database_count "$container" "$LEGACY_DATABASE_NAME" "$table")"
    printf 'db.%s\t%s\n' "$table" "$count" >>"$output"
  done
  printf 'state.files\t%s\n' "$(state_file_count)" >>"$output"
  printf 'state.bytes\t%s\n' "$(state_byte_count)" >>"$output"
  if [[ -e "$CENTER_DATA_DIR/channel-key.json" || -L "$CENTER_DATA_DIR/channel-key.json" ]]; then
    [[ -f "$CENTER_DATA_DIR/channel-key.json" && ! -L "$CENTER_DATA_DIR/channel-key.json" ]] \
      || fail "Center channel key is not a regular non-symlink file"
    printf 'center.channel_key.presence\tpresent\n' >>"$output"
    # Pre-migration the key is root-owned 0600; hash through the same sudo
    # boundary as the metadata migration when direct reads are denied.
    local -a channel_key_sha=(sha256sum)
    [[ -r "$CENTER_DATA_DIR/channel-key.json" ]] || channel_key_sha=(sudo -n sha256sum)
    printf 'center.channel_key.sha256\t%s\n' "$("${channel_key_sha[@]}" "$CENTER_DATA_DIR/channel-key.json" | awk '{print $1}')" >>"$output"
    printf 'center.channel_key.mode\t%s\n' "$(stat -c '%a' "$CENTER_DATA_DIR/channel-key.json")" >>"$output"
    printf 'center.channel_key.owner\t%s\n' "$(stat -c '%u:%g' "$CENTER_DATA_DIR/channel-key.json")" >>"$output"
  else
    printf 'center.channel_key.presence\tabsent\n' >>"$output"
    printf 'center.channel_key.sha256\t-\n' >>"$output"
    printf 'center.channel_key.mode\t-\n' >>"$output"
    printf 'center.channel_key.owner\t-\n' >>"$output"
  fi
  chmod 600 "$output"
}

validate_center_channel_key_json() {
  # The pre-migration channel key is root-owned mode 0600 by design; the
  # channel-key metadata transaction migrates ownership during cutover. Read
  # it with the same sudo boundary as the migration when it is not readable.
  local -a channel_key_python=(python3)
  [[ -r "$1" ]] || channel_key_python=(sudo -n python3)
  "${channel_key_python[@]}" - "$1" <<'PY'
import base64,binascii,json,os,re,stat,sys
path=sys.argv[1]
try:
    before=os.lstat(path)
except OSError as error:
    raise SystemExit(f"Center channel key is unavailable: {error}")
if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
    raise SystemExit("Center channel key must be a regular non-symlink file")
flags=os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)
descriptor=os.open(path,flags)
try:
    opened=os.fstat(descriptor)
    if (opened.st_dev,opened.st_ino,opened.st_size)!=(before.st_dev,before.st_ino,before.st_size):
        raise SystemExit("Center channel key changed before validation")
    if opened.st_size<1 or opened.st_size>16384: raise SystemExit("Center channel key has an invalid size")
    body=os.read(descriptor,opened.st_size+1)
    if len(body)!=opened.st_size: raise SystemExit("Center channel key changed while reading")
finally:
    os.close(descriptor)
after=os.lstat(path)
if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)!=(
        before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns):
    raise SystemExit("Center channel key changed during validation")
def pairs(values):
    result={}
    for key,value in values:
        if key in result: raise ValueError(f"duplicate field: {key}")
        result[key]=value
    return result
try:
    document=json.loads(body.decode("utf-8"),object_pairs_hook=pairs)
except (UnicodeDecodeError,json.JSONDecodeError,ValueError) as error:
    raise SystemExit(f"Center channel key JSON is invalid: {error}")
# `keys` is the per-wearer map. Center used to hold ONE process-global channel
# key, which sealed every wearer's notes under one kid; it now keeps a key per
# wearer and mirrors the legacy pair at the top level for readers that predate
# the map. Accepting only {kid,key} rejected the very first file Center wrote
# after that change -- and because this same validator guards backup, cutover
# AND restore, it would have failed every deploy and closed the recovery path
# out of the release that caused it. Each map entry is held to exactly the rules
# the legacy pair is held to.
if not isinstance(document,dict) or set(document)-{"keys"}!={"kid","key"}:
    raise SystemExit("Center channel key JSON must contain kid and key, and may contain keys")
def check_kid(kid,label):
    if (not isinstance(kid,str) or not kid or len(kid.encode("utf-8"))>1024
            or any(ord(char)<32 or 127<=ord(char)<=159 for char in kid)):
        raise SystemExit(f"{label} kid is invalid")
    suffix="/center/ephemeral"
    if not kid.endswith(suffix): raise SystemExit(f"{label} kid is not a complete Center kid")
    principal=kid[:-len(suffix)]
    if len(principal.encode("utf-8"))>128: raise SystemExit(f"{label} principal is oversized")
    component=r"[A-Za-z0-9._-]+"
    if (re.fullmatch(rf"U:{component}",principal) is None
            and re.fullmatch(rf"V:[0-9A-Fa-f]{{2}}:D:{component}:U:{component}",principal) is None):
        raise SystemExit(f"{label} kid has an unsupported principal")
def check_key(encoded,label):
    if not isinstance(encoded,str): raise SystemExit(f"{label} value is not base64 text")
    try: key=base64.b64decode(encoded,validate=True)
    except (binascii.Error,ValueError) as error: raise SystemExit(f"{label} is not valid base64: {error}")
    if len(key)!=16 or base64.b64encode(key).decode("ascii")!=encoded:
        raise SystemExit(f"{label} must be canonical base64 for exactly 16 AES-128 bytes")
check_kid(document["kid"],"Center channel key")
check_key(document["key"],"Center channel key")
mapped=document.get("keys",{})
if not isinstance(mapped,dict): raise SystemExit("Center channel key map must be an object")
if len(mapped)>256: raise SystemExit("Center channel key map is implausibly large")
for mapped_kid,mapped_key in mapped.items():
    check_kid(mapped_kid,"Center channel key map entry")
    check_key(mapped_key,"Center channel key map entry")
PY
}

validate_backup_invariants() {
  python3 - "$1" "$BACKUP_INVARIANT_KIND" "$BACKUP_INVARIANT_VERSION" <<'PY'
import re,sys
path,kind,version=sys.argv[1:]
expected={
    "contract.schema","contract.version",
    "db.carry_channel_key","db.carry_contact","db.carry_contact_encrypted",
    "db.carry_contact_tombstone","db.carry_memory","db.carry_note",
    "db.carry_event","db.carry_device_account","state.files","state.bytes",
    "center.channel_key.presence","center.channel_key.sha256",
    "center.channel_key.mode","center.channel_key.owner",
}
rows={}
try: lines=open(path,encoding="utf-8").read().splitlines()
except OSError as error: raise SystemExit(f"invariant contract is unavailable: {error}")
for line_number,line in enumerate(lines,1):
    fields=line.split("\t")
    if len(fields)!=2 or not fields[0] or fields[0] in rows:
        raise SystemExit(f"invariant contract has a malformed or duplicate row at line {line_number}")
    rows[fields[0]]=fields[1]
if set(rows)!=expected:
    missing=sorted(expected-set(rows)); unknown=sorted(set(rows)-expected)
    raise SystemExit(f"invariant contract fields differ; missing={missing}, unknown={unknown}")
if rows["contract.schema"]!=kind or rows["contract.version"]!=version:
    raise SystemExit("invariant contract schema version is unsupported")
for key,value in rows.items():
    if key.startswith("db.") and not re.fullmatch(r"-1|[0-9]+",value):
        raise SystemExit(f"invalid database invariant: {key}")
for key in ("state.files","state.bytes"):
    if not re.fullmatch(r"[0-9]+",rows[key]): raise SystemExit(f"invalid state invariant: {key}")
presence=rows["center.channel_key.presence"]
channel={key.removeprefix("center.channel_key."):value for key,value in rows.items()
         if key.startswith("center.channel_key.")}
if presence=="present":
    if not re.fullmatch(r"[0-9a-f]{64}",channel["sha256"]): raise SystemExit("channel key digest is invalid")
    if not re.fullmatch(r"[0-7]{3,4}",channel["mode"]): raise SystemExit("channel key mode is invalid")
    if not re.fullmatch(r"[0-9]+:[0-9]+",channel["owner"]): raise SystemExit("channel key owner is invalid")
elif presence=="absent":
    if any(channel[key]!="-" for key in ("sha256","mode","owner")):
        raise SystemExit("absent channel key must have a complete '-' metadata set")
else:
    raise SystemExit("channel key presence is invalid")
PY
}

# Production backup entrypoint: validate key semantics first, then emit and
# validate the complete versioned invariant document.  The lower-level
# write_invariants function remains useful for read-only probes and fixtures.
write_backup_invariants() {
  local output="$1" container="$2" key="$CENTER_DATA_DIR/channel-key.json"
  if [[ -e "$key" || -L "$key" ]]; then validate_center_channel_key_json "$key"; fi
  write_invariants "$output" "$container"
  validate_backup_invariants "$output"
}

validate_center_channel_backup_contract() {
  local invariants="$1" inventory="$2" archive="$3"
  validate_backup_invariants "$invariants"
  validate_archive_inventory "$inventory"
  python3 - "$invariants" "$inventory" "$archive" <<'PY'
import base64,binascii,hashlib,json,re,sys,tarfile
invariants_path,inventory_path,archive_path=sys.argv[1:]
rows={line.split("\t",1)[0]:line.split("\t",1)[1] for line in open(invariants_path,encoding="utf-8").read().splitlines()}
inventory=json.load(open(inventory_path,encoding="utf-8"))
inventory_entries=[item for item in inventory if item.get("path")=="channel-key.json"]
with tarfile.open(archive_path,"r:gz") as bundle:
    members=[member for member in bundle.getmembers()
             if ("." if member.name in (".","./") else member.name.removeprefix("./"))=="channel-key.json"]
    if rows["center.channel_key.presence"]=="absent":
        if inventory_entries or members: raise SystemExit("absent channel key appears in Center archive")
        raise SystemExit(0)
    if len(inventory_entries)!=1 or len(members)!=1: raise SystemExit("present channel key is missing or duplicated in Center archive")
    item=inventory_entries[0]; member=members[0]
    if not member.isfile() or "linkname" in item or item.get("type") not in {"0","\x00"}:
        raise SystemExit("Center channel key archive entry is not a regular file")
    source=bundle.extractfile(member); body=source.read(); source.close()
digest=hashlib.sha256(body).hexdigest()
if digest!=rows["center.channel_key.sha256"] or item.get("sha256")!=digest:
    raise SystemExit("Center channel key digest differs across invariant and archive contracts")
if format(member.mode,"o")!=rows["center.channel_key.mode"] or item.get("mode")!=oct(member.mode):
    raise SystemExit("Center channel key mode differs across invariant and archive contracts")
owner=f"{member.uid}:{member.gid}"
if owner!=rows["center.channel_key.owner"] or item.get("uid")!=member.uid or item.get("gid")!=member.gid:
    raise SystemExit("Center channel key owner differs across invariant and archive contracts")
def pairs(values):
    result={}
    for key,value in values:
        if key in result: raise ValueError(f"duplicate field: {key}")
        result[key]=value
    return result
try: document=json.loads(body.decode("utf-8"),object_pairs_hook=pairs)
except (UnicodeDecodeError,json.JSONDecodeError,ValueError) as error: raise SystemExit(f"archived Center channel key JSON is invalid: {error}")
# Mirrors validate_center_channel_key_json: `keys` is the per-wearer map, and
# every entry is held to the same rules as the mirrored legacy pair. This copy
# guards the ARCHIVED key inside a backup, so leaving it stricter than the
# writer would let a backup be taken and then refuse to validate on restore --
# the failure would surface only when someone needed the backup.
if not isinstance(document,dict) or set(document)-{"keys"}!={"kid","key"}:
    raise SystemExit("archived Center channel key fields differ")
def check_archived(kid,encoded,label):
    if (not isinstance(kid,str) or not kid or len(kid.encode("utf-8"))>1024
            or any(ord(char)<32 or 127<=ord(char)<=159 for char in kid) or not isinstance(encoded,str)):
        raise SystemExit(f"{label} values are invalid")
    suffix="/center/ephemeral"
    if not kid.endswith(suffix): raise SystemExit(f"{label} kid is not a complete Center kid")
    principal=kid[:-len(suffix)]
    if len(principal.encode("utf-8"))>128: raise SystemExit(f"{label} principal is oversized")
    component=r"[A-Za-z0-9._-]+"
    if (re.fullmatch(rf"U:{component}",principal) is None
            and re.fullmatch(rf"V:[0-9A-Fa-f]{{2}}:D:{component}:U:{component}",principal) is None):
        raise SystemExit(f"{label} kid has an unsupported principal")
    try: key=base64.b64decode(encoded,validate=True)
    except (binascii.Error,ValueError) as error: raise SystemExit(f"{label} is not base64: {error}")
    if len(key)!=16 or base64.b64encode(key).decode("ascii")!=encoded:
        raise SystemExit(f"{label} is not canonical AES-128 material")
check_archived(document["kid"],document["key"],"archived Center channel key")
mapped=document.get("keys",{})
if not isinstance(mapped,dict): raise SystemExit("archived Center channel key map must be an object")
if len(mapped)>256: raise SystemExit("archived Center channel key map is implausibly large")
for mapped_kid,mapped_key in mapped.items():
    check_archived(mapped_kid,mapped_key,"archived Center channel key map entry")
PY
}

backup_required_artifacts() {
  cat <<'EOF'
BACKUP_ID
CREATED_AT
active-security-roots.tsv
application-before/containers.tsv
application-before/mounts.tsv
application-before/running-containers.txt
application-before/running-identities.tsv
application-before/semantic-baseline.tsv
application-before/volumes.json
bridge-inventory.after.json
bridge-inventory.before.json
center-data.inventory.json
center-data.tar.gz
cosmos-state.inventory.json
cosmos-state.tar.gz
cosmos.sql.gz
executing-code.tsv
flags-before.json
grafana-data.inventory.json
grafana-data.tar.gz
invariants.tsv
keycloak.sql.gz
postgres-data.inventory.json
postgres-data.tar.gz
postgres-data.tsv
postgres-globals.sql.gz
postgres-restore-image-id.txt
postgres-schema.tsv
postgres-security.json
prometheus-data.inventory.json
prometheus-data.tar.gz
protected-inventory.json
protected-presence.tsv
protected.paths
protected.tar.gz
quiesced-containers.txt
EOF
}

backup_optional_artifacts() {
  # cloudflared/ carries the Center-route transaction binding evidence when the
  # backup is taken under --cloudflared-record; the state marker present
  # depends on the route state (INSTALLED for desired, RESTORED for before).
  # The *.tsv.columns sidecars record which columns each relation digest was
  # taken over, so a later comparison can project onto them and stay blind to an
  # ADDITIVE migration while still catching any changed value. They are optional
  # because backups taken before the sidecar existed have none, and the capture
  # falls back to the live column list in that case.
  #
  # postgres-schema.tsv.<database>.sql is the canonical pg_dump text behind each
  # digest line, kept for the same reason one step up: deploy.sh compares this
  # backup's schema manifest against the post-candidate backup's, and a
  # legitimately additive delta can only be CLASSIFIED (classify_schema_delta)
  # from the two dumps — the pre-candidate one cannot be re-taken after the
  # candidate has migrated. Optional for the same backward-compatibility reason;
  # classification against a backup that lacks it refuses, which is the safe
  # direction.
  #
  # postgres-data.unprojected.tsv is present exactly when postgres-data.tsv is
  # PROJECTED — that is, only for the post-candidate backups deploy.sh takes. It
  # is the same capture over every live column, and it is what every SAME-CLUSTER
  # fidelity check compares against (backup_fidelity_data_manifest), so narrowing
  # the authoritative manifest for the pre-vs-post gate never narrows the
  # snapshot/restore round-trip checks with it.
  printf '%s\n' BRIDGE_QUIESCED PUBLIC_INGRESS_QUIESCED \
    cloudflared/INSTALLED.json cloudflared/JOURNAL.json cloudflared/RESTORED.json \
    cloudflared/before.yml cloudflared/desired.yml cloudflared/ingress-evidence.tsv \
    cloudflared/route-state \
    postgres-data.tsv.columns postgres-data.after-physical.tsv.columns \
    postgres-data.physical-restored.tsv.columns postgres-data.restored.tsv.columns \
    postgres-data.unprojected.tsv postgres-data.unprojected.tsv.columns \
    postgres-schema.tsv.carry.sql postgres-schema.tsv.keycloak.sql
}

write_backup_artifact_manifest() {
  local root="$1" backup_id="$2" inventory
  [[ -d "$root" && ! -L "$root" ]] || fail "backup artifact root is unavailable"
  [[ "$backup_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || fail "backup artifact id is invalid"
  validate_backup_invariants "$root/invariants.tsv" || fail "backup invariant contract is invalid"
  for inventory in cosmos-state.inventory.json center-data.inventory.json \
    prometheus-data.inventory.json grafana-data.inventory.json \
    postgres-data.inventory.json protected-inventory.json; do
    validate_archive_inventory "$root/$inventory" \
      || fail "backup archive inventory contract is invalid: $inventory"
  done
  validate_center_channel_backup_contract "$root/invariants.tsv" \
    "$root/center-data.inventory.json" "$root/center-data.tar.gz" \
    || fail "Center channel-key backup contract is inconsistent"
  python3 - "$root" "$backup_id" "$BACKUP_CONTRACT_KIND" "$BACKUP_CONTRACT_VERSION" \
    "$BACKUP_ARCHIVE_INVENTORY_VERSION" "$BACKUP_INVARIANT_KIND" "$BACKUP_INVARIANT_VERSION" \
    3< <(backup_required_artifacts) 4< <(backup_optional_artifacts) <<'PY'
import hashlib,json,os,stat,sys,tempfile
root,backup_id,kind,version,inventory_version,invariant_kind,invariant_version=sys.argv[1:]
required={line.strip() for line in os.fdopen(3,encoding="utf-8") if line.strip()}
optional={line.strip() for line in os.fdopen(4,encoding="utf-8") if line.strip()}
if not required or required & optional: raise SystemExit("backup artifact allowlist is invalid")
for name in required:
    path=os.path.join(root,name)
    metadata=os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"required backup artifact is missing or unsafe: {name}")
if open(os.path.join(root,"BACKUP_ID"),encoding="utf-8").read().strip()!=backup_id:
    raise SystemExit("backup artifact id does not match BACKUP_ID")
entries=[]
for directory,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    relative_directory=os.path.relpath(directory,root)
    names=[(name,"directory") for name in dirs]+[(name,"file") for name in files]
    if relative_directory==".":
        metadata=os.lstat(directory)
        entries.append({"path":".","type":"directory","mode":f"{stat.S_IMODE(metadata.st_mode):04o}","uid":metadata.st_uid,"gid":metadata.st_gid})
    for name,declared_type in names:
        path=os.path.join(directory,name); relative=os.path.relpath(path,root)
        if relative in {"BACKUP_MANIFEST.json","SHA256SUMS"}: continue
        if (relative.startswith("/") or "\\" in relative
                or any(ord(char)<32 or 127<=ord(char)<=159 for char in relative)
                or ".." in relative.split(os.sep)):
            raise SystemExit("backup artifact path is unsafe")
        metadata=os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode): raise SystemExit("backup artifacts must not contain symlinks")
        actual_type="directory" if stat.S_ISDIR(metadata.st_mode) else "file" if stat.S_ISREG(metadata.st_mode) else "other"
        if actual_type!=declared_type: raise SystemExit("backup artifact contains an unsupported object")
        entry={"path":relative,"type":actual_type,"mode":f"{stat.S_IMODE(metadata.st_mode):04o}","uid":metadata.st_uid,"gid":metadata.st_gid}
        if actual_type=="file":
            digest=hashlib.sha256()
            with open(path,"rb") as source:
                for chunk in iter(lambda:source.read(1024*1024),b""): digest.update(chunk)
            entry.update({"size":metadata.st_size,"sha256":digest.hexdigest()})
        entries.append(entry)
entries.sort(key=lambda item:item["path"].encode())
files={item["path"] for item in entries if item["type"]=="file"}
directories={item["path"] for item in entries if item["type"]=="directory"}
if not required<=files: raise SystemExit(f"required backup artifacts are missing: {sorted(required-files)}")
if not files<=required|optional: raise SystemExit(f"unknown backup artifacts are present: {sorted(files-required-optional)}")
if directories not in ({".","application-before"},{".","application-before","cloudflared"}):
    raise SystemExit(f"backup artifact directories differ: {sorted(directories)}")
document={
    "schemaVersion":int(version),
    "kind":kind,
    "backupId":backup_id,
    "requiredArtifacts":sorted(required,key=lambda value:value.encode()),
    "optionalArtifacts":sorted(optional,key=lambda value:value.encode()),
    "contracts":{
        "archiveInventory":{
            "schemaVersion":int(inventory_version),"format":"json-array","rootPath":".",
            "requiredEntryFields":["acl","gid","mode","path","size","type","uid","xattrs"],
            "regularFileField":"sha256","linkField":"linkname",
        },
        "invariants":{"schemaVersion":int(invariant_version),"kind":invariant_kind,"path":"invariants.tsv"},
        "channelKey":{
            "jsonFields":["key","kid"],"keyBytes":16,
            "invariantFields":["mode","owner","presence","sha256"],
            "inventoryPath":"center-data.inventory.json","path":"channel-key.json",
        },
    },
    "artifacts":entries,
}
descriptor,temporary=tempfile.mkstemp(prefix=".BACKUP_MANIFEST.",dir=root,text=True)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="utf-8",newline="\n") as output:
        json.dump(document,output,sort_keys=True,separators=(",",":")); output.write("\n")
    os.replace(temporary,os.path.join(root,"BACKUP_MANIFEST.json"))
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
  verify_backup_artifact_manifest "$root"
}

verify_backup_artifact_manifest() {
  local root="$1" inventory
  [[ -d "$root" && ! -L "$root" ]] || fail "backup artifact root is unavailable"
  validate_backup_invariants "$root/invariants.tsv" || fail "backup invariant contract is invalid"
  for inventory in cosmos-state.inventory.json center-data.inventory.json \
    prometheus-data.inventory.json grafana-data.inventory.json \
    postgres-data.inventory.json protected-inventory.json; do
    validate_archive_inventory "$root/$inventory" \
      || fail "backup archive inventory contract is invalid: $inventory"
  done
  validate_center_channel_backup_contract "$root/invariants.tsv" \
    "$root/center-data.inventory.json" "$root/center-data.tar.gz" \
    || fail "Center channel-key backup contract is inconsistent"
  python3 - "$root" "$BACKUP_CONTRACT_KIND" "$BACKUP_CONTRACT_VERSION" \
    "$BACKUP_ARCHIVE_INVENTORY_VERSION" "$BACKUP_INVARIANT_KIND" "$BACKUP_INVARIANT_VERSION" \
    3< <(backup_required_artifacts) 4< <(backup_optional_artifacts) <<'PY'
import hashlib,json,os,re,stat,sys
root,kind,version,inventory_version,invariant_kind,invariant_version=sys.argv[1:]
required=sorted({line.strip() for line in os.fdopen(3,encoding="utf-8") if line.strip()},key=lambda value:value.encode())
optional=sorted({line.strip() for line in os.fdopen(4,encoding="utf-8") if line.strip()},key=lambda value:value.encode())
manifest_path=os.path.join(root,"BACKUP_MANIFEST.json")
try: document=json.load(open(manifest_path,encoding="utf-8"))
except (OSError,json.JSONDecodeError) as error: raise SystemExit(f"backup manifest is invalid: {error}")
if set(document)!={"schemaVersion","kind","backupId","requiredArtifacts","optionalArtifacts","contracts","artifacts"}:
    raise SystemExit("backup manifest top-level schema mismatch")
if document["schemaVersion"]!=int(version) or document["kind"]!=kind:
    raise SystemExit("backup manifest schema version is unsupported")
if not isinstance(document["backupId"],str) or not re.fullmatch(r"[A-Za-z0-9._-]{8,96}",document["backupId"]):
    raise SystemExit("backup manifest id is invalid")
# Required stays EXACT: a backup missing a required artifact, or claiming one
# this release does not know, is not a backup this release can trust.
#
# Optional is a SUBSET test, because the optional list grows. A backup written
# by an earlier release cannot name artifacts that release had never heard of,
# and demanding equality here made every pre-existing backup unverifiable the
# moment the list gained an entry — including the baseline an armed transaction
# must re-verify to be reconciled, which would have sealed that transaction shut
# with no way forward or back. Nothing is loosened: an artifact NOT on this
# release's optional list is still rejected, and the per-artifact digest and
# presence checks below are unchanged.
if document["requiredArtifacts"]!=required:
    raise SystemExit("backup manifest artifact allowlist differs")
if not set(document["optionalArtifacts"])<=set(optional):
    raise SystemExit("backup manifest declares an unknown optional artifact")
expected_contracts={
    "archiveInventory":{
        "schemaVersion":int(inventory_version),"format":"json-array","rootPath":".",
        "requiredEntryFields":["acl","gid","mode","path","size","type","uid","xattrs"],
        "regularFileField":"sha256","linkField":"linkname",
    },
    "invariants":{"schemaVersion":int(invariant_version),"kind":invariant_kind,"path":"invariants.tsv"},
    "channelKey":{
        "jsonFields":["key","kid"],"keyBytes":16,
        "invariantFields":["mode","owner","presence","sha256"],
        "inventoryPath":"center-data.inventory.json","path":"channel-key.json",
    },
}
if document["contracts"]!=expected_contracts: raise SystemExit("backup manifest embedded contract differs")
expected={}
for item in document["artifacts"]:
    if not isinstance(item,dict) or set(item) not in ({"path","type","mode","uid","gid"},{"path","type","mode","uid","gid","size","sha256"}):
        raise SystemExit("backup manifest artifact schema mismatch")
    relative=item["path"]
    if not isinstance(relative,str) or not relative or relative in expected: raise SystemExit("backup manifest artifact path is missing or duplicated")
    expected[relative]=item
actual={}
for directory,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    relative_directory=os.path.relpath(directory,root)
    if relative_directory==".":
        metadata=os.lstat(directory)
        actual["."]={"path":".","type":"directory","mode":f"{stat.S_IMODE(metadata.st_mode):04o}","uid":metadata.st_uid,"gid":metadata.st_gid}
    for name in [*dirs,*files]:
        path=os.path.join(directory,name); relative=os.path.relpath(path,root)
        if relative in {"BACKUP_MANIFEST.json","SHA256SUMS"}: continue
        metadata=os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode): raise SystemExit("backup artifact tree contains a symlink")
        object_type="directory" if stat.S_ISDIR(metadata.st_mode) else "file" if stat.S_ISREG(metadata.st_mode) else "other"
        if object_type=="other": raise SystemExit("backup artifact tree contains an unsupported object")
        item={"path":relative,"type":object_type,"mode":f"{stat.S_IMODE(metadata.st_mode):04o}","uid":metadata.st_uid,"gid":metadata.st_gid}
        if object_type=="file":
            digest=hashlib.sha256()
            with open(path,"rb") as source:
                for chunk in iter(lambda:source.read(1024*1024),b""): digest.update(chunk)
            item.update({"size":metadata.st_size,"sha256":digest.hexdigest()})
        actual[relative]=item
if actual!=expected: raise SystemExit("backup artifact tree differs from BACKUP_MANIFEST.json")
files={path for path,item in actual.items() if item["type"]=="file"}
directories={path for path,item in actual.items() if item["type"]=="directory"}
if (not set(required)<=files or not files<=set(required)|set(optional)
        or directories not in ({".","application-before"},{".","application-before","cloudflared"})):
    raise SystemExit("backup artifact set differs from the versioned allowlist")
if open(os.path.join(root,"BACKUP_ID"),encoding="utf-8").read().strip()!=document["backupId"]:
    raise SystemExit("backup manifest id differs from BACKUP_ID")
PY
}

# The data manifest a SAME-CLUSTER FIDELITY check must compare against, which is
# NOT always the backup's authoritative postgres-data.tsv.
#
# The projection above exists for ONE question — deploy.sh's "did a value move
# while the candidate migrated?" — and it answers that question by deliberately
# excluding columns that did not exist at the pre-candidate boundary. A fidelity
# check asks a different question entirely: "did this cluster survive the snapshot,
# the restore, the round trip?". Both sides of that comparison are the same schema
# at the same instant, so there is nothing additive to project away, and projecting
# anyway makes the check BLIND to every column the projection excludes — a
# corrupted `carry_memory.thumbnail_count` would round-trip unnoticed.
#
# So a backup whose authoritative manifest is projected keeps an unprojected one
# beside it, and every fidelity comparison resolves through here. For an
# unprojected backup — every backup taken outside a deploy — this returns
# postgres-data.tsv and nothing changes at all. The caller projects onto
# "<returned>.columns", which is that manifest's own full column list.
backup_fidelity_data_manifest() {
  local backup="$1" unprojected="$1/postgres-data.unprojected.tsv"
  if [[ -f "$unprojected" && ! -L "$unprojected" && -f "$unprojected.columns" && ! -L "$unprojected.columns" ]]; then
    printf '%s\n' "$unprojected"
  else
    printf '%s\n' "$backup/postgres-data.tsv"
  fi
}

verify_invariants() {
  local baseline="$1" container current expected key
  [[ -f "$baseline" ]] || fail "invariant baseline is missing"
  container="$(find_postgres_container)"
  current="$(mktemp)"
  # Self-clearing for the same reason as capture_postgres_data above: a RETURN
  # trap fires again on the caller's return, in the caller's scope, and `current`
  # is a common enough name that this is one rename away from deleting a caller's
  # file. It has not bitten here; it is closed because the other one did.
  trap 'rm -f "${current:-}"; trap - RETURN' RETURN
  write_invariants "$current" "$container"
  while IFS=$'\t' read -r key expected; do
    local actual
    actual="$(awk -F '\t' -v wanted="$key" '$1 == wanted {print $2}' "$current")"
    [[ -n "$actual" ]] || fail "post-deploy invariant disappeared: $key"
    if [[ "$actual" != "$expected" ]]; then
      # The channel-key metadata migration is a journaled, separately verified
      # transaction (transaction.py forces exactly 0600 1000:1001 in
      # production, and the Center zero-delta comparison whitelists the same
      # delta). Its key CONTENT must never change, so only the recorded
      # ownership/mode may advance to those exact desired values.
      case "$key" in
        center.channel_key.owner) [[ "$actual" == 1000:1001 ]] || fail "post-deploy invariant changed: $key (expected $expected, got $actual)" ;;
        center.channel_key.mode) [[ "$actual" == 600 ]] || fail "post-deploy invariant changed: $key (expected $expected, got $actual)" ;;
        *) fail "post-deploy invariant changed: $key (expected $expected, got $actual)" ;;
      esac
    fi
  done <"$baseline"
}
