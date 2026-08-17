import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staging = path.join(root, "platform/deploy/vps/remote/staging-smoke.sh");
const common = path.join(root, "platform/deploy/vps/remote/common.sh");

function bash(script, args = [], options = {}) {
  return spawnSync("bash", ["-c", script, "fixture", ...args], {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function makeBackup(parent, { channel = true, id = `backup-${Date.now()}-${Math.random().toString(16).slice(2, 10)}` } = {}) {
  const backup = path.join(parent, id);
  const work = path.join(parent, `${id}-source`);
  const center = path.join(work, "center");
  const empty = path.join(work, "empty");
  const protectedSource = path.join(work, "protected");
  const script = String.raw`
source "$1"
backup="$2"; work="$3"; center="$4"; empty="$5"; protected_source="$6"; id="$7"; channel="$8"
export COPYFILE_DISABLE=1
mkdir -p "$backup" "$center" "$empty" "$protected_source"; chmod 700 "$backup" "$center" "$empty" "$protected_source"
CENTER_DATA_DIR="$center"
database_count() { printf '%s\n' -1; }
state_file_count() { printf '0\n'; }
state_byte_count() { printf '0\n'; }
${portableStat}
if [[ "$channel" == 1 ]]; then
  printf '%s\n' '{"kid":"U:wearer/center/ephemeral","key":"BwcHBwcHBwcHBwcHBwcHBw=="}' >"$center/channel-key.json"
  chmod 0600 "$center/channel-key.json"
fi
write_backup_invariants "$backup/invariants.tsv" ignored
for stem in cosmos-state center-data prometheus-data grafana-data postgres-data; do
  source="$empty"; [[ "$stem" == center-data ]] && source="$center"
  tar -czpf "$backup/$stem.tar.gz" -C "$source" .
  archive_inventory "$backup/$stem.tar.gz" "$backup/$stem.inventory.json"
done

attest=/home/anders/ai-pin-revival/private/attest
duc=/home/anders/ai-pin-revival/private/duc
mkdir -p \
  "$protected_source$attest" "$protected_source$duc" \
  "$protected_source/etc/nginx/sites-available" "$protected_source/etc/nginx/sites-enabled" \
  "$protected_source/etc/systemd/system" "$protected_source/etc/penumbra" \
  "$protected_source/var/lib/penumbra-center"
printf 'fixture attest cert\n' >"$protected_source$attest/ca.crt"
printf 'fixture attest key\n' >"$protected_source$attest/ca.key"
printf 'fixture duc cert\n' >"$protected_source$duc/duc-ca.crt"
printf 'fixture duc key\n' >"$protected_source$duc/duc-ca.key"
printf 'events {}\n' >"$protected_source/etc/nginx/nginx.conf"
printf '[Service]\n' >"$protected_source/etc/systemd/system/penumbra-center-bridge.service"
printf 'bridge\n' >"$protected_source/etc/penumbra/bridge.env"
printf 'state\n' >"$protected_source/var/lib/penumbra-center/state"
find "$protected_source" -type d -exec chmod 700 {} +
find "$protected_source" -type f -exec chmod 600 {} +
tar -czpf "$backup/protected.tar.gz" -C "$protected_source" .
archive_inventory "$backup/protected.tar.gz" "$backup/protected-inventory.json"
printf 'attestation\t%s\ndevice-user\t%s\n' "$attest" "$duc" >"$backup/active-security-roots.tsv"
python3 - "$backup/protected-presence.tsv" "$backup/protected.paths" "$attest" "$duc" <<'PY'
import sys
presence_path,paths_path,attest,duc=sys.argv[1:]
required={attest,duc,"/etc/nginx/nginx.conf","/etc/nginx/sites-available","/etc/nginx/sites-enabled","/etc/systemd/system/penumbra-center-bridge.service","/etc/penumbra","/var/lib/penumbra-center"}
optional={"/home/anders/humane-carry-clone/.env","/home/anders/carry-backends.env","/home/anders/carry-center.env","/home/anders/carry-edge","/home/anders/keycloak-themes/humane","/home/anders/ai-pin-revival/private","/etc/nginx/conf.d","/etc/cloudflared","/home/anders/.cloudflared"}
present=required|{"/home/anders/ai-pin-revival/private"}
with open(presence_path,"w",encoding="utf-8") as output:
    for value in sorted(required): output.write(f"required\tpresent\t{value}\n")
    for value in sorted(optional): output.write(f"optional\t{'present' if value in present else 'absent'}\t{value}\n")
selected=[]
for value in sorted(present,key=lambda item:(item.count('/'),item)):
    if any(value==parent or value.startswith(parent+'/') for parent in selected): continue
    selected.append(value)
with open(paths_path,"w",encoding="utf-8") as output:
    for value in selected: output.write(value.removeprefix('/')+'\n')
PY

printf '%s\n' "$id" >"$backup/BACKUP_ID"
printf '2026-08-09T00:00:00Z\n' >"$backup/CREATED_AT"
while IFS= read -r artifact; do
  [[ -n "$artifact" ]] || continue
  parent="$(dirname -- "$artifact")"; [[ "$parent" == . ]] || mkdir -p "$backup/$parent"
  [[ -e "$backup/$artifact" ]] || printf 'fixture\n' >"$backup/$artifact"
done < <(backup_required_artifacts)
for archive in postgres-globals.sql.gz cosmos.sql.gz keycloak.sql.gz; do
  printf 'fixture sql\n' | gzip -c >"$backup/$archive"
done
find "$backup" -type d -exec chmod 700 {} +
find "$backup" -type f -exec chmod 600 {} +
write_backup_artifact_manifest "$backup" "$id"
python3 - "$backup" <<'PY'
import hashlib,os,sys
root=sys.argv[1]; rows=[]
for directory,dirs,files in os.walk(root):
    dirs.sort(); files.sort()
    for name in files:
        relative=os.path.relpath(os.path.join(directory,name),root)
        if relative=="SHA256SUMS": continue
        body=open(os.path.join(root,relative),"rb").read()
        rows.append((relative,hashlib.sha256(body).hexdigest()))
with open(os.path.join(root,"SHA256SUMS"),"w",encoding="utf-8") as output:
    for relative,digest in sorted(rows,key=lambda item:item[0].encode()): output.write(f"{digest}  {relative}\n")
PY
chmod 600 "$backup/SHA256SUMS"
`;
  const result = bash(script, [common, backup, work, center, empty, protectedSource, id, channel ? "1" : "0"]);
  assert.equal(result.status, 0, result.stderr);
  return { backup, center, id, protectedSource, work };
}

function validate(backup) {
  return bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
staging_validate_backup_contract "$2"
staging_validate_protected_contract "$2"
`, [staging, backup]);
}

function refreshEvidence(backup) {
  const script = String.raw`
import hashlib,json,os,stat,sys
root=sys.argv[1]; manifest_path=os.path.join(root,"BACKUP_MANIFEST.json")
document=json.load(open(manifest_path,encoding="utf-8"))
for item in document.get("artifacts",[]):
    path=root if item.get("path")=="." else os.path.join(root,item["path"])
    metadata=os.lstat(path)
    item["mode"]=f"{stat.S_IMODE(metadata.st_mode):04o}"; item["uid"]=metadata.st_uid; item["gid"]=metadata.st_gid
    if stat.S_ISREG(metadata.st_mode):
        body=open(path,"rb").read(); item["size"]=len(body); item["sha256"]=hashlib.sha256(body).hexdigest()
with open(manifest_path,"w",encoding="utf-8") as output:
    json.dump(document,output,sort_keys=True,separators=(",",":")); output.write("\n")
rows=[]
for directory,dirs,files in os.walk(root):
    dirs.sort(); files.sort()
    for name in files:
        relative=os.path.relpath(os.path.join(directory,name),root)
        if relative=="SHA256SUMS": continue
        body=open(os.path.join(root,relative),"rb").read(); rows.append((relative,hashlib.sha256(body).hexdigest()))
with open(os.path.join(root,"SHA256SUMS"),"w",encoding="utf-8") as output:
    for relative,digest in sorted(rows,key=lambda item:item[0].encode()): output.write(f"{digest}  {relative}\n")
`;
  const result = bash("python3 - \"$1\"", [backup], { input: script });
  assert.equal(result.status, 0, result.stderr);
}

function refreshChecksums(backup) {
  const script = String.raw`
import hashlib,os,sys
root=sys.argv[1]; rows=[]
for directory,dirs,files in os.walk(root):
    dirs.sort(); files.sort()
    for name in files:
        relative=os.path.relpath(os.path.join(directory,name),root)
        if relative=="SHA256SUMS": continue
        body=open(os.path.join(root,relative),"rb").read(); rows.append((relative,hashlib.sha256(body).hexdigest()))
with open(os.path.join(root,"SHA256SUMS"),"w",encoding="utf-8") as output:
    for relative,digest in sorted(rows,key=lambda item:item[0].encode()): output.write(f"{digest}  {relative}\n")
`;
  const result = bash("python3 - \"$1\"", [backup], { input: script });
  assert.equal(result.status, 0, result.stderr);
}

async function replaceChannel(fixture, body) {
  await writeFile(path.join(fixture.center, "channel-key.json"), body, { mode: 0o600 });
  const result = bash(String.raw`
source "$1"
backup="$2"; center="$3"
export COPYFILE_DISABLE=1
tar -czpf "$backup/center-data.tar.gz" -C "$center" .
archive_inventory "$backup/center-data.tar.gz" "$backup/center-data.inventory.json"
python3 - "$backup/invariants.tsv" "$backup/center-data.inventory.json" <<'PY'
import json,pathlib,sys
invariants=pathlib.Path(sys.argv[1]); item=next(item for item in json.load(open(sys.argv[2],encoding="utf-8")) if item["path"]=="channel-key.json")
rows=[]
for raw in invariants.read_text().splitlines():
    key,value=raw.split("\t",1)
    if key=="center.channel_key.sha256": value=item["sha256"]
    elif key=="center.channel_key.mode": value=item["mode"].removeprefix("0o")
    elif key=="center.channel_key.owner": value=f'{item["uid"]}:{item["gid"]}'
    rows.append(f"{key}\t{value}\n")
invariants.write_text("".join(rows))
PY
`, [common, fixture.backup, fixture.center]);
  assert.equal(result.status, 0, result.stderr);
  refreshEvidence(fixture.backup);
}

test("staging consumes valid present and absent BACKUP_MANIFEST contracts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-valid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const channel of [true, false]) {
    const fixture = await makeBackup(directory, { channel });
    const result = validate(fixture.backup);
    assert.equal(result.status, 0, result.stderr);
    if (!channel) {
      const roundtrip = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1 COPYFILE_DISABLE=1
source "$1"
mkdir -p "$3"
tar -xzpf "$2/center-data.tar.gz" -C "$3"
tar -czpf "$4" -C "$3" .
archive_inventory "$4" "$5"
compare_archive_inventories "$2/center-data.inventory.json" "$5"
`, [staging, fixture.backup, path.join(directory, "empty-center-restore"), path.join(directory, "empty-center.tar.gz"), path.join(directory, "empty-center.json")]);
      assert.equal(roundtrip.status, 0, roundtrip.stderr);
    }
  }
});

test("staging rejects missing, duplicate, unknown, and version-drift invariant fields", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-invariants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mutations = {
    missing: (body) => body.split("\n").filter((line) => !line.startsWith("state.bytes\t")).join("\n"),
    duplicate: (body) => `${body}state.bytes\t0\n`,
    unknown: (body) => `${body}state.objects\t0\n`,
    version: (body) => body.replace("contract.version\t1", "contract.version\t2"),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const fixture = await makeBackup(directory, { id: `backup-invariant-${name}` });
    const target = path.join(fixture.backup, "invariants.tsv");
    await writeFile(target, mutate(await readFile(target, "utf8")), { mode: 0o600 });
    refreshEvidence(fixture.backup);
    const result = validate(fixture.backup);
    assert.notEqual(result.status, 0, `${name} invariant mutation unexpectedly passed`);
  }
});

test("staging rejects unknown manifest fields, manifest version drift, and undeclared artifacts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["unknown", "version", "artifact", "duplicate-top", "duplicate-contract"]) {
    const fixture = await makeBackup(directory, { id: `backup-manifest-${name}` });
    if (name === "artifact") {
      await writeFile(path.join(fixture.backup, "undeclared.bin"), "no\n", { mode: 0o600 });
    } else if (name.startsWith("duplicate-")) {
      const manifestPath = path.join(fixture.backup, "BACKUP_MANIFEST.json");
      let body = await readFile(manifestPath, "utf8");
      if (name === "duplicate-top") {
        body = body.replace('"kind":"dk.andersmadsen.ai-pin-revival.backup"', '"kind":"shadow","kind":"dk.andersmadsen.ai-pin-revival.backup"');
      } else {
        body = body.replace('"contracts":{', '"contracts":{"archiveInventory":{"schemaVersion":999},');
      }
      await writeFile(manifestPath, body, { mode: 0o600 });
      refreshChecksums(fixture.backup);
      const result = validate(fixture.backup);
      assert.notEqual(result.status, 0, `${name} manifest mutation unexpectedly passed`);
      continue;
    } else {
      const manifestPath = path.join(fixture.backup, "BACKUP_MANIFEST.json");
      const document = JSON.parse(await readFile(manifestPath, "utf8"));
      if (name === "unknown") document.comment = "not in schema";
      else document.schemaVersion = 2;
      await writeFile(manifestPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    }
    refreshEvidence(fixture.backup);
    const result = validate(fixture.backup);
    assert.notEqual(result.status, 0, `${name} manifest mutation unexpectedly passed`);
  }
});

test("staging rejects malformed channel JSON and every non-16-byte decoded key", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-channel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = new Map([
    ["malformed", Buffer.from('{"kid":"wearer","key":')],
    ["duplicate", Buffer.from('{"kid":"one","kid":"two","key":"BwcHBwcHBwcHBwcHBwcHBw=="}')],
    ...[0, 15, 17, 32].map((length) => [
      `length-${length}`,
      Buffer.from(JSON.stringify({ kid: "wearer", key: Buffer.alloc(length, 9).toString("base64") })),
    ]),
  ]);
  for (const [name, body] of cases) {
    const fixture = await makeBackup(directory, { id: `backup-channel-${name}` });
    await replaceChannel(fixture, body);
    const result = validate(fixture.backup);
    assert.notEqual(result.status, 0, `${name} channel mutation unexpectedly passed`);
  }
});

test("protected-root declarations are closed and bind both trust-root identities", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-protected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["missing", "duplicate", "unknown", "security-duplicate"]) {
    const fixture = await makeBackup(directory, { id: `backup-protected-${name}` });
    if (name === "security-duplicate") {
      const target = path.join(fixture.backup, "active-security-roots.tsv");
      await writeFile(target, `${await readFile(target, "utf8")}attestation\t/home/anders/carry-attest\n`, { mode: 0o600 });
    } else {
      const target = path.join(fixture.backup, "protected-presence.tsv");
      const body = await readFile(target, "utf8");
      const rows = body.trimEnd().split("\n");
      if (name === "missing") rows.pop();
      else if (name === "duplicate") rows.push(rows[0]);
      else rows.push("optional\tabsent\t/unknown/protected-root");
      await writeFile(target, `${rows.join("\n")}\n`, { mode: 0o600 });
    }
    refreshEvidence(fixture.backup);
    const result = validate(fixture.backup);
    assert.notEqual(result.status, 0, `${name} protected mutation unexpectedly passed`);
  }
});

test("projected security inventory detects content and root-metadata drift", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await makeBackup(directory, { id: "backup-security-identity" });
  for (const [label, relative] of [
    ["attest", "home/anders/ai-pin-revival/private/attest"],
    ["duc", "home/anders/ai-pin-revival/private/duc"],
  ]) {
    const projected = path.join(directory, `${label}-projected.json`);
    const actual = path.join(directory, `${label}-actual.json`);
    const drift = path.join(directory, `${label}-drift.json`);
    let result = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
export COPYFILE_DISABLE=1
staging_project_protected_root_inventory "$2/protected-inventory.json" \
  "/$7" "$3"
tar -czpf "$5" -C "$4/$7" .
archive_inventory "$5" "$6"
`, [staging, fixture.backup, projected, fixture.protectedSource, path.join(directory, `${label}-actual.tar.gz`), actual, relative]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(actual, "utf8")), JSON.parse(await readFile(projected, "utf8")));
    const body = JSON.parse(await readFile(actual, "utf8"));
    body.find((item) => item.path === ".").mode = "0o755";
    await writeFile(drift, JSON.stringify(body), { mode: 0o600 });
    result = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
compare_archive_inventories "$2" "$3"
`, [staging, projected, drift]);
    assert.notEqual(result.status, 0, `${label} root metadata drift unexpectedly passed`);
  }
  assert.equal(sha256(await readFile(path.join(fixture.protectedSource, "home/anders/ai-pin-revival/private/attest/ca.crt"))), sha256("fixture attest cert\n"));
});

test("runtime Center inventory changes only the declared disposable owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-staging-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const channel of [true, false]) {
    const fixture = await makeBackup(directory, { channel, id: `backup-owner-${channel ? "present" : "absent"}` });
    const output = path.join(directory, `runtime-${channel}.json`);
    const runtimeUid = 2312;
    const runtimeGid = 3412;
    const result = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
staging_write_runtime_center_inventory "$2/invariants.tsv" "$2/center-data.inventory.json" "$3" "$4" "$5"
`, [staging, fixture.backup, output, String(runtimeUid), String(runtimeGid)]);
    assert.equal(result.status, 0, result.stderr);
    const before = JSON.parse(await readFile(path.join(fixture.backup, "center-data.inventory.json"), "utf8"));
    const after = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(after.find((item) => item.path === "."), before.find((item) => item.path === "."));
    const beforeKey = before.find((item) => item.path === "channel-key.json");
    const afterKey = after.find((item) => item.path === "channel-key.json");
    if (channel) {
      assert.equal(afterKey.uid, runtimeUid);
      assert.equal(afterKey.gid, runtimeGid);
      assert.deepEqual({ ...afterKey, uid: beforeKey.uid, gid: beforeKey.gid }, beforeKey);
    } else {
      assert.deepEqual(after, before);
    }
  }
});

test("candidate Center runtime owner must be an explicit numeric non-root uid:gid", async () => {
  let result = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
staging_parse_runtime_owner "$2"
`, [staging, "2312:3412"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "2312\t3412");
  for (const invalid of ["", "root", "1000", "0:1001", "1000:0", "node:center"]) {
    result = bash(String.raw`
export REVIVAL_STAGING_CONTRACT_LIBRARY_ONLY=1
source "$1"
staging_parse_runtime_owner "$2"
`, [staging, invalid]);
    assert.notEqual(result.status, 0, `${invalid || "empty"} runtime owner unexpectedly passed`);
  }
  const source = await readFile(staging, "utf8");
  assert.match(source, /--user "\$center_runtime_uid:\$center_runtime_gid"/u);
});
