#!/usr/bin/env bash
# Protected configuration: staging, proposals, evidence recording and
# verification.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

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
