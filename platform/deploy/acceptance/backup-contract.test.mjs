import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ordering over script source goes through the guarded offsets only: a bare
// indexOf answers -1 for a token that was deleted, and -1 is smaller than every
// real offset, so `at(a) < at(b)` would be SATISFIED by removing `a`. That is
// precisely the mutation the key-material call-site pins below exist to catch.
import { at } from "./source-offsets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "platform/deploy/vps/remote/common.sh");

function bash(script, args = []) {
  return spawnSync("bash", ["-c", script, "fixture", common, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

const portableStat = String.raw`
stat() {
  if [[ "$1" == -c ]]; then
    python3 - "$2" "$3" <<'PY'
import os,stat,sys
fmt,path=sys.argv[1:]; metadata=os.stat(path,follow_symlinks=False)
if fmt=="%a": print(format(stat.S_IMODE(metadata.st_mode),"o"))
elif fmt=="%u:%g": print(f"{metadata.st_uid}:{metadata.st_gid}")
else: raise SystemExit(2)
PY
  else command stat "$@"; fi
}
`;

test("canonical archive inventory retains root metadata, ACLs, and xattrs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-backup-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"
python3 - "$work/good.tar.gz" "$work/drift.tar.gz" <<'PY'
import io,sys,tarfile
for target,mode in ((sys.argv[1],0o711),(sys.argv[2],0o700)):
    with tarfile.open(target,"w:gz",format=tarfile.PAX_FORMAT) as bundle:
        root=tarfile.TarInfo("."); root.type=tarfile.DIRTYPE; root.mode=mode; root.uid=17; root.gid=23
        root.pax_headers={"SCHILY.acl.access":"user::rwx","SCHILY.xattr.user.fixture":"root-value"}
        bundle.addfile(root)
        body=b"payload\n"; item=tarfile.TarInfo("./entry.txt"); item.mode=0o640; item.uid=17; item.gid=23; item.size=len(body)
        item.pax_headers={"SCHILY.acl.access":"user::rw-","SCHILY.xattr.user.fixture":"file-value"}
        bundle.addfile(item,io.BytesIO(body))
PY
archive_inventory "$work/good.tar.gz" "$work/good.json"
archive_inventory "$work/drift.tar.gz" "$work/drift.json"
validate_archive_inventory "$work/good.json"
compare_archive_inventories "$work/good.json" "$work/good.json"
! (compare_archive_inventories "$work/good.json" "$work/drift.json") >/dev/null 2>&1
python3 - "$work/good.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1],encoding="utf-8")); roots=[item for item in items if item["path"]=="."]
assert len(roots)==1
assert roots[0]["mode"]=="0o711" and roots[0]["uid"]==17 and roots[0]["gid"]==23
assert roots[0]["acl"]=={"access":"user::rwx"}
assert roots[0]["xattrs"]=={"user.fixture":"root-value"}
entry=next(item for item in items if item["path"]=="entry.txt")
assert entry["acl"]=={"access":"user::rw-"} and entry["xattrs"]=={"user.fixture":"file-value"}
assert len(entry["sha256"])==64
PY
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("the archive inventory reads each archive once and still emits it name-ordered", async (t) => {
  // WHY A READER-MODE ASSERTION SITS IN AN OUTPUT-CONTRACT SUITE.
  //
  // archive_inventory hashes every member of every archive a backup produces, and
  // it runs twelve times per backup — six over the archives, six over the
  // re-tarred restores. All twelve are inside the window where deploy.sh has
  // stopped nginx and both Cloudflare connectors and the wearer's Pin is
  // connection-refused, and a deploy takes two backups, so it is twenty-four.
  //
  // `r:gz` makes those reads random-access, and random access into a gzip stream
  // is implemented by rewinding and re-inflating from byte zero. Asking for
  // members in NAME order out of an archive stored in DIRECTORY order therefore
  // replayed the decompression once per out-of-order member. On the volume
  // archives — a few large members each — it is invisible. On postgres-data.tar.gz,
  // a PGDATA tree of thousands of small relation segments, it measured 79 SECONDS
  // for 21 MB, four times in the 950s outage of 2026-08-11.
  //
  // `r|gz` is the strictly sequential reader: it cannot seek backwards, so this
  // assertion is what keeps the cost linear. The sort moved to the finished items
  // and is pinned below, because the ORDER is the output contract every
  // comparison downstream depends on and the reader change must not touch it.
  const libDir = path.join(path.dirname(common), "lib");
  const libNames = (await readdir(libDir)).filter((name) => name.endsWith(".sh")).sort();
  const source = [
    await readFile(common, "utf8"),
    ...(await Promise.all(libNames.map((name) => readFile(path.join(libDir, name), "utf8")))),
  ].join("\n");
  assert.match(
    source,
    /^with tarfile\.open\(archive,"r\|gz"\) as bundle:$/m,
    "archive_inventory must read sequentially; r:gz re-inflates from byte zero per out-of-order member",
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-inventory-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"
# Stored deliberately in reverse name order, which is what a real PGDATA archive
# looks like to a name-ordered reader: every member out of position.
python3 - "$work/scrambled.tar.gz" <<'PY'
import io,sys,tarfile
with tarfile.open(sys.argv[1],"w:gz",format=tarfile.PAX_FORMAT) as bundle:
    root=tarfile.TarInfo("."); root.type=tarfile.DIRTYPE; root.mode=0o700
    bundle.addfile(root)
    for name in ("zeta","mu","beta","alpha"):
        body=name.encode()*4
        item=tarfile.TarInfo(f"./{name}.txt"); item.mode=0o600; item.size=len(body)
        bundle.addfile(item,io.BytesIO(body))
PY
archive_inventory "$work/scrambled.tar.gz" "$work/scrambled.json"
validate_archive_inventory "$work/scrambled.json"
python3 - "$work/scrambled.json" <<'PY'
import hashlib,json,sys
items=json.load(open(sys.argv[1],encoding="utf-8"))
paths=[item["path"] for item in items]
assert paths==[".","alpha.txt","beta.txt","mu.txt","zeta.txt"], paths
# Every member's bytes, not merely its header: a sequential reader that advanced
# past a member without hashing it would still produce this exact path list.
for item in items:
    if item["path"]==".": continue
    name=item["path"].removesuffix(".txt")
    assert item["sha256"]==hashlib.sha256(name.encode()*4).hexdigest(), item["path"]
PY
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("protected multi-root producer inventories one root and only reviewed paths", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-protected-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backup = path.join(root, "platform/deploy/vps/remote/backup.sh");
  const script = String.raw`
source "$1"
backup="$2"; work="$3"; source_root="$work/source"; restore_root="$work/restore"

# Source the exact production producer while avoiding backup.sh's top-level
# device/VPS orchestration. macOS bsdtar lacks GNU tar's xattrs include filter,
# so the sudo fixture removes only that platform-specific option.
eval "$(sed -n '/^archive_selected_paths() {/,/^}/p' "$backup")"
sudo() {
  [[ "$1" != -n ]] || shift
  if [[ "$1" == tar ]]; then
    shift
    local arguments=() argument
    for argument in "$@"; do
      [[ "$argument" == --xattrs-include=* ]] || arguments+=("$argument")
    done
    COPYFILE_DISABLE=1 command tar "${"$"}{arguments[@]}"
  else
    command "$@"
  fi
}

mkdir -p "$source_root/reviewed/tree" "$source_root/identity" "$source_root/unreviewed" "$restore_root"
chmod 0711 "$source_root"
printf 'protected payload\n' >"$source_root/reviewed/tree/note.txt"
printf 'trust root\n' >"$source_root/identity/key.bin"
printf 'must stay out\n' >"$source_root/unreviewed/leak.txt"
chmod 0750 "$source_root/reviewed/tree" "$source_root/identity"
chmod 0640 "$source_root/reviewed/tree/note.txt" "$source_root/identity/key.bin"
printf 'reviewed/tree\nidentity/key.bin\n' >"$work/protected.paths"

archive_selected_paths "$source_root" "$work/protected.paths" "$work/protected.tar.gz"
archive_inventory "$work/protected.tar.gz" "$work/protected.inventory.json"
python3 - "$work/protected.inventory.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1],encoding="utf-8"))
paths=[item["path"] for item in items]
assert paths.count(".")==1
assert set(paths)=={".","reviewed/tree","reviewed/tree/note.txt","identity/key.bin"}
root=next(item for item in items if item["path"]==".")
note=next(item for item in items if item["path"]=="reviewed/tree/note.txt")
assert root["mode"]==oct(0o711)
assert note["mode"]==oct(0o640) and len(note["sha256"])==64
assert all(not name.startswith("unreviewed") for name in paths)
PY

sudo -n tar --numeric-owner --acls --xattrs --xattrs-include='*' \
  -xzpf "$work/protected.tar.gz" -C "$restore_root"
archive_selected_paths "$restore_root" "$work/protected.paths" "$work/protected-restored.tar.gz"
archive_inventory "$work/protected-restored.tar.gz" "$work/protected-restored.inventory.json"
compare_archive_inventories "$work/protected.inventory.json" "$work/protected-restored.inventory.json"
`;
  const result = bash(script, [backup, directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("channel-key JSON accepts only exact canonical AES-128 material", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-channel-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = JSON.stringify({ kid: "U:wearer/center/ephemeral", key: Buffer.alloc(16, 7).toString("base64") });
  const invalid = {
    missing: JSON.stringify({ key: Buffer.alloc(16).toString("base64") }),
    duplicate: `{"kid":"first","kid":"second","key":"${Buffer.alloc(16).toString("base64")}"}`,
    unknown: JSON.stringify({ kid: "wearer", key: Buffer.alloc(16).toString("base64"), algorithm: "AES-128-GCM" }),
    wrongLength: JSON.stringify({ kid: "wearer", key: Buffer.alloc(32).toString("base64") }),
  };
  const validPath = path.join(directory, "valid.json");
  await writeFile(validPath, valid, { mode: 0o600 });
  let result = bash('source "$1"; validate_center_channel_key_json "$2"', [validPath]);
  assert.equal(result.status, 0, result.stderr);
  for (const [name, body] of Object.entries(invalid)) {
    const target = path.join(directory, `${name}.json`);
    await writeFile(target, body, { mode: 0o600 });
    result = bash('source "$1"; validate_center_channel_key_json "$2"', [target]);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
  }
});

test("versioned invariants produce complete present and absent channel states", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-channel-invariants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"; CENTER_DATA_DIR="$work/center"; mkdir -p "$CENTER_DATA_DIR"
database_count() { printf '%s\n' -1; }
state_file_count() { printf '0\n'; }
state_byte_count() { printf '0\n'; }
${portableStat}
printf '%s\n' '{"kid":"U:wearer/center/ephemeral","key":"BwcHBwcHBwcHBwcHBwcHBw=="}' >"$CENTER_DATA_DIR/channel-key.json"
chmod 0600 "$CENTER_DATA_DIR/channel-key.json"
write_backup_invariants "$work/present.tsv" ignored
validate_backup_invariants "$work/present.tsv"
grep -qx $'contract.schema\tdk.andersmadsen.ai-pin-revival.backup-invariants' "$work/present.tsv"
grep -qx $'contract.version\t1' "$work/present.tsv"
grep -qx $'center.channel_key.presence\tpresent' "$work/present.tsv"
grep -Eq $'^center\.channel_key\.sha256\t[0-9a-f]{64}$' "$work/present.tsv"
grep -qx $'center.channel_key.mode\t600' "$work/present.tsv"
rm "$CENTER_DATA_DIR/channel-key.json"
write_backup_invariants "$work/absent.tsv" ignored
validate_backup_invariants "$work/absent.tsv"
grep -qx $'center.channel_key.presence\tabsent' "$work/absent.tsv"
grep -qx $'center.channel_key.sha256\t-' "$work/absent.tsv"
grep -qx $'center.channel_key.mode\t-' "$work/absent.tsv"
grep -qx $'center.channel_key.owner\t-' "$work/absent.tsv"
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);

  const valid = await readFile(path.join(directory, "present.tsv"), "utf8");
  const mutations = {
    missing: valid.split("\n").filter((line) => !line.startsWith("center.channel_key.mode\t")).join("\n"),
    duplicate: `${valid}center.channel_key.mode\t600\n`,
    unknown: `${valid}center.channel_key.algorithm\tAES-128-GCM\n`,
    unknownVersion: valid.replace("contract.version\t1", "contract.version\t2"),
  };
  for (const [name, body] of Object.entries(mutations)) {
    const target = path.join(directory, `${name}.tsv`);
    await writeFile(target, body, { mode: 0o600 });
    const checked = bash('source "$1"; validate_backup_invariants "$2"', [target]);
    assert.notEqual(checked.status, 0, `${name} invariant mutation unexpectedly passed`);
  }
});

test("channel contract binds JSON, digest, type, mode, owner, ACL, and xattrs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-channel-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"; CENTER_DATA_DIR="$work/center"; mkdir -p "$CENTER_DATA_DIR"
database_count() { printf '%s\n' -1; }
state_file_count() { printf '1\n'; }
state_byte_count() { printf '64\n'; }
${portableStat}
printf '%s\n' '{"kid":"U:wearer/center/ephemeral","key":"BwcHBwcHBwcHBwcHBwcHBw=="}' >"$CENTER_DATA_DIR/channel-key.json"
chmod 0600 "$CENTER_DATA_DIR/channel-key.json"
write_backup_invariants "$work/invariants.tsv" ignored
tar -czpf "$work/center.tar.gz" -C "$CENTER_DATA_DIR" .
archive_inventory "$work/center.tar.gz" "$work/center.inventory.json"
validate_center_channel_backup_contract "$work/invariants.tsv" "$work/center.inventory.json" "$work/center.tar.gz"
cp "$work/invariants.tsv" "$work/drift.tsv"
python3 - "$work/drift.tsv" <<'PY'
import pathlib,sys
path=pathlib.Path(sys.argv[1]); body=path.read_text(); path.write_text(body.replace("center.channel_key.mode\t600","center.channel_key.mode\t640"))
PY
! (validate_center_channel_backup_contract "$work/drift.tsv" "$work/center.inventory.json" "$work/center.tar.gz") >/dev/null 2>&1
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("BACKUP_MANIFEST freezes artifact and embedded contract schemas", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-backup-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"; backup="$work/backup"; source_dir="$work/source"; CENTER_DATA_DIR="$source_dir"
mkdir -p "$backup" "$source_dir"; chmod 0700 "$backup" "$source_dir"
database_count() { printf '%s\n' -1; }
state_file_count() { printf '0\n'; }
state_byte_count() { printf '0\n'; }
${portableStat}
write_backup_invariants "$backup/invariants.tsv" ignored
tar -czpf "$work/empty.tar.gz" -C "$source_dir" .
archive_inventory "$work/empty.tar.gz" "$work/empty.inventory.json"
for stem in cosmos-state center-data prometheus-data grafana-data postgres-data; do
  cp "$work/empty.tar.gz" "$backup/$stem.tar.gz"
  cp "$work/empty.inventory.json" "$backup/$stem.inventory.json"
done
cp "$work/empty.tar.gz" "$backup/protected.tar.gz"
cp "$work/empty.inventory.json" "$backup/protected-inventory.json"
printf 'backup-fixture-0001\n' >"$backup/BACKUP_ID"
printf '2026-08-09T00:00:00Z\n' >"$backup/CREATED_AT"
while IFS= read -r artifact; do
  [[ -n "$artifact" ]] || continue
  parent="$(dirname -- "$artifact")"
  [[ "$parent" == . ]] || mkdir -p "$backup/$parent"
  [[ -e "$backup/$artifact" ]] || printf 'fixture\n' >"$backup/$artifact"
done < <(backup_required_artifacts)
find "$backup" -type d -exec chmod 700 {} +
find "$backup" -type f -exec chmod 600 {} +
write_backup_artifact_manifest "$backup" backup-fixture-0001
verify_backup_artifact_manifest "$backup"
python3 - "$backup/BACKUP_MANIFEST.json" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8"))
assert body["schemaVersion"]==1 and body["kind"]=="dk.andersmadsen.ai-pin-revival.backup"
assert body["contracts"]["archiveInventory"]["rootPath"]=="."
assert body["contracts"]["channelKey"]["keyBytes"]==16
assert any(item["path"]=="." and item["type"]=="directory" for item in body["artifacts"])
PY
cp "$backup/BACKUP_MANIFEST.json" "$work/manifest.good"
python3 - "$backup/BACKUP_MANIFEST.json" <<'PY'
import json,sys
path=sys.argv[1]; body=json.load(open(path,encoding="utf-8")); body["schemaVersion"]=2
open(path,"w",encoding="utf-8").write(json.dumps(body,separators=(",",":"))+"\n")
PY
! (verify_backup_artifact_manifest "$backup") >/dev/null 2>&1
cp "$work/manifest.good" "$backup/BACKUP_MANIFEST.json"
verify_backup_artifact_manifest "$backup"
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("inherited lock proof rejects closed and unrelated descriptor 9", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-backup-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
work="$2"; LOCK_FILE="$work/deploy.lock"; : >"$LOCK_FILE"; : >"$work/other.lock"
! (exec 9>&-; assert_inherited_deploy_lock) >/dev/null 2>&1
! (exec 9>"$work/other.lock"; assert_inherited_deploy_lock) >/dev/null 2>&1
exec 9>"$LOCK_FILE"
assert_inherited_deploy_lock
assert_inherited_deploy_lock
`;
  const result = bash(script, [directory]);
  assert.equal(result.status, 0, result.stderr);
});

/*
 * The irreplaceable key material: the functions, AND the four places they are
 * called from.
 *
 * The attestation and DeviceUser CA private keys cannot be regenerated from
 * anything once the disk holding them is gone — the attestation root is pinned
 * inside the APKs already installed on the Pin — so a backup that lacks them is
 * worse than no backup, because it is the thing an operator reaches for after
 * losing the disk. Listing their DIRECTORIES in required_protected_paths proves
 * the directories exist, not that the keys are inside the archive: an empty or
 * partially readable root archives cleanly and passes every inventory
 * comparison downstream, because those comparisons compare the archive with
 * itself.
 *
 * assert_key_material_captured and verify_fetched_backup close that. Nothing
 * covered either: the entire acceptance suite had zero mentions of key material
 * or --fetch, so deleting a CALL (not the function) at any of the four sites
 * left every test green. The functions are sound and the call sites were one
 * careless edit from the pre-round state, which is the whole failure mode this
 * project has now hit three separate times.
 *
 * Below: both functions exercised against fabricated archives through every
 * refusal they can make, and then the call sites pinned line-anchored with the
 * ordering that makes each one load-bearing.
 */

const remoteBackupPath = path.join(root, "platform/deploy/vps/remote/backup.sh");
const localBackupPath = path.join(root, "platform/deploy/vps/backup.sh");

/*
 * macOS bsdtar has no GNU `--xattrs-include` filter, so the stub removes only
 * that platform-specific option and passes everything else through. sudo itself
 * is not needed: the fixture roots are inside the test's own temporary
 * directory, so the production `sudo -n` prefix is the only thing standing
 * between this and running unprivileged.
 */
const portableSudo = String.raw`
sudo() {
  [[ "$1" != -n ]] || shift
  if [[ "$1" == tar ]]; then
    shift
    local arguments=() argument
    for argument in "$@"; do
      [[ "$argument" == --xattrs-include=* ]] || arguments+=("$argument")
    done
    COPYFILE_DISABLE=1 command tar "${"$"}{arguments[@]}"
  else
    command "$@"
  fi
}
`;

/*
 * Assert that a command refuses AND that it says which of the four roles and
 * which failure. A bare non-zero exit is not enough here: every one of these
 * refusals happens at backup time, hours or months before anyone reads it, and
 * "backup failed" without the role is not actionable.
 */
const refuseHelper = String.raw`
refuse() {
  local expected="$1"; shift
  local output
  if output="$("$@" 2>&1)"; then
    printf 'expected a refusal naming "%s" but the call succeeded\n' "$expected" >&2
    return 1
  fi
  case "$output" in
    *"$expected"*) return 0 ;;
    *) printf 'refusal did not name "%s"; it said: %s\n' "$expected" "$output" >&2; return 1 ;;
  esac
}
`;

test("assert_key_material_captured refuses every way a backup can lack a CA private key", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-key-material-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
backup="$2"; work="$3"
# The production producer, sourced without backup.sh's device/VPS orchestration.
eval "$(sed -n '/^archive_selected_paths() {/,/^}/p' "$backup")"
${portableSudo}
${refuseHelper}

attest="$work/live/attest"; duc="$work/live/duc"
mkdir -p "$attest" "$duc"
write_live() {
  printf 'attestation ca private key\n' >"$attest/ca.key"
  printf 'attestation ca certificate\n' >"$attest/ca.crt"
  printf 'device-user ca private key\n' >"$duc/duc-ca.key"
  printf 'device-user ca certificate\n' >"$duc/duc-ca.crt"
}
write_live
# key_material_paths is the single source of the four member names, so the
# fixture cannot drift from what the assertion actually looks for.
key_material_paths "$attest" "$duc" | cut -f2 >"$work/protected.paths"
archive_selected_paths / "$work/protected.paths" "$work/protected.tar.gz" 2>/dev/null
archive_inventory "$work/protected.tar.gz" "$work/inventory.json"

# A complete capture passes, twice — the assertion must be re-runnable, because
# the restore side calls it a second time over the rebuilt archive.
assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "$attest" "$duc"
assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "$attest" "$duc"

# 1. The live key is gone from the host. Everything downstream still succeeds:
#    the archive is intact and compares equal with itself.
mv "$attest/ca.key" "$work/stashed-ca.key"
refuse "irreplaceable key material is missing on the host" \
  assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "$attest" "$duc"
mv "$work/stashed-ca.key" "$attest/ca.key"

# 2. The live key is present but empty — an interrupted rotation. Without the
#    explicit empty-digest check this hashes to the empty-input digest on both
#    sides of a naive comparison and passes having measured nothing.
: >"$duc/duc-ca.key"
refuse "irreplaceable key material is empty or undigestible" \
  assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "$attest" "$duc"
write_live

# 3. The live key was rotated after the archive was written, so the backup holds
#    a key the device no longer authenticates against.
printf 'rotated attestation ca private key\n' >"$attest/ca.key"
refuse "archived key material differs from the live key" \
  assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "$attest" "$duc"
write_live

# 4. The archive was produced from a path list that no longer names the key —
#    exactly what a partially readable protected root produces.
grep -v '/ca\.key$' "$work/protected.paths" >"$work/partial.paths"
archive_selected_paths / "$work/partial.paths" "$work/partial.tar.gz" 2>/dev/null
archive_inventory "$work/partial.tar.gz" "$work/partial.json"
refuse "irreplaceable key material is absent from the archive inventory" \
  assert_key_material_captured "$work/partial.json" "$work/partial.tar.gz" "$attest" "$duc"

# 5. The inventory AGREES with the live key and the archive does not. This is
#    the case the inventory comparison alone cannot see, and the only reason it
#    fails is that the member bytes are re-hashed out of the tarball: an
#    inventory-only check confirms a copy against its own description.
printf 'rotated attestation ca private key\n' >"$attest/ca.key"
python3 - "$work/inventory.json" "$work/doctored.json" "$attest/ca.key" <<'PY'
import hashlib,json,sys
source,target,live=sys.argv[1:]
digest=hashlib.sha256(open(live,"rb").read()).hexdigest()
items=json.load(open(source,encoding="utf-8"))
for item in items:
    if item["path"].removeprefix("./").removeprefix("/").endswith("/ca.key"):
        item["sha256"]=digest
json.dump(items,open(target,"w",encoding="utf-8"))
PY
refuse "archived key material bytes differ from the live key" \
  assert_key_material_captured "$work/doctored.json" "$work/protected.tar.gz" "$attest" "$duc"
write_live

# 6. An inventory that describes the key as a zero-length member. The archive is
#    fine; the description is the lie, and it must not be believed either way.
python3 - "$work/inventory.json" "$work/empty-member.json" <<'PY'
import json,sys
source,target=sys.argv[1:]
items=json.load(open(source,encoding="utf-8"))
for item in items:
    if item["path"].removeprefix("./").removeprefix("/").endswith("/duc-ca.key"):
        item["size"]=0
json.dump(items,open(target,"w",encoding="utf-8"))
PY
refuse "archived key material is empty" \
  assert_key_material_captured "$work/empty-member.json" "$work/protected.tar.gz" "$attest" "$duc"

# 7. Missing inputs are refused before anything is measured, so a typo'd path
#    cannot read as "nothing to check".
refuse "key material inventory is missing or unsafe" \
  assert_key_material_captured "$work/absent.json" "$work/protected.tar.gz" "$attest" "$duc"
refuse "key material archive is missing or unsafe" \
  assert_key_material_captured "$work/inventory.json" "$work/absent.tar.gz" "$attest" "$duc"
refuse "key material roots are unavailable" \
  assert_key_material_captured "$work/inventory.json" "$work/protected.tar.gz" "" "$duc"
`;
  const result = bash(script, [remoteBackupPath, directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("verify_fetched_backup re-proves the off-host bundle from the bytes that arrived", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-fetched-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
source "$1"
backup="$2"; local_backup="$3"; work="$4"
eval "$(sed -n '/^archive_selected_paths() {/,/^}/p' "$backup")"
eval "$(sed -n '/^verify_fetched_backup() {/,/^}/p' "$local_backup")"
# lib/local.sh's two helpers, which the extracted function calls.
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need_local() { command -v "$1" >/dev/null 2>&1 || die "required local command is unavailable: $1"; }
${portableSudo}
${refuseHelper}

attest="$work/live/attest"; duc="$work/live/duc"; pristine="$work/pristine"
mkdir -p "$attest" "$duc" "$pristine"
printf 'attestation ca private key\n' >"$attest/ca.key"
printf 'attestation ca certificate\n' >"$attest/ca.crt"
printf 'device-user ca private key\n' >"$duc/duc-ca.key"
printf 'device-user ca certificate\n' >"$duc/duc-ca.crt"
key_material_paths "$attest" "$duc" | cut -f2 >"$work/protected.paths"
archive_selected_paths / "$work/protected.paths" "$pristine/protected.tar.gz" 2>/dev/null
archive_inventory "$pristine/protected.tar.gz" "$pristine/protected-inventory.json"
printf 'backup-fixture-0001\n' >"$pristine/BACKUP_ID"
# The member names follow the host's recorded roots rather than a constant, so
# the fixture records the roots the archive was actually built from.
printf 'attestation\t%s\ndevice-user\t%s\n' "$attest" "$duc" >"$pristine/active-security-roots.tsv"

resum() {
  local target="$1" file
  ( cd "$target" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort \
    | while IFS= read -r file; do printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$file"; done >SHA256SUMS )
}
reset() { rm -rf -- "$work/fetched"; cp -R "$pristine" "$work/fetched"; }
resum "$pristine"

reset
verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/key-material.tsv"
# The evidence file is what write_recovery_index carries into RECOVERY.json, so
# a "verified" run that produced no rows would leave a bundle whose index claims
# four keys it never saw.
[[ "$(wc -l <"$work/key-material.tsv" | tr -d '[:space:]')" == 4 ]] \
  || { echo "key material evidence does not carry four roles" >&2; exit 1; }
grep -q $'^attestation-ca-key\t' "$work/key-material.tsv"
grep -q $'^device-user-ca-key\t' "$work/key-material.tsv"

# 1. The archive transferred intact and simply does not contain a key. Every
#    digest in SHA256SUMS still matches, which is the whole point: a manifest of
#    the files that arrived says nothing about what is inside them.
reset
grep -v '/duc-ca\.key$' "$work/protected.paths" >"$work/partial.paths"
rm -f -- "$work/fetched/protected.tar.gz"
archive_selected_paths / "$work/partial.paths" "$work/fetched/protected.tar.gz" 2>/dev/null
archive_inventory "$work/fetched/protected.tar.gz" "$work/fetched/protected-inventory.json"
resum "$work/fetched"
refuse "irreplaceable key material is absent from the fetched backup" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"

# 2. The inventory describes the key the host captured and the archive carries
#    different bytes. Only re-hashing the member out of the tarball catches it.
reset
printf 'substituted attestation ca private key\n' >"$attest/ca.key"
rm -f -- "$work/fetched/protected.tar.gz"
archive_selected_paths / "$work/protected.paths" "$work/fetched/protected.tar.gz" 2>/dev/null
resum "$work/fetched"
refuse "key material bytes differ from the inventory" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"
printf 'attestation ca private key\n' >"$attest/ca.key"

# 3. A bundle that is internally consistent but is a different backup than the
#    one asked for — the shape a retried fetch under a reused directory takes.
reset
printf 'backup-fixture-0002\n' >"$work/fetched/BACKUP_ID"
resum "$work/fetched"
refuse "fetched backup identifies itself as a different backup" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"

# 4. Without the recorded root the member names cannot be derived at all, and a
#    check that cannot name what it is looking for must not pass.
reset
grep -v '^device-user' "$work/fetched/active-security-roots.tsv" >"$work/roots.tmp"
mv "$work/roots.tmp" "$work/fetched/active-security-roots.tsv"
resum "$work/fetched"
refuse "fetched backup does not record its device-user root" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"

# 5. A truncated transfer: content that no longer matches the manifest.
reset
printf 'truncated\n' >>"$work/fetched/BACKUP_ID"
refuse "fetched backup content differs from SHA256SUMS" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"

# 6. A file nothing vouches for, and a symlink that could point anywhere on the
#    operator's machine.
reset
printf 'unvouched\n' >"$work/fetched/stowaway.txt"
refuse "fetched backup does not match SHA256SUMS" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"
reset
ln -s /etc/passwd "$work/fetched/passwd"
refuse "fetched backup contains a symlink" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"

# 7. No SHA256SUMS at all is a refusal, not an empty comparison.
reset
rm -f -- "$work/fetched/SHA256SUMS"
refuse "fetched backup has no SHA256SUMS" \
  verify_fetched_backup "$work/fetched" backup-fixture-0001 "$work/evidence.tsv"
`;
  const result = bash(script, [remoteBackupPath, localBackupPath, directory]);
  assert.equal(result.status, 0, result.stderr);
});

test("every key-material assertion is still WIRED, on both the backup and the restore side", async () => {
  /*
   * The functions above are sound. This is the half that was one deletion from
   * gone: the CALLS.
   *
   * Deleting `assert_key_material_captured …` from remote/backup.sh, or
   * `verify_fetched_backup` / `capture_operator_key_material` from vps/backup.sh,
   * left the whole 201-test suite green — every test above passes just as well
   * against a backup that never calls them. So each site is pinned line-anchored
   * (`^…$` with `m`), counted, and placed: a call that survives in the file but
   * has moved after the point where the backup declares itself complete is not
   * a gate, it is a comment.
   */
  const remoteBackup = await readFile(remoteBackupPath, "utf8");
  const localBackup = await readFile(localBackupPath, "utf8");

  // --- The backup side: the protected archive, as it is written. -----------
  assert.match(
    remoteBackup,
    /^assert_key_material_captured "\$destination\/protected-inventory\.json" \\$/m,
    "the protected snapshot must assert its key material before anything downstream trusts it",
  );
  assert.match(
    remoteBackup,
    /^  "\$destination\/protected\.tar\.gz" "\$active_attest_dir" "\$active_duc_dir"$/m,
    "the assertion must be handed the archive and both live roots, not the inventory alone",
  );

  // --- The restore side: the archive rebuilt from an extracted tree. -------
  assert.match(
    remoteBackup,
    /^assert_key_material_captured "\$destination\/protected-restored\.inventory\.json" \\$/m,
    "the restore rehearsal must re-assert the key material it rebuilt",
  );
  assert.match(
    remoteBackup,
    /^  "\$destination\/protected-restored\.tar\.gz" "\$active_attest_dir" "\$active_duc_dir"$/m,
  );

  // Exactly two, so deleting one and leaving the other cannot satisfy the pair
  // of matches above by accident.
  assert.equal(
    [...remoteBackup.matchAll(/^assert_key_material_captured /gm)].length,
    2,
    "remote/backup.sh must assert key material on the backup side AND on the restore side",
  );

  // Placement. The backup-side call has to sit after the inventory it reads and
  // before BACKUP_ID/CREATED_AT, which are what mark the directory as a usable
  // backup; the restore-side call after the inventory comparison it strengthens
  // and before the verification scaffolding is torn down.
  const written = at(remoteBackup, 'archive_inventory "$destination/protected.tar.gz" "$destination/protected-inventory.json"');
  const asserted = at(remoteBackup, 'assert_key_material_captured "$destination/protected-inventory.json"');
  const declared = at(remoteBackup, `printf '%s\\n' "$backup_id" >"$destination/BACKUP_ID"`);
  assert.ok(written < asserted, "the key-material assertion must read the inventory the backup just wrote");
  assert.ok(
    asserted < declared,
    "a backup must not be declared complete before its irreplaceable key material is proven present",
  );
  const compared = at(remoteBackup, 'compare_archive_inventories "$destination/protected-inventory.json" \\');
  const reasserted = at(remoteBackup, 'assert_key_material_captured "$destination/protected-restored.inventory.json"');
  // The teardown CALL, not the function definition or the recovery path's use of
  // it: `cleanup_verify_strict` appears three times in this file and the first
  // is its own `() {` line, which sits far above everything here.
  const cleaned = at(remoteBackup, 'cleanup_verify_strict || fail "verified backup left temporary Docker or filesystem objects"');
  assert.ok(compared < reasserted, "the restore rehearsal must compare inventories before re-hashing the keys");
  assert.ok(reasserted < cleaned, "the rebuilt archive must be proven before it is deleted");

  // --- The operator side: `./revival backup --fetch`. ----------------------
  assert.match(
    localBackup,
    /^  verify_fetched_backup "\$staging\/\$id" "\$id" "\$evidence"$/m,
    "a fetched backup must be re-verified here, from the bytes that actually arrived",
  );
  assert.match(
    localBackup,
    /^  capture_operator_key_material "\$operator"$/m,
    "the bundle must capture the Pin signing keystores, which are in no backup at all",
  );
  assert.equal([...localBackup.matchAll(/^  verify_fetched_backup /gm)].length, 1);
  assert.equal([...localBackup.matchAll(/^  capture_operator_key_material /gm)].length, 1);

  // Verification must happen while the pull is still in the staging directory:
  // once `mv` has published it as the host half, an operator has a directory
  // that looks like a completed backup.
  const verified = at(localBackup, 'verify_fetched_backup "$staging/$id" "$id" "$evidence"');
  const published = at(localBackup, 'mv "$staging/$id" "$host"');
  assert.ok(verified < published, "a fetched backup must be verified before it is published as the host half");
  // And RECOVERY.json is written last and only on success, so its presence is
  // the signal that the bundle is a complete recovery set.
  const captured = at(localBackup, 'capture_operator_key_material "$operator"');
  const indexed = at(localBackup, 'write_recovery_index "$bundle" "$id" "$key_material"');
  assert.ok(published < captured, "the operator half is captured after the host half is durable");
  assert.ok(captured < indexed, "the recovery index must not claim an operator half that was never captured");
});

test("every operator runbook publishes --fetch as a runnable command", async () => {
  /*
   * `--fetch` is the ONLY thing that puts the irreplaceable key material on a
   * machine other than the one it protects: the two CA private keys and the Pin
   * signing keystores. Every assertion above proves the command captures and
   * verifies those bytes correctly; none of them proves an operator is ever told
   * to run it. That gap is how this finding started — the command existed, was
   * correct, and was absent from the Production block an operator actually
   * works from, so it was never run and the "off-host copy" was a fiction.
   *
   * The rule is about RUNNABLE text, matching the runbook rule in
   * authority-cutover.test.mjs: a fenced block is what someone copies, and
   * prose describing the flag is not a command anyone executes. Losing the
   * fenced line while keeping a paragraph about it is exactly the state this
   * pins against, so prose alone must not satisfy it.
   */
  for (const name of ["docs/operations.md", "docs/recovery.md"]) {
    const body = await readFile(path.join(root, name), "utf8");
    const fenced = [...body.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gmu)].map((block) => block[1]);
    assert.ok(fenced.length > 0, `${name} has no fenced command blocks; the scan below would be vacuous`);
    assert.ok(
      // `(?![-\w])`, not `\b`: `--fetch` is a prefix of `--fetch-dir`, and `\b`
      // matches between `h` and `-`, so `\b` here was satisfied by a block that
      // offered ONLY `./revival backup --fetch-dir /Volumes/…`. That is a
      // different command — it demands a path the operator may not have — and it
      // would have let the plain form disappear from both runbooks silently.
      fenced.some((block) => /^\.\/revival backup --fetch(?![-\w])/mu.test(block)),
      `${name} does not offer \`./revival backup --fetch\` in a copyable command block`,
    );
  }

  // README.md is prose by design — it is the orientation page, not a runbook —
  // so there the requirement is only that the command is named, because that is
  // the pointer a first-time operator follows into the runbooks above.
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(
    readme,
    /`\.\/revival backup --fetch`/u,
    "README.md must name the command that creates the only off-host copy of the key material",
  );

  /*
   * And the other half of the same rule: the flag those three documents publish
   * has to be one a script actually parses.
   *
   * This is not hypothetical here. `--confirm-database-restore` was documented on
   * three surfaces and implemented in none, so the one command the runbook named
   * as the safe path answered a bare `usage:` at the moment an operator reached
   * for it (authority-cutover.test.mjs pins that refusal). A docs-only assertion
   * above cannot tell the two states apart: deleting the `--fetch` case arm from
   * the wrapper leaves every runbook assertion above green and turns the command
   * this whole file exists to protect into a silently ignored argument that takes
   * a server-side backup and pulls nothing.
   *
   * Line-anchored on the case arms rather than the flag name, because the usage
   * string a few lines above still spells `--fetch` after the parser has lost it.
   */
  const wrapper = await readFile(localBackupPath, "utf8");
  assert.match(
    wrapper,
    /^    --fetch\) fetch=1; shift ;;$/mu,
    "`--fetch` must still be PARSED by platform/deploy/vps/backup.sh, not merely advertised",
  );
  assert.match(
    wrapper,
    /^    --fetch-dir\) \(\(\$# >= 2\)\) \|\| usage; fetch_dir="\$2"; fetch=1; shift 2 ;;$/mu,
    "`--fetch-dir` must still be parsed, and must imply --fetch — a destination with no fetch is a no-op",
  );
  // The CLI is the surface the runbooks tell the operator to type, so it has to
  // keep naming the flag it forwards.
  const cliDir = path.join(root, "platform", "cli");
  const cli = [
    await readFile(path.join(root, "revival"), "utf8"),
    ...(await Promise.all((await readdir(cliDir)).filter((name) => name.endsWith(".js")).sort()
      .map((name) => readFile(path.join(cliDir, name), "utf8")))),
  ].join("\n");
  assert.match(cli, /--fetch \[--fetch-dir DIR\]/u, "`./revival help` must still name --fetch");
});
