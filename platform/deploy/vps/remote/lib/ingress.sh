#!/usr/bin/bash
# Managed ingress: cloudflared topology, ingress evidence, quiesce and
# restore.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

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
