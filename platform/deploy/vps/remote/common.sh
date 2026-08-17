#!/usr/bin/env bash
# Common remote-side deployment primitives. The drivers concatenate this file
# with one reviewed entry point over SSH; do not print or `set -x` secret data.
set -euo pipefail
umask 077

REMOTE_ROOT="/home/anders/ai-pin-revival"
PRIVATE_DIR="$REMOTE_ROOT/private"
DATA_DIR="$REMOTE_ROOT/data"
PIN_RELEASE_DIR="$DATA_DIR/pin-releases"
BACKUP_ROOT="$REMOTE_ROOT/backups"
DEPLOYMENTS_DIR="$REMOTE_ROOT/deployments"
PACKAGES_DIR="$REMOTE_ROOT/packages"
MANIFESTS_DIR="$REMOTE_ROOT/manifests"
RELEASES_DIR="$REMOTE_ROOT/releases"
LOCK_FILE="$REMOTE_ROOT/deploy.lock"

BACKUP_CONTRACT_KIND="dk.andersmadsen.ai-pin-revival.backup"
BACKUP_CONTRACT_VERSION=1
BACKUP_INVARIANT_KIND="dk.andersmadsen.ai-pin-revival.backup-invariants"
BACKUP_INVARIANT_VERSION=1
BACKUP_ARCHIVE_INVENTORY_VERSION=1

EXPECTED_HOST="anders-server"
EXPECTED_USER="anders"
EXPECTED_ARCH="aarch64"
PROJECT="ai-pin-revival"
LEGACY_PROJECT="humane-carry-clone"
HELPER_IMAGE="node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b"

STATE_VOLUME="humane-carry-clone_carry-state"
PG_VOLUME="humane-carry-clone_carry-pgdata"
PROMETHEUS_VOLUME="humane-carry-clone_prometheus-data"
GRAFANA_VOLUME="humane-carry-clone_grafana-data"
CENTER_DATA_DIR="/home/anders/carry-center-data"

RUNTIME_ENV="$PRIVATE_DIR/runtime.env"
COSMOS_ENV="$PRIVATE_DIR/cosmos.env"
CENTER_ENV="$PRIVATE_DIR/center.env"
PROVIDER_ENV="$PRIVATE_DIR/providers.env"
# Operator-provisioned, never written by any script here. See
# assert_wearer_canary_secret for the contract and docs/operations.md for the
# provisioning runbook.
WEARER_CANARY_SECRET="$PRIVATE_DIR/canary-wearer.secret"

MANAGED_CLOUDFLARED_CONFIG="/home/anders/.cloudflared/config.yml"
MANAGED_CLOUDFLARED_BINARY="/usr/local/bin/cloudflared"
MANAGED_CLOUDFLARED_COMMAND="$MANAGED_CLOUDFLARED_BINARY tunnel --config $MANAGED_CLOUDFLARED_CONFIG run"
MANAGED_CLOUDFLARED_SYSTEM_UNIT="cloudflared-tunnel.service"
MANAGED_CLOUDFLARED_USER_UNIT="cloudflared-hermes.service"

log() { printf '[ai-pin-revival] %s\n' "$*"; }
warn() { printf '[ai-pin-revival] warning: %s\n' "$*" >&2; }
fail() { printf '[ai-pin-revival] error: %s\n' "$*" >&2; exit 1; }
usage_fail() { printf '[ai-pin-revival] error: %s\n' "$*" >&2; exit 64; }

need() { command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"; }

managed_systemctl() {
  local manager="$1"
  shift
  case "$manager" in
    system) systemctl "$@" ;;
    user) systemctl --machine="${EXPECTED_USER}@" --user "$@" ;;
    *) return 1 ;;
  esac
}

managed_systemctl_mutate() {
  local manager="$1"
  shift
  case "$manager" in
    system) sudo -n systemctl "$@" ;;
    user) systemctl --machine="${EXPECTED_USER}@" --user "$@" ;;
    *) return 1 ;;
  esac
}

cloudflared_unit_command_sha256() {
  local manager="$1" unit="$2" value
  value="$(managed_systemctl "$manager" show --property=ExecStart --value "$unit")" || return 1
  if ! python3 - "$value" "$MANAGED_CLOUDFLARED_BINARY" "$MANAGED_CLOUDFLARED_COMMAND" <<'PY'
import sys

value,binary,command=sys.argv[1:]
if not value or len(value)>65536 or "\n" in value or "\r" in value:
    raise SystemExit("unsafe cloudflared ExecStart evidence")
if value.count("argv[]=") != 1 or value.count(f"path={binary} ;") != 1:
    raise SystemExit("cloudflared unit does not bind the exact reviewed binary")
if value.count(f"argv[]={command} ;") != 1:
    raise SystemExit("cloudflared unit does not bind the exact reviewed command")
PY
  then
    return 1
  fi
  printf '%s' "$MANAGED_CLOUDFLARED_COMMAND" | sha256sum | awk '{print $1}'
}

cloudflared_unit_definition_sha256() {
  local manager="$1" unit="$2"
  local user_uid user_runtime user_unit_definition
  if [[ "$manager" == user ]]; then
    if user_uid="$(id -u "$EXPECTED_USER" 2>/dev/null)"; then
      user_runtime="/run/user/$user_uid"
      if user_unit_definition="$(sudo -n -u "$EXPECTED_USER" \
        XDG_RUNTIME_DIR="$user_runtime" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$user_runtime/bus" \
        systemctl --user cat "$unit" 2>/dev/null \
        | sha256sum | awk '{print $1}' 2>/dev/null)" ; then
        printf '%s\n' "$user_unit_definition"
        return 0
      fi
    fi
  fi
  managed_systemctl "$manager" cat "$unit" | sha256sum | awk '{print $1}'
}

cloudflared_config_identity() {
  python3 - "$MANAGED_CLOUDFLARED_CONFIG" <<'PY'
import hashlib,os,stat,sys

path=sys.argv[1]
before_path=os.lstat(path)
assert stat.S_ISREG(before_path.st_mode) and not stat.S_ISLNK(before_path.st_mode)
descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
try:
    before=os.fstat(descriptor)
    assert stat.S_ISREG(before.st_mode) and before.st_size <= 16*1024*1024
    digest=hashlib.sha256()
    while True:
        chunk=os.read(descriptor,131072)
        if not chunk: break
        digest.update(chunk)
    after=os.fstat(descriptor)
finally:
    os.close(descriptor)
after_path=os.lstat(path)
identity=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
assert identity(before_path)==identity(before)==identity(after)==identity(after_path)
print(f"{stat.S_IMODE(before.st_mode):o}\t{before.st_uid}:{before.st_gid}\t{digest.hexdigest()}")
PY
}

cloudflared_unit_main_pid() {
  local manager="$1" unit="$2" pid
  pid="$(managed_systemctl "$manager" show --property=MainPID --value "$unit")" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$pid" != 1 ]] || return 1
  printf '%s\n' "$pid"
}

assert_cloudflared_process_command() {
  local pid="$1"
  [[ "$(readlink -f -- "/proc/$pid/exe")" == "$MANAGED_CLOUDFLARED_BINARY" ]] || return 1
  python3 - "/proc/$pid/cmdline" "$MANAGED_CLOUDFLARED_BINARY" "$MANAGED_CLOUDFLARED_CONFIG" <<'PY'
import sys

path,binary,config=sys.argv[1:]
raw=open(path,"rb").read()
assert 0 < len(raw) <= 65536 and raw.endswith(b"\0")
argv=[value.decode("utf-8","strict") for value in raw[:-1].split(b"\0")]
assert argv == [binary,"tunnel","--config",config,"run"]
PY
}

assert_managed_cloudflared_topology() {
  local system_pid user_pid manager unit unit_id
  local -a observed=()
  [[ -f "$MANAGED_CLOUDFLARED_CONFIG" && ! -L "$MANAGED_CLOUDFLARED_CONFIG" \
    && -x "$MANAGED_CLOUDFLARED_BINARY" && ! -L "$MANAGED_CLOUDFLARED_BINARY" ]] || return 1
  for spec in "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    managed_systemctl "$manager" list-unit-files --type=service --no-legend --no-pager \
      | awk -v unit="$unit" '$1 == unit { print $1 }' | LC_ALL=C sort -u \
      | grep -qx "$unit" || return 1
    unit_id="$(managed_systemctl "$manager" show --property=Id --value "$unit")" || return 1
    [[ "$unit_id" == "$unit" ]] || return 1
    managed_systemctl "$manager" is-active --quiet "$unit" || return 1
    cloudflared_unit_command_sha256 "$manager" "$unit" >/dev/null || return 1
    cloudflared_unit_definition_sha256 "$manager" "$unit" >/dev/null || return 1
  done
  system_pid="$(cloudflared_unit_main_pid system "$MANAGED_CLOUDFLARED_SYSTEM_UNIT")" || return 1
  user_pid="$(cloudflared_unit_main_pid user "$MANAGED_CLOUDFLARED_USER_UNIT")" || return 1
  [[ "$system_pid" != "$user_pid" ]] || return 1
  assert_cloudflared_process_command "$system_pid" || return 1
  assert_cloudflared_process_command "$user_pid" || return 1
  mapfile -t observed < <(pgrep -x cloudflared | LC_ALL=C sort -n) || return 1
  [[ "${#observed[@]}" == 2 ]] || return 1
  [[ "${observed[0]}" == "$system_pid" && "${observed[1]}" == "$user_pid" \
    || "${observed[0]}" == "$user_pid" && "${observed[1]}" == "$system_pid" ]] || return 1
}

record_ingress_services() {
  local evidence="$1" temporary state manager unit command_sha unit_sha
  local config_mode config_owner config_sha
  temporary="${evidence}.tmp"
  assert_managed_cloudflared_topology \
    || fail "Cloudflare ingress is not the exact reviewed two-connector topology"
  : >"$temporary"
  printf 'contract\t1\t-\t-\t-\t-\t-\t-\t-\t-\n' >>"$temporary"
  for unit in nginx.service penumbra-center-bridge.service; do
    state=inactive
    if systemctl is-active --quiet "$unit"; then state=active; fi
    printf 'service\tsystem\t%s\t%s\t-\t-\t-\t-\t-\t-\n' "$unit" "$state" >>"$temporary"
  done
  IFS=$'\t' read -r config_mode config_owner config_sha < <(cloudflared_config_identity) \
    || { rm -f -- "$temporary"; return 1; }
  for spec in "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT"; do
    manager="${spec%%:*}"; unit="${spec#*:}"; state=inactive
    managed_systemctl "$manager" is-active --quiet "$unit" && state=active
    command_sha="$(cloudflared_unit_command_sha256 "$manager" "$unit")" \
      || { rm -f -- "$temporary"; return 1; }
    unit_sha="$(cloudflared_unit_definition_sha256 "$manager" "$unit")" \
      || { rm -f -- "$temporary"; return 1; }
    printf 'cloudflared\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$manager" "$unit" "$state" "$command_sha" "$unit_sha" \
      "$MANAGED_CLOUDFLARED_CONFIG" "$config_mode" "$config_owner" "$config_sha" >>"$temporary"
  done
  grep -qx $'service\tsystem\tnginx.service\tactive\t-\t-\t-\t-\t-\t-' "$temporary" \
    || { rm -f -- "$temporary"; fail "Nginx ingress is not active before quiescence"; }
  grep -qx $'service\tsystem\tpenumbra-center-bridge.service\tactive\t-\t-\t-\t-\t-\t-' "$temporary" \
    || { rm -f -- "$temporary"; fail "Pin bridge ingress is not active before quiescence"; }
  grep -q $'^cloudflared\tsystem\tcloudflared-tunnel.service\tactive\t' "$temporary" \
    || { rm -f -- "$temporary"; fail "reviewed system Cloudflare connector is not active before quiescence"; }
  grep -q $'^cloudflared\tuser\tcloudflared-hermes.service\tactive\t' "$temporary" \
    || { rm -f -- "$temporary"; fail "reviewed user Cloudflare connector is not active before quiescence"; }
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$evidence"
  sync -f "$evidence"
}

validate_ingress_evidence() {
  local evidence="$1"
  [[ -f "$evidence" && ! -L "$evidence" ]] || return 1
  python3 - "$evidence" <<'PY'
import re,sys
expected={
    ("service","system","nginx.service"),
    ("service","system","penumbra-center-bridge.service"),
    ("cloudflared","system","cloudflared-tunnel.service"),
    ("cloudflared","user","cloudflared-hermes.service"),
}
rows={}; contract=0
for raw in open(sys.argv[1],encoding="utf-8",newline="\n"):
    fields=raw.rstrip("\n").split("\t")
    assert len(fields)==10
    if fields[0]=="contract":
        assert fields==["contract","1","-","-","-","-","-","-","-","-"] and contract==0
        contract=1; continue
    key=tuple(fields[:3]); assert key in expected and key not in rows and fields[3] in {"active","inactive"}
    if fields[0]=="service":
        assert fields[4:]==["-","-","-","-","-","-"]
    else:
        assert re.fullmatch(r"[0-9a-f]{64}",fields[4]) and re.fullmatch(r"[0-9a-f]{64}",fields[5])
        assert fields[6]=="/home/anders/.cloudflared/config.yml"
        assert re.fullmatch(r"[0-7]{3,4}",fields[7]) and re.fullmatch(r"[0-9]+:[0-9]+",fields[8])
        assert re.fullmatch(r"[0-9a-f]{64}",fields[9])
    rows[key]=fields
assert contract==1
assert set(rows)==expected
assert rows[("service","system","nginx.service")][3]=="active"
assert rows[("service","system","penumbra-center-bridge.service")][3]=="active"
assert rows[("cloudflared","system","cloudflared-tunnel.service")][3]=="active"
assert rows[("cloudflared","user","cloudflared-hermes.service")][3]=="active"
left=rows[("cloudflared","system","cloudflared-tunnel.service")]
right=rows[("cloudflared","user","cloudflared-hermes.service")]
assert left[4]==right[4] and left[6:]==right[6:]
PY
}

assert_cloudflared_identity_matches_recorded() {
  local evidence="$1" kind manager unit expected_state expected_command expected_unit rest
  validate_ingress_evidence "$evidence" || return 1
  while IFS=$'\t' read -r kind manager unit expected_state expected_command expected_unit rest \
    || [[ -n "$kind" ]]; do
    [[ "$kind" == cloudflared ]] || continue
    [[ "$(cloudflared_unit_command_sha256 "$manager" "$unit")" == "$expected_command" ]] || return 1
    [[ "$(cloudflared_unit_definition_sha256 "$manager" "$unit")" == "$expected_unit" ]] || return 1
  done <"$evidence"
}

assert_cloudflared_config_matches_recorded() {
  local evidence="$1" mode owner digest
  validate_ingress_evidence "$evidence" || return 1
  IFS=$'\t' read -r mode owner digest < <(cloudflared_config_identity) || return 1
  awk -F '\t' -v mode="$mode" -v owner="$owner" -v digest="$digest" '
    $1=="cloudflared" { count++; if ($7!="/home/anders/.cloudflared/config.yml" || $8!=mode || $9!=owner || $10!=digest) exit 1 }
    END { if (count!=2) exit 1 }
  ' "$evidence"
}

verify_cloudflared_activation_state() {
  local evidence="$1" record="$2" route_state="$3"
  assert_cloudflared_identity_matches_recorded "$evidence" || return 1
  case "$route_state" in
    recorded)
      assert_cloudflared_config_matches_recorded "$evidence" || return 1
      domain_cloudflared_assert_ready
      ;;
    before)
      [[ -d "$record" && ! -L "$record" ]] || return 1
      domain_cloudflared_verify_before "$record"
      ;;
    desired)
      [[ -d "$record" && ! -L "$record" ]] || return 1
      domain_cloudflared_verify_desired "$record"
      ;;
    *) return 1 ;;
  esac
}

assert_ingress_matches_recorded() {
  local evidence="$1" kind manager unit expected actual _rest
  validate_ingress_evidence "$evidence" || return 1
  assert_cloudflared_identity_matches_recorded "$evidence" || return 1
  while IFS=$'\t' read -r kind manager unit expected _rest || [[ -n "$kind" ]]; do
    [[ "$kind" != contract ]] || continue
    actual=inactive
    if managed_systemctl "$manager" is-active --quiet "$unit"; then actual=active; fi
    [[ "$actual" == "$expected" ]] || return 1
  done <"$evidence"
}

quiesce_ingress_services() {
  local spec evidence="$1" bridge_already_quiesced="${2:-0}" record="$3" route_state="$4"
  [[ -f "$evidence" && ! -L "$evidence" ]] || return 1
  validate_ingress_evidence "$evidence" || return 1
  verify_cloudflared_activation_state "$evidence" "$record" "$route_state" || return 1
  # DO NOT STOP NGINX UNLESS IT CAN BE STARTED AGAIN. `sudo -n nginx -t` is a hard
  # precondition of restore_ingress_services, which returns before issuing a single
  # `systemctl start` when it fails — so quiescing with an invalid on-disk config
  # turns a serving host into one that nothing here can reopen. nginx runs from the
  # config it LOADED, so a drift is invisible until something stops it, and
  # record_ingress_services records only is-active, never validity. Checking it
  # here means the deployment is refused with the site still up.
  if grep -qx $'service\tsystem\tnginx.service\tactive\t-\t-\t-\t-\t-\t-' "$evidence"; then
    sudo -n nginx -t >/dev/null || return 1
  fi
  if [[ "$bridge_already_quiesced" == 1 ]]; then
    ! systemctl is-active --quiet penumbra-center-bridge.service \
      || fail "Pin bridge was expected to remain quiesced after backup"
  fi
  for spec in "user:$MANAGED_CLOUDFLARED_USER_UNIT" \
    "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "system:nginx.service" \
    "system:penumbra-center-bridge.service"; do
    local manager="${spec%%:*}" unit="${spec#*:}"
    if managed_systemctl "$manager" is-active --quiet "$unit" \
        && ! managed_systemctl_mutate "$manager" stop "$unit"; then
      restore_ingress_services "$evidence" "$record" "$route_state" || true
      return 1
    fi
  done
  assert_ingress_quiesced \
    || { restore_ingress_services "$evidence" "$record" "$route_state" || true; return 1; }
}

start_recorded_ingress_service() {
  local evidence="$1" service="$2"
  [[ -f "$evidence" && ! -L "$evidence" ]] || return 1
  grep -qx $'service\tsystem\t'"$service"$'\tactive\t-\t-\t-\t-\t-\t-' "$evidence" || return 0
  sudo -n systemctl start "$service" || return 1
  systemctl is-active --quiet "$service" || return 1
  if [[ "$service" == penumbra-center-bridge.service ]]; then
    # The bridge initializes its iroh P2P endpoint before binding the loopback
    # listener; a cold start can take longer than one probe window. Wait a
    # bounded 30 seconds before treating the recorded service as unhealthy.
    local bridge_attempt
    for bridge_attempt in 1 2 3 4 5 6 7 8 9 10; do
      if timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null; then return 0; fi
      systemctl is-active --quiet "$service" || return 1
      ((bridge_attempt < 10)) || return 1
      sleep 3
    done
  fi
}

force_quiesce_ingress_services() {
  local failed=0 spec manager unit
  for spec in "user:$MANAGED_CLOUDFLARED_USER_UNIT" \
    "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "system:nginx.service" \
    "system:penumbra-center-bridge.service"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    if managed_systemctl "$manager" is-active --quiet "$unit"; then
      managed_systemctl_mutate "$manager" stop "$unit" || failed=1
    fi
  done
  assert_ingress_quiesced || failed=1
  ((failed == 0))
}

restore_ingress_services() {
  local spec evidence="$1" record="${2:-}" route_state="${3:-}" kind manager unit expected _rest
  validate_ingress_evidence "$evidence" || return 1
  if [[ -n "$record" && -n "$route_state" ]]; then
    verify_cloudflared_activation_state "$evidence" "$record" "$route_state" || return 1
  fi
  grep -qx $'service\tsystem\tnginx.service\tactive\t-\t-\t-\t-\t-\t-' "$evidence" \
    && sudo -n nginx -t >/dev/null || return 1
  # First stop anything that was originally inactive, then start the exact
  # recorded active set in dependency order.  Omitted rows are impossible.
  while IFS=$'\t' read -r kind manager unit expected _rest || [[ -n "$kind" ]]; do
    [[ "$kind" != contract ]] || continue
    if [[ "$expected" == inactive ]] && managed_systemctl "$manager" is-active --quiet "$unit"; then
      managed_systemctl_mutate "$manager" stop "$unit" || return 1
    fi
  done <"$evidence"
  start_recorded_ingress_service "$evidence" penumbra-center-bridge.service \
    || { force_quiesce_ingress_services || true; return 1; }
  start_recorded_ingress_service "$evidence" nginx.service \
    || { force_quiesce_ingress_services || true; return 1; }
  for spec in "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    if grep -q $'^cloudflared\t'"$manager"$'\t'"$unit"$'\tactive\t' "$evidence"; then
      managed_systemctl_mutate "$manager" start "$unit" \
        || { force_quiesce_ingress_services || true; return 1; }
      managed_systemctl "$manager" is-active --quiet "$unit" \
        || { force_quiesce_ingress_services || true; return 1; }
    fi
  done
  verify_cloudflared_activation_state "$evidence" "$record" "$route_state" \
    || { force_quiesce_ingress_services || true; return 1; }
  assert_ingress_matches_recorded "$evidence" \
    || { force_quiesce_ingress_services || true; return 1; }
}

# Bounded patience for ONE unit, used only by the two non-destructive passes.
#
# The retry budget used to live entirely in the destructive loop — the one whose
# every failed attempt force-quiesces the whole edge — and not at all here. That
# is backwards: this is the last thing that will ever run, it stops nothing, and
# the realistic failure it faces is a service that is slow to come up or a
# Cloudflare connector that has not finished re-registering. Retrying here costs
# ten seconds and no downtime; retrying there costs an outage window.
start_ingress_unit_with_patience() {
  local manager="$1" unit="$2" attempt
  for attempt in 1 2 3 4; do
    if managed_systemctl "$manager" is-active --quiet "$unit"; then return 0; fi
    managed_systemctl_mutate "$manager" start "$unit" || true
    if managed_systemctl "$manager" is-active --quiet "$unit"; then return 0; fi
    ((attempt < 4)) || return 1
    sleep 5
  done
}

# The same four units force_quiesce_ingress_services stops, started in dependency
# order and never stopped. Used only when the recorded evidence cannot be read at
# all, so there is nothing better to go on than the shape of every serving host.
#   0  all four active   20 some active   1 none
reopen_canonical_ingress_last_resort() {
  local spec manager unit up=0 down=0
  for spec in "system:penumbra-center-bridge.service" "system:nginx.service" \
    "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    if start_ingress_unit_with_patience "$manager" "$unit"; then
      ((up += 1))
    else
      warn "last-resort reopen could not start $unit; it stays down and nothing else was stopped for it"
      ((down += 1))
    fi
  done
  ((up > 0)) || return 1
  ((down == 0)) || return 20
}

ingress_evidence_records_active() {
  local evidence="$1" manager="$2" unit="$3"
  grep -qE "^(service|cloudflared)"$'\t'"$manager"$'\t'"$unit"$'\tactive\t' "$evidence"
}

# LAST-RESORT DEGRADED REOPEN. Starts every unit the evidence records active and
# STOPS NOTHING, ever.
#
# restore_ingress_services is all-or-none on purpose: it force-quiesces rather
# than leave a half-open edge, because one Cloudflare connector without the other
# answers 530, which is worse than closed. That rule is right when the restore is
# a step in a deployment that can still be refused. It is wrong as the LAST thing
# that will ever run: at that point the choice is not "half-open or clean", it is
# "half-open or dark", and a dashboard that serves while the device plane is down
# beats a host that is connection-refused for both. A dead user-manager connector,
# a bridge whose iroh endpoint never binds, or an nginx config that will not load
# should each cost exactly what it is, and nothing more.
#
#   0  every recorded-active unit is now active
#   20 some are active and some could not be started
#   1  nothing recorded active is running
reopen_recorded_ingress_best_effort() {
  local evidence="$1" spec manager unit up=0 down=0
  # UNREADABLE EVIDENCE IS NOT A REASON TO LEAVE THE HOST DARK. Returning here
  # conflated "the file naming the units is corrupt" with "nothing can be
  # started", and the second does not follow from the first: the four units are
  # compile-time constants in this file, and force_quiesce_ingress_services
  # already hard-codes exactly this list in order to STOP them. Refusing to start
  # a list we are willing to stop is not caution, it is an outage.
  #
  # It is a strictly worse guess than the evidence — a unit the record had as
  # inactive gets started too — so it is last-resort only, and the caller is told
  # it is degraded either way.
  if ! validate_ingress_evidence "$evidence"; then
    warn "ingress evidence is unusable; falling back to starting the canonical ingress units"
    reopen_canonical_ingress_last_resort
    return $?
  fi
  # Dependency order, same as the full restore: the bridge and nginx before the
  # connectors that front them.
  for spec in "system:penumbra-center-bridge.service" "system:nginx.service" \
    "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    ingress_evidence_records_active "$evidence" "$manager" "$unit" || continue
    if start_ingress_unit_with_patience "$manager" "$unit"; then
      ((up += 1))
    else
      warn "degraded reopen could not start $unit; it stays down and nothing else was stopped for it"
      ((down += 1))
    fi
  done
  ((up > 0)) || return 1
  ((down == 0)) || return 20
}

assert_ingress_quiesced() {
  local spec manager unit
  for spec in "system:penumbra-center-bridge.service" \
    "system:$MANAGED_CLOUDFLARED_SYSTEM_UNIT" "user:$MANAGED_CLOUDFLARED_USER_UNIT" \
    "system:nginx.service"; do
    manager="${spec%%:*}"; unit="${spec#*:}"
    ! managed_systemctl "$manager" is-active --quiet "$unit" || return 1
  done
}

assert_public_ingress_quiesced() {
  ! systemctl is-active --quiet nginx.service || return 1
  ! managed_systemctl system is-active --quiet "$MANAGED_CLOUDFLARED_SYSTEM_UNIT" || return 1
  ! managed_systemctl user is-active --quiet "$MANAGED_CLOUDFLARED_USER_UNIT" || return 1
  [[ -z "$(pgrep -x cloudflared 2>/dev/null || true)" ]] || return 1
}

assert_target() {
  local actual_host actual_user actual_arch
  actual_host="$(hostname -s)"
  actual_user="$(id -un)"
  actual_arch="$(uname -m)"
  [[ "$actual_host" == "$EXPECTED_HOST" ]] || fail "refusing target host '$actual_host' (expected '$EXPECTED_HOST')"
  [[ "$actual_user" == "$EXPECTED_USER" ]] || fail "refusing target user '$actual_user' (expected '$EXPECTED_USER')"
  case "$EXPECTED_ARCH:$actual_arch" in
    aarch64:aarch64|arm64:aarch64|aarch64:arm64|arm64:arm64) ;;
    *) fail "refusing target architecture '$actual_arch' (expected '$EXPECTED_ARCH')" ;;
  esac
}

assert_remote_root() {
  [[ "$REMOTE_ROOT" == /home/anders/ai-pin-revival ]] || fail "unexpected remote root"
}

validate_release_id() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail "invalid release id"
}

# ---------------------------------------------------------------------------
# CROSS-RELEASE INVOCATION: running a script that belongs to a DIFFERENT release
# tree than the one whose code is doing the running.
#
# There is exactly one situation that needs it, and it is not optional. When
# deploy.sh reconciles a transaction that a PREVIOUS release armed, the partial
# effects on disk belong to that release, so the scripts that finish or unwind
# them must be that release's — the pending tree, not the selected one. The
# invocation therefore crosses a release boundary, and the invoked script's
# INTERFACE IS WHATEVER IT WAS WHEN THAT RELEASE WAS CUT. Not what this release's
# copy of the same file accepts.
#
# ASSUMING OTHERWISE IS A PRODUCTION DEADLOCK, not a failed deploy. Deploy 14:
# the new deploy.sh passed --data-columns-source to the pending release's
# backup.sh, which had never heard of the option, so backup.sh exited 64 on its
# own usage line. The transaction was already CANDIDATE_ACTIVATION_ARMED, which
# by design has no abort path — live mutation has begun and only a resume may
# finish it — so the single code path capable of completing it was the one that
# could not run. Every future option added to any invoked script re-creates that
# for every transaction armed before the option existed.
#
# THE RULE. Across a release boundary, pass ONLY options from the frozen baseline
# below. Anything the new code needs beyond that baseline, the NEW CODE MUST
# PRODUCE ITSELF with its own helpers — see deploy.sh's precommit-resume path,
# which captures its own projected data manifest and its own retained-text schema
# manifest instead of asking an older backup.sh to produce them.
#
# ADDING AN OPTION TO A LIST HERE IS A PROMISE that every release still capable of
# being pending accepts it. It is not a record of what the current release
# happens to support; the current release's own scripts are invoked from
# "$release_dir" and are not subject to any of this.
cross_release_baseline_options() {
  case "$1" in
    backup.sh)
      printf '%s\n' --backup-id --leave-quiesced --already-locked --public-ingress-quiesced \
        --cloudflared-record --cloudflared-state --ingress-evidence --json ;;
    canary.sh)
      printf '%s\n' --release-id --baseline --image-evidence --require-remote-tts \
        --require-owner-spotify --require-wearer-plane --quiesced-loopback \
        --expect-bridge-ready --legacy-dashboard-origin --cookie-file --json ;;
    transaction.py)
      printf '%s\n' --root --record --namespace --inventory --operation-action \
        --operation-ingress-evidence --channel-key-action --channel-key-path \
        --channel-key-contract --trust-root-action --staged-attest --staged-duc \
        --live-attest --live-duc --reconcile --prepare-only ;;
    verify-release.py)
      printf '%s\n' --archive --tree --manifest --extract --expect-release-id --json ;;
    *) return 1 ;;
  esac
}

# Refuse, before anything is executed, an argument list that assumes an interface
# newer than the boundary baseline. The failure is a loud message here instead of
# an exit 64 from a script three releases old in the middle of an armed cutover.
assert_cross_release_options() {
  local program="$1" baseline argument
  shift
  baseline="$(cross_release_baseline_options "$program")" \
    || fail "no cross-release interface baseline is declared for $program"
  for argument in "$@"; do
    [[ "$argument" == --* ]] || continue
    grep -qxF -- "$argument" <<<"$baseline" \
      || fail "cross-release invocation of $program passes $argument, which is newer than the release-boundary baseline: the invoked script belongs to a possibly-older release and its interface must not be assumed"
  done
}

# The one way deploy.sh runs a shell script out of another release's tree.
run_cross_release_script() {
  local release="$1" script="$2" entry
  shift 2
  entry="$release/platform/deploy/vps/remote/$script"
  [[ -f "$entry" && ! -L "$entry" ]] || fail "cross-release script is missing or unsafe: $script"
  assert_cross_release_options "$script" "$@"
  bash "$entry" "$@"
}

# Authenticate the verifier entry without executing that verifier. This breaks
# the otherwise circular trust relationship where a modified verifier could
# approve the release tree containing itself.
verify_release_verifier_entry() {
  local manifest="$1" verifier="$2" expected_release_id="$3"
  python3 - "$manifest" "$verifier" "$expected_release_id" <<'PY'
import hashlib,json,os,stat,sys
manifest_path,verifier_path,expected=sys.argv[1:]
for path in (manifest_path,verifier_path):
    metadata=os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit("release bootstrap input is not a regular file")
with open(manifest_path,"r",encoding="utf-8") as stream:
    manifest=json.load(stream)
if set(manifest) != {"schemaVersion","profile","releaseId","entries"}:
    raise SystemExit("release bootstrap manifest schema mismatch")
payload={"schemaVersion":manifest.get("schemaVersion"),"profile":manifest.get("profile"),"entries":manifest.get("entries")}
calculated=hashlib.sha256(json.dumps(payload,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
if manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps" or manifest.get("releaseId") != expected or calculated != expected:
    raise SystemExit("release bootstrap manifest identity mismatch")
entries=[entry for entry in manifest.get("entries",[]) if isinstance(entry,dict) and entry.get("path")=="platform/deploy/vps/verify-release.py"]
if len(entries) != 1 or set(entries[0]) != {"path","sha256","size","mode"}:
    raise SystemExit("release bootstrap verifier entry mismatch")
entry=entries[0]; before=os.lstat(verifier_path)
if entry.get("mode") not in {"0644","0755"} or entry.get("size") != before.st_size or entry.get("mode") != f"{stat.S_IMODE(before.st_mode):04o}":
    raise SystemExit("release bootstrap verifier metadata mismatch")
descriptor=os.open(verifier_path,os.O_RDONLY|os.O_NOFOLLOW)
try:
    opened=os.fstat(descriptor)
    if (opened.st_dev,opened.st_ino,opened.st_size) != (before.st_dev,before.st_ino,before.st_size):
        raise SystemExit("release bootstrap verifier changed before open")
    digest=hashlib.file_digest(os.fdopen(descriptor,"rb",closefd=False),"sha256").hexdigest()
finally:
    os.close(descriptor)
after=os.lstat(verifier_path)
if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) != (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns):
    raise SystemExit("release bootstrap verifier changed while hashing")
if not isinstance(entry.get("sha256"),str) or digest != entry["sha256"]:
    raise SystemExit("release bootstrap verifier digest mismatch")
PY
}

ensure_layout() {
  assert_remote_root
  [[ ! -L "$DATA_DIR" && ! -L "$PIN_RELEASE_DIR" ]] \
    || fail "canonical Pin release data path is a symlink"
  mkdir -p -- "$REMOTE_ROOT" "$PRIVATE_DIR" "$DATA_DIR" "$PIN_RELEASE_DIR" \
    "$BACKUP_ROOT" "$DEPLOYMENTS_DIR" "$PACKAGES_DIR" "$MANIFESTS_DIR" "$RELEASES_DIR"
  chmod 700 "$REMOTE_ROOT" "$PRIVATE_DIR" "$DATA_DIR" "$PIN_RELEASE_DIR" \
    "$BACKUP_ROOT" "$DEPLOYMENTS_DIR" "$PACKAGES_DIR" "$MANIFESTS_DIR" "$RELEASES_DIR"
  [[ "$(stat -c '%u' "$DATA_DIR")" == 1000 && "$(stat -c '%u' "$PIN_RELEASE_DIR")" == 1000 ]] \
    || fail "canonical Pin release data paths are not owned by the Center runtime uid"
  touch "$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
}

# `--already-locked` is used only when a parent deploy/rollback operation has
# inherited descriptor 9 into backup.sh.  Prove that descriptor 9 names the
# canonical lock inode and holds (or can acquire) the exclusive flock before
# trusting the option.  A caller cannot bypass serialization merely by passing
# the flag with a closed or unrelated descriptor.
assert_inherited_deploy_lock() {
  python3 - "$LOCK_FILE" <<'PY'
import fcntl,os,stat,sys
path=sys.argv[1]
try:
    descriptor=os.fstat(9)
    target=os.stat(path,follow_symlinks=False)
except OSError as error:
    raise SystemExit(f"inherited deployment lock descriptor is unavailable: {error}")
if not stat.S_ISREG(target.st_mode):
    raise SystemExit("canonical deployment lock is not a regular file")
if (descriptor.st_dev,descriptor.st_ino)!=(target.st_dev,target.st_ino):
    raise SystemExit("inherited descriptor does not name the canonical deployment lock")
try:
    fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("inherited descriptor does not own the deployment lock")
PY
}

read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    {
      name=substr($0,1,index($0,"=")-1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) value=substr($0,index($0,"=")+1)
    }
    END {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^\042.*\042$/) value=substr(value,2,length(value)-2)
      if (length(value)) print value; else exit 1
    }
  ' "$file"
}

update_env_value() {
  local file="$1" key="$2" value="$3" temporary
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid environment key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "environment value contains a newline"
  mkdir -p -- "$(dirname -- "$file")"
  [[ -e "$file" ]] || install -m 600 /dev/null "$file"
  temporary="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { changed=0 }
    {
      name=$0
      sub(/=.*/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) {
        if (!changed) print wanted "=" replacement
        changed=1
      } else print
    }
    END { if (!changed) print wanted "=" replacement }
  ' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$file"
}

remove_env_value() {
  local file="$1" key="$2" temporary
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -f "$file" ]] || fail "invalid environment key removal"
  temporary="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v unwanted="$key" '
    {
      name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != unwanted) print
    }
  ' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$file"
}

copy_file_once() {
  local source="$1" destination="$2"
  [[ -f "$destination" ]] && return 0
  [[ -f "$source" ]] || return 1
  install -m 600 "$source" "$destination"
}

copy_tree_once() {
  local source="$1" destination="$2"
  [[ -e "$destination" ]] && return 0
  [[ -d "$source" ]] || return 1
  mkdir -p -- "$(dirname -- "$destination")"
  cp -a -- "$source" "$destination"
}

prepare_private_copies() {
  mkdir -p -- "$PRIVATE_DIR/imported"
  chmod 700 "$PRIVATE_DIR/imported"

  copy_file_once /home/anders/humane-carry-clone/.env "$RUNTIME_ENV" || true
  copy_file_once /home/anders/carry-center.env "$CENTER_ENV" || true
  copy_file_once /home/anders/carry-backends.env "$PRIVATE_DIR/imported/carry-backends.env" || true

  # Provider credentials are intentionally scoped to ai-bus. Preserve the old
  # file byte-for-byte in imported/, then derive two canonical files without
  # ever sourcing or displaying their contents.
  local source="$PRIVATE_DIR/imported/carry-backends.env"
  if [[ ! -f "$PROVIDER_ENV" && -f "$source" ]]; then
      awk '
        /^[[:space:]]*#/ { print; next }
        /^[[:space:]]*$/ { print; next }
        {
          name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
          if (name ~ /^(AZURE_|CARRY_AZURE_|CARRY_LLM_|CARRY_OPENROUTER_API_KEY$|CARRY_INTERSTITIAL_|CARRY_SERPAPI_KEY$|CARRY_GOOGLE_MAPS_KEY$|CARRY_PIRATE_WEATHER_KEY$|CARRY_WOLFRAM_APP_ID$|CARRY_PPLX_|CARRY_MUSICBRAINZ_|CARRY_SHOPPING_|OPENAI_|OPENROUTER_)/) print
        }
      ' "$source" >"$PROVIDER_ENV"
      chmod 600 "$PROVIDER_ENV"
  fi
  if [[ ! -f "$COSMOS_ENV" && -f "$source" ]]; then
      awk '
        /^[[:space:]]*#/ { print; next }
        /^[[:space:]]*$/ { print; next }
        {
          name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
          if (name !~ /^(AZURE_|CARRY_AZURE_|CARRY_LLM_|CARRY_OPENROUTER_API_KEY$|CARRY_INTERSTITIAL_|CARRY_SERPAPI_KEY$|CARRY_GOOGLE_MAPS_KEY$|CARRY_PIRATE_WEATHER_KEY$|CARRY_WOLFRAM_APP_ID$|CARRY_PPLX_|CARRY_MUSICBRAINZ_|CARRY_SHOPPING_|OPENAI_|OPENROUTER_)/) print
        }
      ' "$source" >"$COSMOS_ENV"
      chmod 600 "$COSMOS_ENV"
  fi

  for file in "$RUNTIME_ENV" "$COSMOS_ENV" "$CENTER_ENV" "$PROVIDER_ENV"; do
    [[ -f "$file" ]] || install -m 600 /dev/null "$file"
    chmod 600 "$file"
  done

  copy_tree_once /home/anders/carry-edge "$PRIVATE_DIR/edge" || true
  copy_tree_once /home/anders/carry-attest "$PRIVATE_DIR/attest" || true
  copy_tree_once /home/anders/carry-duc "$PRIVATE_DIR/duc" || true
  copy_tree_once /home/anders/keycloak-themes/humane "$PRIVATE_DIR/keycloak-theme" || true
}

# Assemble a candidate private configuration without changing any file used by
# the running production stack. This is used for image builds and rehearsal;
# install_staged_configuration performs the first live config write only after
# a verified backup exists and the old stack is fully quiesced.
stage_private_configuration() {
  local destination="$1" source
  [[ "$destination" == "$DEPLOYMENTS_DIR/"* ]] || fail "staged configuration must live under deployments"
  mkdir -p -- "$destination"
  chmod 700 "$destination"

  source="$RUNTIME_ENV"
  [[ -f "$source" ]] || source=/home/anders/humane-carry-clone/.env
  [[ -f "$source" ]] && install -m 600 "$source" "$destination/runtime.env" || install -m 600 /dev/null "$destination/runtime.env"

  source="$CENTER_ENV"
  [[ -f "$source" ]] || source=/home/anders/carry-center.env
  [[ -f "$source" ]] && install -m 600 "$source" "$destination/center.env" || install -m 600 /dev/null "$destination/center.env"

  if [[ -f "$PROVIDER_ENV" ]]; then
    install -m 600 "$PROVIDER_ENV" "$destination/providers.env"
  else
    source="$PRIVATE_DIR/imported/carry-backends.env"
    [[ -f "$source" ]] || source=/home/anders/carry-backends.env
    [[ -f "$source" ]] || fail "provider configuration source is missing"
    awk '
      /^[[:space:]]*#/ { print; next }
      /^[[:space:]]*$/ { print; next }
      {
        name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
        if (name ~ /^(AZURE_|CARRY_AZURE_|CARRY_LLM_|CARRY_OPENROUTER_API_KEY$|CARRY_INTERSTITIAL_|CARRY_SERPAPI_KEY$|CARRY_GOOGLE_MAPS_KEY$|CARRY_PIRATE_WEATHER_KEY$|CARRY_WOLFRAM_APP_ID$|CARRY_PPLX_|CARRY_MUSICBRAINZ_|CARRY_SHOPPING_|OPENAI_|OPENROUTER_)/) print
      }
    ' "$source" >"$destination/providers.env"
  fi

  if [[ -f "$COSMOS_ENV" ]]; then
    install -m 600 "$COSMOS_ENV" "$destination/cosmos.env"
  else
    source="$PRIVATE_DIR/imported/carry-backends.env"
    [[ -f "$source" ]] || source=/home/anders/carry-backends.env
    [[ -f "$source" ]] || fail "Cosmos configuration source is missing"
    awk '
      /^[[:space:]]*#/ { print; next }
      /^[[:space:]]*$/ { print; next }
      {
        name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
        if (name !~ /^(AZURE_|CARRY_AZURE_|CARRY_LLM_|CARRY_OPENROUTER_API_KEY$|CARRY_INTERSTITIAL_|CARRY_SERPAPI_KEY$|CARRY_GOOGLE_MAPS_KEY$|CARRY_PIRATE_WEATHER_KEY$|CARRY_WOLFRAM_APP_ID$|CARRY_PPLX_|CARRY_MUSICBRAINZ_|CARRY_SHOPPING_|OPENAI_|OPENROUTER_)/) print
      }
    ' "$source" >"$destination/cosmos.env"
  fi
  chmod 600 "$destination"/*.env
  normalize_compatibility_aliases "$destination/runtime.env"
  merge_scoped_provider_values "$destination/runtime.env" "$destination/providers.env"
}

# Apply the dashboard's pending configuration proposals into a STAGED env set.
#
# This is the only thing that acts on what Center's configuration console
# writes, and it is deliberately the deploy that does it. The four protected env
# files are fingerprinted into every deployment record by
# record_configuration_evidence, and rollback.sh recomputes those fingerprints
# before it will roll anything back -- so a dashboard that wrote them directly
# would disarm recovery for the live system, silently, and the operator would
# find out during the rollback that refuses. Applying here means the new values
# and the new digests are captured by the SAME record_configuration_evidence
# call, in the same deployment record, as the release they ship with.
#
# READ-ONLY WITH RESPECT TO CENTER'S DATA. The store is desired state, not a
# queue: applying an entry twice is applying it once, so nothing has to be
# marked consumed and no writer for Center's data volume has to exist inside the
# deploy transaction. An absent store is the normal state and returns quietly.
#
# THE ALLOWLIST BELOW IS INDEPENDENT, AND THAT IS THE POINT. Center validates
# before it writes, but Center is the public web app -- it is the thing an
# attacker reaches first, and a forged or hand-edited store file is exactly what
# a compromise would leave behind. So this re-derives which names may be set,
# which file each belongs in, and what shape each value must have, and refuses
# the WHOLE file if anything does not match rather than applying the part that
# does. platform/deploy/acceptance/configuration-proposals.test.mjs pins this
# table against center/src/server/configuration.ts so the two cannot drift.
apply_configuration_proposals() {
  local stage_env="$1" store="$CENTER_DATA_DIR/configuration-proposals.json"
  [[ -d "$stage_env" && ! -L "$stage_env" ]] || fail "staged environment directory is missing or unsafe"

  # Absent is the normal state of a deployment nobody has proposed anything on.
  # Present-but-not-a-regular-file is not: a symlink here would be an attempt to
  # make the deploy read something else, and there is no benign reason for one.
  if [[ ! -e "$store" && ! -L "$store" ]]; then return 0; fi
  [[ -f "$store" && ! -L "$store" ]] \
    || fail "configuration proposal store is not a regular file: $store"

  local plan
  plan="$(python3 - "$store" <<'PY'
import json, re, sys

# name -> (env file it belongs in, value grammar). Mirrors the `proposable`
# descriptors in center/src/server/configuration.ts whose delivery is
# "env-plane". A name absent from here is refused, whatever the file says.
ALLOWED = {
    "KEYCLOAK_SCOPES": ("center.env", "scopes"),
    "REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS": ("runtime.env", "timeout"),
    "CARRY_AZURE_SPEECH_VOICE": ("providers.env", "voice"),
    "CARRY_LLM_MODEL": ("providers.env", "model"),
    "CARRY_VISION_MODEL": ("runtime.env", "model"),
}
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$")
VOICE = re.compile(r"^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+$")
SCOPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")

def refuse(message):
    raise SystemExit(f"configuration proposal store is not applicable: {message}")

def check(name, kind, value):
    # Shared first, and non-negotiable: this value becomes the right-hand side
    # of a KEY=value line that Compose interpolates. A newline would forge a
    # second assignment; update_env_value refuses one outright, which would fail
    # the deploy at the point of no return instead of here.
    if not (1 <= len(value) <= 512) or not re.fullmatch(r"[\x20-\x7e]+", value):
        refuse(f"{name} is empty, too long, or contains something other than printable ASCII")
    if value != value.strip():
        refuse(f"{name} has leading or trailing whitespace")
    if kind == "timeout":
        if not re.fullmatch(r"(0|[1-9][0-9]*)", value) or not 500 <= int(value) <= 60000:
            refuse(f"{name} must be a whole number of milliseconds between 500 and 60000")
    elif kind == "model":
        if len(value) > 128 or not MODEL.fullmatch(value):
            refuse(f"{name} is not a usable provider model identifier")
    elif kind == "voice":
        if len(value) > 64 or not VOICE.fullmatch(value):
            refuse(f"{name} is not a usable Azure locale and voice name")
    elif kind == "scopes":
        tokens = value.split(" ")
        if not 1 <= len(tokens) <= 12 or not all(SCOPE.fullmatch(token) for token in tokens):
            refuse(f"{name} is not a usable space-separated scope list")
        if "openid" not in tokens:
            refuse(f"{name} must include openid or no one can sign in")
    else:
        refuse(f"{name} has no grammar defined for it")

try:
    document = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as error:
    refuse(f"it could not be parsed ({error})")
if not isinstance(document, dict) or document.get("schemaVersion") != 1:
    refuse("it does not declare schema version 1")
settings = document.get("settings")
if not isinstance(settings, dict):
    refuse("it carries no settings object")

for name in sorted(settings):
    entry = settings[name]
    if name not in ALLOWED:
        refuse(f"{name} is not a setting the dashboard may propose")
    if not isinstance(entry, dict) or not isinstance(entry.get("value"), str):
        refuse(f"the entry for {name} is malformed")
    target, kind = ALLOWED[name]
    value = entry["value"]
    check(name, kind, value)
    print(f"{name}\t{target}\t{value}")
PY
  )" || fail "refusing to deploy with an unapplicable configuration proposal store; the message above names the entry, and Center's operator console can remove it"

  [[ -n "$plan" ]] || return 0

  local name target value file touched
  while IFS=$'\t' read -r name target value; do
    [[ -n "$name" ]] || continue
    touched=""
    # The name's home, plus every other staged file that already defines it.
    # All four are Compose --env-file arguments and the LAST one wins, so
    # writing only the home would let a stale value in a later file quietly win
    # -- the operator would see the change saved, deployed, and ineffective,
    # which is the one outcome this whole mechanism exists to avoid.
    for file in runtime.env cosmos.env providers.env center.env; do
      if [[ "$file" == "$target" ]] || read_env_value "$stage_env/$file" "$name" >/dev/null 2>&1; then
        update_env_value "$stage_env/$file" "$name" "$value"
        touched="$touched $file"
      fi
    done
    # The name and the files, never the value: these are not secrets, but this
    # output is shared and the store is the record that carries values anyway.
    log "applied dashboard configuration proposal: $name ->$touched"
  done <<<"$plan"
  unset name target value file touched
}

normalize_compatibility_aliases() {
  local file="$1"
  python3 - "$file" <<'PY'
import os,sys,tempfile
path=sys.argv[1]
mapping={
  "REVIVAL_AUTH_MODE":"CARRY_AUTH_MODE",
  "REVIVAL_EDGE_TOKEN":"CARRY_EDGE_TOKEN",
  "REVIVAL_SHARE_TOKEN_SECRET":"CARRY_SHARE_TOKEN_SECRET",
  "REVIVAL_CENTER_PROJECTION_TOKEN":"CARRY_CENTER_PROJECTION_TOKEN",
  "REVIVAL_ADMIN_TOKEN":"CARRY_ADMIN_TOKEN",
  "REVIVAL_OPAQUE_SEED":"CARRY_OPAQUE_SEED",
  "REVIVAL_REMOTE_TTS_ENABLED":"CARRY_REMOTE_TTS_ENABLED",
  "AZURE_SPEECH_KEY":"CARRY_AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION":"CARRY_AZURE_SPEECH_REGION",
  "AZURE_SPEECH_VOICE":"CARRY_AZURE_SPEECH_VOICE",
  "REVIVAL_ENROLLMENT_PINCODE":"CARRY_ENROLLMENT_PINCODE",
  "REVIVAL_ENROLLMENT_USER_ID":"CARRY_ENROLLMENT_USER_ID",
  "REVIVAL_DUC_CA_CERT":"CARRY_DUC_CA_CERT",
  "REVIVAL_DUC_CA_KEY":"CARRY_DUC_CA_KEY",
  "REVIVAL_OPERATOR_EMAILS":"CARRY_OPERATOR_EMAILS",
}
lines=open(path,encoding="utf-8").readlines() if os.path.exists(path) else []
values={}
for line in lines:
    key,separator,value=line.rstrip("\n").partition("=")
    if separator: values[key.strip()]=value
replacements={alias:values[source] for source,alias in mapping.items() if values.get(source,"") and not values.get(alias,"")}
seen=set(); output=[]
for line in lines:
    key,separator,_=line.rstrip("\n").partition("="); key=key.strip()
    if separator and key in replacements:
        output.append(f"{key}={replacements[key]}\n"); seen.add(key)
    else: output.append(line)
for key in sorted(replacements):
    if key not in seen: output.append(f"{key}={replacements[key]}\n")
fd,temporary=tempfile.mkstemp(prefix=".aliases.",dir=os.path.dirname(path),text=True)
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as handle: handle.writelines(output)
    os.replace(temporary,path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
  chmod 600 "$file"
}

merge_scoped_provider_values() {
  local source="$1" destination="$2"
  python3 - "$source" "$destination" <<'PY'
import os,re,sys,tempfile
source,destination=sys.argv[1:]
allowed=re.compile(r"^(?:AZURE_|CARRY_AZURE_|CARRY_LLM_|CARRY_OPENROUTER_API_KEY$|CARRY_INTERSTITIAL_|CARRY_SERPAPI_KEY$|CARRY_GOOGLE_MAPS_KEY$|CARRY_PIRATE_WEATHER_KEY$|CARRY_WOLFRAM_APP_ID$|CARRY_PPLX_|CARRY_MUSICBRAINZ_|CARRY_SHOPPING_|OPENAI_|OPENROUTER_)")
def parse(path):
    values={}
    if os.path.exists(path):
        for line in open(path,encoding="utf-8"):
            key,separator,value=line.rstrip("\n").partition("=")
            if separator: values[key.strip()]=value
    return values
source_values=parse(source); destination_values=parse(destination)
add={key:value for key,value in source_values.items() if value and allowed.match(key) and not destination_values.get(key,"")}
lines=open(destination,encoding="utf-8").readlines() if os.path.exists(destination) else []
for key in sorted(add): lines.append(f"{key}={add[key]}\n")
fd,temporary=tempfile.mkstemp(prefix=".providers.",dir=os.path.dirname(destination),text=True)
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as handle: handle.writelines(lines)
    os.replace(temporary,destination)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
  chmod 600 "$destination"
}

# Import only the Center values that may exist solely in the effective
# container environment. Values never cross stdout and are never placed in a
# command-line argument. Existing staged values win unless the live container
# provides the authoritative effective value for the same allowlisted key.
capture_live_center_env() {
  local destination="$1" container inspection project current containers
  if current="$(safe_release_pointer "$REMOTE_ROOT/current" 2>/dev/null)"; then
    safe_deployment_pointer "$REMOTE_ROOT/current-deployment" >/dev/null 2>&1 \
      || fail "canonical Center cannot be selected without authoritative deployment lineage"
    project="$PROJECT"
  else
    project="$LEGACY_PROJECT"
  fi
  containers="$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=center')"
  [[ -n "$containers" && "$(printf '%s\n' "$containers" | sed '/^$/d' | wc -l | tr -d '[:space:]')" == 1 ]] \
    || fail "expected exactly one active authoritative Center container"
  container="$containers"
  inspection="$(mktemp)"
  docker inspect --format '{{json .Config.Env}}' "$container" >"$inspection"
  python3 - "$destination" "$inspection" <<'PY'
import json, os, sys, tempfile
destination,inspection=sys.argv[1:]
allowed={
    "AUTH_SESSION_SECRET", "KEYCLOAK_CLIENT_SECRET", "CARRY_ADMIN_TOKEN",
    "CARRY_CENTER_PROJECTION_TOKEN", "CARRY_SHARE_TOKEN_SECRET",
    "CARRY_OPERATOR_EMAILS", "KEYCLOAK_BASE_URL", "KEYCLOAK_REALM",
    "KEYCLOAK_CLIENT_ID", "KEYCLOAK_SCOPES", "CARRY_OIDC_ISSUER",
    "CARRY_OIDC_JWKS_URI", "CARRY_OIDC_AUDIENCE",
}
raw=open(inspection,encoding="utf-8").read()
values={}
for item in json.loads(raw):
    key, separator, value=item.partition("=")
    if separator and key in allowed:
        if "\n" in value or "\r" in value: raise SystemExit("unsafe newline in live Center environment")
        values[key]=value
lines=[]
seen=set()
if os.path.exists(destination):
    for line in open(destination, encoding="utf-8"):
        key, separator, _=line.rstrip("\n").partition("=")
        if separator and key.strip() in values:
            key=key.strip(); lines.append(f"{key}={values[key]}\n"); seen.add(key)
        else: lines.append(line)
for key in sorted(values):
    if key not in seen: lines.append(f"{key}={values[key]}\n")
directory=os.path.dirname(destination)
fd, temporary=tempfile.mkstemp(prefix=".center.env.", dir=directory, text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as output: output.writelines(lines)
    os.replace(temporary,destination)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
  rm -f -- "$inspection"
  chmod 600 "$destination"
}

derive_paired_identity() {
  local postgres="$1" rows device_id account_sub keycloak_count
  rows="$(docker exec "$postgres" psql -v ON_ERROR_STOP=1 -U carry -d carry -AtF $'\t' -c \
    'select device_id, account_sub from carry_device_account order by paired_at_epoch, device_id')"
  [[ -n "$rows" && "$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')" == 1 ]] \
    || fail "expected exactly one durable Pin pairing"
  IFS=$'\t' read -r device_id account_sub <<<"$rows"
  [[ -n "$device_id" && -n "$account_sub" && "$device_id" != *$'\n'* && "$account_sub" != *$'\n'* ]] \
    || fail "durable Pin pairing is malformed"
  local account_sub_sql
  account_sub_sql="${account_sub//\'/''}"
  keycloak_count="$(docker exec "$postgres" psql -v ON_ERROR_STOP=1 -U carry -d keycloak -Atc \
    "select count(*) from user_entity where id = '${account_sub_sql}'" | tr -d '[:space:]')"
  [[ "$keycloak_count" == 1 ]] || fail "paired Pin subject is not an exact Keycloak user id"
  printf '%s\t%s\n' "$device_id" "$account_sub"
}

stage_paired_identity() {
  local postgres="$1" destination="$2" identity device_id account_sub existing
  identity="$(derive_paired_identity "$postgres")"
  IFS=$'\t' read -r device_id account_sub <<<"$identity"
  existing="$(read_env_value "$destination" REVIVAL_PIN_BRIDGE_DEVICE_ID 2>/dev/null || true)"
  [[ -z "$existing" || "$existing" == "$device_id" ]] || fail "protected Pin device identity conflicts with the durable roster"
  existing="$(read_env_value "$destination" REVIVAL_PIN_BRIDGE_OWNER_SUB 2>/dev/null || true)"
  [[ -z "$existing" || "$existing" == "$account_sub" ]] || fail "protected Pin owner identity conflicts with the durable roster"
  update_env_value "$destination" REVIVAL_PIN_BRIDGE_DEVICE_ID "$device_id"
  update_env_value "$destination" REVIVAL_PIN_BRIDGE_OWNER_SUB "$account_sub"
  unset identity device_id account_sub existing
}

record_path_metadata() {
  local output="$1"
  shift
  : >"$output"
  local path
  for path in "$@"; do
    if [[ -e "$path" || -L "$path" ]]; then
      printf 'present\t%s\n' "$path" >>"$output"
    else
      printf 'absent\t%s\n' "$path" >>"$output"
    fi
  done
  chmod 600 "$output"
}

record_image_evidence() {
  local release_dir="$1" output="$2" service container image configured_id repo_digests
  load_compose_command "$release_dir"
  : >"$output"
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    container="$("${COMPOSE[@]}" ps --all -q "$service" 2>/dev/null || true)"
    [[ -n "$container" ]] || continue
    image="$(docker inspect --format '{{.Config.Image}}' "$container")"
    configured_id="$(docker inspect --format '{{.Image}}' "$container")"
    repo_digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$configured_id" 2>/dev/null || true)"
    printf '%s\t%s\t%s\t%s\n' "$service" "$image" "$configured_id" "$repo_digests" >>"$output"
  done < <("${COMPOSE[@]}" config --services)
  # `compose config --services` does not guarantee a stable order, and this
  # evidence is re-recorded and byte-compared at later gates. Sort so identical
  # running state always produces an identical file.
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output"
}

verify_image_evidence() {
  local expected="$1" release_dir="$2" current
  [[ -f "$expected" ]] || fail "running image evidence is missing"
  current="$(mktemp)"
  record_image_evidence "$release_dir" "$current"
  if ! cmp -s "$expected" "$current"; then
    # The evidence is recorded once and re-proved at several later gates; a
    # drift here is only actionable with the exact differing rows.
    { echo "--- image evidence drift (expected | actual) ---"
      diff -u "$expected" "$current" | head -40
      echo "--- end drift ---"; } >&2 || true
    rm -f "$current"
    fail "running image identity drift"
  fi
  rm -f "$current"
}

verify_running_against_resolved() {
  local resolved="$1" running="$2"
  python3 - "$resolved" "$running" <<'PY'
import sys
resolved={}
for line_number,line in enumerate(open(sys.argv[1],encoding="utf-8"),1):
    parts=line.rstrip("\n").split("\t")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise SystemExit(f"malformed resolved image evidence at line {line_number}")
    image,image_id=parts[:2]
    if image in resolved:
        raise SystemExit(f"duplicate resolved image evidence: {image}")
    resolved[image]=image_id
seen=set()
services=set()
for line_number,line in enumerate(open(sys.argv[2],encoding="utf-8"),1):
    parts=line.rstrip("\n").split("\t")
    if len(parts) < 3 or not all(parts[:3]):
        raise SystemExit(f"malformed running image evidence at line {line_number}")
    service,image,image_id=parts[:3]
    if service in services:
        raise SystemExit(f"duplicate running service evidence: {service}")
    services.add(service)
    if image not in resolved or resolved[image] != image_id:
        raise SystemExit(f"running image id was not the pre-cutover resolved id for {service}")
    seen.add(image)
if not seen or seen != set(resolved):
    missing=sorted(set(resolved)-seen)
    raise SystemExit(f"running image evidence is incomplete; unresolved images: {missing}")
PY
}

# Record fingerprints and metadata only, never protected values. The rendered
# Compose model is canonicalized in memory so its digest binds interpolation
# without persisting the secret-bearing model.
protected_path_digest() {
  local path="$1"
  sudo -n python3 - "$path" <<'PY'
import hashlib,os,stat,sys
root=os.path.abspath(sys.argv[1]); digest=hashlib.sha256()
def add(value):
    data=value if isinstance(value,bytes) else str(value).encode()
    digest.update(len(data).to_bytes(8,"big")); digest.update(data)
def visit(path,relative):
    metadata=os.lstat(path); mode=metadata.st_mode
    add(relative); add(stat.S_IFMT(mode)); add(stat.S_IMODE(mode)); add(metadata.st_uid); add(metadata.st_gid)
    if stat.S_ISREG(mode):
        add(metadata.st_size)
        with open(path,"rb") as handle:
            while chunk:=handle.read(1024*1024): digest.update(chunk)
    elif stat.S_ISLNK(mode): add(os.readlink(path))
    elif stat.S_ISDIR(mode):
        for name in sorted(os.listdir(path)): visit(os.path.join(path,name),os.path.join(relative,name))
    else: raise SystemExit(f"unsupported protected object type: {relative}")
visit(root,".")
print(digest.hexdigest())
PY
}

record_configuration_evidence_with_env() {
  local release_dir="$1" runtime="$2" cosmos="$3" provider="$4" center="$5" output="$6"
  local temporary label path digest mode owner
  load_compose_command_with_env "$release_dir" "$runtime" "$cosmos" "$provider" "$center"
  temporary="$(mktemp)"
  : >"$temporary"
  while IFS=$'\t' read -r label path; do
    [[ -f "$path" && ! -L "$path" ]] || { rm -f -- "$temporary"; fail "configuration input is missing or unsafe: $label"; }
    digest="$(sha256sum "$path" | awk '{print $1}')"
    mode="$(stat -c '%a' "$path")"
    owner="$(stat -c '%u:%g' "$path")"
    printf 'file\t%s\t%s\t%s\t%s\n' "$label" "$digest" "$mode" "$owner" >>"$temporary"
  done <<EOF
runtime.env	$runtime
cosmos.env	$cosmos
providers.env	$provider
center.env	$center
edge.envoy	$PRIVATE_DIR/edge/envoy.yaml
spotify.token	$PRIVATE_DIR/spotify-adapter/token
nginx.connectivity	/etc/nginx/sites-available/ai-pin-revival-connectivity
EOF
  path=/etc/nginx/sites-enabled/ai-pin-revival-connectivity
  [[ -L "$path" ]] || { rm -f -- "$temporary"; fail "configuration input is missing or unsafe: nginx.enabled"; }
  digest="$(readlink -- "$path" | sha256sum | awk '{print $1}')"
  mode="$(stat -c '%a' "$path")"
  owner="$(stat -c '%u:%g' "$path")"
  printf 'symlink\tnginx.enabled\t%s\t%s\t%s\n' "$digest" "$mode" "$owner" >>"$temporary"
  local center_available=/etc/nginx/sites-available/ai-pin-revival-center
  local center_enabled=/etc/nginx/sites-enabled/ai-pin-revival-center
  if [[ -e "$center_available" || -L "$center_available" || -e "$center_enabled" || -L "$center_enabled" ]]; then
    [[ -f "$center_available" && ! -L "$center_available" && -L "$center_enabled" ]] \
      || { rm -f -- "$temporary"; fail "Center Nginx configuration is incomplete or unsafe"; }
    digest="$(sha256sum "$center_available" | awk '{print $1}')"
    mode="$(stat -c '%a' "$center_available")"
    owner="$(stat -c '%u:%g' "$center_available")"
    printf 'file\tnginx.center.available\t%s\t%s\t%s\n' "$digest" "$mode" "$owner" >>"$temporary"
    digest="$(readlink -- "$center_enabled" | sha256sum | awk '{print $1}')"
    mode="$(stat -c '%a' "$center_enabled")"
    owner="$(stat -c '%u:%g' "$center_enabled")"
    printf 'symlink\tnginx.center.enabled\t%s\t%s\t%s\n' "$digest" "$mode" "$owner" >>"$temporary"
  fi
  while IFS=$'\t' read -r label path; do
    sudo -n test -e "$path" || { rm -f -- "$temporary"; fail "protected security root is missing: $label"; }
    digest="$(protected_path_digest "$path")"
    printf 'protected\t%s\t%s\t-\t-\n' "$label" "$digest" >>"$temporary"
  done <<EOF
edge.security	$PRIVATE_DIR/edge
attestation.security	$PRIVATE_DIR/attest
device-user.security	$PRIVATE_DIR/duc
keycloak.theme	$PRIVATE_DIR/keycloak-theme
bridge.config	/etc/penumbra
bridge.state	/var/lib/penumbra-center
bridge.unit	/etc/systemd/system/penumbra-center-bridge.service
EOF
  digest="$("${COMPOSE[@]}" config --format json \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")))' \
    | sha256sum | awk '{print $1}')"
  printf 'rendered\tcompose.json\t%s\t-\t-\n' "$digest" >>"$temporary"
  LC_ALL=C sort -o "$temporary" "$temporary"
  install -m 600 "$temporary" "$output"
  rm -f -- "$temporary"
}

record_configuration_evidence() {
  local release_dir="$1" output="$2"
  record_configuration_evidence_with_env "$release_dir" "$RUNTIME_ENV" "$COSMOS_ENV" "$PROVIDER_ENV" "$CENTER_ENV" "$output"
}

verify_configuration_evidence() {
  local expected="$1" release_dir="$2" current
  [[ -f "$expected" ]] || fail "configuration evidence is missing"
  current="$(mktemp)"
  record_configuration_evidence "$release_dir" "$current"
  if ! python3 - "$expected" "$current" <<'PY'
import sys
def stable(path):
    rows=[]
    for raw in open(path,encoding="utf-8"):
        fields=raw.rstrip("\n").split("\t")
        if fields[:2]==["protected","bridge.state"]: continue
        rows.append(fields)
    return rows
assert stable(sys.argv[1])==stable(sys.argv[2])
PY
  then
    rm -f -- "$current"
    fail "protected configuration or rendered Compose model drift"
  fi
  rm -f -- "$current"
}

nginx_snapshot_manifest_value() {
  local manifest="$1" key="$2"
  awk -F '\t' -v wanted="$key" '
    $1 == wanted { if (found) exit 2; value=$2; found=1 }
    END { if (!found) exit 3; print value }
  ' "$manifest"
}

nginx_snapshot_object_type() {
  local path="$1"
  if sudo -n test -L "$path"; then printf 'symlink\n'
  elif sudo -n test -f "$path"; then printf 'regular\n'
  elif ! sudo -n test -e "$path" && ! sudo -n test -L "$path"; then printf 'absent\n'
  else return 1
  fi
}

nginx_snapshot_object_identity() {
  local path="$1" type="$2"
  case "$type" in
    regular)
      {
        printf 'regular\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n sha256sum -- "$path" | awk '{printf "%s%c", $1, 0}'
      } | sha256sum | awk '{print $1}'
      ;;
    symlink)
      {
        printf 'symlink\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n readlink -z -- "$path"
      } | sha256sum | awk '{print $1}'
      ;;
    *) return 1 ;;
  esac
}

validate_nginx_transaction_snapshot() {
  local evidence="$1" require_install="${2:-0}"
  local snapshot="$evidence/nginx-install/snapshot"
  local manifest="$snapshot/PRESENCE.COMPLETE"
  local label target expected_snapshot present type name identity actual_type actual_identity
  [[ -d "$snapshot" && ! -L "$snapshot" && -f "$manifest" && ! -L "$manifest" ]] || return 1
  [[ "$(wc -l <"$manifest" | tr -d '[:space:]')" == 12 ]] || return 1
  [[ "$(nginx_snapshot_manifest_value "$manifest" schema)" == ai-pin-revival-nginx-presence-v1 ]] || return 1
  [[ "$(nginx_snapshot_manifest_value "$manifest" complete)" == 1 ]] || return 1
  if [[ "$require_install" == 1 ]]; then
    local marker="$evidence/nginx-install/INSTALL.COMPLETE"
    [[ -f "$marker" && ! -L "$marker" ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" schema)" == ai-pin-revival-nginx-install-v1 ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" complete)" == 1 ]] || return 1
    [[ "$(nginx_snapshot_manifest_value "$marker" presence_manifest)" == snapshot/PRESENCE.COMPLETE ]] || return 1
  fi
  while IFS=$'\t' read -r label target expected_snapshot; do
    [[ "$(nginx_snapshot_manifest_value "$manifest" "$label.target")" == "$target" ]] || return 1
    present="$(nginx_snapshot_manifest_value "$manifest" "$label.present")" || return 1
    type="$(nginx_snapshot_manifest_value "$manifest" "$label.type")" || return 1
    name="$(nginx_snapshot_manifest_value "$manifest" "$label.snapshot")" || return 1
    identity="$(nginx_snapshot_manifest_value "$manifest" "$label.identity_sha256")" || return 1
    case "$present:$type:$name" in
      0:absent:-)
        [[ "$identity" == - && ! -e "$snapshot/$expected_snapshot" && ! -L "$snapshot/$expected_snapshot" ]] || return 1
        ;;
      1:regular:"$expected_snapshot"|1:symlink:"$expected_snapshot")
        [[ "$identity" =~ ^[0-9a-f]{64}$ ]] || return 1
        actual_type="$(nginx_snapshot_object_type "$snapshot/$expected_snapshot")" || return 1
        [[ "$actual_type" == "$type" ]] || return 1
        actual_identity="$(nginx_snapshot_object_identity "$snapshot/$expected_snapshot" "$type")" || return 1
        [[ "$actual_identity" == "$identity" ]] || return 1
        ;;
      *) return 1 ;;
    esac
  done <<'EOF'
available	/etc/nginx/sites-available/ai-pin-revival-connectivity	available.before
enabled	/etc/nginx/sites-enabled/ai-pin-revival-connectivity	enabled.before
EOF
}

restore_nginx_transaction_snapshot() {
  local evidence="$1" require_install="${2:-0}" reload_mode="${3:-reload}"
  local snapshot="$evidence/nginx-install/snapshot"
  local manifest="$snapshot/PRESENCE.COMPLETE"
  local label target expected_snapshot present type identity temporary actual_type actual_identity
  validate_nginx_transaction_snapshot "$evidence" "$require_install" || return 1
  while IFS=$'\t' read -r label target expected_snapshot; do
    present="$(nginx_snapshot_manifest_value "$manifest" "$label.present")" || return 1
    type="$(nginx_snapshot_manifest_value "$manifest" "$label.type")" || return 1
    identity="$(nginx_snapshot_manifest_value "$manifest" "$label.identity_sha256")" || return 1
    temporary="${target}.ai-pin-revival-outer-restore.$$"
    sudo -n rm -f -- "$temporary" || return 1
    if [[ "$present" == 0 ]]; then
      sudo -n rm -f -- "$target" || return 1
      [[ "$(nginx_snapshot_object_type "$target")" == absent ]] || return 1
      continue
    fi
    sudo -n cp -a -- "$snapshot/$expected_snapshot" "$temporary" || return 1
    actual_type="$(nginx_snapshot_object_type "$temporary")" || return 1
    [[ "$actual_type" == "$type" ]] || return 1
    actual_identity="$(nginx_snapshot_object_identity "$temporary" "$type")" || return 1
    [[ "$actual_identity" == "$identity" ]] || return 1
    sudo -n mv -Tf -- "$temporary" "$target" || return 1
  done <<'EOF'
available	/etc/nginx/sites-available/ai-pin-revival-connectivity	available.before
enabled	/etc/nginx/sites-enabled/ai-pin-revival-connectivity	enabled.before
EOF
  sudo -n nginx -t >/dev/null || return 1
  if [[ "$reload_mode" == reload ]]; then
    sudo -n systemctl reload nginx || return 1
  elif [[ "$reload_mode" != validate-only ]]; then
    return 1
  fi
}

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

assert_durable_inputs() {
  local volume
  for volume in "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME"; do
    volume_exists "$volume" || fail "required durable volume is missing: $volume"
  done
  [[ -d "$CENTER_DATA_DIR" && ! -L "$CENTER_DATA_DIR" ]] \
    || fail "Center data directory is missing or unsafe"
}

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

active_read_only_security_root() {
  local service="$1" first_destination="$2" second_destination="$3"
  local first_name="$4" second_name="$5" canonical_root="$6" legacy_root="$7" label="$8"
  local container first_source second_source root
  container="$(active_service_container "$service")"
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
  [[ "$root" == "$canonical_root" || "$root" == "$legacy_root" ]] \
    || fail "active $label root is outside the reviewed canonical and legacy locations"
  sudo -n test -d "$root" && ! sudo -n test -L "$root" \
    && sudo -n test -f "$first_source" && ! sudo -n test -L "$first_source" \
    && sudo -n test -f "$second_source" && ! sudo -n test -L "$second_source" \
    || fail "active $label root contains an unsafe object"
  printf '%s\n' "$root"
}

active_attestation_root() {
  active_read_only_security_root ai-bus /etc/carry-attest/ca.crt /etc/carry-attest/ca.key \
    ca.crt ca.key "$PRIVATE_DIR/attest" /home/anders/carry-attest attestation
}

active_device_user_root() {
  active_read_only_security_root provisioning /etc/carry-duc/duc-ca.crt /etc/carry-duc/duc-ca.key \
    duc-ca.crt duc-ca.key "$PRIVATE_DIR/duc" /home/anders/carry-duc DeviceUser
}

assert_active_durable_mounts() {
  local service destination expected container actual type
  while IFS=$'\t' read -r service destination expected type; do
    container="$(active_service_container "$service")"
    actual="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{if eq \"$type\" \"volume\"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$container")"
    [[ "$actual" == "$expected" ]] || fail "active $service mount at $destination is not the reviewed durable source"
  done <<EOF
postgres	/var/lib/postgresql/data	$PG_VOLUME	volume
connectivity	/var/lib/carry	$STATE_VOLUME	volume
ai-bus	/var/lib/carry	$STATE_VOLUME	volume
account	/var/lib/carry	$STATE_VOLUME	volume
contacts	/var/lib/carry	$STATE_VOLUME	volume
feature-flags	/var/lib/carry	$STATE_VOLUME	volume
notable-events	/var/lib/carry	$STATE_VOLUME	volume
provisioning	/var/lib/carry	$STATE_VOLUME	volume
prometheus	/prometheus	$PROMETHEUS_VOLUME	volume
grafana	/var/lib/grafana	$GRAFANA_VOLUME	volume
center	/data	$CENTER_DATA_DIR	bind
EOF
  active_attestation_root >/dev/null
  active_device_user_root >/dev/null
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
                or any(ord(char)<32 or ord(char)==127 for char in path)
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
    if (name.startswith("/") or "\\" in name or any(ord(char)<32 or ord(char)==127 for char in name)
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
# key material, byte for byte, rather than merely carrying the directories that
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
  python3 - "$inventory" "$archive" "$expected" <<'PY' || { rm -f -- "$expected"; fail "backup does not carry the irreplaceable key material"; }
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

state_file_count() {
  docker run --rm -v "$STATE_VOLUME:/source:ro" "$HELPER_IMAGE" \
    sh -euc 'find /source -type f | wc -l' | tr -d '[:space:]'
}

state_byte_count() {
  docker run --rm -v "$STATE_VOLUME:/source:ro" "$HELPER_IMAGE" \
    sh -euc 'find /source -type f -exec stat -c %s {} + | awk "{s+=\$1} END{print s+0}"' | tr -d '[:space:]'
}

database_count() {
  local container="$1" database="$2" table="$3"
  [[ "$table" =~ ^[a-z_]+$ ]] || fail "invalid invariant table"
  local exists
  exists="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U carry -d "$database" -Atc "select to_regclass('public.$table') is not null" | tr -d '[:space:]')"
  if [[ "$exists" == t ]]; then
    docker exec "$container" psql -v ON_ERROR_STOP=1 -U carry -d "$database" -Atc "select count(*) from $table" | tr -d '[:space:]'
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
    count="$(database_count "$container" carry "$table")"
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
import base64,binascii,json,os,stat,sys
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
            or any(ord(char)<32 or ord(char)==127 for char in kid)):
        raise SystemExit(f"{label} kid is invalid")
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
if len(mapped)>4096: raise SystemExit("Center channel key map is implausibly large")
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
import base64,binascii,hashlib,json,sys,tarfile
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
            or any(ord(char)<32 or ord(char)==127 for char in kid) or not isinstance(encoded,str)):
        raise SystemExit(f"{label} values are invalid")
    try: key=base64.b64decode(encoded,validate=True)
    except (binascii.Error,ValueError) as error: raise SystemExit(f"{label} is not base64: {error}")
    if len(key)!=16 or base64.b64encode(key).decode("ascii")!=encoded:
        raise SystemExit(f"{label} is not canonical AES-128 material")
check_archived(document["kid"],document["key"],"archived Center channel key")
mapped=document.get("keys",{})
if not isinstance(mapped,dict): raise SystemExit("archived Center channel key map must be an object")
if len(mapped)>4096: raise SystemExit("archived Center channel key map is implausibly large")
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
                or any(ord(char)<32 or ord(char)==127 for char in relative)
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

# Hash every dumpable, non-system relation without retaining row bodies.  Both
# backup creation and the domain cutover use this one canonical producer, so a
# rollback comparison cannot silently drift to a second manifest format.
#
# ONE psql SESSION PER DATABASE, NOT ONE `docker exec` PER STATEMENT.
#
# This used to spend three to four `docker exec` calls per relation — a count, a
# column lookup and a digest — across ~110 relations in two databases, roughly
# 330 container round trips. On the production host a `docker exec` costs about
# 65ms of namespace and process setup before psql has said a word, and the two
# databases together are 25MB, so the capture was almost entirely process
# spawning: 20.2s measured per call, nine calls inside the quiesced public
# ingress window, ~180s of a 420s budget during which the wearer sees a
# Cloudflare 530 and the Pin's device plane is unreachable.
#
# WHAT THIS DELIBERATELY DOES NOT CHANGE, because the whole value of the
# manifest is that two captures of an unchanged cluster are byte-identical:
#
#   * Every statement is still issued SEPARATELY, one at a time, in the same
#     order, with the same text. A batch is a single psql SESSION, never a
#     single TRANSACTION — psql stays in autocommit, so each statement still
#     takes its own snapshot exactly as a separate `docker exec` did. Wrapping
#     the relations in one transaction would arguably be *more* consistent and
#     is exactly why it is not done: it would change what the digest means.
#   * Every statement keeps the environment it had. The counts and the COPYs
#     still run with PGOPTIONS statement_timeout/lock_timeout; the catalog list,
#     the column lookups and the large-object count still run without them.
#     That is why the column lookups get their own session rather than riding
#     along with the digests.
#   * The digest is still sha256 of THE BYTES PSQL WROTE, computed here on the
#     host. Moving it into SQL (sha256(convert_to(string_agg(...)))) would mean
#     re-implementing COPY's text escaping in SQL — a second implementation of
#     the manifest format, which is precisely the defect class this file has
#     already been bitten by twice (see data-mutation-gates.test.mjs).
#
# HOW THE STREAM IS SPLIT. psql writes every statement's output to one stdout,
# so `\echo <marker>` is emitted before each statement and split_postgres_segments
# cuts the stream on that exact line, hashing each segment independently. The
# marker is a per-run random nonce wrapped in '#'. It cannot be forged by data:
# COPY renders every row of this manifest as either a jsonb object ('{'…) or a
# large-object page (a digit…), JSON escapes every control character inside
# strings, and COPY escapes every newline, so no data line can begin with '#'.
# A segment miscount is fatal rather than silently shifting one relation's
# digest onto the next.
#
# THE ONE ORDERING THAT DID MOVE: the column lookups now all run before the
# first digest instead of interleaved one relation at a time. They are pure
# pg_attribute reads whose answer is regex-validated before it can reach a
# digest, and a column that disappeared between the lookup and its COPY fails
# the COPY loudly. On the quiesced cluster every caller captures from, no DDL
# can run at all.
#
# The scratch workspace holds only generated SQL, the per-statement plan and the
# resulting digests — the COPY stream itself is piped and never lands on disk,
# so no wearer row body is written anywhere.
postgres_segment_batch() {
  local container="$1" database_user="$2" database="$3" timeouts="$4" \
    marker="$5" script="$6" plan="$7" results="$8"
  local -a command=(docker exec -i)
  [[ "$timeouts" != timeouts ]] \
    || command+=(-e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000')
  command+=("$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" -f -)
  "${command[@]}" <"$script" | split_postgres_segments "$marker" "$plan" >"$results" \
    || fail "batched PostgreSQL capture failed for database $database"
}

# Cut one psql stdout stream on its marker lines and reduce each segment to the
# value the caller asked for: `digest` for a COPY (sha256 of the exact bytes,
# identical to the old `docker exec … | sha256sum` per statement) and `text` for
# a scalar select. `3<&0` hands the piped stream to python on fd 3 so stdin can
# still carry the program, the way every other inline python here is written.
split_postgres_segments() {
  python3 - "$1" "$2" 3<&0 <<'PY'
import hashlib,os,sys
marker=(sys.argv[1]+"\n").encode()
with open(sys.argv[2],encoding="ascii") as source:
    plan=[line.strip() for line in source if line.strip()]
if not plan: raise SystemExit("psql batch plan is empty")
index=-1; digest=None; text=bytearray(); values=[]
def close_segment():
    if index<0: return
    values.append(text.decode("utf-8").strip() if plan[index]=="text" else digest.hexdigest())
for raw in os.fdopen(3,"rb"):
    if raw==marker:
        close_segment(); index+=1
        if index>=len(plan): raise SystemExit("psql batch produced more segments than its plan")
        digest=hashlib.sha256(); text=bytearray()
        continue
    if index<0: raise SystemExit("psql batch wrote output before its first segment marker")
    digest.update(raw)
    if plan[index]=="text": text+=raw
close_segment()
if index+1!=len(plan): raise SystemExit("psql batch segment count differs from its plan")
sys.stdout.write("".join(value+"\n" for value in values))
PY
}

# The recorded half of the column projection: the list this relation's digest was
# taken over when the BEFORE snapshot was taken, or empty when there is no
# sidecar or no entry for this relation. Kept per-relation because it is a local
# awk over a file and costs nothing; the LIVE half is what had to be batched.
relation_recorded_columns() {
  local key="$1" columns_source="$2" columns=""
  if [[ -n "$columns_source" && -f "$columns_source" ]]; then
    columns="$(awk -F'\t' -v want="$key" '$1 == want { print $2 }' "$columns_source")"
  fi
  printf '%s' "$columns"
}

# The column list a relation digest is taken over. With no recorded source this
# is simply "every column, in attnum order"; with one, it is the list that
# relation had when the BEFORE snapshot was taken, so an added column cannot
# change the digest and a removed one cannot hide inside it.
relation_column_projection() {
  local key="$1" recorded="$2" live="$3" columns
  columns="$recorded"
  [[ -n "$columns" ]] || columns="$live"
  [[ -n "$columns" ]] || fail "relation $key has no readable columns"
  [[ "$columns" =~ ^[A-Za-z0-9_\",]+$ ]] || fail "unsafe column list for relation $key"
  printf '%s' "$columns"
}

# `columns_source` (optional 4th argument) makes a comparison insensitive to an
# ADDITIVE schema change while staying strict about values. `to_jsonb(t)` encodes
# the schema as well as the data, so a migration adding a nullable column
# rewrites every row's JSON without moving a single byte of anyone's data — and
# this project's migration policy explicitly permits exactly that
# (`ADD COLUMN IF NOT EXISTS`, asserted additive and non-destructive by
# store_postgres.rs). Without this the two invariants contradict each other and
# no schema change is deployable. Pass the sidecar written by the BEFORE capture
# to project the AFTER capture onto the columns that existed then: a new column
# is invisible, a changed value or a vanished row is not, and a DROPPED column
# fails loudly because the projection no longer resolves.
capture_postgres_data() {
  local container="$1" database_user="$2" output="$3" columns_source="${4:-}"
  local database schema relation kind qualified count digest lo_count lo_digest relations columns
  local work marker index consumed
  local -a rel_schema rel_name rel_kind rel_columns pending values
  need python3
  work="$(mktemp -d)"
  # SELF-CLEARING, and that is not tidiness. A RETURN trap set inside a function
  # is NOT removed when that function returns: it stays installed and fires again
  # when the CALLER returns, evaluated in the caller's scope. Both this function
  # and its caller capture_resume_candidate_evidence have a local named `work`, so
  # the second firing expanded to the CALLER's directory and deleted it — the
  # resume's evidence directory, wiped between being written and being read, which
  # surfaced as "install: cannot create regular file ... No such file or directory"
  # and refused a deploy with public ingress already quiesced.
  #
  # `trap - RETURN` inside the body removes it after the first firing. Verified on
  # bash 5.2.21 (the host) and 5.3.15: without it the caller's directory is deleted,
  # with it neither the caller's nor the outer scope's is touched.
  trap 'rm -rf -- "${work:-}"; trap - RETURN' RETURN
  chmod 700 "$work"
  marker="#$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')#"
  [[ "$marker" =~ ^#[0-9a-f]{32}#$ ]] || fail "segment marker nonce is unavailable"
  : >"$output"
  : >"$output.columns"
  for database in carry keycloak; do
    relations="$(docker exec "$container" psql -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
      -U "$database_user" -d "$database" -c \
      "select n.nspname,c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','m','S') order by n.nspname,c.relname,c.relkind")"
    [[ -n "$relations" ]] || fail "database relation catalog is empty"
    rel_schema=(); rel_name=(); rel_kind=(); rel_columns=(); pending=()
    : >"$work/columns.sql"
    : >"$work/columns.plan"
    while IFS=$'\t' read -r schema relation kind; do
      [[ "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$relation" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
        || fail "database contains an unsafe relation identifier"
      qualified="\"$schema\".\"$relation\""
      rel_schema+=("$schema"); rel_name+=("$relation"); rel_kind+=("$kind"); rel_columns+=("")
      case "$kind" in
        r|p)
          rel_columns[-1]="$(relation_recorded_columns "$database.$schema.$relation" "$columns_source")"
          # Only the relations the sidecar does not already answer for cost a
          # query, and they are all asked in one session below.
          if [[ -z "${rel_columns[-1]}" ]]; then
            pending+=("$(( ${#rel_kind[@]} - 1 ))")
            cat >>"$work/columns.sql" <<SQL
\echo $marker
select string_agg(quote_ident(attname), ',' order by attnum)
  from pg_attribute
 where attrelid = '$qualified'::regclass and attnum > 0 and not attisdropped;
SQL
            printf 'text\n' >>"$work/columns.plan"
          fi
          ;;
        m|S) ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
    done <<<"$relations"
    if (( ${#pending[@]} > 0 )); then
      postgres_segment_batch "$container" "$database_user" "$database" plain \
        "$marker" "$work/columns.sql" "$work/columns.plan" "$work/columns.out"
      mapfile -t values <"$work/columns.out"
      (( ${#values[@]} == ${#pending[@]} )) || fail "database relation column batch is incomplete"
      for index in "${!pending[@]}"; do
        rel_columns[${pending[index]}]="${values[index]}"
      done
    fi
    : >"$work/data.sql"
    : >"$work/data.plan"
    for index in "${!rel_kind[@]}"; do
      schema="${rel_schema[index]}"; relation="${rel_name[index]}"; kind="${rel_kind[index]}"
      qualified="\"$schema\".\"$relation\""
      case "$kind" in
        r|p)
          columns="$(relation_column_projection "$database.$schema.$relation" \
            "${rel_columns[index]}" "")"
          printf '%s.%s.%s\t%s\n' "$database" "$schema" "$relation" "$columns" >>"$output.columns"
          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from only $qualified;
\echo $marker
copy (select to_jsonb(x)::text from (select $columns from only $qualified) x order by 1) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"
          ;;
        m)
          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from $qualified;
\echo $marker
copy (select to_jsonb(t)::text from $qualified t order by to_jsonb(t)::text) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"
          ;;
        S)
          # A sequence has exactly one row by construction, so its count was
          # never queried and still is not.
          cat >>"$work/data.sql" <<SQL
\echo $marker
copy (select jsonb_build_object('last_value',last_value,'is_called',is_called)::text from $qualified) to stdout;
SQL
          printf 'digest\n' >>"$work/data.plan"
          ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
    done
    postgres_segment_batch "$container" "$database_user" "$database" timeouts \
      "$marker" "$work/data.sql" "$work/data.plan" "$work/data.out"
    mapfile -t values <"$work/data.out"
    consumed=0
    for index in "${!rel_kind[@]}"; do
      schema="${rel_schema[index]}"; relation="${rel_name[index]}"; kind="${rel_kind[index]}"
      case "$kind" in
        r|p|m) count="${values[consumed]:-}"; digest="${values[consumed + 1]:-}"; consumed=$((consumed + 2)) ;;
        S) count=1; digest="${values[consumed]:-}"; consumed=$((consumed + 1)) ;;
        *) fail "unsupported durable relation kind in database manifest" ;;
      esac
      [[ "$count" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]] \
        || fail "database relation manifest failed"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$database" "$schema" "$relation" "$kind" "$count" "$digest" >>"$output"
    done
    (( consumed == ${#values[@]} )) || fail "database relation manifest is incomplete"
    lo_count="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
      -U "$database_user" -d "$database" -c 'select count(*) from pg_largeobject_metadata' | tr -d '[:space:]')"
    lo_digest="$(docker exec -e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000' \
      "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" \
      -c "copy (select loid::text || ':' || pageno::text || ':' || encode(data,'hex') from pg_largeobject order by loid,pageno) to stdout" \
      | sha256sum | awk '{print $1}')"
    [[ "$lo_count" =~ ^[0-9]+$ && "$lo_digest" =~ ^[0-9a-f]{64}$ ]] \
      || fail "large-object manifest failed"
    printf '%s\tpg_catalog\tpg_largeobject\tL\t%s\t%s\n' "$database" "$lo_count" "$lo_digest" >>"$output"
  done
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output" "$output.columns"
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

# Canonical security metadata for a complete logical PostgreSQL restore. Role
# password verifiers are one-way hashed again before they enter the inventory;
# the globals dump itself remains the protected source of truth.
#
# One producer on purpose, like capture_postgres_data above: backup.sh writes
# postgres-security.json and staging-smoke.sh compares its own captures against
# that file byte-for-byte, so a second body here is a second interpretation of
# the same format that only agrees until one of them is edited.
#
# `work_parent` (optional 4th argument) is where the scratch capture workspace
# is created. backup.sh omits it (system tmp); staging-smoke.sh passes its 0700
# projection workspace so a failure mid-capture is swept by the smoke's own
# cleanup trap. Either way the workdir is appended to `security_work_dirs`,
# the failure-cleanup ledger backup.sh's EXIT trap consumes — appending is
# harmless for callers that never read it.
capture_postgres_security() {
  local container="$1" database_user="$2" output="$3" work_parent="${4:-}" work database
  if [[ -n "$work_parent" ]]; then
    work="$(mktemp -d "$work_parent/pg-security.XXXXXX")"
  else
    work="$(mktemp -d)"
  fi
  security_work_dirs+=("$work")
  chmod 700 "$work"
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    >"$work/roles.jsonl" <<'SQL'
select jsonb_build_object(
  'name',a.rolname,'superuser',a.rolsuper,'inherit',a.rolinherit,
  'create_role',a.rolcreaterole,'create_db',a.rolcreatedb,'can_login',a.rolcanlogin,
  'replication',a.rolreplication,'connection_limit',a.rolconnlimit,
  'bypass_rls',a.rolbypassrls,'valid_until',coalesce(a.rolvaliduntil::text,''),
  'config',coalesce(to_jsonb(s.setconfig),'[]'::jsonb),
  'password',coalesce(a.rolpassword,'')
)::text
from pg_authid a
left join pg_db_role_setting s on s.setrole = a.oid and s.setdatabase = 0
where a.rolname !~ '^pg_' and a.rolname <> 'revival_restore_bootstrap'
order by a.rolname;
SQL
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    >"$work/memberships.jsonl" <<'SQL'
select jsonb_build_object(
  'role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),
  'grantor',pg_get_userbyid(grantor),'admin_option',admin_option,
  'inherit_option',inherit_option,'set_option',set_option
)::text
from pg_auth_members
where pg_get_userbyid(roleid) !~ '^pg_' or pg_get_userbyid(member) !~ '^pg_'
order by 1;
SQL
  docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d postgres \
    >"$work/globals.jsonl" <<'SQL'
select jsonb_build_object(
  'kind','database','name',datname,'owner',pg_get_userbyid(datdba),
  'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,
  'allow_connections',datallowconn,'connection_limit',datconnlimit,
  'tablespace',coalesce(t.spcname,''),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(d.datacl) x),'[]'::jsonb)
)::text
from pg_database d left join pg_tablespace t on t.oid=d.dattablespace
where datname in ('carry','keycloak') order by datname;
select jsonb_build_object(
  'kind','tablespace','name',spcname,'owner',pg_get_userbyid(spcowner),
  'options',coalesce(to_jsonb(spcoptions),'[]'::jsonb),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(spcacl) x),'[]'::jsonb)
)::text
from pg_tablespace where spcname !~ '^pg_' order by spcname;
select jsonb_build_object(
  'kind','database_role_setting','database',coalesce(d.datname,''),
  'role',coalesce(r.rolname,''),'settings',coalesce(to_jsonb(s.setconfig),'[]'::jsonb)
)::text
from pg_db_role_setting s
left join pg_database d on d.oid=s.setdatabase
left join pg_roles r on r.oid=s.setrole
where d.datname in ('carry','keycloak') or s.setdatabase=0
order by 1;
SQL
  for database in carry keycloak; do
    docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database" \
      >"$work/$database.jsonl" <<'SQL'
select jsonb_build_object(
  'kind','schema','name',nspname,'owner',pg_get_userbyid(nspowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(nspacl) x),'[]'::jsonb)
)::text
from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname;
select jsonb_build_object(
  'kind','relation','schema',n.nspname,'name',c.relname,'relation_kind',c.relkind,
  'persistence',c.relpersistence,'owner',pg_get_userbyid(c.relowner),
  'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(c.relacl) x),'[]'::jsonb)
)::text
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and c.relkind in ('r','p','v','m','S','f')
order by n.nspname,c.relname,c.relkind;
select jsonb_build_object(
  'kind','column_acl','schema',n.nspname,'relation',c.relname,'column',a.attname,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(a.attacl) x),'[]'::jsonb)
)::text
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and a.attnum>0 and not a.attisdropped and a.attacl is not null
order by n.nspname,c.relname,a.attnum;
select jsonb_build_object(
  'kind','routine','schema',n.nspname,'name',p.proname,
  'identity_arguments',pg_get_function_identity_arguments(p.oid),
  'routine_kind',p.prokind,'owner',pg_get_userbyid(p.proowner),
  'security_definer',p.prosecdef,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(p.proacl) x),'[]'::jsonb)
)::text
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid);
select jsonb_build_object(
  'kind','type','schema',n.nspname,'name',t.typname,'type_kind',t.typtype,
  'owner',pg_get_userbyid(t.typowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(t.typacl) x),'[]'::jsonb)
)::text
from pg_type t join pg_namespace n on n.oid=t.typnamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  and t.typisdefined and t.typname !~ '^_'
order by n.nspname,t.typname;
select jsonb_build_object(
  'kind','default_acl','role',pg_get_userbyid(d.defaclrole),
  'schema',coalesce(n.nspname,''),'object_type',d.defaclobjtype,
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(d.defaclacl) x),'[]'::jsonb)
)::text
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
order by 1;
select jsonb_build_object(
  'kind','policy','schema',n.nspname,'relation',c.relname,'name',p.polname,
  'permissive',p.polpermissive,'command',p.polcmd,
  'roles',coalesce((select jsonb_agg(pg_get_userbyid(x) order by pg_get_userbyid(x)) from unnest(p.polroles) x),'[]'::jsonb),
  'using',coalesce(pg_get_expr(p.polqual,p.polrelid),''),
  'check',coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
)::text
from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
order by n.nspname,c.relname,p.polname;
select jsonb_build_object(
  'kind','extension','name',e.extname,'owner',pg_get_userbyid(e.extowner),
  'schema',n.nspname,'version',e.extversion
)::text
from pg_extension e join pg_namespace n on n.oid=e.extnamespace
where e.extname <> 'plpgsql'
order by e.extname;
select jsonb_build_object(
  'kind','large_object','oid',m.oid,'owner',pg_get_userbyid(m.lomowner),
  'acl',coalesce((select jsonb_agg(x::text order by x::text) from unnest(m.lomacl) x),'[]'::jsonb)
)::text
from pg_largeobject_metadata m order by m.oid;
SQL
  done
  python3 - "$work" "$output" <<'PY'
import hashlib,json,os,sys
work,output=sys.argv[1:]
def read(name):
    path=os.path.join(work,name)
    return [json.loads(line) for line in open(path,encoding="utf-8") if line.strip()]
roles=read("roles.jsonl")
for role in roles:
    password=role.pop("password","")
    role["password_sha256"]=hashlib.sha256(password.encode()).hexdigest() if password else None
document={
    "roles":roles,
    "memberships":read("memberships.jsonl"),
    "globals":read("globals.jsonl"),
    "databases":{"carry":read("carry.jsonl"),"keycloak":read("keycloak.jsonl")},
}
with open(output,"w",encoding="utf-8") as target:
    json.dump(document,target,sort_keys=True,separators=(",",":"))
PY
  chmod 600 "$output"
  rm -rf -- "$work"
}

# pg_dump's schema-only stream covers definitions that row/catalog summaries do
# not: columns/defaults/generated identities, constraints, indexes, triggers,
# views, and routine bodies. Normalize only pg_dump's random psql restriction
# token; retain owners, ACLs, comments, and all other emitted semantics.
#
# Also one producer on purpose: staging-smoke.sh compares backup.sh's
# postgres-schema.tsv against its own captures line-for-line, and the two
# previously separate bodies had already diverged while still emitting a
# matching line — the format agreement was luck, not structure.
#
# `retain-sql` (optional 4th argument, exactly that literal): additionally keep
# the canonical pg_dump text beside each digest line, as
# "$output.<database>.sql". The digest is unchanged and is still the whole of
# the equality check; the retained text exists only so that a FAILED equality
# check can be classified (classify_schema_delta below) and reported as something
# other than "two hashes differ". The classifier re-hashes what it reads and
# refuses unless it reproduces the digest recorded here, so retaining the text
# cannot become a way to have the gate judge bytes it did not hash.
#
# The BACKUP producer retains too, and must. deploy.sh compares the pre-candidate
# backup's schema manifest against the post-candidate one, and the pre-candidate
# dump cannot be re-taken once the candidate has migrated — so if it is not kept
# at capture time there is nothing to classify a legitimate additive delta
# against, and the gate can only refuse. The two sidecars are enumerated as
# OPTIONAL artifacts (backup_optional_artifacts) so a backup taken before they
# existed still verifies; classification against such a backup refuses, which is
# the safe direction.
capture_postgres_schema() {
  local container="$1" database_user="$2" output="$3" retain_sql="${4:-}" database record canonical_path
  [[ -z "$retain_sql" || "$retain_sql" == retain-sql ]] \
    || fail "unknown capture_postgres_schema retention mode: $retain_sql"
  : >"$output"
  for database in carry keycloak; do
    canonical_path=""
    [[ "$retain_sql" != retain-sql ]] || canonical_path="$output.$database.sql"
    record="$(docker exec -e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000' \
      "$container" pg_dump --schema-only --quote-all-identifiers \
      -U "$database_user" -d "$database" | python3 -c '
import hashlib,os,sys
database,canonical_path=sys.argv[1:3]; limit=32*1024*1024
body=sys.stdin.buffer.read(limit+1)
if len(body)>limit: raise SystemExit("pg_dump schema stream exceeds limit")
lines=body.splitlines(keepends=True)
restrict=next((index for index,line in enumerate(lines) if line.startswith(b"\\restrict ")),None)
if restrict is not None:
    parts=lines[restrict].rstrip(b"\r\n").split(maxsplit=1)
    if len(parts)!=2 or not parts[1]: raise SystemExit("invalid pg_dump restriction token")
    token=parts[1]
    unrestrict=next((index for index in range(len(lines)-1,restrict,-1)
        if lines[index].rstrip(b"\r\n")==b"\\unrestrict "+token),None)
    if unrestrict is None: raise SystemExit("mismatched pg_dump restriction token")
    lines[restrict]=b"\\restrict <normalized>\n"; lines[unrestrict]=b"\\unrestrict <normalized>\n"
canonical=b"".join(lines)
if len(canonical)<64 or len(lines)<3: raise SystemExit("incomplete pg_dump schema stream")
if canonical_path:
    with os.fdopen(os.open(canonical_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600),"wb") as retained:
        retained.write(canonical)
print(f"{database}\t{len(canonical)}\t{len(lines)}\t{hashlib.sha256(canonical).hexdigest()}")
' "$database" "$canonical_path")"
    [[ "$record" =~ ^$database$'\t'[0-9]+$'\t'[0-9]+$'\t'[0-9a-f]{64}$ ]] \
      || fail "database schema manifest failed"
    printf '%s\n' "$record" >>"$output"
    [[ -z "$canonical_path" ]] || chmod 600 "$canonical_path"
  done
  LC_ALL=C sort -o "$output" "$output"
  chmod 600 "$output"
}

# THE ADDITIVE-SCHEMA ALLOWANCE, shared by every gate that compares a schema
# manifest captured BEFORE a candidate started against one captured AFTER.
#
# It lives here rather than beside any one of them because it has three consumers:
# staging-smoke.sh's candidate-mutation gate, deploy.sh's pre-commit comparison of
# the pre- and post-candidate backups, and rollback.sh's legacy-eligibility check.
# All three go through compare_schema_manifests below. Copying it instead of
# hoisting it is the defect that cost four deploy cycles the last time.
#
# A gate compares two sha256 digests over pg_dump --schema-only, so it can prove
# the schema moved and cannot say how. A pending additive migration — today
# cosmos/migrations/0004_listing.sql, `ADD COLUMN IF NOT EXISTS
# carry_memory.thumbnail_count` plus three `CREATE INDEX IF NOT EXISTS` — moves it
# legitimately, and thirteen deploys have stopped there.
#
# This is NOT a loosened comparison. The digest equality check stays exactly where
# it was; it is still the only thing that decides whether anything changed. This
# classifier runs only after that check has already failed, and its job is to
# PROVE a specific delta is non-destructive or refuse it by name. Its default
# answer is refusal: every statement is compared for exact equality, and only a
# short, explicit list of arrivals is permitted.
#
#   PERMITTED  a column appended to an existing table, leaving every pre-existing
#              column's definition byte-identical and in place; an entirely new
#              table (and the OWNER/CONSTRAINT/DEFAULT/SEQUENCE decoration
#              pg_dump emits for THAT table); a new non-UNIQUE index.
#   REFUSED    everything else, by name — a dropped or renamed table or column, a
#              retyped column, a changed nullability or default, a reordered
#              column list, a dropped or redefined index or constraint, changed
#              ownership or grants, any function, trigger, view or type change,
#              a UNIQUE index over rows that already exist, a change to the
#              CREATE TABLE heading or table options of a table that already
#              existed (UNLOGGED, PARTITION BY, storage options), and ANY delta
#              at all in the keycloak database.
#
# THE SUBTLETY THAT MAKES A NAIVE LINE DIFF WRONG: pg_dump prints CREATE TABLE
# with the full column list, so adding a column does not appear as an "ADD COLUMN"
# line — it REWRITES the whole CREATE TABLE block, which a line diff reads as one
# line removed and one line added. So this reasons about the COLUMN SET and not
# the text: the BEFORE column list must be an exact, byte-identical PREFIX of the
# AFTER column list. `ALTER TABLE ... ADD COLUMN` always appends in attnum order,
# so a genuine addition satisfies that; a drop, a rename, a retype, or a reorder
# breaks the prefix at a named position and is refused there.
#
# The corollary, which is easy to miss: a CREATE TABLE block is more than its
# column list. Its HEADING and its trailing TABLE OPTIONS are compared verbatim
# too, and a rewritten block that yields no attributable difference at all is
# refused rather than passed over. Otherwise a table quietly converted to
# UNLOGGED — losing every existing row on the next crash — would produce no note
# of its own and ride along under the legitimate `+column` note beside it.
#
# It cannot be fooled by handing it different text than the gate compared: it
# re-hashes the retained pg_dump bytes and refuses unless they reproduce the exact
# digest, byte count, and line count in the manifest the gate used. And if the
# digests differ while no statement-level delta explains it — a comment-only or
# whitespace-only difference — that is refused too, rather than waved through as
# "nothing found".
classify_schema_delta() {
  local before="$1" after="$2"
  [[ -f "$before" && ! -L "$before" && -f "$after" && ! -L "$after" ]] \
    || fail "schema delta classifier needs both schema manifests"
  python3 - "$before" "$after" <<'PY'
import collections,hashlib,os,re,sys
before_manifest,after_manifest=sys.argv[1:3]
class Refusal(Exception): pass
def refuse(message): raise Refusal(message)
QUOTED=r'"(?:[^"]|"")*"'
NAME=r'(?:'+QUOTED+r'|[A-Za-z_][A-Za-z0-9_$]*)'
QUALIFIED=NAME+r'(?:\.'+NAME+r')*'
DOLLAR=re.compile(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$')
CREATE_TABLE=re.compile(r'^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')\s*$',re.I)
CREATE_INDEX=re.compile(r'^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')\s+ON\s+('+QUALIFIED+r')(?=[\s(])',re.I)
TABLE_OWNER=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+OWNER\s+TO\s',re.I)
TABLE_CONSTRAINT=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+ADD\s+CONSTRAINT\s+('+QUALIFIED+r')(?=[\s(])',re.I)
TABLE_DEFAULT=re.compile(r'^ALTER\s+TABLE\s+(?:ONLY\s+)?('+QUALIFIED+r')\s+ALTER\s+COLUMN\s+('+QUALIFIED+r')\s+SET\s+DEFAULT\s',re.I)
CREATE_SEQUENCE=re.compile(r'^CREATE\s+(?:UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?('+QUALIFIED+r')(?=[\s(]|$)',re.I)
SEQUENCE_OWNED=re.compile(r'^ALTER\s+SEQUENCE\s+('+QUALIFIED+r')\s+OWNED\s+BY\s+('+QUALIFIED+r')\.('+NAME+r')\s*$',re.I)
SEQUENCE_OWNER=re.compile(r'^ALTER\s+SEQUENCE\s+('+QUALIFIED+r')\s+OWNER\s+TO\s',re.I)

def chunks(text):
    """Yield (is_literal, chunk) over SQL: comments dropped, quoted spans opaque."""
    index=0; start=0; size=len(text)
    while index<size:
        char=text[index]
        if char=="-" and text.startswith("--",index):
            if start<index: yield (False,text[start:index])
            stop=text.find("\n",index); index=size if stop<0 else stop+1; start=index; continue
        if char=="'" or char=='"':
            if start<index: yield (False,text[start:index])
            cursor=index+1
            while True:
                stop=text.find(char,cursor)
                if stop<0: refuse("pg_dump output has an unterminated quoted span")
                if text.startswith(char*2,stop): cursor=stop+2; continue
                break
            yield (True,text[index:stop+1]); index=stop+1; start=index; continue
        if char=="$":
            match=DOLLAR.match(text,index)
            if match:
                if start<index: yield (False,text[start:index])
                tag=match.group(0); stop=text.find(tag,match.end())
                if stop<0: refuse("pg_dump output has an unterminated dollar-quoted body")
                yield (True,text[index:stop+len(tag)]); index=stop+len(tag); start=index; continue
        index+=1
    if start<size: yield (False,text[start:size])

def masked(text):
    """(flat text, literal mask) so scanning can ignore delimiters inside literals."""
    body=[]; mask=[]
    for literal,chunk in chunks(text):
        body.append(chunk); mask.extend([literal]*len(chunk))
    return "".join(body),mask

def normalize(statement):
    return "".join(chunk if literal else re.sub(r"\s+"," ",chunk)
                   for literal,chunk in chunks(statement)).strip()

def parse(text):
    """(psql meta lines, normalized statements) for one pg_dump --schema-only stream."""
    meta=[line for line in text.splitlines() if line.startswith("\\")]
    body="\n".join(line for line in text.splitlines() if not line.startswith("\\"))
    out=[]; current=[]
    for literal,chunk in chunks(body):
        if literal: current.append(chunk); continue
        while True:
            stop=chunk.find(";")
            if stop<0: current.append(chunk); break
            current.append(chunk[:stop]); out.append("".join(current)); current=[]; chunk=chunk[stop+1:]
    if "".join(current).strip(): refuse("pg_dump output ends with an unterminated statement")
    return meta,[statement for statement in (normalize(item) for item in out) if statement]

def entries(text,mask):
    """Top-level comma-separated entries of a parenthesised body."""
    out=[]; start=0; depth=0
    for index,char in enumerate(text):
        if mask[index]: continue
        if char=="(": depth+=1
        elif char==")": depth-=1
        elif char=="," and depth==0: out.append(text[start:index]); start=index+1
    out.append(text[start:])
    return [item.strip() for item in out if item.strip()]

class Table:
    def __init__(self,name,heading,columns,others,trailing,statement):
        self.name=name; self.heading=heading; self.columns=columns; self.others=others
        self.trailing=trailing; self.statement=statement

def parse_table(statement):
    """A CREATE TABLE as (name, ordered columns, other entries, trailing options).

    None for anything this does not model exactly -- a partition, a typed table, a
    CREATE TABLE ... AS. Those fall through to the exact-equality path, where any
    change to them is refused."""
    text,mask=masked(statement)
    open_index=next((index for index,char in enumerate(text) if char=="(" and not mask[index]),None)
    if open_index is None: return None
    header=CREATE_TABLE.match(text[:open_index])
    if not header: return None
    depth=0; close_index=None
    for index in range(open_index,len(text)):
        if mask[index]: continue
        if text[index]=="(": depth+=1
        elif text[index]==")":
            depth-=1
            if depth==0: close_index=index; break
    if close_index is None: refuse("CREATE TABLE body is unbalanced: "+describe(statement))
    body=text[open_index+1:close_index]; body_mask=mask[open_index+1:close_index]
    columns=[]; others=[]
    for entry in entries(body,body_mask):
        # --quote-all-identifiers means every real column starts with its quoted
        # name; an entry that does not is a table constraint (CONSTRAINT/PRIMARY
        # KEY/CHECK/...), which is compared as an unordered set below.
        if entry.startswith('"'): columns.append((re.match(QUOTED,entry).group(0),entry))
        else: others.append(entry)
    # The heading is retained verbatim, not just the name the regex captured out of
    # it. CREATE TABLE and CREATE UNLOGGED TABLE name the same table, so comparing
    # only names would let `ALTER TABLE ... SET UNLOGGED` -- which throws away every
    # existing row on the next crash -- ride along inside a delta whose columns are
    # genuinely additive.
    return Table(header.group(1),text[:open_index].strip(),columns,tuple(sorted(others)),
                 text[close_index+1:].strip(),statement)

def readable(name):
    return ".".join(part[1:-1].replace('""','"') if part.startswith('"') else part
                    for part in re.findall(NAME,name))

def describe(statement,limit=180):
    text=re.sub(r"\s+"," ",statement).strip()
    return text if len(text)<=limit else text[:limit]+" ..."

def kind(statement):
    """The leading keyword phrase only -- never an identifier, which keeps its case."""
    words=[]
    for word in re.sub(r"\s+"," ",statement).strip().split(" ")[:4]:
        if not word.isalpha(): break
        words.append(word.upper())
    return " ".join(words) or "statement"

def identity(statement):
    """An already-readable key for the object a statement defines, so a statement
    leaving BEFORE and one arriving in AFTER for the same object read as one
    redefinition instead of as two unrelated events."""
    match=CREATE_INDEX.match(statement)
    if match: return f"index {readable(match.group(1))}"
    match=TABLE_OWNER.match(statement)
    if match: return f"ownership of table {readable(match.group(1))}"
    match=TABLE_CONSTRAINT.match(statement)
    if match: return f"constraint {readable(match.group(2))} on table {readable(match.group(1))}"
    match=TABLE_DEFAULT.match(statement)
    if match: return f"default of column {readable(match.group(1))}.{readable(match.group(2))}"
    match=CREATE_SEQUENCE.match(statement)
    if match: return f"sequence {readable(match.group(1))}"
    match=SEQUENCE_OWNED.match(statement)
    if match: return f"owning column of sequence {readable(match.group(1))}"
    match=SEQUENCE_OWNER.match(statement)
    if match: return f"ownership of sequence {readable(match.group(1))}"
    return None

def read_manifest(path):
    rows={}
    for number,raw in enumerate(open(path,encoding="utf-8"),1):
        line=raw.rstrip("\n")
        if not line: continue
        parts=line.split("\t")
        if len(parts)!=4: refuse(f"{path}: malformed schema manifest row at line {number}")
        database,size,lines,digest=parts
        if database in rows: refuse(f"{path}: duplicate schema manifest row for {database}")
        if not re.fullmatch(r"[0-9a-f]{64}",digest) or not size.isdigit() or not lines.isdigit():
            refuse(f"{path}: malformed schema manifest row at line {number}")
        rows[database]=(int(size),int(lines),digest)
    if not rows: refuse(f"{path}: schema manifest is empty")
    return rows

def read_dump(manifest_path,database,record):
    """The retained pg_dump text, proved to be the exact bytes the gate hashed."""
    size,lines,digest=record
    path=f"{manifest_path}.{database}.sql"
    if not os.path.isfile(path) or os.path.islink(path):
        refuse(f"{database}: retained pg_dump text is missing beside the manifest ({path})")
    body=open(path,"rb").read()
    if len(body)!=size or hashlib.sha256(body).hexdigest()!=digest:
        refuse(f"{database}: retained pg_dump text does not reproduce the digest the gate "
               f"compared ({path}); refusing to classify text the gate did not hash")
    if len(body.splitlines(keepends=True))!=lines:
        refuse(f"{database}: retained pg_dump text line count does not match the manifest ({path})")
    try: return body.decode("utf-8")
    except UnicodeDecodeError: refuse(f"{database}: retained pg_dump text is not valid UTF-8 ({path})")

def compare_table(database,before,after):
    """Notes for a provably additive table delta; refuses, by name, otherwise."""
    name=readable(before.name)
    if before.heading!=after.heading:
        refuse(f"{database}: table {name} changed its CREATE TABLE heading, which is a property of "
               f"the table itself and not of its columns (UNLOGGED, for one, discards every row "
               f"that already exists on the next crash): before <{before.heading}> after "
               f"<{after.heading}>")
    if before.trailing!=after.trailing:
        refuse(f"{database}: table {name} changed its table-level options: "
               f"before <{before.trailing}> after <{after.trailing}>")
    if before.others!=after.others:
        gone=[item for item in before.others if item not in after.others]
        arrived=[item for item in after.others if item not in before.others]
        if gone: refuse(f"{database}: table {name} lost an inline table constraint: {describe(gone[0])}")
        refuse(f"{database}: table {name} gained an inline table constraint, which can reject or "
               f"reinterpret rows that already exist: {describe(arrived[0])}")
    before_names=[column for column,_ in before.columns]
    after_names=[column for column,_ in after.columns]
    if len(after.columns)<len(before.columns):
        lost=[readable(column) for column in before_names if column not in after_names]
        refuse(f"{database}: table {name} lost column(s) "
               f"{', '.join(lost) or '(the column list was reordered)'}: a column may not disappear")
    for index,(before_column,after_column) in enumerate(zip(before.columns,after.columns)):
        if before_column==after_column: continue
        if before_column[0]!=after_column[0]:
            if before_column[0] not in after_names:
                refuse(f"{database}: table {name} column {readable(before_column[0])} was dropped or "
                       f"renamed; position {index+1} now holds {readable(after_column[0])}")
            refuse(f"{database}: table {name} reordered its pre-existing columns; position "
                   f"{index+1} held {readable(before_column[0])} and now holds "
                   f"{readable(after_column[0])}")
        refuse(f"{database}: table {name} changed the definition of pre-existing column "
               f"{readable(before_column[0])}: before <{before_column[1]}> after <{after_column[1]}>")
    added=after.columns[len(before.columns):]
    for column,definition in added:
        if column in before_names:
            refuse(f"{database}: table {name} lists column {readable(column)} twice after the delta")
    return [f"+column {name}.{readable(column)}" for column,_ in added]

def classify(database,before_text,after_text):
    before_meta,before_statements=parse(before_text)
    after_meta,after_statements=parse(after_text)
    if before_meta!=after_meta:
        refuse(f"{database}: the psql meta-commands around the dump changed")
    before_tables={}; after_tables={}
    before_other=collections.Counter(); after_other=collections.Counter()
    for statements,tables,other in ((before_statements,before_tables,before_other),
                                    (after_statements,after_tables,after_other)):
        for statement in statements:
            table=parse_table(statement)
            if table is None: other[statement]+=1; continue
            if table.name in tables: refuse(f"{database}: table {readable(table.name)} is created twice")
            tables[table.name]=table
    # Every object name the BEFORE schema already knew. "New" below means "absent
    # from this set", so an object that is merely being redefined can never be
    # mistaken for one this delta created.
    before_objects=set(before_tables)
    for statement in before_other:
        for pattern in (CREATE_INDEX,CREATE_SEQUENCE):
            match=pattern.match(statement)
            if match: before_objects.add(match.group(1))
    removed=before_other-after_other
    added=after_other-before_other
    arrivals={}
    for statement in added.elements():
        key=identity(statement)
        if key is not None: arrivals.setdefault(key,statement)

    # 1. Departures first, and tables before the statements that decorate them, so
    #    a dropped table is reported as a dropped table and not as its own vanished
    #    OWNER TO line.
    for name in sorted(before_tables):
        if name not in after_tables:
            refuse(f"{database}: table {readable(name)} was dropped or renamed")
    for statement in sorted(removed.elements()):
        key=identity(statement)
        if key is not None and key in arrivals:
            refuse(f"{database}: {key} was redefined: before <{describe(statement)}> "
                   f"after <{describe(arrivals[key])}>")
        refuse(f"{database}: {kind(statement)} disappeared from the schema"
               + (f" ({key})" if key else "") + f": {describe(statement)}")

    # 2. Tables. A new table is additive; a table both dumps have is additive only
    #    if every column it already had survives byte-identically, in place.
    notes=[]; new_tables=set()
    for name in sorted(after_tables):
        if name not in before_tables:
            new_tables.add(name); notes.append(f"+table {readable(name)}")
    for name in sorted(before_tables):
        if after_tables[name].statement!=before_tables[name].statement:
            found=compare_table(database,before_tables[name],after_tables[name])
            # A rewritten CREATE TABLE that compare_table can neither refuse nor
            # attribute to an appended column is a part of the statement this
            # classifier does not model. Silence there would let it ride along
            # under some OTHER table's legitimate note, so it refuses instead.
            if not found:
                refuse(f"{database}: the CREATE TABLE for {readable(name)} was rewritten, but no "
                       "column, inline constraint, table option or heading difference explains it; "
                       "refusing a table redefinition this classifier cannot attribute")
            notes.extend(found)

    # 3. Arrivals. Only a new non-UNIQUE index, or the decoration pg_dump emits for
    #    a table THIS delta created, may arrive.
    for statement in sorted(added.elements()):
        match=CREATE_INDEX.match(statement)
        if match:
            index,target=match.group(1),match.group(2)
            if index in before_objects:
                refuse(f"{database}: index {readable(index)} is created twice after the delta")
            if target not in after_tables:
                refuse(f"{database}: index {readable(index)} targets {readable(target)}, "
                       "which is not a table this dump creates")
            if re.match(r"^CREATE\s+UNIQUE\s",statement,re.I) and target not in new_tables:
                refuse(f"{database}: index {readable(index)} adds a UNIQUE constraint to "
                       f"pre-existing table {readable(target)}; a uniqueness rule over rows that "
                       "already exist is a constraint change, not an additive index")
            notes.append(f"+index {readable(index)} on {readable(target)}")
            continue
        for pattern,label in ((TABLE_OWNER,"ownership"),(TABLE_CONSTRAINT,"constraint"),
                              (TABLE_DEFAULT,"column default")):
            match=pattern.match(statement)
            if match and match.group(1) in new_tables:
                notes.append(f"+{label} on new table {readable(match.group(1))}"); break
        else:
            match=CREATE_SEQUENCE.match(statement) or SEQUENCE_OWNER.match(statement)
            if match and match.group(1) not in before_objects:
                notes.append(f"+sequence {readable(match.group(1))}"); continue
            match=SEQUENCE_OWNED.match(statement)
            if match and match.group(1) not in before_objects and match.group(2) in new_tables:
                notes.append(f"+sequence {readable(match.group(1))} owned by new table "
                             f"{readable(match.group(2))}"); continue
            key=identity(statement)
            refuse(f"{database}: {kind(statement)} is not a provably additive change"
                   + (f" ({key})" if key else "") + f": {describe(statement)}")
    return notes

try:
    before_rows=read_manifest(before_manifest); after_rows=read_manifest(after_manifest)
    if set(before_rows)!=set(after_rows):
        refuse(f"the set of databases changed: before {sorted(before_rows)} after {sorted(after_rows)}")
    accepted=[]
    for database in sorted(before_rows):
        if before_rows[database][2]==after_rows[database][2]: continue
        notes=classify(database,
                       read_dump(before_manifest,database,before_rows[database]),
                       read_dump(after_manifest,database,after_rows[database]))
        if database!="carry":
            refuse(f"{database}: only the carry database may carry a pending migration; the "
                   f"{database} schema must not change at all, additively or otherwise"
                   + (f"; observed {'; '.join(notes)}" if notes else
                      "; the change is not even a classifiable statement delta"))
        if not notes:
            refuse(f"{database}: the schema text changed but no statement-level delta explains it "
                   "(a comment-only or whitespace-only difference); refusing an unexplained change")
        accepted.append(f"{database}: "+"; ".join(notes))
    if not accepted:
        refuse("the schema manifests differ in a field no digest explains (byte or line count); "
               "refusing a manifest that disagrees with itself")
    print("additive schema delta accepted -- "+" | ".join(accepted))
except Refusal as refusal:
    raise SystemExit("schema delta refused: "+str(refusal))
PY
}

# The one call every pre-vs-post schema gate makes. Byte equality still decides
# whether anything changed at all; the classifier runs ONLY after that has already
# failed and must then PROVE the delta non-destructive or refuse it by name. It is
# an addition to the equality check, never a replacement for it.
compare_schema_manifests() {
  local before="$1" after="$2" context="$3" allowance
  if cmp -s "$before" "$after"; then return 0; fi
  allowance="$(classify_schema_delta "$before" "$after")" \
    || fail "$context: the schema delta is NOT provably additive; the classifier's refusal above names the object it refused and why"
  log "$context: $allowance"
}

# A relation-column sidecar is the "$output.columns" file capture_postgres_data
# writes beside every data manifest: one row per relation, `db.schema.relation`
# TAB the exact comma-separated quoted column list that relation's digest was
# taken over. Validate it before a LATER capture is projected onto it, so a
# truncated, duplicated or hand-edited file fails loudly here instead of silently
# narrowing what a digest covers.
validate_relation_column_sidecar() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] \
    || fail "relation column sidecar is missing or unsafe: $path"
  python3 - "$path" <<'PY'
import re,sys
path=sys.argv[1]
seen=set()
for number,raw in enumerate(open(path,encoding="utf-8"),1):
    line=raw.rstrip("\n")
    if not line: continue
    parts=line.split("\t")
    if len(parts)!=2: raise SystemExit(f"{path}: malformed relation column row at line {number}")
    key,columns=parts
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2}",key):
        raise SystemExit(f"{path}: unsafe relation key at line {number}")
    if key in seen: raise SystemExit(f"{path}: duplicate relation key {key}")
    seen.add(key)
    if not re.fullmatch(r'[A-Za-z0-9_",]+',columns):
        raise SystemExit(f"{path}: unsafe column list for {key}")
if not seen: raise SystemExit(f"{path}: relation column sidecar is empty")
PY
}

verify_keycloak_post_migration_evidence() {
  local record="$1"
  python3 - "$record/keycloak-post-migration-data.tsv" "$record/keycloak-post-migration-data.sha256" <<'PY'
import hashlib
import os
import re
import stat
import sys

data_path, digest_path = sys.argv[1:]
for path in (data_path, digest_path):
    metadata = os.lstat(path)
    assert stat.S_ISREG(metadata.st_mode), f"not a regular migration-evidence file: {path}"

with open(digest_path, encoding="ascii") as source:
    line = source.read()
match = re.fullmatch(
    r"([0-9a-f]{64})[ \t]+\*?(?:.*/)?keycloak-post-migration-data\.tsv\n?",
    line,
)
assert match, "invalid Keycloak post-migration digest record"

actual = hashlib.sha256()
with open(data_path, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        actual.update(chunk)
assert actual.hexdigest() == match.group(1), "Keycloak post-migration evidence digest drift"
PY
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

write_application_semantic_evidence() {
  local output="$1" mode="$2" work login_status status_digest connectivity_url center_url
  work="$(mktemp -d)" || return 1
  case "$mode" in
    public)
      connectivity_url=http://127.0.0.1/
      center_url=https://carry.andersmadsen.dk/login
      ;;
    quiesced)
      connectivity_url=http://127.0.0.1:18085/
      center_url=http://127.0.0.1:14000/login
      ;;
    *) rm -rf -- "$work"; return 1 ;;
  esac
  {
    printf 'connectivity.ready\t%s\n' "$(http_status http://127.0.0.1:18085/readyz 2>/dev/null || true)"
    printf 'aibus.ready\t%s\n' "$(http_status http://127.0.0.1:18086/readyz 2>/dev/null || true)"
    printf 'connectivity.authority\t%s\n' "$(http_status -H 'Host: connectivity-check.carry.humane.cloud' "$connectivity_url" 2>/dev/null || true)"
    printf 'oidc.discovery\t%s\n' "$(http_status http://127.0.0.1:8088/realms/humane/.well-known/openid-configuration 2>/dev/null || true)"
    if [[ "$mode" == quiesced ]]; then
      login_status="$(http_status -H 'Host: carry.andersmadsen.dk' "$center_url" 2>/dev/null || true)"
    else
      login_status="$(http_status "$center_url" 2>/dev/null || true)"
    fi
    printf 'center.login\t%s\n' "$login_status"
  } >"$work/statuses.tsv"
  curl --silent --show-error --fail --max-time 20 \
    http://127.0.0.1:18086/demo-api/status >"$work/aibus-status.json" \
    || { rm -rf -- "$work"; return 1; }
  status_digest="$(python3 - "$work/aibus-status.json" <<'PY'
import hashlib,json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); mesh=body.get("mesh") or {}
summary={
  "assistant":body.get("assistant"), "speech":body.get("speech"),
  "reachable":mesh.get("reachable"), "total":mesh.get("total"),
  "services":mesh.get("services"), "methods":mesh.get("methods"),
}
assert summary["assistant"] is True and summary["speech"] is True
assert summary["reachable"] == summary["total"] == 7
encoded=json.dumps(summary,sort_keys=True,separators=(",",":")).encode()
print(hashlib.sha256(encoded).hexdigest())
PY
)" || { rm -rf -- "$work"; return 1; }
  for key in connectivity.ready aibus.ready connectivity.authority; do
    [[ "$(awk -F '\t' -v wanted="$key" '$1==wanted{print $2}' "$work/statuses.tsv")" == 204 ]] \
      || { rm -rf -- "$work"; return 1; }
  done
  [[ "$(awk -F '\t' '$1=="oidc.discovery"{print $2}' "$work/statuses.tsv")" == 200 ]] \
    || { rm -rf -- "$work"; return 1; }
  [[ "$login_status" == 200 || "$login_status" == 302 || "$login_status" == 307 ]] \
    || { rm -rf -- "$work"; return 1; }
  printf 'aibus.status.sha256\t%s\n' "$status_digest" >>"$work/statuses.tsv"
  LC_ALL=C sort -o "$work/statuses.tsv" "$work/statuses.tsv"
  install -m 600 "$work/statuses.tsv" "$output"
  rm -rf -- "$work"
}

write_legacy_semantic_evidence() { write_application_semantic_evidence "$1" public; }

# Used only when the deployment owner has deliberately stopped public ingress.
write_quiesced_semantic_evidence() { write_application_semantic_evidence "$1" quiesced; }

# First-cutover rollback has no canonical release from which to run a canary.
# Compare only the exact healthy surfaces captured before cutover; legacy did
# not expose the later n.carry, Center version, or Spotify-adapter contracts.
verify_legacy_application() {
  local snapshot="$1" baseline="${2:-}" current
  verify_recorded_application_identity "$snapshot" || return 1
  [[ -f "$snapshot/semantic-baseline.tsv" ]] || return 1
  systemctl is-active --quiet penumbra-center-bridge.service || return 1
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || return 1
  current="$(mktemp)" || return 1
  write_legacy_semantic_evidence "$current" || { rm -f -- "$current"; return 1; }
  cmp -s "$snapshot/semantic-baseline.tsv" "$current" || { rm -f -- "$current"; return 1; }
  rm -f -- "$current"
  if [[ -n "$baseline" ]]; then
    (verify_invariants "$baseline/invariants.tsv") || return 1
  fi
}

verify_quiesced_application() {
  local snapshot="$1" baseline="${2:-}" current
  verify_recorded_application_identity "$snapshot" || return 1
  [[ -f "$snapshot/semantic-baseline.tsv" ]] || return 1
  systemctl is-active --quiet penumbra-center-bridge.service || return 1
  timeout 3 bash -c '</dev/tcp/127.0.0.1/18080' 2>/dev/null || return 1
  current="$(mktemp)" || return 1
  write_quiesced_semantic_evidence "$current" || { rm -f -- "$current"; return 1; }
  cmp -s "$snapshot/semantic-baseline.tsv" "$current" || { rm -f -- "$current"; return 1; }
  rm -f -- "$current"
  if [[ -n "$baseline" ]]; then (verify_invariants "$baseline/invariants.tsv") || return 1; fi
}

# A deployment-minted Center SESSION for the paired owner — and nothing else.
#
# Read what this does and does not carry before treating a canary that consumes
# it as proof of the wearer data plane. The jar holds exactly one cookie name,
# `carry_session`: the HS256 session Center signs with AUTH_SESSION_SECRET. It
# does NOT hold the separate `carry_tokens` manifest and chunk cookies that
# Center reassembles into the wearer's Keycloak bearer (TOKENS_COOKIE and its
# `carry_tokens.N` chunks, center/src/server/auth.ts), so `requestBearer()`
# returns null for every request made with it, and with CARRY_PRINCIPAL unset
# (which is every production deployment, deliberately) every outbound gRPC call
# carries no wearer identity and the workload refuses it. Center logs
# "cosmos: outbound gRPC carries no wearer identity" on each one.
#
# That is on purpose: a deploy gate must not hold a wearer credential, and there
# is no service identity here that could stand in for one without either sealing
# a real wearer's token into $PRIVATE_DIR or minting a deployment-wide principal.
# So the contract this jar supports is the HONEST-DEGRADED one — routes that
# need a bearer must answer 200 with `x-data-state: degraded`, never 500 and
# never a silently "live" fixture — and canary.sh's --require-wearer-plane
# asserts exactly that, plus the REST plane which resolves without a bearer.
#
# Closing the remaining gap needs a real sealed bearer (a `center-canary`
# confidential Keycloak client with service accounts, or a synthetic realm user),
# and until that exists the canary says so out loud rather than implying
# coverage it does not have.
write_owner_canary_cookie() {
  local release="$1" output="$2" owner_sub center_container
  load_compose_command "$release"
  owner_sub="$(read_env_value "$CENTER_ENV" REVIVAL_PIN_BRIDGE_OWNER_SUB)"
  center_container="$("${COMPOSE[@]}" ps -q center)"
  [[ -n "$owner_sub" && -n "$center_container" ]] || return 1
  docker exec -i -e "REVIVAL_CANARY_SUB=$owner_sub" "$center_container" node >"$output" <<'NODE'
const { createHmac } = require("node:crypto");
const secret = process.env.AUTH_SESSION_SECRET || "";
const sub = process.env.REVIVAL_CANARY_SUB || "";
if (secret.length < 32 || !sub || /[\r\n]/u.test(sub)) process.exit(1);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: "HS256" })}.${encode({ sub, email: "", name: "deployment canary", operator: false, iat: now, exp: now + 3600 })}`;
const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
// curl matches a cookie against the request's effective Host header, so the jar
// must name every host a canary dials: the loopback origin and both public
// dashboard hosts (the quiesced canary reaches Center on 127.0.0.1 while
// sending Host: <dashboard>). None may be secure-only, because that same
// quiesced path speaks plain HTTP and curl withholds secure cookies there.
// This jar is ephemeral canary material: one hour, mode 0600, removed after.
const token = `${unsigned}.${signature}`;
const expiry = now + 3600;
process.stdout.write(
  `# Netscape HTTP Cookie File\n` +
    `127.0.0.1\tFALSE\t/\tFALSE\t${expiry}\tcarry_session\t${token}\n` +
    `#HttpOnly_center.andersmadsen.dk\tFALSE\t/\tFALSE\t${expiry}\tcarry_session\t${token}\n` +
    `#HttpOnly_carry.andersmadsen.dk\tFALSE\t/\tFALSE\t${expiry}\tcarry_session\t${token}\n`,
);
NODE
  unset owner_sub
  chmod 600 "$output"
  python3 - "$output" <<'PY'
import os,re,sys
data=open(sys.argv[1],encoding="ascii").read()
assert os.stat(sys.argv[1]).st_mode & 0o777 == 0o600
assert len(data) <= 4096
assert re.fullmatch(
    r"# Netscape HTTP Cookie File\n"
    r"127\.0\.0\.1\tFALSE\t/\tFALSE\t[0-9]+\tcarry_session\t(?P<token>[A-Za-z0-9_.-]+)\n"
    r"#HttpOnly_center\.andersmadsen\.dk\tFALSE\t/\tFALSE\t[0-9]+\tcarry_session\t(?P=token)\n"
    r"#HttpOnly_carry\.andersmadsen\.dk\tFALSE\t/\tFALSE\t[0-9]+\tcarry_session\t(?P=token)\n",
    data,
)
PY
}

# ── The canary wearer credential ─────────────────────────────────────────────
#
# write_owner_canary_cookie above mints a SESSION and deliberately no bearer, and
# says so at length. What follows is the other half: a real sealed Keycloak
# bearer for a DEDICATED canary identity, which is the only thing that can prove
# openTokens/refreshTokens/JWKS/CARRY_EDGE_TOKEN are intact on a live deployment.
# Two 100%-degraded wearer planes shipped green because nothing did.
#
# WHY A SEPARATE REALM USER AND NOT A SERVICE ACCOUNT. Center mints the wearer
# bearer in exactly one place — POST /api/auth/login, which calls keycloakLogin
# (Resource Owner Password against client `center`), seals the result with
# sealTokens and writes it as the chunked `carry_tokens` cookie set. A
# client-credentials service account would return a token this deployment's own
# login path never produces, and it returns no refresh token at all, so the gate
# would be exercising a code path production does not have. The canary therefore
# signs in the way a wearer signs in, through Center's own route, and the jar it
# gets back is byte-for-byte the jar a browser gets.
#
# WHAT THE OPERATOR PROVISIONS. One Keycloak realm user in `humane` that is:
#   * NOT in the operator allowlist and holds no `carry-operator` role, so the
#     admin plane refuses it — canary.sh proves this at runtime rather than
#     trusting the provisioning;
#   * NOT the paired Pin owner, so it addresses its own empty `U:<sub>`
#     partition — canary.sh proves that too, against
#     REVIVAL_PIN_BRIDGE_OWNER_SUB;
#   * paired to no device, so it cannot drive the bridge.
# Everything that identity can reach is therefore an empty account. A stolen jar
# buys an attacker a view of nothing, which is the point: this credential must
# not widen what reading a log or an evidence file is worth.
#
# WHERE THE SECRET LIVES. $WEARER_CANARY_SECRET, inside the 0700 $PRIVATE_DIR,
# mode 0600, owned by the deploying user — the same posture as every other
# secret file on this host. It is NOT an entry in any .env file: those are
# interpolated into Compose and land in container environments, and this
# credential must never be readable from inside a workload. It is deliberately
# NOT fingerprinted into config-digests.tsv either, because rotating it would
# then trip the protected-configuration gate and deadlock a deploy on a
# credential rotation — the exact class of deadlock adopt-config exists to undo.
#
# HOW IT REACHES A REQUEST. It does not reach canary.sh as a value at all. The
# password goes from the file into a mode-0600 JSON body in a private temp
# directory, curl reads that body with `--data @path` (the PATH is the argument;
# the value never appears in argv, in the environment, or in any log), and what
# comes back is a short-lived cookie jar. The exchange happens on the loopback
# Center origin only, so the credential never traverses nginx, Cloudflare or any
# public hop. The jar is removed when the canary exits.

# Fail CLOSED and say exactly which property is wrong. Never prints a value —
# not a length, not a prefix — because this is the one file on the host whose
# contents are a live wearer credential.
assert_wearer_canary_secret() {
  local path="${1:-$WEARER_CANARY_SECRET}"
  python3 - "$path" <<'PY'
import os,stat,sys

path=sys.argv[1]
try:
    metadata=os.lstat(path)
except FileNotFoundError:
    raise SystemExit("the canary wearer credential file does not exist")
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("the canary wearer credential must be a regular file, not a link")
if stat.S_IMODE(metadata.st_mode) not in (0o600,0o400):
    raise SystemExit("the canary wearer credential must be mode 0600 or 0400")
if metadata.st_uid != os.geteuid():
    raise SystemExit("the canary wearer credential is not owned by the deploying user")
directory=os.stat(os.path.dirname(os.path.abspath(path)))
if stat.S_IMODE(directory.st_mode) & 0o077:
    raise SystemExit("the directory holding the canary wearer credential is group- or world-accessible")
if not 0 < metadata.st_size <= 4096:
    raise SystemExit("the canary wearer credential file has an implausible size")

required={"REVIVAL_CANARY_WEARER_USERNAME","REVIVAL_CANARY_WEARER_PASSWORD"}
values={}
for line in open(path,encoding="utf-8"):
    line=line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"): continue
    key,separator,value=line.partition("=")
    if not separator:
        raise SystemExit("the canary wearer credential file has a line that is not KEY=VALUE")
    key=key.strip()
    # An extra key means this file is a copy of something larger — a whole
    # center.env, say — and the blast radius of the one file that must stay
    # single-purpose has quietly grown.
    if key not in required:
        raise SystemExit("the canary wearer credential file carries a key that is not part of its contract")
    if key in values:
        raise SystemExit("the canary wearer credential file defines a key twice")
    values[key]=value.strip()
missing=sorted(required-set(values))
if missing:
    raise SystemExit("the canary wearer credential file is missing a required key")
username=values["REVIVAL_CANARY_WEARER_USERNAME"]
password=values["REVIVAL_CANARY_WEARER_PASSWORD"]
for value in (username,password):
    if not value:
        raise SystemExit("the canary wearer credential file has an empty value")
    if any(character < " " or character == "\x7f" for character in value):
        raise SystemExit("the canary wearer credential file has a control character in a value")
if not 1 <= len(username) <= 320:
    raise SystemExit("the canary wearer username is implausible")
# Short enough to be a placeholder is short enough to be guessable, and a
# password equal to the username is the shape a hurried provisioning takes.
if len(password) < 16 or password == username:
    raise SystemExit("the canary wearer password is too weak to be a provisioned credential")
PY
}

wearer_canary_secret_present() {
  [[ -f "$WEARER_CANARY_SECRET" && ! -L "$WEARER_CANARY_SECRET" ]]
}

# The credential's only appearance outside its own file: a mode-0600 JSON body
# that curl reads by path. Kept separate from the request so it is testable
# without a running Center.
write_wearer_canary_login_body() {
  local secret="$1" output="$2"
  python3 - "$secret" "$output" <<'PY'
import json,os,sys,tempfile
secret,output=sys.argv[1:]
values={}
for line in open(secret,encoding="utf-8"):
    key,separator,value=line.rstrip("\n").partition("=")
    if separator: values[key.strip()]=value.strip()
body=json.dumps(
    {"username":values["REVIVAL_CANARY_WEARER_USERNAME"],
     "password":values["REVIVAL_CANARY_WEARER_PASSWORD"]},
    separators=(",",":"),
)
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-login.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="utf-8") as handle: handle.write(body)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Turn Center's login response headers into the raw jar the normalizer consumes.
#
# WHY NOT curl's own --cookie-jar, which is what this did until it was run.
# curl REFUSES TO STORE a `Secure` cookie that arrived over a plain-http URL, and
# Center sets every auth cookie Secure whenever NODE_ENV=production — which
# production is. The login is loopback-only by design (a wearer credential must
# not traverse the public edge, and the quiesced window has no public edge at
# all), so the response ALWAYS arrives over http and curl ALWAYS dropped the
# entire set. The jar came back empty and the run failed with "Center's login set
# no session cookie", which reads as a broken Center and was in fact a broken
# canary. Observed against production, curl 8.5.0, for both http://127.0.0.1 and
# http://localhost: four Set-Cookie headers received, zero cookies stored.
#
# Reading Set-Cookie directly is what canary.sh's OIDC block already does with
# these very headers, so this is the existing pattern rather than a new one, and
# it does not depend on a cookie-engine heuristic that varies by curl version.
#
# Values are carried VERBATIM. Next.js percent-encodes cookie values on the way
# out, and what goes back on the wire has to be the same bytes a browser would
# send; decoding here would quietly rewrite the credential material.
write_login_cookie_jar() {
  local headers="$1" output="$2"
  python3 - "$headers" "$output" <<'PY'
import os,re,sys,tempfile,time

headers,output=sys.argv[1:]
expiry=int(time.time())+3600
rows=[]
for line in open(headers,encoding="latin1"):
    key,separator,value=line.partition(":")
    if not separator or key.strip().lower()!="set-cookie": continue
    attributes=[part.strip() for part in value.strip().split(";")]
    name,assignment,raw=attributes[0].partition("=")
    if not assignment: continue
    # A cleared cookie is not a credential. Center deletes with Max-Age=0, and
    # storing one would make an emptied session look like a complete jar.
    if any(re.fullmatch(r"max-age\s*=\s*0",attribute,re.I) for attribute in attributes[1:]): continue
    rows.append((name.strip(),raw))
if not rows:
    raise SystemExit("Center's login answered 200 and set no cookie at all")
data="# Netscape HTTP Cookie File\n"+"".join(
    f"127.0.0.1\tFALSE\t/\tFALSE\t{expiry}\t{name}\t{value}\n" for name,value in rows
)
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-raw.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="utf-8") as handle: handle.write(data)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Rewrite the login's cookies into the canonical multi-host form the canary
# dials, and refuse anything that is not a complete sealed token set.
#
# The refusal is the gate: Center answers a successful login with 200 and a
# session cookie whether or not sealTokens produced anything usable, so "the
# login worked" is not evidence that the bearer plane exists. A jar with a
# session and no `carry_tokens` manifest is exactly the credential-free jar
# write_owner_canary_cookie mints, and accepting it here would silently
# reinstate the blind spot this whole path exists to close.
#
# The Secure attribute is dropped on purpose, in both directions. Center sets
# these cookies Secure in production, and the canary reaches Center over plain
# HTTP on 127.0.0.1 to sign in — always, and necessarily so in the quiesced
# window, where every public ingress is stopped. curl neither STORES such a
# cookie (see write_login_cookie_jar) nor SENDS one back over loopback, so a jar
# that kept the attribute would be silently empty on the one run that brackets
# the cutover. The values are unchanged and the file is 0600 on a 0700 directory
# — the attribute governs what curl does on loopback, not what Center sets on a
# browser.
normalize_wearer_canary_jar() {
  local raw="$1" output="$2"
  python3 - "$raw" "$output" <<'PY'
import os,re,sys,tempfile,time,urllib.parse

raw,output=sys.argv[1:]
cookies={}
for line in open(raw,encoding="utf-8"):
    line=line.rstrip("\n")
    if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")): continue
    fields=line.split("\t")
    if len(fields)!=7: continue
    name,value=fields[5],fields[6]
    if name in cookies and cookies[name]!=value:
        raise SystemExit("Center's login returned two different values for one cookie")
    cookies[name]=value

session=cookies.get("carry_session")
manifest=cookies.get("carry_tokens")
if not session:
    raise SystemExit("Center's login set no session cookie")
if not manifest:
    raise SystemExit("Center's login set no sealed token cookie, so this jar carries no wearer bearer")
# Center writes `v1:N`, and Next.js percent-encodes every cookie value on the way
# out, so the byte sequence that actually arrives is `v1%3AN`. The DECODED form is
# what gets checked, because that is what Center meant; the ENCODED form is what
# stays in the jar, because that is what a browser sends back.
found=re.fullmatch(r"v1:([1-4])",urllib.parse.unquote(manifest))
if not found:
    raise SystemExit("the sealed token manifest is not the chunk format Center writes")
ordered=[("carry_session",session),("carry_tokens",manifest)]
for index in range(int(found.group(1))):
    name=f"carry_tokens.{index}"
    value=cookies.get(name)
    if not value:
        raise SystemExit("the sealed token set is missing a chunk its own manifest declares")
    ordered.append((name,value))
for name,value in ordered:
    # base64url for the session JWT and every JWE chunk, plus the one colon in
    # the `v1:N` manifest — percent-escaped or not, since Next.js escapes it and
    # base64url itself has nothing left to escape. Anything else means a hop
    # rewrote the cookie, and a rewritten sealed token is a silent `degraded`
    # three checks later.
    if not re.fullmatch(r"[A-Za-z0-9_.:%~-]{1,16384}",value):
        raise SystemExit("a canary cookie value is not the shape Center emits")

expiry=int(time.time())+3600
lines=["# Netscape HTTP Cookie File\n"]
for host in ("127.0.0.1","#HttpOnly_center.andersmadsen.dk","#HttpOnly_carry.andersmadsen.dk"):
    for name,value in ordered:
        lines.append(f"{host}\tFALSE\t/\tFALSE\t{expiry}\t{name}\t{value}\n")
data="".join(lines)
if len(data) > 262144:
    raise SystemExit("the canary cookie jar is larger than the supported cookie budget")
directory=os.path.dirname(os.path.abspath(output))
descriptor,temporary=tempfile.mkstemp(prefix=".canary-jar.",dir=directory)
try:
    os.fchmod(descriptor,0o600)
    with os.fdopen(descriptor,"w",encoding="ascii") as handle: handle.write(data)
    os.replace(temporary,output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

# Sign the canary wearer in through Center's own login route and leave a jar
# holding the real sealed bearer. Diagnostics name the failing stage and never
# the credential.
write_wearer_canary_jar() {
  local output="$1" work status
  assert_wearer_canary_secret "$WEARER_CANARY_SECRET" || return 1
  work="$(mktemp -d)" || return 1
  if ! write_wearer_canary_login_body "$WEARER_CANARY_SECRET" "$work/login.json"; then
    rm -rf -- "$work"
    return 1
  fi
  # Loopback only: the credential must not traverse the public edge, and this is
  # also the one Center origin that is reachable inside the quiesced window.
  status="$(curl --silent --show-error --connect-timeout 4 --max-time 25 --max-redirs 0 \
    -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' -H 'Host: center.andersmadsen.dk' \
    -H 'X-Forwarded-Proto: https' -H 'Origin: https://center.andersmadsen.dk' \
    --data @"$work/login.json" -D "$work/login.headers" \
    http://127.0.0.1:14000/api/auth/login || true)"
  rm -f -- "$work/login.json"
  if [[ "$status" != 200 ]]; then
    # 401 is a rejected credential; 503 is a Center with no KEYCLOAK_BASE_URL;
    # 000 is a Center that did not answer at all. All three are deploy-blocking
    # and none of them is the operator's password being echoed anywhere.
    warn "the canary wearer could not sign in to Center (HTTP $status)"
    rm -rf -- "$work"
    return 1
  fi
  if ! write_login_cookie_jar "$work/login.headers" "$work/raw.cookies"; then
    rm -rf -- "$work"
    return 1
  fi
  if ! normalize_wearer_canary_jar "$work/raw.cookies" "$output"; then
    rm -rf -- "$work"
    return 1
  fi
  rm -rf -- "$work"
}

# The subject Center signed into the session half of the jar. Read from our own
# cookie without verifying it — the signature is Center's to check, and this is
# only used to prove the canary is NOT the paired wearer.
wearer_canary_jar_subject() {
  local jar="$1"
  python3 - "$jar" <<'PY'
import base64,json,re,sys
value=None
for line in open(sys.argv[1],encoding="ascii"):
    fields=line.rstrip("\n").split("\t")
    if len(fields)==7 and fields[5]=="carry_session": value=fields[6]; break
if not value: raise SystemExit("the canary jar has no session cookie")
parts=value.split(".")
if len(parts)!=3: raise SystemExit("the canary session cookie is not a compact JWT")
payload=parts[1]
claims=json.loads(base64.urlsafe_b64decode(payload+"="*(-len(payload)%4)))
subject=str(claims.get("sub") or "")
if not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,320}",subject):
    raise SystemExit("the canary session cookie carries no usable subject")
print(subject)
PY
}

latest_deployment() {
  find "$DEPLOYMENTS_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' -print \
    | LC_ALL=C sort | tail -n 1
}

safe_release_pointer() {
  local pointer="$1"
  [[ -L "$pointer" ]] || return 1
  local resolved
  resolved="$(readlink -f "$pointer")"
  [[ "$resolved" == "$RELEASES_DIR/"* && -d "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

# The first canonical cutover records the still-running legacy containers as
# its rollback target. Those containers retain their historical external
# network attachment even though no Ai Pin Revival service uses that network.
legacy_rollback_network_required() {
  local current_pointer="${1:-$REMOTE_ROOT/current}"
  if (($#)); then
    local explicit_releases resolved
    explicit_releases="$(dirname -- "$current_pointer")/releases"
    if [[ -L "$current_pointer" ]]; then
      resolved="$(readlink -f -- "$current_pointer")" || return 0
      if [[ "$resolved" == "$explicit_releases/"* && -d "$resolved" ]]; then
        return 1
      fi
    fi
  elif safe_release_pointer "$current_pointer" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

safe_deployment_pointer() {
  local pointer="$1" resolved
  [[ -L "$pointer" ]] || return 1
  resolved="$(readlink -f "$pointer")"
  [[ "$resolved" == "$DEPLOYMENTS_DIR/"* && -d "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

cleanup_project_images() {
  # Exact repository scope only. Never run a builder/system prune and never
  # remove volumes or images referenced by any container.
  local image_id references
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] || continue
    references="$(docker ps -aq --filter "ancestor=$image_id" | head -n 1)"
    [[ -z "$references" ]] || continue
    docker image rm "$image_id" >/dev/null || true
  done < <(docker images --filter reference='ai-pin-revival/*' --filter dangling=true --quiet | LC_ALL=C sort -u)
}

json_result() {
  local status="$1" detail="$2"
  python3 - "$status" "$detail" <<'PY'
import json, sys
print(json.dumps({"ok": sys.argv[1] == "ok", "detail": sys.argv[2]}, separators=(",", ":")))
PY
}
