#!/usr/bin/env -S /bin/bash -p
set -euo pipefail
case "${BASH_SOURCE[0]}" in /*) SCRIPT_PATH="${BASH_SOURCE[0]}" ;; *) SCRIPT_PATH="$PWD/${BASH_SOURCE[0]}" ;; esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
builtin source "$SCRIPT_DIR/lib/local.sh"

leave=0
json=0
fetch=0
confirm=0
backup_id=""
# Mirrors revival's BACKUP_DIR/SECRETS_DIR resolution so the wrapper behaves the
# same whether it is invoked through `./revival backup` (which exports both) or
# directly.
fetch_dir="${REVIVAL_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-pin-revival/backups}"
secrets_dir="${REVIVAL_SECRETS_DIR:-${REVIVAL_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-pin-revival}/secrets}"
usage() {
  echo "usage: $0 --confirm [--remote vps] [--backup-id ID] [--leave-quiesced] [--fetch [--fetch-dir DIR]] [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --backup-id) (($# >= 2)) || usage; backup_id="$2"; shift 2 ;;
    --leave-quiesced) leave=1; shift ;;
    --fetch) fetch=1; shift ;;
    --fetch-dir) (($# >= 2)) || usage; fetch_dir="$2"; fetch=1; shift 2 ;;
    --json) json=1; shift ;;
    --confirm) ((confirm == 0)) || usage; confirm=1; shift ;;
    *) usage ;;
  esac
done
[[ -z "$backup_id" || "$backup_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || usage
((confirm == 1)) || usage_error "backup changes production and requires one literal --confirm"
need_local ssh

note() { printf '[ai-pin-revival] %s\n' "$*"; }
notice() { printf '[ai-pin-revival] warning: %s\n' "$*" >&2; }

# Checked before the host is touched as well as at the copy itself, so an
# unusable destination is reported before a backup quiesces the wearer's Pin
# bridge for minutes rather than after.
assert_fetch_destination() {
  local directory="$1" id="$2"
  [[ "$directory" == /* ]] || die "--fetch-dir must be an absolute path: $directory"
  # Private keys must never land inside the checkout, where the next `git add`
  # or release package would contain them.
  [[ "$directory" != "$REVIVAL_ROOT" && "$directory" != "$REVIVAL_ROOT"/* ]] \
    || die "--fetch-dir must be outside the source tree: $directory"
  [[ -z "$id" || ! -e "$directory/$id" ]] \
    || die "a local backup bundle for $id already exists: $directory/$id"
}

# Every backup this project has ever taken lives on the same filesystem as the
# data it protects, and one of the things it protects - the attestation and
# DeviceUser CA private keys - cannot be regenerated once that disk is gone,
# because the attestation root is pinned inside the APKs already installed on
# the Pin. --fetch is the missing direction: it pulls one completed, already
# self-verifying backup off the host and re-verifies it here, then adds the half
# that exists only here (the Pin signing keystores, which are in no backup at
# all and without which no signed upgrade can ever be built again). The result
# is one directory that holds both halves; nothing else in the system does.
fetch_backup() {
  local id="$1" bundle="$2/$1" staging="$2/.incoming-$1"
  local host="$bundle/host" operator="$bundle/operator" evidence key_material

  assert_fetch_destination "$2" "$id"
  mkdir -p "$2"
  chmod 700 "$2"
  rm -rf -- "$staging"
  mkdir -p "$staging"
  chmod 700 "$staging"

  # tar over ssh rather than scp or rsync: it is read-only on the host, it is
  # one stream so a truncated transfer cannot look like a complete directory,
  # and tar exists on every operator machine while rsync does not.
  note "fetching backup $id from $DEPLOY_REMOTE"
  run_ssh "$REMOTE_POSITIVE_ENV /usr/bin/tar $(remote_quote -C "$REMOTE_ROOT/backups" -cf - -- "$id")" \
    | "${REVIVAL_LOCAL_TAR:?}" -C "$staging" -xpf -
  [[ -d "$staging/$id" && ! -L "$staging/$id" ]] || die "fetched backup is not the expected directory: $id"

  evidence="$staging/key-material.tsv"
  verify_fetched_backup "$staging/$id" "$id" "$evidence"
  key_material="$(cat "$evidence")"

  mkdir -p "$bundle"
  chmod 700 "$bundle"
  mv "$staging/$id" "$host"
  find "$host" -type d -exec chmod 700 {} +
  find "$host" -type f -exec chmod 600 {} +
  note "verified host half: $host"

  # The operator half is captured after the host half is durable. If it fails,
  # the pull is not thrown away - but no RECOVERY.json is written, so the bundle
  # is visibly incomplete rather than quietly half a backup.
  capture_operator_key_material "$operator"
  write_recovery_index "$bundle" "$id" "$key_material"
  rm -rf -- "$staging"

  note "off-host bundle complete: $bundle"
  notice "this bundle holds every irreplaceable private key in the system - both CA keys and the Pin signing keystores. Copy it to offline media and keep it encrypted; it is the only copy that is not on the host it protects."
}

# Re-verify what the host claimed, here, from the bytes that actually arrived:
# the manifest of digests, the backup identity, and - independently - that the
# irreplaceable key material is really inside protected.tar.gz. A backup that
# transferred cleanly but lacks those four members is the failure this whole
# command exists to prevent, and it is invisible in a directory listing.
verify_fetched_backup() {
  local root="$1" id="$2" evidence="$3"
  need_local python3
  "${REVIVAL_LOCAL_PYTHON:-python3}" -I -B - "$root" "$id" "$evidence" <<'PY' || die "fetched backup failed local verification"
import hashlib,json,os,stat,sys,tarfile
root,expected_id,evidence=sys.argv[1:]

def digest_file(path):
    value=hashlib.sha256()
    with open(path,"rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""): value.update(chunk)
    return value.hexdigest()

present={}
for directory,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    for name in [*dirs,*files]:
        path=os.path.join(directory,name); relative=os.path.relpath(path,root)
        metadata=os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode): raise SystemExit(f"fetched backup contains a symlink: {relative}")
        if stat.S_ISDIR(metadata.st_mode): continue
        if not stat.S_ISREG(metadata.st_mode): raise SystemExit(f"fetched backup contains a non-regular file: {relative}")
        present[relative]=path

sums=os.path.join(root,"SHA256SUMS")
if not os.path.isfile(sums): raise SystemExit("fetched backup has no SHA256SUMS")
declared={}
for number,line in enumerate(open(sums,encoding="utf-8").read().splitlines(),1):
    if not line.strip(): continue
    parts=line.split("  ",1)
    if len(parts)!=2 or len(parts[0])!=64: raise SystemExit(f"SHA256SUMS is malformed at line {number}")
    declared[parts[1]]=parts[0]
listed=set(declared); carried=set(present)-{"SHA256SUMS"}
if listed!=carried:
    raise SystemExit(f"fetched backup does not match SHA256SUMS; missing={sorted(listed-carried)}, unlisted={sorted(carried-listed)}")
for relative,expected in sorted(declared.items()):
    if digest_file(present[relative])!=expected:
        raise SystemExit(f"fetched backup content differs from SHA256SUMS: {relative}")
if open(os.path.join(root,"BACKUP_ID"),encoding="utf-8").read().strip()!=expected_id:
    raise SystemExit("fetched backup identifies itself as a different backup")

# active-security-roots.tsv records where the two CA roots lived on the host, so
# the member names below follow the host rather than a constant duplicated here.
roots={}
for line in open(os.path.join(root,"active-security-roots.tsv"),encoding="utf-8").read().splitlines():
    if not line.strip(): continue
    label,value=line.split("\t")
    roots[label]=value
wanted={}
for label,names in (("attestation",("ca.key","ca.crt")),("device-user",("duc-ca.key","duc-ca.crt"))):
    base=roots.get(label)
    if not base: raise SystemExit(f"fetched backup does not record its {label} root")
    for name in names:
        role=f"{label}-ca-{'key' if name.endswith('.key') else 'cert'}"
        wanted[f"{base}/{name}".removeprefix("/")]=role

inventory={item["path"].removeprefix("./").removeprefix("/"):item
    for item in json.load(open(os.path.join(root,"protected-inventory.json"),encoding="utf-8"))}
rows=[]
for member,role in sorted(wanted.items()):
    item=inventory.get(member)
    if item is None: raise SystemExit(f"irreplaceable key material is absent from the fetched backup: {role} ({member})")
    if item["type"] not in {"0","\x00"} or "sha256" not in item or item["size"]<=0:
        raise SystemExit(f"irreplaceable key material is not usable in the fetched backup: {role} ({member})")
    rows.append((role,member,item["sha256"],item["size"]))

found=set()
with tarfile.open(os.path.join(root,"protected.tar.gz"),"r:gz") as bundle:
    for member in bundle:
        name=member.name.removeprefix("./").removeprefix("/")
        if name not in wanted: continue
        if not member.isfile(): raise SystemExit(f"key material member is not a regular file: {name}")
        stream=bundle.extractfile(member); value=hashlib.sha256()
        for chunk in iter(lambda:stream.read(1024*1024),b""): value.update(chunk)
        stream.close()
        if value.hexdigest()!=inventory[name]["sha256"]:
            raise SystemExit(f"key material bytes differ from the inventory: {name}")
        found.add(name)
missing=sorted(set(wanted)-found)
if missing: raise SystemExit(f"irreplaceable key material is absent from protected.tar.gz: {missing}")

with open(evidence,"w",encoding="utf-8",newline="\n") as output:
    for role,member,sha,size in rows: output.write(f"{role}\t/{member}\t{sha}\t{size}\n")
os.chmod(evidence,0o600)
print(f"verified {len(rows)} irreplaceable key files inside {len(declared)} hash-manifested artifacts")
PY
}

# The Pin signing keystores exist on this machine and nowhere else, and no
# backup has ever contained them: losing this laptop means no signed upgrade can
# ever be built for the Pin already in the wearer's hand. Capture them beside
# the host half so one directory is a complete recovery set.
capture_operator_key_material() {
  local operator="$1" signing="$secrets_dir/pin" store name
  if [[ ! -d "$signing" ]]; then
    notice "no operator Pin signing material at $signing; the bundle carries the host half only"
    return 0
  fi
  [[ -f "$signing/signing.env" && ! -L "$signing/signing.env" ]] \
    || die "Pin signing environment is missing or unsafe: $signing/signing.env"
  store="$("${REVIVAL_LOCAL_PYTHON:-python3}" -I -B - "$signing/signing.env" <<'PY'
import re,sys
for line in open(sys.argv[1],encoding="utf-8"):
    match=re.fullmatch(r"export PIN_SIGNING_STORE_FILE=(.*)",line.rstrip("\n"))
    if not match: continue
    value=match.group(1).strip()
    if len(value)>1 and value[0]==value[-1] and value[0] in "'\"": value=value[1:-1]
    print(value)
    break
PY
)" || die "could not read the Pin signing environment: $signing/signing.env"
  [[ -n "$store" ]] || die "$signing/signing.env does not name PIN_SIGNING_STORE_FILE; the signing keystore cannot be identified"
  [[ -f "$store" && ! -L "$store" && -s "$store" ]] \
    || die "Pin signing keystore is missing, unsafe, or empty: $store"
  [[ "$store" == "$signing/"* ]] \
    || die "Pin signing keystore lives outside $signing ($store); move it there so the bundle can capture it"

  mkdir -p "$operator"
  chmod 700 "$operator"
  # Copy the whole tree: signing.env names one store, but the bootstrap
  # keystore beside it is just as unrecoverable and is referenced by nothing —
  # and the provisioning flow now stores per-device identity material under
  # device-identities/<device-id>/, which is exactly the credential class this
  # bundle exists to contain. Regular files only, at any depth; a symlink or
  # anything else stops the capture rather than half-succeeding.
  while IFS= read -r name; do
    relative="${name#"$signing"/}"
    if [[ -d "$name" && ! -L "$name" ]]; then
      mkdir -p "$operator/$relative"
      chmod 700 "$operator/$relative"
      continue
    fi
    [[ -f "$name" && ! -L "$name" ]] || die "operator signing material contains a non-regular object: $name"
    [[ -s "$name" ]] || die "operator signing material is empty: $name"
    install -m 600 "$name" "$operator/$relative"
  done < <(find "$signing" -mindepth 1 -print | LC_ALL=C sort)
  note "captured operator half: $operator"
}

# The index is written last and only on success, so its presence is the signal
# that this bundle is a complete recovery set. An operator finding a bundle
# without it has half a backup and must be able to tell.
write_recovery_index() {
  local bundle="$1" id="$2" key_material="$3"
  "${REVIVAL_LOCAL_PYTHON:-python3}" -I -B - "$bundle" "$id" "$DEPLOY_REMOTE" "$REMOTE_ROOT" "$key_material" <<'PY' \
    || die "recovery index could not be written"
import hashlib,json,os,stat,sys
bundle,backup_id,remote,remote_root,key_material=sys.argv[1:]
def inventory(directory):
    # Walk recursively: the operator half now carries per-device identity
    # material under device-identities/<device-id>/. Regular files at any
    # depth are hashed under their relative path; anything else stops the
    # index rather than describing a bundle it does not understand.
    items=[]
    if not os.path.isdir(directory): return items
    for root,dirs,names in os.walk(directory):
        dirs.sort()
        for name in sorted(names):
            path=os.path.join(root,name)
            metadata=os.lstat(path)
            if not stat.S_ISREG(metadata.st_mode): raise SystemExit(f"unexpected object in {directory}: {name}")
            value=hashlib.sha256()
            with open(path,"rb") as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b""): value.update(chunk)
            items.append({"path":os.path.relpath(path,directory),"size":metadata.st_size,"sha256":value.hexdigest()})
    return items
keys=[]
for line in key_material.splitlines():
    if not line.strip(): continue
    role,path,sha,size=line.split("\t")
    keys.append({"role":role,"hostPath":path,"sha256":sha,"size":int(size)})
operator=inventory(os.path.join(bundle,"operator"))
operator_half={"path":"operator","files":operator}
if not operator:
    operator_half["note"]="no Pin signing material was present on this machine when the bundle was written"
host_half={"path":"host",
    "verified":["SHA256SUMS","BACKUP_ID","protected-inventory.json","protected.tar.gz"],
    "irreplaceableKeys":keys}
document={"schemaVersion":1,
    "kind":"dk.andersmadsen.ai-pin-revival.recovery-bundle",
    "backupId":backup_id,
    "fetchedFrom":{"remote":remote,"path":f"{remote_root}/backups/{backup_id}"},
    "hostHalf":host_half,
    "operatorHalf":operator_half,
    "procedure":"docs/recovery.md"}
path=os.path.join(bundle,"RECOVERY.json")
with open(path,"w",encoding="utf-8",newline="\n") as output:
    json.dump(document,output,indent=2,sort_keys=True); output.write("\n")
os.chmod(path,0o600)
PY
}

if ((fetch)); then
  need_local python3
  need_local tar
  if [[ -z "$backup_id" ]]; then
    # Choose the identity here rather than parsing it back out of the remote
    # log: the fetch has to know exactly which directory it is pulling, and the
    # remote driver already accepts --backup-id in this shape.
    backup_id="$(date -u +%Y%m%dT%H%M%SZ)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    [[ "$backup_id" =~ ^[A-Za-z0-9._-]{8,96}$ ]] || die "could not generate a backup id"
  fi
  # Refuse an unusable destination before the host is quiesced, not after: the
  # backup stops the wearer's Pin bridge and every application writer for
  # minutes, and finding out then that the copy has nowhere to land wastes the
  # whole window.
  assert_fetch_destination "$fetch_dir" "$backup_id"
fi

args=()
[[ -n "$backup_id" ]] && args+=(--backup-id "$backup_id")
((leave)) && args+=(--leave-quiesced)
((json)) && args+=(--json)
run_current_release_operation backup.sh "${args[@]}"
((fetch == 0)) || fetch_backup "$backup_id" "$fetch_dir"
