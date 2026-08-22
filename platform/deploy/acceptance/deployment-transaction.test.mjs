import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ordering over script source is asserted through guarded offsets only. A bare
// indexOf answers -1 for a token that is not in the file, and -1 is less than
// every real offset, so `indexOf(a) < indexOf(b)` PASSES when a was deleted.
// See source-offsets.mjs.
import { at, eventAt, lastAt } from "./source-offsets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = path.join(root, "platform/deploy/vps/remote");
const transaction = path.join(remote, "transaction.py");
const releaseA = "a".repeat(64);
const releaseB = "b".repeat(64);

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-transaction-")));
  await mkdir(path.join(directory, "releases", releaseA), { recursive: true });
  await mkdir(path.join(directory, "releases", releaseB), { recursive: true });
  await mkdir(path.join(directory, "deployments", "deploy-a"), { recursive: true });
  await mkdir(path.join(directory, "deployments", "deploy-b"), { recursive: true });
  await symlink(path.join(directory, "releases", releaseA), path.join(directory, "current"));
  await symlink(path.join(directory, "deployments", "deploy-a"), path.join(directory, "current-deployment"));
  return directory;
}

function runTransaction(arguments_, expected = 0) {
  const result = spawnSync("python3", [transaction, ...arguments_], { encoding: "utf8" });
  assert.equal(result.status, expected, `transaction exited ${result.status}: ${result.stderr}`);
}


/**
 * The common library is a loader plus cohesive lib/ files; every text-level
 * extraction reads them as one concatenation, the same order the loader
 * sources them.
 */
async function commonLibrarySource() {
  const remoteDir = remote;
  const libDir = path.join(remoteDir, "lib");
  const names = (await readdir(libDir)).filter((name) => name.endsWith(".sh")).sort();
  const parts = [await readFile(path.join(remoteDir, "common.sh"), "utf8")];
  for (const name of names) parts.push(await readFile(path.join(libDir, name), "utf8"));
  return parts.join("\n");
}

function bashFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing bash function ${name}`);
  const tail = source.slice(start);
  const end = tail.search(/^\}\n/mu);
  assert.ok(end >= 0, `unterminated bash function ${name}`);
  return tail.slice(0, end + 2);
}

async function target(link) {
  return path.resolve(path.dirname(link), await import("node:fs/promises").then(({ readlink }) => readlink(link)));
}

const publicationFailpoints = [
  "after-application-committed",
  "after-previous",
  "after-current",
  "after-current-deployment",
  "before-committed",
  "after-committed",
  "after-success",
];

test("canonical deployment publication converges after every pointer and marker failure", async (t) => {
  for (const failpoint of publicationFailpoints) {
    await t.test(failpoint, async () => {
      const directory = await fixture();
      const record = path.join(directory, "deployments", "deploy-b");
      await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
      await writeFile(path.join(record, "INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
      const base = [
        "--root", directory,
        "--record", record,
        "--namespace", "deploy",
        "--old-current", path.join(directory, "releases", releaseA),
        "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
        "--desired-current", path.join(directory, "releases", releaseB),
        "--desired-previous", path.join(directory, "releases", releaseA),
        "--desired-current-deployment", record,
      ];
      runTransaction([...base, "--failpoint", failpoint], 86);
      runTransaction(["--root", directory, "--record", record, "--reconcile"]);
      assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseB));
      assert.equal(await target(path.join(directory, "current-deployment")), record);
      assert.equal(await target(path.join(directory, "previous")), path.join(directory, "releases", releaseA));
      for (const marker of [
        "INGRESS_ACTIVATED",
        "APPLICATION_COMMITTED",
        "POINTER_TRANSACTION_PREPARED",
        "POINTER_TRANSACTION_COMMITTED",
        "SUCCEEDED",
      ]) assert.match(await readFile(path.join(record, marker), "utf8"), /\S/u);
    });
  }
});

test("ingress failure cannot publish current or SUCCEEDED", async () => {
  const directory = await fixture();
  const record = path.join(directory, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  const result = spawnSync("python3", [
    transaction,
    "--root", directory,
    "--record", record,
    "--namespace", "deploy",
    "--old-current", path.join(directory, "releases", releaseA),
    "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
    "--desired-current", path.join(directory, "releases", releaseB),
    "--desired-previous", path.join(directory, "releases", releaseA),
    "--desired-current-deployment", record,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseA));
  await assert.rejects(readFile(path.join(record, "SUCCEEDED")));
  assert.match(await readFile(path.join(record, "POINTER_TRANSACTION_PREPARED"), "utf8"), /prepared/u);
});

test("durable pointer intent exists before ingress acceptance and is replayable after it", async () => {
  const directory = await fixture();
  const record = path.join(directory, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  const base = [
    "--root", directory,
    "--record", record,
    "--namespace", "deploy",
    "--old-current", path.join(directory, "releases", releaseA),
    "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
    "--desired-current", path.join(directory, "releases", releaseB),
    "--desired-previous", path.join(directory, "releases", releaseA),
    "--desired-current-deployment", record,
  ];
  runTransaction([...base, "--prepare-only"]);
  assert.match(await readFile(path.join(record, "POINTER_TRANSACTION_PREPARED"), "utf8"), /prepared/u);
  assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseA));
  await assert.rejects(readFile(path.join(record, "SUCCEEDED")));
  await writeFile(path.join(record, "INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
  runTransaction(["--root", directory, "--record", record, "--reconcile"]);
  assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseB));
  assert.match(await readFile(path.join(record, "SUCCEEDED"), "utf8"), /accepted/u);
});

test("reconciliation rejects a mismatched or path-bearing journal namespace", async () => {
  for (const namespace of ["rollback", "../../escape"]) {
    const directory = await fixture();
    const record = path.join(directory, "deployments", "deploy-b");
    await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
    const base = [
      "--root", directory, "--record", record, "--namespace", "deploy",
      "--old-current", path.join(directory, "releases", releaseA),
      "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
      "--desired-current", path.join(directory, "releases", releaseB),
      "--desired-previous", path.join(directory, "releases", releaseA),
      "--desired-current-deployment", record, "--prepare-only",
    ];
    runTransaction(base);
    const journalPath = path.join(record, "POINTER_TRANSACTION.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.namespace = namespace;
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    const result = spawnSync("python3", [transaction, "--root", directory, "--record", record, "--namespace", "deploy", "--reconcile"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseA));
    await assert.rejects(readFile(path.join(record, "SUCCEEDED")));
  }
});

test("an aborted prepared transaction can never publish authority", async () => {
  const directory = await fixture();
  const record = path.join(directory, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  const base = [
    "--root", directory, "--record", record, "--namespace", "deploy",
    "--old-current", path.join(directory, "releases", releaseA),
    "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
    "--desired-current", path.join(directory, "releases", releaseB),
    "--desired-previous", path.join(directory, "releases", releaseA),
    "--desired-current-deployment", record, "--prepare-only",
  ];
  runTransaction(base);
  await writeFile(path.join(record, "POINTER_TRANSACTION_ABORTED"), "aborted\n", { mode: 0o600 });
  await writeFile(path.join(record, "INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
  const result = spawnSync("python3", [transaction, "--root", directory, "--record", record, "--namespace", "deploy", "--reconcile"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await target(path.join(directory, "current")), path.join(directory, "releases", releaseA));
  await assert.rejects(readFile(path.join(record, "SUCCEEDED")));
});

for (const kind of ["canonical", "legacy"]) {
  test(`${kind} rollback pointer publication is replayable`, async (t) => {
    for (const failpoint of publicationFailpoints) await t.test(failpoint, async () => {
      const directory = await fixture();
      const record = path.join(directory, "deployments", "deploy-a");
      await writeFile(path.join(record, "POINTER_TRANSACTION.json"), "{}\n", { mode: 0o600 });
      await writeFile(path.join(record, "ROLLBACK_INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
      const desiredCurrent = kind === "canonical" ? path.join(directory, "releases", releaseB) : "";
      const desiredDeployment = kind === "canonical" ? path.join(directory, "deployments", "deploy-b") : "";
      const base = [
        "--root", directory,
        "--record", record,
        "--namespace", "rollback",
        "--old-current", path.join(directory, "releases", releaseA),
        "--old-current-deployment", path.join(directory, "deployments", "deploy-a"),
        "--desired-current", desiredCurrent,
        "--desired-previous", path.join(directory, "releases", releaseA),
        "--desired-current-deployment", desiredDeployment,
      ];
      runTransaction([...base, "--failpoint", failpoint], 86);
      runTransaction(["--root", directory, "--record", record, "--namespace", "rollback", "--reconcile"]);
      if (kind === "canonical") {
        assert.equal(await target(path.join(directory, "current")), desiredCurrent);
        assert.equal(await target(path.join(directory, "current-deployment")), desiredDeployment);
      } else {
        await assert.rejects(target(path.join(directory, "current")));
        await assert.rejects(target(path.join(directory, "current-deployment")));
      }
      assert.match(await readFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_COMMITTED"), "utf8"), /committed/u);
    });
  });
}

test("ingress snapshot records and restores exact active and inactive services", async () => {
  const common = path.join(remote, "common.sh");
  const script = String.raw`
source "$1"
assert_managed_cloudflared_topology() { :; }
domain_cloudflared_assert_ready() { :; }
domain_cloudflared_verify_before() { :; }
domain_cloudflared_verify_desired() { :; }
nginx_state=1
bridge_state=1
cloudflared_system_state=1
cloudflared_user_state=1
service_active() {
  case "$1:$2" in
    system:nginx.service) printf '%s' "$nginx_state";;
    system:penumbra-center-bridge.service) printf '%s' "$bridge_state";;
    system:cloudflared-tunnel.service) printf '%s' "$cloudflared_system_state";;
    user:cloudflared-hermes.service) printf '%s' "$cloudflared_user_state";;
    *) printf '%s' 0;;
  esac
}
set_service_state() {
  local manager="$1" service="$2" state="$3"
  case "$manager:$service" in
    system:nginx.service) nginx_state=$state;;
    system:penumbra-center-bridge.service) bridge_state=$state;;
    system:cloudflared-tunnel.service) cloudflared_system_state=$state;;
    user:cloudflared-hermes.service) cloudflared_user_state=$state;;
  esac
}
cloudflared_unit_command_sha256() { printf '%s\n' "$(printf 'a%.0s' {1..64})"; }
cloudflared_unit_definition_sha256() { printf '%s\n' "$(printf 'b%.0s' {1..64})"; }
cloudflared_config_identity() { printf '600\t1000:1001\t%s\n' "$(printf 'c%.0s' {1..64})"; }
managed_systemctl() {
  local manager="$1"; shift
  if [[ "$manager" == system ]]; then systemctl "$@"; else systemctl --user "$@"; fi
}
managed_systemctl_mutate() {
  local manager="$1"; shift
  if [[ "$manager" == system ]]; then sudo -n systemctl "$@"; else systemctl --user "$@"; fi
}
systemctl() {
  local manager="system" verb service
  if [[ "$1" == --user ]]; then manager="user"; shift; fi
  verb="$1"; shift
  if [[ "$1" == --quiet ]]; then shift; fi
  case "$verb" in
    is-active)
      service="$1"
      [[ "$(service_active "$manager" "$service")" == "1" ]]
      ;;
    start)
      service="$1"
      set_service_state "$manager" "$service" 1
      ;;
    stop)
      service="$1"
      set_service_state "$manager" "$service" 0
      ;;
    *) return 1;;
  esac
}
nginx() { [[ "$1" == -t ]]; }
timeout() { return 0; }
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
record_ingress_services "$2"
grep -qx $'service\tsystem\tnginx.service\tactive\t-\t-\t-\t-\t-\t-' "$2"
grep -q $'^cloudflared\tsystem\tcloudflared-tunnel.service\tactive\t' "$2"
grep -q $'^cloudflared\tuser\tcloudflared-hermes.service\tactive\t' "$2"
grep -qx $'service\tsystem\tpenumbra-center-bridge.service\tactive\t-\t-\t-\t-\t-\t-' "$2"
record_path="$(mktemp -d)"
quiesce_ingress_services "$2" 0 "$record_path" recorded
assert_ingress_quiesced
restore_ingress_services "$2" "$record_path" before
assert_ingress_matches_recorded "$2"
  [[ "$(service_active system nginx.service):$(service_active user cloudflared-hermes.service):$(service_active system penumbra-center-bridge.service)" == 1:1:1 ]]
  `;
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-ingress-"));
  const evidence = path.join(directory, "ingress.tsv");
  const result = spawnSync("bash", ["-c", script, "fixture", common, evidence], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("ingress restore proves the Pin bridge before opening public services", async () => {
  const common = path.join(remote, "common.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-ingress-order-"));
  const evidence = path.join(directory, "ingress.tsv");
  const trace = path.join(directory, "trace");
  await writeFile(evidence, [
    "contract\t1\t-\t-\t-\t-\t-\t-\t-\t-",
    "service\tsystem\tnginx.service\tactive\t-\t-\t-\t-\t-\t-",
    "service\tsystem\tpenumbra-center-bridge.service\tactive\t-\t-\t-\t-\t-\t-",
    `cloudflared\tsystem\tcloudflared-tunnel.service\tactive\t${"a".repeat(64)}\t${"b".repeat(64)}\t/home/anders/.cloudflared/config.yml\t600\t1000:1001\t${"c".repeat(64)}`,
    `cloudflared\tuser\tcloudflared-hermes.service\tactive\t${"a".repeat(64)}\t${"b".repeat(64)}\t/home/anders/.cloudflared/config.yml\t600\t1000:1001\t${"c".repeat(64)}`,
  ].join("\n"));
  const script = String.raw`
source "$1"
trace="$3"
nginx_state=0
bridge_state=0
cloudflared_system_state=0
cloudflared_user_state=0
service_active() {
  case "$1:$2" in
    system:nginx.service) printf '%s' "$nginx_state";;
    system:penumbra-center-bridge.service) printf '%s' "$bridge_state";;
    system:cloudflared-tunnel.service) printf '%s' "$cloudflared_system_state";;
    user:cloudflared-hermes.service) printf '%s' "$cloudflared_user_state";;
    *) printf '%s' 0;;
  esac
}
set_service_state() {
  local manager="$1" service="$2" state="$3"
  case "$manager:$service" in
    system:nginx.service) nginx_state=$state;;
    system:penumbra-center-bridge.service) bridge_state=$state;;
    system:cloudflared-tunnel.service) cloudflared_system_state=$state;;
    user:cloudflared-hermes.service) cloudflared_user_state=$state;;
  esac
}
managed_systemctl() {
  local manager="$1"; shift
  if [[ "$manager" == system ]]; then systemctl "$@"; else systemctl --user "$@"; fi
}
managed_systemctl_mutate() {
  local manager="$1"; shift
  if [[ "$manager" == system ]]; then sudo -n systemctl "$@"; else systemctl --user "$@"; fi
}
assert_managed_cloudflared_topology() { :; }
cloudflared_unit_command_sha256() { printf '%s\n' "$(printf 'a%.0s' {1..64})"; }
cloudflared_unit_definition_sha256() { printf '%s\n' "$(printf 'b%.0s' {1..64})"; }
cloudflared_config_identity() { printf '600\t1000:1001\t%s\n' "$(printf 'c%.0s' {1..64})"; }
domain_cloudflared_assert_ready() { :; }
domain_cloudflared_verify_before() { :; }
domain_cloudflared_verify_desired() { :; }
systemctl() {
  local manager="system" verb service
  if [[ "$1" == --user ]]; then manager="user"; shift; fi
  verb="$1"; shift
  if [[ "$1" == --quiet ]]; then shift; fi
  case "$verb" in
    is-active)
      service="$1"
      [[ "$(service_active "$manager" "$service")" == "1" ]]
      ;;
    start)
      service="$1"
      set_service_state "$manager" "$service" 1
      printf '%s\n' "$service" >>"$trace"
      ;;
    stop)
      service="$1"
      set_service_state "$manager" "$service" 0
      ;;
  esac
}
nginx() { [[ "$1" == -t ]]; }
timeout() { printf 'bridge.listener\n' >>"$trace"; return 0; }
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
restore_ingress_services "$2" "$(mktemp -d)" before
[[ "$(paste -sd ' ' "$trace")" == 'penumbra-center-bridge.service bridge.listener nginx.service cloudflared-tunnel.service cloudflared-hermes.service' ]]
`;
  const result = spawnSync("bash", ["-c", script, "fixture", common, evidence, trace], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("mount-derived quiescence includes connectivity, excludes only exact Postgres, and rejects outsiders", async () => {
  const common = path.join(remote, "common.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-mounts-"));
  const mounts = path.join(directory, "mounts.json");
  await writeFile(mounts, JSON.stringify([
    { Id: "pgid", Name: "/postgres", Mounts: [{ Type: "volume", Name: "humane-carry-clone_carry-pgdata", Source: "/vol/pg", RW: true }] },
    { Id: "connid", Name: "/connectivity", Mounts: [{ Type: "volume", Name: "humane-carry-clone_carry-state", Source: "/vol/state", RW: true }] },
    { Id: "outsideid", Name: "/outside", Mounts: [{ Type: "bind", Name: "", Source: "/home/anders/carry-center-data/subdir", RW: true }] },
  ]));
  const script = String.raw`
source "$1"
fixture="$2"
docker() {
  if [[ "$1" == ps && "$2" == -q ]]; then printf 'pgid\nconnid\noutsideid\n'; return; fi
  if [[ "$1" == inspect && "$2" == --format && "$3" == '{{.Id}}' ]]; then printf 'pgid\n'; return; fi
  if [[ "$1" == inspect && "$2" == --format ]]; then
    case "$4" in connectivity) printf '%s\n' "$PROJECT";; outside) printf 'other-project\n';; *) printf '%s\n' "$PROJECT";; esac
    return
  fi
  if [[ "$1" == inspect ]]; then cat "$fixture"; return; fi
  return 1
}
holders="$(running_durable_writer_names postgres /canonical/attest /canonical/duc)"
[[ "$holders" == $'connectivity\noutside' ]]
! (assert_reviewed_durable_writer_names connectivity outside)
`;
  const result = spawnSync("bash", ["-c", script, "fixture", common, mounts], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("active attestation roots are bound to matching read-only production mounts", async () => {
  const common = path.join(remote, "common.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-security-roots-"));
  const good = path.join(directory, "good.json");
  const mixed = path.join(directory, "mixed.json");
  const writable = path.join(directory, "writable.json");
  const mounts = (keySource, rw = false) => JSON.stringify([{ Mounts: [
    { Destination: "/etc/cosmos-attest/ca.crt", Type: "bind", RW: false, Source: "/home/anders/carry-attest/ca.crt" },
    { Destination: "/etc/cosmos-attest/ca.key", Type: "bind", RW: rw, Source: keySource },
  ], Config: { Labels: { "com.docker.compose.project": "ai-pin-revival" } } }]);
  await writeFile(good, mounts("/home/anders/carry-attest/ca.key"));
  await writeFile(mixed, mounts("/home/anders/carry-duc/duc-ca.key"));
  await writeFile(writable, mounts("/home/anders/carry-attest/ca.key", true));
  const script = String.raw`
source "$1"
active_service_container() { printf 'ai-bus\n'; }
fixture="$2"
docker() {
  [[ "$1" == inspect ]] || return 1
  if [[ "$2" == --format ]]; then printf '%s\n' "$PROJECT"; else cat "$fixture"; fi
}
sudo() { [[ "$1" != -n ]] || shift; [[ "$1" == test ]] || return 1; [[ "$2" == -L ]] && return 1; return 0; }
[[ "$(active_attestation_root)" == /home/anders/carry-attest ]]
fixture="$3"; ! (active_attestation_root >/dev/null)
fixture="$4"; ! (active_attestation_root >/dev/null)
`;
  const result = spawnSync("bash", ["-c", script, "fixture", common, good, mixed, writable], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("every container is refused an alternate writer or mount target for Carry security paths", async () => {
  const backupLibrary = await readFile(path.join(remote, "lib/backup.sh"), "utf8");
  const guardStart = backupLibrary.indexOf("assert_no_alternate_security_writers() {");
  const guardEnd = backupLibrary.indexOf("\nrunning_durable_writer_names() {", guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, "security writer guard is not a complete function");
  const guard = backupLibrary.slice(guardStart, guardEnd);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-security-writers-")));
  const fixturePath = path.join(directory, "mounts.json");
  const container = (mount) => [{
    Config: { Labels: {
      "com.docker.compose.project": "humane-carry-clone",
      "com.docker.compose.service": "ai-bus",
    } },
    Mounts: [mount],
  }];
  const exact = {
    Type: "bind", Source: "/home/anders/carry-attest/ca.key",
    Destination: "/etc/carry-attest/ca.key", RW: false,
  };
  const cases = [
    ["writable", { ...exact, RW: true }],
    ["parent", { ...exact, Source: "/home/anders" }],
    ["wrong-target", { ...exact, Destination: "/etc/unreviewed/ca.key" }],
  ];
  const script = String.raw`
set -euo pipefail
${guard}
PROJECT=ai-pin-revival; LEGACY_PROJECT=humane-carry-clone; fixture="$1"
fail() { printf '%s\n' "$*" >&2; return 1; }
docker() {
  if [[ "$1" == ps ]]; then printf '%064d\n' 1
  elif [[ "$1" == inspect ]]; then cat "$fixture"
  else return 97
  fi
}
assert_no_alternate_security_writers
`;
  await writeFile(fixturePath, JSON.stringify(container(exact)));
  let result = spawnSync("bash", ["-c", script, "fixture", fixturePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const [name, mount] of cases) {
    await writeFile(fixturePath, JSON.stringify(container(mount)));
    result = spawnSync("bash", ["-c", script, name, fixturePath], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `${name} alternate security access unexpectedly passed`);
  }
});

test("archive inventory and channel-key contract retain root and child metadata", async () => {
  const common = path.join(remote, "common.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-metadata-"));
  const script = String.raw`
set -euo pipefail
source "$1"
work="$2"; source_dir="$work/source"; restore_dir="$work/restore"
mkdir "$source_dir" "$restore_dir"; chmod 0711 "$source_dir"; printf 'secret\n' >"$source_dir/channel-key.json"; chmod 0640 "$source_dir/channel-key.json"
tar -czpf "$work/source.tar.gz" -C "$source_dir" .
archive_inventory "$work/source.tar.gz" "$work/source.json"
python3 - "$work/source.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1])); root=[item for item in items if item["path"]=="."]
assert len(root)==1 and root[0]["mode"]==oct(0o711)
key=[item for item in items if item["path"]=="channel-key.json"]
assert len(key)==1 and key[0]["mode"]==oct(0o640) and len(key[0]["sha256"])==64
PY
tar -xzpf "$work/source.tar.gz" -C "$restore_dir"
tar -czpf "$work/restored.tar.gz" -C "$restore_dir" .
archive_inventory "$work/restored.tar.gz" "$work/restored.json"
cmp -s "$work/source.json" "$work/restored.json"
CENTER_DATA_DIR="$source_dir"
database_count() { printf '%s\n' -1; }; state_file_count() { printf '1\n'; }; state_byte_count() { printf '7\n'; }
stat() {
  if [[ "$1" == -c ]]; then
    python3 - "$2" "$3" <<'PY'
import os,stat,sys
fmt,path=sys.argv[1:]; meta=os.stat(path)
if fmt=="%a": print(format(stat.S_IMODE(meta.st_mode),"o"))
elif fmt=="%u:%g": print(f"{meta.st_uid}:{meta.st_gid}")
else: raise SystemExit(2)
PY
  else command stat "$@"; fi
}
write_invariants "$work/present.tsv" ignored
grep -qx $'center.channel_key.presence\tpresent' "$work/present.tsv"
grep -qx $'center.channel_key.mode\t640' "$work/present.tsv"
rm "$source_dir/channel-key.json"
write_invariants "$work/absent.tsv" ignored
grep -qx $'center.channel_key.presence\tabsent' "$work/absent.tsv"
grep -qx $'center.channel_key.owner\t-' "$work/absent.tsv"
`;
  const result = spawnSync("bash", ["-c", script, "fixture", common, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("quiesced semantic backup uses only direct loopback application listeners", async () => {
  const common = path.join(remote, "common.sh");
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-quiesced-"));
  const trace = path.join(directory, "trace");
  const output = path.join(directory, "semantic.tsv");
  const script = String.raw`
source "$1"
trace="$2"
http_status() {
  printf '%s\n' "$*" >>"$trace"
  case "$*" in *readyz*|*connectivity-check*) printf 204;; *) printf 200;; esac
}
curl() { printf '%s' '{"assistant":true,"speech":true,"mesh":{"reachable":7,"total":7,"services":22,"methods":98}}'; }
write_quiesced_semantic_evidence "$3"
! grep -q 'https://carry.andersmadsen.dk' "$trace"
! grep -q 'http://127.0.0.1/$' "$trace"
grep -q '127.0.0.1:18085' "$trace"
grep -q '127.0.0.1:14000/login' "$trace"
`;
  const result = spawnSync("bash", ["-c", script, "fixture", common, trace, output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, "utf8"), /aibus\.status\.sha256/u);
});

test("deploy and rollback publish authority only after public acceptance", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  // The final public canary — the one that runs against the activated edge — is
  // the only owner canary that also carries --require-wearer-plane, so match on
  // that exact flag pair rather than on --require-owner-spotify alone, which the
  // pre-activation recovery invocations use too.
  const publicCanaryFlags = "--require-owner-spotify --require-wearer-plane --cookie-file";
  const deployPublic = lastAt(deploy, publicCanaryFlags);
  assert.ok(
    deployPublic > 0,
    "the public-acceptance canary must exercise Center's wearer data plane",
  );
  // Every one of these is bound through lastAt/at rather than a bare indexOf:
  // the whole chain is `<` comparisons, so an absent chain head used to read as
  // offset -1 and satisfy the ordering it was supposed to prove.
  const deployPrepared = lastAt(deploy, "prepare_candidate_commit");
  const deployAccepted = at(deploy, '>"$record/INGRESS_ACTIVATED.tmp"');
  const deployCommit = lastAt(deploy, "complete_candidate_commit");
  assert.ok(
    deployPrepared < deployPublic && deployPublic < deployAccepted && deployAccepted < deployCommit,
    "deploy must prepare the pointer, pass the public canary, mark ingress accepted, then commit",
  );
  const rollbackPublic = lastAt(rollback, "--require-owner-spotify --cookie-file");
  const rollbackPrepared = lastAt(rollback, "prepare_target_commit");
  const rollbackAccepted = at(rollback, '>"$record/ROLLBACK_INGRESS_ACTIVATED.tmp"');
  const rollbackCommit = lastAt(rollback, "complete_target_commit");
  assert.ok(
    rollbackPrepared < rollbackPublic && rollbackPublic < rollbackAccepted && rollbackAccepted < rollbackCommit,
    "rollback must prepare the pointer, pass the public canary, mark ingress accepted, then commit",
  );
  assert.match(deploy, /--public-ingress-quiesced/u);
  assert.doesNotMatch(deploy, /bash "\$old_current\/platform\/deploy\/vps\/remote\/canary\.sh"/u);
  assert.doesNotMatch(rollback, /bash "\$target_release\/platform\/deploy\/vps\/remote\/(?:canary|staging-smoke)\.sh"/u);
});

test("live activation is durably prepared before either candidate or rollback target starts", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  // Whole-file offsets, not offsets inside a slice. `prepare_candidate_commit`
  // is deliberately called BEFORE quiescence — long before the window this test
  // used to slice out — so the old in-slice lookup found nothing, returned -1,
  // and "durably prepared before the candidate starts" was proven by the token
  // being absent from the window. Anchor on the candidate start instead.
  const deployMainStart = lastAt(deploy, 'record_configuration_evidence "$release_dir"');
  const candidateStart = deployMainStart + at(deploy.slice(deployMainStart), '"${COMPOSE[@]}" up -d');
  // The CALL, not the function definition: the definition line is
  // `prepare_candidate_commit() {`, so requiring a trailing newline right after
  // the name matches only an invocation. Without that, deleting the call left
  // the definition behind and the ordering still "held".
  assert.ok(
    lastAt(deploy, "prepare_candidate_commit\n", candidateStart) < candidateStart,
    "the candidate pointer intent must be durable before the candidate containers start",
  );
  // The ARM, not the mention. The token also appears in a comment and in the
  // pre-activation recovery test at deploy.sh:370, either of which would satisfy
  // a bare-token ordering check while the marker was never written.
  const armCandidate = 'mv "$record/CANDIDATE_ACTIVATION_ARMED.tmp" "$record/CANDIDATE_ACTIVATION_ARMED"';
  assert.ok(
    lastAt(deploy, armCandidate, candidateStart) < candidateStart,
    "CANDIDATE_ACTIVATION_ARMED must be durably armed before the candidate containers start",
  );
  // The marker's own write, pinned in full. Nothing in the suite pinned that
  // deploy.sh writes it AT ALL: preflight.sh keys the crashed-deploy recovery
  // branch on its presence, so losing it silently classifies a post-activation
  // crash as pre-activation and recovery walks the wrong path. Pin the durable
  // shape (temp file, atomic rename, fsync) — a half-written marker is the same
  // failure with a different cause.
  assert.match(deploy, /^printf '%s\\n' "\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >"\$record\/CANDIDATE_ACTIVATION_ARMED\.tmp"$/mu);
  assert.match(deploy, /^mv "\$record\/CANDIDATE_ACTIVATION_ARMED\.tmp" "\$record\/CANDIDATE_ACTIVATION_ARMED"$/mu);
  assert.match(deploy, /^sync -f "\$record\/CANDIDATE_ACTIVATION_ARMED"$/mu);
  const rollbackMain = rollback.slice(at(rollback, 'fresh_backup_pointer="$record/rollback-backup-path"'));
  const rollbackStop = at(rollbackMain, '"${COMPOSE[@]}" down --remove-orphans');
  assert.ok(
    at(rollbackMain, "prepare_target_commit\n") < rollbackStop,
    "the rollback pointer intent must be durable before the live stack is torn down",
  );
  assert.ok(
    at(rollbackMain, 'mv "$record/ROLLBACK_ACTIVATION_ARMED.tmp" "$record/ROLLBACK_ACTIVATION_ARMED"') < rollbackStop,
    "ROLLBACK_ACTIVATION_ARMED must be durably armed before the live stack is torn down",
  );
  assert.match(deploy, /reprove_candidate_acceptance && complete_candidate_commit/u);
  assert.match(rollback, /reprove_target_acceptance && complete_target_commit/u);
  assert.match(deploy, /POINTER_TRANSACTION_ABORTED/u);
  assert.match(rollback, /ROLLBACK_POINTER_TRANSACTION_ABORTED/u);
});

test("operation authority precedes every quiescing backup and live-mutation boundary", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const deployMain = deploy.slice(deploy.lastIndexOf('record_ingress_services "$ingress_evidence"'));
  const deployOperation = deployMain.indexOf("--operation-action prepare");
  const deployPointer = deployMain.indexOf("prepare_candidate_commit");
  const deployQuiescing = deployMain.indexOf("--operation-action quiescing");
  const deployBackup = deployMain.indexOf("--leave-quiesced --already-locked");
  const deployQuiesced = deployMain.indexOf("--operation-action quiesced");
  const liveMutation = deployMain.indexOf("LIVE_MUTATION_STARTED");
  const firstStop = deployMain.indexOf('stop_project_containers "$PROJECT"');
  assert.ok(0 <= deployOperation && deployOperation < deployPointer && deployPointer < deployQuiescing);
  assert.ok(deployQuiescing < deployBackup && deployBackup < deployQuiesced);
  assert.ok(deployQuiesced < liveMutation && liveMutation < firstStop);
  assert.match(deploy, /preserving staged trust roots for the pending deployment operation/u);

  const rollbackMain = rollback.slice(rollback.lastIndexOf('record_ingress_services "$ingress_evidence"'));
  const rollbackPointer = rollbackMain.indexOf("prepare_target_commit");
  const rollbackOperation = rollbackMain.indexOf("--operation-action prepare");
  const rollbackQuiescing = rollbackMain.indexOf("--operation-action quiescing");
  const rollbackBackup = rollbackMain.indexOf("--leave-quiesced --already-locked");
  const rollbackQuiesced = rollbackMain.indexOf("--operation-action quiesced");
  assert.ok(0 <= rollbackPointer && rollbackPointer < rollbackOperation && rollbackOperation < rollbackQuiescing);
  assert.ok(rollbackQuiescing < rollbackBackup && rollbackBackup < rollbackQuiesced);
  assert.match(rollback, /ROLLBACK_ACTIVATION_ARMED/u);
  assert.match(rollback, /operation-action abort/u);
});

test("preflight admits only a verified pre-activation deploy operation before ordinary ingress checks", async () => {
  const preflight = await readFile(path.join(remote, "preflight.sh"), "utf8");
  const inventory = preflight.indexOf("--inventory");
  const operationVerify = preflight.indexOf("--operation-action verify");
  const preArmed = preflight.indexOf('! -f "$pending_record/CANDIDATE_ACTIVATION_ARMED"');
  const pointerVerify = preflight.indexOf("--namespace deploy --reconcile --prepare-only");
  const pendingReturn = preflight.indexOf('printf \'{"ok":true,"pendingActivation":true}');
  const ordinaryIngress = preflight.indexOf("systemctl is-active --quiet penumbra-center-bridge.service");
  assert.ok(0 <= inventory && inventory < operationVerify && operationVerify < preArmed);
  assert.ok(preArmed < pointerVerify && pointerVerify < pendingReturn && pendingReturn < ordinaryIngress);
  assert.match(preflight, /pending_namespace" == deploy/u);
  assert.match(preflight, /OPERATION_TRANSACTION_PREPARED/u);
  assert.match(preflight, /OPERATION_TRANSACTION_COMPLETED/u);
  assert.match(preflight, /OPERATION_TRANSACTION_ABORTED/u);
  assert.match(preflight, /pre-activation operation contains accepted or committed authority/u);
});

test("pre-activation recovery callback restores live mutation and canaries before public ingress", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const callback = bashFunction(deploy, "recover_pending_pre_activation_application");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-operation-recovery-")));
  const releases = path.join(directory, "releases");
  const deployments = path.join(directory, "deployments");
  const oldRelease = path.join(releases, releaseA);
  const oldRecord = path.join(deployments, "old-record");
  const pendingRecord = path.join(deployments, "pending-record");
  const pendingRelease = path.join(releases, releaseB);
  await mkdir(path.join(pendingRecord, "before"), { recursive: true });
  await mkdir(path.join(pendingRelease, "platform/deploy/vps/remote"), { recursive: true });
  await mkdir(oldRelease, { recursive: true });
  await mkdir(oldRecord, { recursive: true });
  const candidateId = "c".repeat(64);
  const candidatePath = path.join(directory, "release-candidates", candidateId);
  await mkdir(candidatePath, { recursive: true });
  await writeFile(path.join(pendingRecord, "old-current"), `${oldRelease}\n`);
  await writeFile(path.join(pendingRecord, "old-current-deployment"), `${oldRecord}\n`);
  await writeFile(path.join(pendingRecord, "ingress-active.tsv"), "nginx.service\tactive\n");
  await writeFile(path.join(pendingRecord, "before/running-containers.txt"), "current-postgres\n");
  await writeFile(path.join(pendingRecord, "LIVE_MUTATION_STARTED"), "started\n");
  await writeFile(path.join(oldRecord, "running-images.tsv"), "fixture\n");
  await writeFile(path.join(oldRecord, "config-digests.tsv"), "fixture\n");
  await writeFile(path.join(oldRecord, "candidate-id"), `${candidateId}\n`);
  await writeFile(path.join(oldRecord, "candidate-path"), `${candidatePath}\n`);
  await writeFile(path.join(pendingRelease, "platform/deploy/vps/remote/canary.sh"), [
    "#!/usr/bin/env bash", "printf 'canary:%s\\n' \"$*\" >>\"$TRACE\"", "",
  ].join("\n"));
  const trace = path.join(directory, "trace");
  const script = String.raw`
set -euo pipefail
${callback}
TRACE="$1"; export TRACE
RELEASES_DIR="$2"; DEPLOYMENTS_DIR="$3"; PROJECT=fixture
trace() { printf '%s\n' "$1" >>"$TRACE"; }
# Faithful stand-in for the held cross-release dispatcher. It records the same
# argv without reopening or executing a mutable release-tree pathname.
assert_cross_release_options() { :; }
run_cross_release_script() {
  local release="$1" script="$2"
  shift 2
  trace "canary:$*"
}
activate_record_candidate_if_present() {
  [[ -f "$2/candidate-id" && -f "$2/candidate-path" ]] || return 1
  trace "activate-candidate:$4"
}
open_public_ingress_window() { trace open-window; }
quiesce_ingress_services() { trace quiesce; }
stop_project_containers() { trace stop-candidate; }
remove_project_containers() { trace remove-candidate; }
restore_pending_live_mutation() { trace restore-live-mutation; }
validate_release_id() { trace validate-release; }
load_compose_command() { COMPOSE=(fixture_compose); trace load-compose; }
fixture_compose() { trace compose-up; }
wait_for_services() { trace wait-services; }
verify_image_evidence() { trace verify-images; }
verify_configuration_evidence() { trace verify-config; }
start_recorded_ingress_service() { trace bridge-start; }
write_owner_canary_cookie() { : >"$2"; trace owner-cookie; }
restore_ingress_services() { trace restore-public-ingress; }
assert_ingress_matches_recorded() { trace assert-ingress; }
start_recorded_containers() { trace start-legacy; }
verify_legacy_application() { trace verify-legacy; }
recover_pending_pre_activation_application "$4" "$5"
`;
  const result = spawnSync("bash", ["-c", script, "fixture", trace, releases, deployments, pendingRecord, pendingRelease], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const events = (await readFile(trace, "utf8")).trim().split("\n");
  const firstCanary = events.findIndex((value) => value.startsWith("canary:"));
  const activation = eventAt(events, "activate-candidate:preactivation-predecessor");
  const restorePublic = eventAt(events, "restore-public-ingress");
  const secondCanary = events.findLastIndex((value) => value.startsWith("canary:"));
  assert.ok(firstCanary >= 0 && secondCanary > firstCanary, `recovery ran ${events.length} steps and fewer than two canaries: ${events.join(", ")}`);
  // Guarded, not bare: an absent event indexes as -1, which is smaller than
  // every real index, so each of these three used to be satisfied by the step
  // never happening. Deleting restore_pending_live_mutation,
  // start_recorded_ingress_service or assert_ingress_matches_recorded from
  // deploy.sh's recovery path left all of them green.
  assert.ok(eventAt(events, "restore-live-mutation") < eventAt(events, "compose-up"));
  assert.ok(activation < eventAt(events, "load-compose") && activation < firstCanary);
  assert.ok(eventAt(events, "bridge-start") < firstCanary);
  assert.ok(firstCanary < restorePublic && restorePublic < secondCanary);
  assert.ok(eventAt(events, "assert-ingress") < secondCanary);
  // This recovery is an OUTAGE — it stops the same four ingress units and then
  // runs container restores and two canaries before reopening — so it must open
  // the measured window before it quiesces anything, exactly as the cutover's own
  // recovery does. Ordered, not merely present: opening after the quiesce would
  // silently discard everything the recovery spent with the edge already closed.
  assert.ok(
    eventAt(events, "open-window") < eventAt(events, "quiesce"),
    `recovery must measure its own ingress outage: ${events.join(", ")}`,
  );
});

test("failed-cutover recovery refuses retained candidate authority before every Compose consumer", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const recovery = bashFunction(deploy, "recover_previous_application");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-deploy-recovery-authority-")));
  const record = path.join(directory, "deployments", "failed-record");
  const stage = path.join(record, "staged", "assets", "attest");
  const oldRelease = path.join(directory, "releases", releaseA);
  const oldRecord = path.join(directory, "deployments", "old-record");
  await mkdir(stage, { recursive: true });
  await mkdir(oldRelease, { recursive: true });
  await mkdir(oldRecord, { recursive: true });
  await writeFile(path.join(stage, "ca.key"), "recoverable staged key\n", { mode: 0o600 });
  await writeFile(path.join(record, "OPERATION_TRANSACTION_PREPARED"), "prepared\n", { mode: 0o600 });
  const trace = path.join(directory, "trace");
  const script = String.raw`
set +e
${recovery}
TRACE="$1"; record="$2"; old_current="$3"; old_current_deployment="$4"
trace() { printf '%s\n' "$1" >>"$TRACE"; }
warn() { :; }
activate_record_candidate_if_present() { trace activation-refused; return 1; }
# None of these may be reached after authority refusal.
open_public_ingress_window() { trace open-window; }
quiesce_ingress_services() { trace quiesce; }
load_candidate_compose_command_with_env() { trace candidate-compose-env; }
load_candidate_compose_command() { trace candidate-compose; }
load_compose_command() { trace load-compose; }
run_held_release_program() { trace canary; }
verify_configuration_evidence() { trace verify-config; }
verify_image_evidence() { trace verify-images; }
recover_previous_application
`;
  const result = spawnSync("bash", ["-c", script, "fixture", trace, record, oldRelease, oldRecord], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"), ["activation-refused"]);
  assert.equal(await readFile(path.join(stage, "ca.key"), "utf8"), "recoverable staged key\n");
  assert.match(await readFile(path.join(record, "OPERATION_TRANSACTION_PREPARED"), "utf8"), /prepared/u);
  await assert.rejects(readFile(path.join(record, "RECOVERY_FAILED")));
});

test("TERM-state between pointer preparation and trust evidence preserves rehearsal material", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const cleanup = bashFunction(deploy, "cleanup_staged_material");
  const finish = bashFunction(deploy, "finish_deploy");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-term-stage-")));
  const record = path.join(directory, "deployments", "pending-record");
  const stage = path.join(record, "staged");
  await mkdir(path.join(stage, "assets/keycloak-theme"), { recursive: true });
  await writeFile(path.join(stage, "assets/keycloak-theme/member"), "staged-theme\n", { mode: 0o600 });
  await writeFile(path.join(record, "POINTER_TRANSACTION_PREPARED"), "prepared\n", { mode: 0o600 });
  await writeFile(path.join(record, "OPERATION_TRANSACTION_PREPARED"), "prepared\n", { mode: 0o600 });
  const script = String.raw`
set +e
${cleanup}
${finish}
record="$1"; stage="$2"; DEPLOYMENTS_DIR="$3"; incoming_release="$4"
application_committed=0; rollback_needed=1; recovery_forbidden=1
ingress_evidence="$record/ingress-active.tsv"; transaction_driver=/unused
warn() { :; }
false
finish_deploy
`;
  const result = spawnSync("bash", ["-c", script, "fixture", record, stage, path.join(directory, "deployments"), path.join(directory, "incoming")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(stage, "assets/keycloak-theme/member"), "utf8"), "staged-theme\n");
  assert.match(await readFile(path.join(record, "CANDIDATE_ACTIVATION_PENDING"), "utf8"), /\S/u);
  await assert.rejects(readFile(path.join(record, "OPERATION_TRANSACTION_ABORTED")));
});

test("rollback pre-activation recovery canaries current authority before abort", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const finish = bashFunction(rollback, "finish_rollback");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-rollback-recovery-")));
  const record = path.join(directory, "deployments", "current-record");
  const work = path.join(record, "manual-rollback-fixture");
  const currentRelease = path.join(directory, "releases", releaseA);
  await mkdir(path.join(work, "current-config"), { recursive: true });
  await mkdir(path.join(currentRelease, "platform/deploy/vps/remote"), { recursive: true });
  const candidateId = "c".repeat(64);
  const candidatePath = path.join(directory, "release-candidates", candidateId);
  await mkdir(candidatePath, { recursive: true });
  await writeFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_PREPARED"), "prepared\n");
  await writeFile(path.join(record, "ROLLBACK_OPERATION_TRANSACTION_PREPARED"), "prepared\n");
  await writeFile(path.join(record, "running-images.tsv"), "fixture\n");
  await writeFile(path.join(record, "candidate-id"), `${candidateId}\n`);
  await writeFile(path.join(record, "candidate-path"), `${candidatePath}\n`);
  await writeFile(path.join(work, "current-config/runtime.env"), "fixture=true\n");
  await writeFile(path.join(currentRelease, "platform/deploy/vps/remote/canary.sh"), [
    "#!/usr/bin/env bash", "printf 'canary:%s\\n' \"$*\" >>\"$TRACE\"", "",
  ].join("\n"));
  const trace = path.join(directory, "trace");
  const script = String.raw`
set +e
${finish}
TRACE="$1"; export TRACE
record="$2"; work="$3"; current_release="$4"; current_release_id="$5"
REMOTE_ROOT="$6"; transaction_driver=/transaction.py; ingress_evidence="$work/ingress-active.tsv"
owner_canary_cookie="$work/owner.cookies"; fresh_backup=""; PROJECT=canonical; LEGACY_PROJECT=legacy
rollback_started=1; rollback_committed=0; target_committed=0; pointers_changed=0; ingress_quiesced=0
trace() { printf '%s\n' "$1" >>"$TRACE"; }
warn() { trace warn; }
quiesce_ingress_services() { trace quiesce; }
assert_ingress_quiesced() { trace assert-quiesced; }
stop_project_containers() { trace "stop:$1"; }
remove_project_containers() { trace remove-candidate; }
restore_config_snapshot() { trace restore-config; }
restore_nginx_transaction_snapshot() { trace restore-nginx; }
domain_nginx_reapply() { trace restore-domain-nginx; }
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
python3() { trace "python:$*"; }
load_compose_command() { COMPOSE=(fixture_compose); trace load-compose; }
fixture_compose() { trace compose-up; }
wait_for_services() { trace wait-services; }
domain_keycloak_apply() { trace keycloak-apply; }
domain_nginx_verify_desired() { trace nginx-verify; }
domain_keycloak_verify_desired() { trace keycloak-verify; }
verify_keycloak_post_migration_evidence() { trace keycloak-evidence; }
verify_configuration_evidence() { trace verify-config; }
verify_image_evidence() { trace verify-images; }
activate_retained_candidate_authority() {
  [[ -f "$2/candidate-id" && -f "$2/candidate-path" ]] || return 1
  trace "activate-candidate:$4"
}
run_held_release_program() { trace "canary:$*"; }
start_recorded_ingress_service() { trace bridge-start; }
domain_cloudflared_install() { trace cloudflared-install; }
domain_cloudflared_verify_desired() { trace cloudflared-verify-desired; }
write_owner_canary_cookie() { : >"$2"; trace owner-cookie; }
restore_ingress_services() { trace restore-public-ingress; }
assert_ingress_matches_recorded() { trace assert-ingress; }
cleanup_work_secrets() { trace cleanup; }
false
finish_rollback
`;
  const result = spawnSync("bash", ["-c", script, "fixture", trace, record, work, currentRelease, releaseA, directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const events = (await readFile(trace, "utf8")).trim().split("\n");
  const canaries = events.map((value, index) => value.startsWith("canary:") ? index : -1).filter((index) => index >= 0);
  const operationAbort = events.findIndex((value) => value.includes("--operation-action abort"));
  const activation = eventAt(events, "activate-candidate:rollback-recovery-current");
  assert.equal(canaries.length, 2);
  // `canaries[0] < indexOf(x)` already fails for an absent x (-1), but
  // `indexOf("bridge-start") < canaries[0]` did not: the rollback recovery path
  // could stop starting the recorded ingress service entirely and stay green.
  assert.ok(eventAt(events, "bridge-start") < canaries[0]);
  assert.ok(activation < eventAt(events, "load-compose") && activation < canaries[0]);
  assert.ok(canaries[0] < eventAt(events, "restore-public-ingress"));
  assert.ok(eventAt(events, "restore-public-ingress") < canaries[1]);
  assert.ok(canaries[1] < operationAbort);
  assert.match(await readFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_ABORTED"), "utf8"), /\S/u);
});

/*
 * The recovery-arm fixtures below differ from the one above in exactly one
 * marker — ROLLBACK_INGRESS_ACTIVATED — and that marker is the whole point. The
 * test above only ever fixtures the case where the target was never publicly
 * accepted, which is why the accepted case could stay broken and green: the arm
 * that runs when a rollback fails AFTER accepting its target used to leave the
 * pointer transaction PREPARED with no terminal marker, and then delete the only
 * material a resume could be finished from.
 *
 * They assert against transaction.py's real inventory rather than against the
 * marker file, because the inventory is what actually gates the control plane:
 * preflight.sh, adopt-config.sh and rollback.sh all refuse while it reports this
 * namespace active. A marker assertion would prove a file exists; this proves
 * the operator can still deploy.
 */
async function rollbackRecoveryFixture(name) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `revival-${name}-`)));
  const record = path.join(directory, "deployments", "current-record");
  const work = path.join(record, "manual-rollback-fixture");
  const currentRelease = path.join(directory, "releases", releaseA);
  const targetRelease = path.join(directory, "releases", releaseB);
  const targetRecord = path.join(directory, "deployments", "target-record");
  await mkdir(path.join(work, "current-config"), { recursive: true });
  await mkdir(path.join(work, "target-stage/assets/keycloak-theme"), { recursive: true });
  await mkdir(path.join(currentRelease, "platform/deploy/vps/remote"), { recursive: true });
  await mkdir(targetRelease, { recursive: true });
  await mkdir(targetRecord, { recursive: true });
  const candidateId = "c".repeat(64);
  const candidatePath = path.join(directory, "release-candidates", candidateId);
  await mkdir(candidatePath, { recursive: true });
  await writeFile(path.join(record, "running-images.tsv"), "fixture\n");
  await writeFile(path.join(record, "candidate-id"), `${candidateId}\n`);
  await writeFile(path.join(record, "candidate-path"), `${candidatePath}\n`);
  await writeFile(path.join(work, "current-config/runtime.env"), "fixture=true\n");
  // Rollback rehearses only disposable configuration/theme/token material.
  // Deployed Carry security roots are never copied into this private work tree.
  await writeFile(path.join(work, "target-stage/assets/keycloak-theme/member"), "theme\n", { mode: 0o600 });
  await writeFile(path.join(currentRelease, "platform/deploy/vps/remote/canary.sh"), [
    "#!/usr/bin/env bash", "printf 'canary:%s\\n' \"$*\" >>\"$TRACE\"", "",
  ].join("\n"));
  // A faithful, inventory-valid record: transaction.py validates every journal it
  // finds behind a marker, so a hand-waved fixture would die rather than answer.
  const evidence = path.join(record, "rollback-ingress-active.tsv");
  const ingress = "nginx.service\tactive\n";
  await writeFile(evidence, ingress);
  await writeFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION.json"), `${JSON.stringify({
    schemaVersion: 1, namespace: "rollback", record,
    oldCurrent: currentRelease, oldPrevious: targetRelease, oldCurrentDeployment: record,
    desiredCurrent: targetRelease, desiredPrevious: currentRelease, desiredCurrentDeployment: targetRecord,
  })}\n`);
  await writeFile(path.join(record, "ROLLBACK_OPERATION_TRANSACTION.json"), `${JSON.stringify({
    schemaVersion: 1, namespace: "rollback", record,
    ingressEvidence: evidence, ingressEvidenceSha256: createHash("sha256").update(ingress).digest("hex"),
  })}\n`);
  await writeFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_PREPARED"), "prepared\n");
  await writeFile(path.join(record, "ROLLBACK_OPERATION_TRANSACTION_PREPARED"), "prepared\n");
  // The operation transaction is already terminal, exactly as the recovery arm
  // leaves it (it aborts the operation unconditionally). That isolates the
  // question to the POINTER transaction's disposition.
  await writeFile(path.join(record, "ROLLBACK_OPERATION_TRANSACTION_ABORTED"), "aborted\n");
  await writeFile(path.join(record, "ROLLBACK_INGRESS_ACTIVATED"), "accepted\n");
  return { directory, record, work, currentRelease, trace: path.join(directory, "trace") };
}

function rollbackRecoveryScript(rollback, overrides) {
  return String.raw`
set +e
${bashFunction(rollback, "cleanup_work_secrets")}
${bashFunction(rollback, "finish_rollback")}
TRACE="$1"; export TRACE
record="$2"; work="$3"; current_release="$4"; current_release_id="$5"
REMOTE_ROOT="$6"; transaction_driver=/transaction.py; ingress_evidence="$work/ingress-active.tsv"
owner_canary_cookie="$work/owner.cookies"; fresh_backup=""; PROJECT=canonical; LEGACY_PROJECT=legacy
target_stage="$work/target-stage"
rollback_started=1; rollback_committed=0; target_committed=0; pointers_changed=0; ingress_quiesced=0
trace() { printf '%s\n' "$1" >>"$TRACE"; }
warn() { trace "warn:$1"; }
quiesce_ingress_services() { trace quiesce; }
assert_ingress_quiesced() { trace assert-quiesced; }
stop_project_containers() { trace "stop:$1"; }
remove_project_containers() { trace remove-candidate; }
restore_config_snapshot() { trace restore-config; }
restore_nginx_transaction_snapshot() { trace restore-nginx; }
domain_nginx_reapply() { trace restore-domain-nginx; }
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
python3() { trace "python:$*"; }
load_compose_command() { COMPOSE=(fixture_compose); trace load-compose; }
fixture_compose() { trace compose-up; }
wait_for_services() { trace wait-services; }
domain_keycloak_apply() { trace keycloak-apply; }
domain_nginx_verify_desired() { trace nginx-verify; }
domain_keycloak_verify_desired() { trace keycloak-verify; }
verify_keycloak_post_migration_evidence() { trace keycloak-evidence; }
verify_configuration_evidence() { trace verify-config; }
verify_image_evidence() { trace verify-images; }
activate_retained_candidate_authority() {
  [[ -f "$2/candidate-id" && -f "$2/candidate-path" ]] || return 1
  trace "activate-candidate:$4"
}
run_held_release_program() { trace "canary:$*"; }
start_recorded_ingress_service() { trace bridge-start; }
domain_cloudflared_install() { trace cloudflared-install; }
domain_cloudflared_verify_desired() { trace cloudflared-verify-desired; }
write_owner_canary_cookie() { : >"$2"; trace owner-cookie; }
restore_ingress_services() { trace restore-public-ingress; }
assert_ingress_matches_recorded() { trace assert-ingress; }
${overrides}
false
finish_rollback
`;
}

function activeAuthority(root) {
  const result = spawnSync("python3", [transaction, "--root", root, "--inventory"], { encoding: "utf8" });
  assert.equal(result.status, 0, `inventory exited ${result.status}: ${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schemaVersion, 1);
  return body.active;
}

test("recovery after a publicly accepted rollback leaves no unresumable authority", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const { directory, record, work, currentRelease, trace } = await rollbackRecoveryFixture("rollback-accepted-recovery");
  // The state the deadlock was reported in: the rollback accepted its target
  // publicly, then failed one of the two re-proofs under that acceptance.
  assert.deepEqual(activeAuthority(directory), [{ namespace: "rollback", record }]);
  // reprove_target_acceptance fails deterministically here for the same reason
  // the run failed: it re-runs assert_ingress_matches_recorded and
  // verify_target_domain_state, the two checks that just refused.
  const script = rollbackRecoveryScript(rollback, "reprove_target_acceptance() { trace reprove; return 1; }");
  const result = spawnSync("bash", ["-c", script, "fixture", trace, record, work, currentRelease, releaseA, directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const events = (await readFile(trace, "utf8")).trim().split("\n");
  const canaries = events.filter((value) => value.startsWith("canary:"));
  assert.equal(canaries.length, 2, `recovery ran ${events.join(", ")}`);
  assert.ok(eventAt(events, "activate-candidate:rollback-recovery-current") <
    events.findIndex((value) => value.startsWith("canary:")), events.join(", "));
  assert.match(await readFile(path.join(work, "CURRENT_RECOVERED"), "utf8"), /\S/u);
  // The whole point: nothing is pending any more, so `./revival deploy`,
  // `adopt-config` and a fresh rollback are all admissible again. Before the fix
  // this answered [{rollback, record}] with no command able to clear it.
  assert.deepEqual(activeAuthority(directory), []);
  assert.match(await readFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_ABORTED"), "utf8"), /\S/u);
  // Terminal, so the real cleanup_work_secrets may remove the disposable
  // rehearsal material. There are no staged copies of the Carry roots.
  await assert.rejects(readFile(path.join(work, "target-stage/assets/keycloak-theme/member")));
  await assert.rejects(readFile(path.join(work, "current-config/runtime.env")));
});

test("recovery that cannot abort a committed rollback keeps the material its resume needs", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const { directory, record, work, currentRelease, trace } = await rollbackRecoveryFixture("rollback-committed-recovery");
  // The one shape the abort above must NOT take: the driver published
  // ROLLBACK_POINTER_TRANSACTION_COMMITTED and complete_target_commit still
  // reported failure (its own pointer re-read refused). Writing the abort marker
  // here would make the record both aborted and committed, which transaction.py
  // treats as a fatal, GLOBAL error — every command that reads the inventory
  // would die. So this record stays resumable, and its resume inputs must survive.
  const script = rollbackRecoveryScript(rollback, [
    "reprove_target_acceptance() { trace reprove; }",
    'complete_target_commit() { : >"$record/ROLLBACK_POINTER_TRANSACTION_COMMITTED"; trace commit-failed; return 1; }',
  ].join("\n"));
  const result = spawnSync("bash", ["-c", script, "fixture", trace, record, work, currentRelease, releaseA, directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const events = (await readFile(trace, "utf8")).trim().split("\n");
  assert.ok(events.includes("commit-failed"), `recovery ran ${events.join(", ")}`);
  assert.ok(eventAt(events, "activate-candidate:rollback-recovery-current") <
    events.findIndex((value) => value.startsWith("canary:")), events.join(", "));
  await assert.rejects(readFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_ABORTED")));
  assert.deepEqual(activeAuthority(directory), [{ namespace: "rollback", record }]);
  // A pending resume retains its exact configuration and rehearsal material.
  assert.match(await readFile(path.join(work, "current-config/runtime.env"), "utf8"), /\S/u);
  assert.match(await readFile(path.join(work, "target-stage/assets/keycloak-theme/member"), "utf8"), /\S/u);
  assert.ok(events.some((value) => value.startsWith("warn:preserving rollback staging")), events.join(", "));
});

test("rollback recovery refuses before Compose when retained candidate activation fails and preserves staging", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const { directory, record, work, currentRelease, trace } = await rollbackRecoveryFixture("rollback-candidate-authority-refusal");
  const script = rollbackRecoveryScript(rollback, [
    "reprove_target_acceptance() { trace reprove; return 1; }",
    "activate_retained_candidate_authority() { trace activation-refused; return 1; }",
  ].join("\n"));
  const result = spawnSync("bash", ["-c", script, "fixture", trace, record, work, currentRelease, releaseA, directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  const events = (await readFile(trace, "utf8")).trim().split("\n");
  assert.ok(events.includes("activation-refused"), events.join(", "));
  assert.equal(events.some((value) => value === "load-compose" || value === "compose-up" || value.startsWith("canary:")), false,
    `failed candidate authority reached a Compose consumer: ${events.join(", ")}`);
  await assert.rejects(readFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_ABORTED")));
  assert.match(await readFile(path.join(work, "current-config/runtime.env"), "utf8"), /fixture/u);
  assert.match(await readFile(path.join(work, "target-stage/assets/keycloak-theme/member"), "utf8"), /theme/u);
  assert.deepEqual(activeAuthority(directory), [{ namespace: "rollback", record }]);
});

test("a durably aborted rollback is refused before anything can be torn down", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  // transaction.py:356 refuses to reopen an aborted transaction, so a retry of an
  // aborted record cannot get past prepare_target_commit. Discovering that at
  // prepare_target_commit is not free: rollback_started is 1 by then, so the
  // refusal runs finish_rollback's recovery arm — a quiesce, a container restart
  // and two canaries, all to refuse. Guarded offsets: a refusal that moved below
  // the trap, or vanished, fails here instead of silently satisfying a `<`.
  const refusal = at(rollback, 'fail "this deployment\'s rollback authority was durably aborted and cannot be reopened"');
  assert.ok(refusal < at(rollback, "trap finish_rollback EXIT"));
  assert.ok(refusal < at(rollback, "rollback_started=1"));
  assert.ok(refusal < at(rollback, 'record_ingress_services "$ingress_evidence"'));
  assert.ok(refusal < lastAt(rollback, "prepare_target_commit\n"));
});

test("a resumed accepted rollback removes disposable rehearsal material", async () => {
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  // The resumed-accepted block calls cleanup_work_secrets before either of the
  // two lines that assign target_stage, so on that path the variable is still its
  // empty initialiser. Guarded offsets: an assignment that moved above the call
  // would fail here rather than silently satisfy a bare indexOf.
  const resumeCleanup = at(rollback, "\n  cleanup_work_secrets\n");
  assert.ok(at(rollback, 'target_stage="$work/target-stage"') > resumeCleanup);
  assert.ok(lastAt(rollback, 'target_stage=""') < resumeCleanup);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-rollback-resume-cleanup-")));
  const work = path.join(directory, "deployments", "current-record", "manual-rollback-fixture");
  await mkdir(path.join(work, "target-stage/assets/keycloak-theme"), { recursive: true });
  await mkdir(path.join(work, "current-config"), { recursive: true });
  await writeFile(path.join(work, "target-stage/assets/keycloak-theme/member"), "theme\n", { mode: 0o600 });
  await writeFile(path.join(work, "current-config/runtime.env"), "fixture=true\n");
  const script = String.raw`
set -euo pipefail
${bashFunction(rollback, "cleanup_work_secrets")}
work="$1"; owner_canary_cookie="$work/owner.cookies"
# Exactly the resumed-accepted path's state.
target_stage=""
sudo() { [[ "$1" != -n ]] || shift; "$@"; }
cleanup_work_secrets
`;
  const result = spawnSync("bash", ["-c", script, "fixture", work], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(work, "target-stage/assets/keycloak-theme/member")));
  await assert.rejects(readFile(path.join(work, "current-config/runtime.env")));
});

test("backup retains separate logical and exact physical PostgreSQL restore proofs", async () => {
  const backup = await readFile(path.join(remote, "backup.sh"), "utf8");
  const logical = backup.indexOf('pg_dumpall --globals-only');
  const stop = backup.indexOf('docker stop --time 60 "$postgres"');
  const physicalArchive = backup.indexOf('archive_volume "$PG_VOLUME" postgres-data.tar.gz');
  const physicalRestore = backup.indexOf('"$verify_physical_postgres_volume:/restore"');
  const physicalStart = backup.indexOf('--name "$verify_physical_postgres_container"');
  const blankLogicalRestore = backup.indexOf('gunzip -c "$destination/postgres-globals.sql.gz"');
  assert.ok(logical < stop && stop < physicalArchive && physicalArchive < physicalRestore);
  assert.ok(physicalRestore < physicalStart && physicalStart < blankLogicalRestore);
  assert.match(backup, /postgres-data\.inventory\.json/u);
  assert.match(backup, /postgres-security\.physical-restored\.json/u);
  assert.match(backup, /center-data\.restored\.inventory\.json/u);
  assert.match(backup, /active-security-roots\.tsv/u);
  assert.match(backup, /protected-presence\.tsv/u);
});

/*
 * THE RECONCILE PATH'S EXIT TRAP, AND THE RESUME'S ZERO-DELTA REFERENCE.
 *
 * Two production outages ended the same way: a failure inside
 * reconcile_pending_deployment_transaction exited with nginx and BOTH cloudflared
 * connectors stopped, because the first `trap ... EXIT` in deploy.sh was installed
 * BELOW the reconcile call. A trap that covers a quiesce only after it has already
 * happened is not coverage, and nothing in this suite said so.
 */

test("an EXIT trap brackets the reconcile before anything in it can quiesce ingress", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const install = at(deploy, "\ntrap finish_reconcile EXIT\n");
  const call = at(deploy, "\nreconcile_pending_deployment_transaction\n");
  const firstTrap = at(deploy, "\ntrap ");
  assert.ok(install < call, "the reconcile's EXIT trap must be installed before the reconcile runs");
  assert.ok(firstTrap < install, "the pre-record Carry identity workspace should already have cleanup coverage");
  assert.match(deploy.slice(firstTrap, install),
    /trap 'rm -rf -- "\$carry_security_work"' EXIT[\s\S]*carry_security_work=""[\s\S]*trap - EXIT/u,
    "the only earlier trap must be the cleared read-only Carry identity workspace cleanup");

  // Every quiesce the reconcile can reach lives inside a function body, and the
  // only one this path enters is the bracketed call. What must never appear above
  // the trap is a TOP-LEVEL quiesce: an unindented statement runs where it is
  // written, so one placed there is uncovered by definition.
  const topLevelQuiesce = [...deploy.matchAll(/^(?:force_)?quiesce_ingress_services /gmu)];
  assert.ok(topLevelQuiesce.length > 0, "the deploy must still quiesce ingress somewhere");
  for (const match of topLevelQuiesce) {
    assert.ok(match.index > install, "a top-level quiesce sits above the reconcile's EXIT trap");
  }

  // Signals must reach the same handler, and the trap must be handed back once
  // the reconcile has returned so finish_deploy owns the rest of the run.
  assert.match(deploy.slice(install, call), /^trap 'exit 129' HUP$/mu);
  assert.match(deploy.slice(install, call), /^trap 'exit 143' TERM$/mu);
  assert.ok(at(deploy, "\ntrap - EXIT HUP INT TERM\nif ((pending_transaction_reconciled)); then") > call);

  // And the handler restores rather than merely reporting: the pre-activation arm
  // is the recovery this file already owns, the armed arm restores the recorded
  // candidate and every recorded ingress service, and neither is optional.
  const handler = bashFunction(deploy, "reconcile_restore_recorded_service");
  const armedArm = bashFunction(deploy, "reconcile_restore_armed_service");
  assert.match(handler, /recover_pending_pre_activation_application "\$target_record" "\$target_release"/u);
  assert.match(armedArm, /restore_ingress_services "\$evidence" "\$target_record" "\$route_state"/u);
  assert.match(armedArm, /start_recorded_ingress_service "\$evidence" penumbra-center-bridge\.service/u);
  assert.match(armedArm, /run_cross_release_script "\$target_release" canary\.sh/u);

  // NEITHER ARM MAY END WITH THE EDGE CLOSED just because its proof failed. The
  // reconcile's own failure is very often the same call the recovery re-makes, so
  // a deterministic failure reproduces exactly — and both arms quiesce before they
  // fail. Each therefore falls through to the last-resort reopen.
  assert.match(
    handler,
    /\( recover_pending_pre_activation_application "\$target_record" "\$target_release" \) && return 0\n\s*reconcile_reopen_outcome "\$target_record" "\$evidence"\n\s*return \$\?/u,
    "the pre-activation arm must reopen ingress when its proof fails",
  );
  assert.match(
    handler,
    /\( reconcile_restore_armed_service "\$target_record" "\$target_release" "\$evidence" \) && return 0\n\s*reconcile_reopen_outcome "\$target_record" "\$evidence"\n\s*return \$\?/u,
    "the armed arm must reopen ingress when its proof fails",
  );

  // A partial reopen must survive the trip back as its own outcome. Collapsing it
  // into 10 tells an operator the edge is fully back when part of it is down;
  // collapsing it into 1 sends them to a host they believe is dark while the
  // dashboard is serving.
  const outcome = bashFunction(deploy, "reconcile_reopen_outcome");
  assert.match(outcome, /0\) return 10 ;;/u);
  assert.match(outcome, /20\) return 20 ;;/u);
  assert.match(outcome, /\*\) return 1 ;;/u);


  // Each proof path runs in its OWN subshell. These paths reach helpers that call
  // `fail`, and `fail` is `exit 1` — uncontained, that exit terminated the whole
  // recovery child, so a drift detected after the quiesce skipped the reopen and
  // left the edge closed. rollback.sh:730-731 already used this containment.
  assert.match(handler, /\( recover_pending_pre_activation_application /u);
  assert.match(handler, /\( reconcile_restore_armed_service /u);

  // Non-regular evidence must skip the PROOF, not the reopen: the last-resort
  // canonical start was reachable from the arm that quiesced nothing and
  // unreachable from the arm that quiesced everything.
  assert.match(
    handler,
    /if \[\[ ! -f "\$evidence" \|\| -L "\$evidence" \]\]; then\n\s*reconcile_reopen_outcome "\$target_record" "\$evidence"/u,
    "unusable evidence must still reach the reopen",
  );
  // While the reopen can still be retried it is all four recorded units or none —
  // it goes through restore_ingress_services, so bringing back one connector and
  // leaving Cloudflare answering 530 is not reachable — and it is patient, because
  // the realistic failure is a cold start or a connector that has not re-registered.
  const reopen = bashFunction(deploy, "reconcile_reopen_recorded_ingress");
  assert.match(reopen, /restore_ingress_services "\$evidence" "\$target_record" "\$route_state"/u);
  // Three, not six. Every FAILING restore_ingress_services attempt force-quiesces
  // the whole edge on its way out, so with a permanently dead unit six rounds
  // stopped and restarted the three healthy units eighteen times before the
  // degraded pass was ever reached. Three keeps enough patience for a cold start
  // or a connector still re-registering, and cuts that churn in half.
  assert.match(reopen, /for attempt in 1 2 3; do/u, "the reopen must retry, not give up on one refusal");
  assert.match(reopen, /\(\(attempt < 3\)\) \|\| break/u);
  assert.doesNotMatch(reopen, /systemctl/u, "the reopen must not hand-start units around the restore helpers");

  // But the all-or-none rule INVERTS as the last act. restore_ingress_services
  // force-quiesces the whole edge on its way out, so ending on it turned one dead
  // unit into a dark host: a failed user-manager connector, or a bridge whose iroh
  // endpoint never binds, would stop nginx and the system tunnel too — six times.
  // The final pass must start what it can and stop nothing.
  assert.match(
    reopen,
    /reopen_recorded_ingress_best_effort "\$evidence"\n\}/u,
    "the reopen must end on the degraded pass, not on a force-quiescing restore",
  );

  // A reopen that could not prove the application must not claim that it did:
  // RECONCILE_RECOVERED belongs to the fully-proven outcome alone.
  const finish = bashFunction(deploy, "finish_reconcile");
  assert.match(finish, /recovery_status == 0/u);
  assert.match(finish, /recovery_status == 10/u);
  assert.ok(
    finish.indexOf("RECONCILE_RECOVERED") < finish.indexOf("recovery_status == 10"),
    "RECONCILE_RECOVERED must be written only on the fully-proven outcome",
  );
  assert.match(finish, /RECONCILE_INGRESS_REOPENED/u);
});

test("the reconcile trap runs recovery only once something has actually been quiesced", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const finish = bashFunction(deploy, "finish_reconcile");

  // The trap is armed before the reconcile's first quiesce ON PURPOSE, so being
  // armed says nothing about whether ingress is down: both arms can fail on either
  // side of their quiesce. Recovering unconditionally would stop the stack and both
  // connectors to put them back — an outage opened by the safety net itself, on a
  // production that was fully serving. So the handler asks first, and bails out
  // without touching anything when the answer is "nothing was taken down".
  assert.match(
    finish,
    /if ! reconcile_ingress_disturbed "\$reconcile_target_record\/ingress-active\.tsv"; then/u,
    "the handler must gate its recovery on whether ingress was actually disturbed",
  );
  const gate = finish.indexOf("reconcile_ingress_disturbed");
  const restore = finish.indexOf("reconcile_restore_recorded_service");
  assert.ok(gate >= 0 && restore > gate, "the gate must precede the recovery it guards");
  assert.match(finish.slice(gate, restore), /exit "\$status"/u, "the ungated path must exit without recovering");

  // And the condition derives from REAL STATE, not from a line number or a marker
  // this file wrote: the record's ingress evidence names the units that were active
  // when the transaction opened, and each is probed live.
  const disturbed = bashFunction(deploy, "reconcile_ingress_disturbed");
  assert.match(disturbed, /managed_systemctl "\$manager" is-active --quiet "\$unit" \|\| return 0/u);
  assert.match(disturbed, /\[\[ "\$expected" == active \]\] \|\| continue/u);
  assert.match(disturbed, /while IFS=\$'\\t' read -r kind manager unit expected _rest/u);
  // Unreadable evidence must answer "disturbed": recovery is the safe direction.
  // The check is delegated to validate_ingress_evidence, which begins with that
  // same `-f && ! -L` test and then also rejects a file whose STRUCTURE cannot
  // support the probe — the weaker inline test admitted an evidence file with no
  // service rows at all, which probes nothing and answers "not disturbed" for a
  // host that is entirely down.
  assert.match(disturbed, /validate_ingress_evidence "\$evidence" \|\| return 0/u);
  const validator = bashFunction(await commonLibrarySource(), "validate_ingress_evidence");
  assert.match(validator, /\[\[ -f "\$evidence" && ! -L "\$evidence" \]\] \|\| return 1/u);
});

test("the resume's Center data check can actually open the root-owned channel-key journal", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const reconcile = bashFunction(deploy, "reconcile_pending_deployment_transaction");

  // The journal is written THROUGH THE SUDO BOUNDARY by the transaction driver, so
  // it lands root-owned 0600 and the deployment user cannot open() it. A bare
  // `python3 - ... "$pending_record/CHANNEL_KEY_METADATA_TRANSACTION.json"` dies on
  // PermissionError on EVERY resume, not an unlucky one: the resume could never
  // complete. Read it with the privilege it was written with, as
  // compare_center_zero_delta_with_migration already does.
  assert.match(reconcile, /resume_center_python=\(python3\)/u);
  assert.match(reconcile, /\|\| resume_center_python=\(sudo -n python3\)/u);
  assert.match(reconcile, /"\$\{resume_center_python\[@\]\}" - "\$baseline\/center-data\.inventory\.json"/u);

  // No reader of the journal anywhere in this file may assume the deployment user
  // can open it. A bare `python3 -` whose argument list names the journal is the bug.
  for (const match of deploy.matchAll(/python3 - /gu)) {
    const chunk = deploy.slice(match.index, match.index + 300);
    if (!chunk.includes("CHANNEL_KEY_METADATA_TRANSACTION.json")) continue;
    assert.fail(
      `an unprivileged python3 reads the root-owned channel-key journal: ${chunk.split("\n").slice(0, 3).join(" ")}`,
    );
  }

  // ...and what that comparison proves is unchanged. The resume arm is the STRICTER
  // one: the whole Center inventory must be byte-identical (no migration window is
  // admitted here, unlike the cutover's helper), and the key is still pinned to the
  // journal's content digest and its DESIRED ownership rather than merely to itself.
  assert.match(reconcile, /journal=json\.load\(open\(sys\.argv\[3\],encoding="utf-8"\)\); assert set\(before\)==set\(after\)/u);
  assert.match(reconcile, /^    assert old==new$/mu);
  assert.match(reconcile, /assert old\.get\("sha256"\)==journal\["contentSha256"\]/u);
  assert.match(
    reconcile,
    /assert \(old\.get\("mode"\),old\.get\("uid"\),old\.get\("gid"\)\)==\(oct\(journal\["desiredMode"\]\),journal\["desiredUid"\],journal\["desiredGid"\]\)/u,
  );
});

test("a resume measures the candidate against its own window, not the record's closed one", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  // The record's backup is still verified and still the rollback baseline...
  assert.match(deploy, /^  verify_backup_artifact_manifest "\$pending_baseline"$/mu);
  assert.match(deploy, /^      --channel-key-contract "\$pending_baseline\/invariants\.tsv"$/mu);
  // ...and it is NOT what the candidate is compared against.
  assert.doesNotMatch(deploy, /compare_precommit_compatibility_state "\$pending_baseline"/u);

  // The reference is a backup this resume takes: after the re-quiesce, before the
  // candidate is started. Both orderings matter — taken earlier it spans the live
  // window again, taken later it measures nothing.
  const requiesce = at(deploy, 'quiesce_ingress_services "$pending_record/ingress-active.tsv" 0 "$pending_record" desired');
  const freshBaseline = at(deploy, '--backup-id "$resume_baseline_id" --leave-quiesced --already-locked --public-ingress-quiesced');
  const candidateUp = at(deploy, '    "${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans\n    wait_for_services "$pending_release"');
  const compare = at(deploy, 'compare_precommit_compatibility_state "$baseline" "$resume_backup"');
  assert.ok(requiesce < freshBaseline, "the resume's baseline must be captured inside its own quiesced window");
  assert.ok(freshBaseline < candidateUp, "the baseline must precede the candidate it measures");
  assert.ok(candidateUp < compare);
  assert.match(deploy, /^    baseline="\$BACKUP_ROOT\/\$resume_baseline_id"$/mu);
  // It is verified exactly as the post-candidate one is before anything reads it.
  assert.match(deploy, /^    verify_backup_artifact_manifest "\$baseline"$/mu);
  assert.match(deploy, /^    assert_ingress_quiesced \|\| fail "resumed candidate baseline backup reopened ingress"$/mu);
});

test("a refusal with ingress already down reopens it instead of walking away", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const reconcile = bashFunction(deploy, "reconcile_pending_deployment_transaction");

  // The full recovery cannot be armed until the record's RELEASE TREE is proven,
  // because both of its arms run that release's own scripts. Reopening the
  // recorded ingress needs none of that — only the record and its evidence file —
  // and the window between the two is exactly where a host whose ingress was
  // ALREADY down on entry (a predecessor that died inside its quiesced window)
  // would otherwise be abandoned: refused, still connection-refused, no marker.
  const evidenceProven = at(reconcile, '|| fail "pending deployment operation lacks durable ingress evidence"');
  const reopenArmed = at(reconcile, 'reconcile_reopen_only_record="$pending_record"');
  const releaseProven = at(reconcile, '|| fail "incomplete pointer transaction release material is unsafe"');

  // The two durability checks must stay SPLIT. Conjoined, a record with good
  // ingress evidence but a missing or symlinked release-id refused with neither
  // scope armed — no reopen and no marker, while the evidence naming exactly
  // which units to start sat proven and unused.
  assert.ok(
    reopenArmed < at(reconcile, '|| fail "pending deployment operation lacks durable identity"'),
    "the release-id check must sit behind the reopen arming, not in front of it",
  );
  assert.doesNotMatch(
    reconcile,
    /lacks durable identity or ingress evidence/u,
    "the conjoined durability check left the reopen scope unarmed on a release-id refusal",
  );
  const fullArmed = at(reconcile, 'reconcile_target_record="$pending_record"');
  assert.ok(evidenceProven < reopenArmed, "the reopen scope must be armed as soon as the evidence is proven durable");
  assert.ok(reopenArmed < releaseProven, "the reopen scope must cover the release-material checks that can refuse");
  assert.ok(releaseProven < fullArmed, "the full recovery must stay behind the release-tree proof");

  // It is a SEPARATE flag, not an early assignment of the full pair: arming
  // reconcile_target_record here would send a refusal into recoveries that
  // dereference an unvalidated $reconcile_target_release.
  const finish = bashFunction(deploy, "finish_reconcile");
  assert.ok(
    at(finish, '[[ -n "$reconcile_target_record" ]]') < at(finish, '[[ -n "$reconcile_reopen_only_record" ]]'),
    "the proven recovery must be preferred whenever it is armed",
  );

  // The narrow arm may only reopen. It must not claim a proof it does not have,
  // and it must not run when nothing is down — a refusal on a fully serving host
  // stays a refusal.
  assert.match(finish, /\[\[ -n "\$reconcile_reopen_only_record" \]\] \\\n\s*&& reconcile_ingress_disturbed "\$reconcile_reopen_only_record\/ingress-active\.tsv"/u);
  const narrow = finish.slice(at(finish, '[[ -n "$reconcile_reopen_only_record" ]]'));
  assert.doesNotMatch(narrow, /\bRECONCILE_RECOVERED\b/u, "the reopen-only arm must never claim the application was proven");
  assert.ok(!narrow.includes("reconcile_restore_recorded_service"), "the reopen-only arm must not enter the release-dependent recovery");
  assert.match(narrow, /record_reconcile_marker "\$reconcile_reopen_only_record" RECONCILE_INGRESS_REOPENED/u);
  assert.match(narrow, /record_reconcile_marker "\$reconcile_reopen_only_record" RECONCILE_RECOVERY_FAILED/u);

  // The arm must actually REOPEN. Asserting only the two markers passes an arm
  // gutted to `recovery_status=0`, which writes "ingress is back" having started
  // nothing — a safety net that reports success and does no work.
  // Through the SAME outcome mapping the armed arm uses. Calling the reopen
  // directly here discarded its partial result: a host with nginx, the bridge and
  // the system connector all serving was recorded RECONCILE_RECOVERY_FAILED and
  // the operator told the Pin was connection-refused.
  assert.match(
    narrow,
    /run_reconcile_recovery reconcile_reopen_outcome "\$reconcile_reopen_only_record" \\\n\s*"\$reconcile_reopen_only_record\/ingress-active\.tsv"\n\s*recovery_status=\$\?/u,
    "the reopen-only arm must go through the guarded runner and branch on the real outcome",
  );
  assert.match(narrow, /\(\(recovery_status == 20\)\)/u, "the reopen-only arm must handle a partial reopen");
  assert.match(narrow, /record_reconcile_marker "\$reconcile_reopen_only_record" RECONCILE_INGRESS_PARTIALLY_REOPENED/u);

  // The initialiser is load-bearing, not tidiness: finish_reconcile reads this
  // variable on every refusal, and deleting the top-level assignment makes the
  // handler die on `unbound variable` under set -u before it can exit with the
  // original status — on exactly the refusals this arm exists to cover.
  assert.ok(
    at(deploy, 'reconcile_reopen_only_record=""') < at(deploy, "trap finish_reconcile EXIT"),
    "the reopen scope must be initialised before the trap that reads it is installed",
  );

  // Every marker goes through the one writer, so none can be written without its
  // mode. A bare redirect into the record is the bug this forecloses.
  assert.doesNotMatch(deploy, /^\s*printf '%s\\n' "\$\(date[^\n]*\)" >"\$reconcile_[a-z_]*record\//mu);
});

test("the reconcile's ingress evidence readers agree with their own validator", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const common = await commonLibrarySource();

  // validate_ingress_evidence reads the file in python, which yields a final
  // line that has no trailing newline. bash's `read` returns non-zero on that
  // line while still populating the fields, so every loop that omits the
  // `|| [[ -n "$kind" ]]` continuation silently drops the last recorded unit —
  // and which unit is last is an ordering accident, not a safety property.
  for (const [name, text] of [["deploy.sh", deploy], ["common.sh", common]]) {
    for (const match of text.matchAll(/while IFS=\$'\\t' read -r kind [^\n]*\n?[^\n]*?; do/gu)) {
      assert.match(
        match[0],
        /\|\| \[\[ -n "\$kind" \]\]; do$/u,
        `${name}: an ingress-evidence loop drops an unterminated final row: ${match[0].replace(/\n\s*/u, " ")}`,
      );
    }
  }

  // Existence is not structure. An evidence file of nothing but `contract` rows
  // passes -f/! -L, probes no unit at all, and would report "not disturbed" for
  // a host that is entirely down — sending the trap down the do-nothing branch.
  const disturbed = bashFunction(deploy, "reconcile_ingress_disturbed");
  assert.ok(
    at(disturbed, 'validate_ingress_evidence "$evidence" || return 0') < at(disturbed, "while IFS="),
    "reconcile_ingress_disturbed must validate the evidence before trusting a probe over it",
  );
});

test("the reconcile's recovery cannot be interrupted by a dropped connection", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const finish = bashFunction(deploy, "finish_reconcile");

  // `trap - EXIT HUP INT TERM` restores the DEFAULT disposition for the three
  // signals, i.e. terminate. This handler is what reopens public ingress and
  // can run for minutes (the reopen alone retries six times with a ten-second
  // sleep), and the driver runs over a plain ssh — a dropped connection lands
  // SIGHUP inside that window and used to kill the recovery mid-flight, leaving
  // the edge closed and no marker written. They must be IGNORED, not defaulted.
  assert.doesNotMatch(finish, /trap - EXIT HUP INT TERM/u);

  // ORDER: the three are installed BEFORE EXIT is cleared. The other way round,
  // a signal arriving in the gap ran the outer `trap 'exit 129' HUP` with no EXIT
  // handler left to re-enter, and the recovery was abandoned silently.
  assert.ok(
    at(finish, "trap 'warn") < at(finish, "trap - EXIT"),
    "the signal traps must be installed before EXIT is cleared, not after",
  );
  assert.ok(
    at(finish, "trap - EXIT") < at(finish, "run_reconcile_recovery reconcile_restore_recorded_service"),
    "both traps must be settled before any recovery starts",
  );

  // AND THAT IS NOT ENOUGH ON ITS OWN. The recovery has to run in a subshell —
  // its helpers call `fail`, and an exit from inside this handler would skip the
  // marker and the original status — but bash RESETS a caught trap to its default
  // inside `( )`. So the traps above protect this shell and not the child doing
  // the actual restoring, which is where a dropped ssh used to kill the recovery
  // and leave the edge closed. They must be re-installed in the child.
  const runner = bashFunction(deploy, "run_reconcile_recovery");
  assert.match(runner, /trap 'warn "[^"]+"' HUP INT TERM/u);
  assert.doesNotMatch(finish, /\(reconcile_restore_recorded_service\)/u, "the bare subshell loses the signal traps");
  // SIGPIPE too: the degraded pass warns to stderr, i.e. to the ssh channel, and
  // a write to a dead channel would otherwise terminate the child part-way
  // through starting the remaining units. `:` and not `warn`, because warning
  // about a broken pipe writes to the broken pipe.
  assert.match(runner, /trap ':' PIPE/u);

  // AND they are trapped to a COMMAND, never to ''. `trap ''` sets SIG_IGN, which
  // POSIX preserves across execve — every docker, compose and systemctl child this
  // handler runs would inherit it and become unkillable by those signals, and
  // several of them have no client-side timeout. A command trap is reset to the
  // default in children, so only this shell is protected.
  assert.doesNotMatch(
    finish,
    /trap '' HUP INT TERM/u,
    "SIG_IGN survives exec and would make the handler's own children unkillable",
  );
  assert.match(finish, /trap 'warn "[^"]+"' HUP INT TERM/u);
});

test("a foreign authority transaction is refused rather than silently skipped", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const reconcile = bashFunction(deploy, "reconcile_pending_deployment_transaction");

  // `mapfile -t pending < <(python3 ...) || fail` binds the `||` to MAPFILE's
  // status, which is 0 however the python exited. A foreign (rollback-namespace)
  // authority transaction therefore printed its refusal to stderr and was then
  // skipped: `pending` came back empty and the reconcile returned as if nothing
  // were pending — the exact opposite of what the failure message promises.
  assert.doesNotMatch(reconcile, /mapfile -t pending < <\(/u);
  assert.match(reconcile, /pending_raw="\$\(python3 - "\$inventory_json"/u);
  assert.match(reconcile, /\)x" \|\| fail "a foreign authority transaction prevents deployment"/u);
  // The sentinel must be stripped, and an empty inventory must stay empty rather
  // than becoming a one-element array holding the empty string.
  assert.match(reconcile, /pending_raw="\$\{pending_raw%x\}"/u);
  assert.match(reconcile, /\[\[ -z "\$pending_raw" \]\] \|\| mapfile -t pending <<<"\$pending_raw"/u);
  assert.ok(
    at(reconcile, '|| fail "a foreign authority transaction prevents deployment"') <
      at(reconcile, '((${#pending[@]} == 1)) || return 0'),
    "the refusal must precede the emptiness test it was being masked by",
  );
});

test("nginx is never stopped unless it has been proven it can start again", async () => {
  const common = await commonLibrarySource();
  const quiesce = bashFunction(common, "quiesce_ingress_services");
  const restore = bashFunction(common, "restore_ingress_services");

  // restore_ingress_services makes `sudo -n nginx -t` a hard precondition and
  // returns BEFORE issuing a single `systemctl start` when it fails. So quiescing
  // without that check turns a serving host into one nothing here can reopen —
  // and it is invisible beforehand, because nginx runs from the config it LOADED
  // and record_ingress_services records only is-active, never validity.
  assert.match(restore, /sudo -n nginx -t >\/dev\/null \|\| return 1/u);
  assert.match(quiesce, /sudo -n nginx -t >\/dev\/null \|\| return 1/u);
  assert.ok(
    at(quiesce, "nginx -t") < at(quiesce, "managed_systemctl_mutate \"$manager\" stop"),
    "the nginx validity gate must precede the first stop, not follow it",
  );
});

test("the last-resort reopen never stops what it just started", async () => {
  const common = await commonLibrarySource();
  const best = bashFunction(common, "reopen_recorded_ingress_best_effort");

  // The all-or-none rule in restore_ingress_services is right while a restore can
  // still be retried — half an edge means Cloudflare answers 530. As the LAST act
  // it inverts: the choice is no longer half-open versus clean, it is half-open
  // versus dark, and a serving dashboard beats a connection-refused host.
  // Comments in this helper name force_quiesce_ingress_services deliberately, to
  // explain why it is NOT called here, so strip them before looking for calls.
  const bestCode = best.replace(/^\s*#.*$/gmu, "");
  assert.doesNotMatch(
    bestCode,
    /force_quiesce_ingress_services|managed_systemctl_mutate "\$manager" stop/u,
    "the degraded pass must never stop a unit",
  );

  // An unreadable evidence file must not mean a dark host. The four units are
  // compile-time constants and force_quiesce_ingress_services already hard-codes
  // exactly this list to STOP them; refusing to start a list we are willing to
  // stop is an outage, not caution.
  const lastResort = bashFunction(common, "reopen_canonical_ingress_last_resort").replace(/^\s*#.*$/gmu, "");
  assert.match(bestCode, /reopen_canonical_ingress_last_resort/u);

  // Both non-destructive passes start units through one patient helper. The retry
  // budget used to sit ENTIRELY in the destructive loop — the one that
  // force-quiesces the whole edge on every failed attempt — and not at all here,
  // which is backwards: this is the last thing that runs, it stops nothing, and a
  // slow service start or a connector still re-registering is the realistic case.
  const patient = bashFunction(common, "start_ingress_unit_with_patience").replace(/^\s*#.*$/gmu, "");
  assert.match(patient, /for attempt in 1 2 3 4/u);
  assert.match(patient, /sleep 5/u);
  assert.doesNotMatch(
    patient,
    /force_quiesce_ingress_services|managed_systemctl_mutate "\$manager" stop/u,
    "the patient starter must never stop a unit",
  );
  assert.match(bestCode, /start_ingress_unit_with_patience "\$manager" "\$unit"/u);
  assert.match(lastResort, /start_ingress_unit_with_patience "\$manager" "\$unit"/u);
  assert.doesNotMatch(
    lastResort,
    /force_quiesce_ingress_services|managed_systemctl_mutate "\$manager" stop/u,
    "the last-resort pass must never stop a unit either",
  );
  assert.match(lastResort, /\(\(up > 0\)\) \|\| return 1/u);
  assert.match(lastResort, /\(\(down == 0\)\) \|\| return 20/u);
  // The start itself now lives in start_ingress_unit_with_patience, asserted below;
  // what matters here is that this pass only ever delegates a START.
  assert.match(bestCode, /start_ingress_unit_with_patience "\$manager" "\$unit"/u);
  // Three outcomes, because "some of it is back" is a different thing to tell an
  // operator than either "all of it" or "none of it".
  assert.match(best, /\(\(up > 0\)\) \|\| return 1/u);
  assert.match(best, /\(\(down == 0\)\) \|\| return 20/u);
  // Dependency order is preserved: the bridge and nginx before the connectors.
  assert.ok(
    at(best, "penumbra-center-bridge.service") < at(best, "MANAGED_CLOUDFLARED_SYSTEM_UNIT"),
    "the degraded pass must start units in dependency order",
  );

  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const finish = bashFunction(deploy, "finish_reconcile");
  assert.match(finish, /record_reconcile_marker "\$reconcile_target_record" RECONCILE_INGRESS_PARTIALLY_REOPENED/u);
});

test("a bare CR cannot make the evidence readers disagree", async () => {
  const common = await commonLibrarySource();
  // Asserted against the file, not the extracted function: the validator's body is
  // an embedded python heredoc, which bashFunction stops at.
  //
  // Python's universal newlines treat a bare CR as a line terminator; bash's
  // `read` does not. Without pinning the newline, the same file parsed as valid
  // in the validator and as a single row in every bash probe over it — so a host
  // with every unit down answered "not disturbed" and the trap left it closed.
  assert.match(common, /open\(sys\.argv\[1\],encoding="utf-8",newline="\\n"\)/u);
  // Scoped to validate_ingress_evidence's own reader. Other helpers in this file
  // read other files with universal newlines, which is fine — the hazard is only
  // where a python reader and a bash `read` loop must agree row-for-row over the
  // SAME file, and ingress-active.tsv is the one that decides whether a host is
  // treated as disturbed.
  const validatorBody = common.slice(
    at(common, "validate_ingress_evidence() {"),
    at(common, "assert_cloudflared_identity_matches_recorded"),
  );
  assert.doesNotMatch(
    validatorBody,
    /open\(sys\.argv\[1\],encoding="utf-8"\)/u,
    "the ingress-evidence validator still uses universal newlines",
  );
});

test("every handler that restores service survives a dropped connection", async () => {
  // The reconcile frame was hardened first and proved out; the SAME two bugs sat
  // untouched in the frame that brackets the actual deployment, and in the backup.
  // A handler that restarts containers or units, entered with ingress already
  // quiesced, must not be killable by the signal that most often causes it to run.
  const handlers = [
    ["deploy.sh", "finish_reconcile"],
    ["deploy.sh", "finish_deploy"],
    ["deploy.sh", "recover_previous_application"],
    ["rollback.sh", "finish_rollback"],
    ["backup.sh", "finish_backup"],
  ];

  for (const [file, name] of handlers) {
    const text = await readFile(path.join(remote, file), "utf8");
    const body = bashFunction(text, name);
    // Each handler's comment quotes the defective construct deliberately, to
    // explain why it is gone, so strip comments before looking for real traps.
    const code = body.replace(/^\s*#.*$/gmu, "");

    assert.doesNotMatch(
      code,
      /trap - EXIT HUP INT TERM/u,
      `${file}:${name} restores the DEFAULT terminate disposition for HUP/INT/TERM`,
    );
    // Trapped to a command, never to '': SIG_IGN survives execve and would make
    // this handler's own docker and systemctl children unkillable.
    assert.match(code, /trap 'warn "[^"]+"' HUP INT TERM/u, `${file}:${name} must catch, not default`);
    assert.doesNotMatch(code, /trap '' HUP INT TERM/u, `${file}:${name} must not leak SIG_IGN to children`);
    // PIPE, because these handlers log and warn to an ssh channel that a dropped
    // connection has already closed — and `log` writes to stdout, so trapping
    // only around stderr writes is not enough.
    assert.match(code, /trap ':' PIPE/u, `${file}:${name} must survive a dead output channel`);
    // Ordering: signals first, so nothing lands in the gap before EXIT is cleared.
    assert.ok(
      at(code, "trap 'warn") < at(code, "trap - EXIT"),
      `${file}:${name} must install the signal traps before clearing EXIT`,
    );
  }
});

test("an armed transaction that cannot commit still reopens public ingress", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const finish = bashFunction(deploy, "finish_deploy");

  // An armed candidate is never aborted, only resumed — so this path does not
  // roll back, and it used to exit with all four ingress units stopped and the
  // stack down. The wearer stayed connection-refused until a human noticed, and
  // the resume could not start either: preflight refuses when the Cloudflare
  // units are not running, so the gate protecting the tunnel could not run while
  // the tunnel was down. That deadlock cost a real 25-minute outage.
  assert.match(
    finish,
    /rollback_needed=0\n\s*status=1\n\s*reopen_pending_candidate_ingress "\$ingress_evidence"/u,
    "the armed-preserve path must reopen ingress before it exits",
  );

  const reopen = bashFunction(deploy, "reopen_pending_candidate_ingress");
  // The CANDIDATE stack, never the predecessor: live mutation has begun, and
  // starting the previous release against a store the candidate has touched is
  // the one thing this file never does.
  assert.match(reopen, /"\$\{COMPOSE\[@\]\}" up -d --pull never --no-build/u);
  assert.doesNotMatch(reopen, /start_recorded_containers/u);
  // It reopens; it never claims the transaction advanced.
  assert.match(reopen, /reopen_recorded_ingress_best_effort "\$evidence"/u);
  assert.doesNotMatch(reopen, /\bRECONCILE_RECOVERED\b/u);
  assert.doesNotMatch(reopen, /POINTER_TRANSACTION_COMMITTED|operation-action complete/u);
});

test("the public ingress window is never recorded as closed while it is open", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const finish = bashFunction(deploy, "finish_deploy");

  // This keyed on RECOVERY_FAILED, a marker the armed-preserve path never writes
  // because recovery there is FORBIDDEN rather than failed. So a deploy recorded
  // "public ingress was down for 379s, ending <time>" while all four units were
  // still stopped. A measurement that says the outage ended when it has not is
  // worse than no measurement: it is what an operator reads to decide nothing is
  // wrong. It derives from the live units now.
  assert.match(
    finish,
    /if reconcile_ingress_disturbed "\$ingress_evidence"; then\n\s*warn "public ingress is STILL DOWN/u,
    "the still-down warning must derive from live unit state, not from a marker",
  );
  assert.ok(
    at(finish, "reconcile_ingress_disturbed") < at(finish, "record_public_ingress_window"),
    "the live check must run before the window is recorded",
  );
});

test("a RETURN trap cannot delete its caller's directory", async () => {
  const common = await commonLibrarySource();

  // A RETURN trap set inside a function is NOT removed when that function
  // returns. It stays installed and fires AGAIN when the caller returns,
  // evaluated in the caller's scope — so a trap body naming a common variable
  // like `work` expands to the CALLER's value the second time.
  //
  // That deleted the resume's evidence directory between writing it and reading
  // it (capture_postgres_data and capture_resume_candidate_evidence both declare
  // a local `work`), surfacing as "install: cannot create regular file ... No
  // such file or directory" and refusing a deploy with ingress already quiesced.
  // Verified on bash 5.2.21 and 5.3.15.
  const traps = [...common.matchAll(/trap '([^']*)' RETURN/gu)];
  assert.ok(traps.length >= 2, "expected the RETURN traps to still be here");
  for (const [whole, body] of traps) {
    assert.match(
      body,
      /;\s*trap - RETURN$/u,
      `a RETURN trap that does not clear itself fires again in the caller's scope: ${whole}`,
    );
  }
});

test("the zero-delta gate ignores Keycloak session churn and nothing else", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const filter = bashFunction(deploy, "zero_delta_volatile_filtered");

  // Exactly two relations, both Keycloak session storage. They are mutated by any
  // authentication, and inside a quiesced window the only thing that can
  // authenticate is the deploy's own wearer canary — so comparing them measures
  // the instrument, not the candidate, and failed every resume.
  assert.match(filter, /\$1 == "keycloak" && \$2 == "public"/u);
  assert.match(filter, /\$3 == "offline_user_session" \|\| \$3 == "offline_client_session"/u);
  // Nothing else may join them without this test being changed deliberately.
  const relations = [...filter.matchAll(/\$3 == "([a-z_]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(relations.sort(), ["offline_client_session", "offline_user_session"]);
  // cosmos is never filtered: that is the wearer's data.
  assert.doesNotMatch(filter, /"cosmos"/u);

  // The gate still compares, and still fails by the same name.
  const compare = bashFunction(deploy, "compare_precommit_compatibility_state");
  assert.match(compare, /zero_delta_volatile_filtered "\$before\/postgres-data\.tsv"/u);
  assert.match(compare, /zero_delta_volatile_filtered "\$data_after"/u);
  assert.match(compare, /fail "\$context: postgres-data\.tsv"/u);
  // The schema half is untouched, and the byte-exact artifacts stay byte-exact.
  assert.match(compare, /compare_schema_manifests "\$schema_before" "\$schema_after" "\$context"/u);
  assert.match(compare, /cmp -s "\$before\/\$name" "\$after\/\$name" \|\| fail "\$context: \$name"/u);
});
