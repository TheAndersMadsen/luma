import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ordering over script source is asserted through guarded offsets only: a bare
// indexOf answers -1 for a deleted token and -1 < n is true, which is how every
// assertion in the wearer channel-key ordering test below became satisfiable by
// deleting the very flags it names. See source-offsets.mjs.
import { at, lastAt } from "./source-offsets.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const transaction = path.join(workspace, "platform/deploy/vps/remote/transaction.py");
const remote = path.join(workspace, "platform/deploy/vps/remote");
const releaseA = "a".repeat(64);
const releaseB = "b".repeat(64);

function execute(args, expected = 0) {
  const result = spawnSync("python3", [transaction, ...args], { encoding: "utf8" });
  assert.equal(result.status, expected, `transaction exited ${result.status}: ${result.stderr}`);
  return result;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-authority-")));
  for (const release of [releaseA, releaseB]) await mkdir(path.join(root, "releases", release), { recursive: true });
  for (const record of ["deploy-a", "deploy-b", "deploy-c"]) await mkdir(path.join(root, "deployments", record), { recursive: true });
  await symlink(path.join(root, "releases", releaseA), path.join(root, "current"));
  await symlink(path.join(root, "deployments", "deploy-a"), path.join(root, "current-deployment"));
  return root;
}

function deployArgs(root, record, desiredRelease, oldRelease, oldRecord, desiredPrevious = "") {
  return [
    "--root", root, "--record", record, "--namespace", "deploy",
    "--old-current", oldRelease, "--old-current-deployment", oldRecord,
    "--desired-current", desiredRelease, "--desired-previous", desiredPrevious,
    "--desired-current-deployment", record,
  ];
}

function rollbackArgs(root, record, desiredRelease, desiredRecord) {
  return [
    "--root", root, "--record", record, "--namespace", "rollback",
    "--old-current", path.join(root, "releases", releaseA),
    "--old-current-deployment", path.join(root, "deployments", "deploy-a"),
    "--desired-current", desiredRelease,
    "--desired-previous", path.join(root, "releases", releaseA),
    "--desired-current-deployment", desiredRecord,
  ];
}

function operationArgs(root, record, namespace = "deploy") {
  return [
    "--root", root, "--record", record, "--namespace", namespace,
    "--operation-ingress-evidence", path.join(record, "ingress-active.tsv"),
  ];
}

async function replaceLink(link, target) {
  const temporary = `${link}.fixture`;
  await symlink(target, temporary);
  await rename(temporary, link);
}

async function linkTarget(link) {
  const raw = await readlink(link);
  return path.resolve(path.dirname(link), raw);
}

test("a stale rollback globally excludes a newer deploy until exact rollback reconciliation", async () => {
  const root = await fixture();
  const recordA = path.join(root, "deployments", "deploy-a");
  const recordB = path.join(root, "deployments", "deploy-b");
  const recordC = path.join(root, "deployments", "deploy-c");
  await writeFile(path.join(recordB, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  const rollback = rollbackArgs(root, recordA, path.join(root, "releases", releaseB), recordB);
  execute([...rollback, "--prepare-only"]);

  const inventory = JSON.parse(execute(["--root", root, "--inventory"]).stdout);
  assert.deepEqual(inventory.active, [{ namespace: "rollback", record: recordA }]);
  const deploy = deployArgs(
    root, recordB, path.join(root, "releases", releaseB),
    path.join(root, "releases", releaseA), recordA,
  );
  const refused = spawnSync("python3", [transaction, ...deploy, "--prepare-only"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /foreign authority transaction/u);
  await assert.rejects(readFile(path.join(recordB, "POINTER_TRANSACTION_PREPARED")));

  await writeFile(path.join(recordA, "ROLLBACK_INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
  execute([...rollback, "--failpoint", "after-current"], 86);
  execute(["--root", root, "--record", recordA, "--namespace", "rollback", "--reconcile"]);
  assert.equal(await linkTarget(path.join(root, "current")), path.join(root, "releases", releaseB));
  assert.equal(await linkTarget(path.join(root, "current-deployment")), recordB);
  await writeFile(path.join(recordA, "MANUAL_ROLLBACK"), "complete\n", { mode: 0o600 });
  assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, []);

  await writeFile(path.join(recordC, "release-id"), `${releaseA}\n`, { mode: 0o600 });
  execute([
    ...deployArgs(
      root, recordC, path.join(root, "releases", releaseA),
      path.join(root, "releases", releaseB), recordB, path.join(root, "releases", releaseB),
    ),
    "--old-previous", path.join(root, "releases", releaseA),
    "--prepare-only",
  ]);
  assert.match(await readFile(path.join(recordC, "POINTER_TRANSACTION_PREPARED"), "utf8"), /prepared/u);
});

test("both namespaces in one record are diagnosed as conflicting global authority", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  execute([
    ...deployArgs(
      root, record, path.join(root, "releases", releaseB),
      path.join(root, "releases", releaseA), path.join(root, "deployments", "deploy-a"),
      path.join(root, "releases", releaseA),
    ),
    "--prepare-only",
  ]);
  const deployJournal = JSON.parse(await readFile(path.join(record, "POINTER_TRANSACTION.json"), "utf8"));
  const rollbackJournal = { ...deployJournal, namespace: "rollback" };
  await writeFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION.json"), `${JSON.stringify(rollbackJournal)}\n`, { mode: 0o600 });
  await writeFile(path.join(record, "ROLLBACK_POINTER_TRANSACTION_PREPARED"), "prepared\n", { mode: 0o600 });
  const result = spawnSync("python3", [transaction, "--root", root, "--inventory"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple unfinished authority transactions/u);
});

test("only the deploy and rollback authority namespaces exist", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  await writeFile(path.join(record, "ingress-active.tsv"), "nginx.service\tactive\n", { mode: 0o600 });
  for (const mode of ["pointer", "operation"]) {
    const args = mode === "pointer"
      ? [...deployArgs(root, record, path.join(root, "releases", releaseB), path.join(root, "releases", releaseA), path.join(root, "deployments", "deploy-a")), "--namespace", "shadow", "--prepare-only"]
      : [...operationArgs(root, record), "--namespace", "shadow", "--operation-action", "prepare"];
    const result = spawnSync("python3", [transaction, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid transaction namespace/u);
  }
  assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, []);
  await assert.rejects(readFile(path.join(record, "SHADOW_POINTER_TRANSACTION_PREPARED")));
});

test("operation authority survives every pre-quiescence and quiescence crash boundary", async (t) => {
  const boundaries = [
    ["after-operation-journal", "prepare", false],
    ["after-operation-prepared", "prepare", true],
    ["after-operation-quiescing", "quiescing", true],
    ["after-operation-quiesced", "quiesced", true],
  ];
  for (const [boundary, action, authoritative] of boundaries) await t.test(boundary, async () => {
    const root = await fixture();
    const record = path.join(root, "deployments", "deploy-b");
    await writeFile(path.join(record, "ingress-active.tsv"), [
      "nginx.service\tactive", "cloudflared.service\tinactive",
      "penumbra-center-bridge.service\tactive", "",
    ].join("\n"), { mode: 0o600 });
    const base = operationArgs(root, record);
    if (action !== "prepare") execute([...base, "--operation-action", "prepare"]);
    if (action === "quiesced") execute(["--root", root, "--record", record, "--namespace", "deploy", "--operation-action", "quiescing"]);
    execute([
      ...(action === "prepare" ? base : ["--root", root, "--record", record, "--namespace", "deploy"]),
      "--operation-action", action, "--failpoint", boundary,
    ], 86);
    const inventory = JSON.parse(execute(["--root", root, "--inventory"]).stdout).active;
    assert.deepEqual(inventory, authoritative ? [{ namespace: "deploy", record }] : []);
    if (authoritative) {
      execute(["--root", root, "--record", record, "--namespace", "deploy", "--operation-action", "verify"]);
      execute(["--root", root, "--record", record, "--namespace", "deploy", "--operation-action", "abort"]);
      assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, []);
    }
  });
});

test("operation and pointer phases share one global authority identity", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  await writeFile(path.join(record, "ingress-active.tsv"), "nginx.service\tactive\n", { mode: 0o600 });
  execute([...operationArgs(root, record), "--operation-action", "prepare"]);
  execute([
    ...deployArgs(root, record, path.join(root, "releases", releaseB), path.join(root, "releases", releaseA), path.join(root, "deployments", "deploy-a"), path.join(root, "releases", releaseA)),
    "--prepare-only",
  ]);
  assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, [
    { namespace: "deploy", record },
  ]);
  await writeFile(path.join(record, "POINTER_TRANSACTION_ABORTED"), "aborted\n", { mode: 0o600 });
  execute(["--root", root, "--record", record, "--namespace", "deploy", "--operation-action", "abort"]);
  assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, []);
});

test("operation authority rejects changed ingress recovery evidence", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  const evidence = path.join(record, "ingress-active.tsv");
  await writeFile(evidence, "nginx.service\tactive\n", { mode: 0o600 });
  execute([...operationArgs(root, record), "--operation-action", "prepare"]);
  await writeFile(evidence, "nginx.service\tinactive\n", { mode: 0o600 });
  const result = spawnSync("python3", [transaction, "--root", root, "--inventory"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingress evidence changed/u);
});

test("reconciliation rejects a pointer mixture that is not an exact publication boundary", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
  execute([
    ...deployArgs(
      root, record, path.join(root, "releases", releaseB),
      path.join(root, "releases", releaseA), path.join(root, "deployments", "deploy-a"),
      path.join(root, "releases", releaseA),
    ),
    "--prepare-only",
  ]);
  // current cannot advance before previous; this is not one of the four legal
  // durable publication states.
  await replaceLink(path.join(root, "current"), path.join(root, "releases", releaseB));
  const result = spawnSync("python3", [
    transaction, "--root", root, "--record", record, "--namespace", "deploy", "--reconcile", "--prepare-only",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact prepared publication boundary/u);
  assert.equal(await linkTarget(path.join(root, "current-deployment")), path.join(root, "deployments", "deploy-a"));
  await assert.rejects(readFile(path.join(record, "SUCCEEDED")));
});

test("every pointer and final-marker boundary remains restart convergent under the global inventory", async (t) => {
  const boundaries = [
    "after-application-committed", "after-previous", "after-current", "after-current-deployment",
    "before-committed", "after-committed", "after-success",
  ];
  for (const boundary of boundaries) await t.test(boundary, async () => {
    const root = await fixture();
    const record = path.join(root, "deployments", "deploy-b");
    await writeFile(path.join(record, "release-id"), `${releaseB}\n`, { mode: 0o600 });
    await writeFile(path.join(record, "INGRESS_ACTIVATED"), "accepted\n", { mode: 0o600 });
    const args = deployArgs(
      root, record, path.join(root, "releases", releaseB),
      path.join(root, "releases", releaseA), path.join(root, "deployments", "deploy-a"),
    );
    execute([...args, "--failpoint", boundary], 86);
    execute(["--root", root, "--record", record, "--namespace", "deploy", "--reconcile"]);
    assert.equal(await linkTarget(path.join(root, "current")), path.join(root, "releases", releaseB));
    assert.equal(await linkTarget(path.join(root, "current-deployment")), record);
    assert.match(await readFile(path.join(record, "SUCCEEDED"), "utf8"), /accepted/u);
    assert.deepEqual(JSON.parse(execute(["--root", root, "--inventory"]).stdout).active, []);
  });
});

test("channel-key metadata migration is backup-bound, byte-preserving, and exactly reversible", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  const data = path.join(root, "center-data");
  const key = path.join(data, "channel-key.json");
  const contract = path.join(root, "backup-invariants.tsv");
  await mkdir(data);
  const body = '{"kid":"fixture","key":"MDEyMzQ1Njc4OWFiY2RlZg=="}\n';
  await writeFile(key, body, { mode: 0o600 });
  await chmod(key, 0o600);
  const metadata = await lstat(key);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  await writeFile(contract, [
    "contract.schema\tdk.andersmadsen.ai-pin-revival.backup-invariants",
    "contract.version\t1",
    "center.channel_key.presence\tpresent",
    `center.channel_key.sha256\t${digest}`,
    "center.channel_key.mode\t600",
    `center.channel_key.owner\t${metadata.uid}:${metadata.gid}`,
    "",
  ].join("\n"), { mode: 0o600 });
  const common = [
    "--root", root, "--record", record, "--channel-key-path", key,
    "--channel-key-contract", contract,
  ];
  execute([
    ...common, "--channel-key-action", "prepare", "--channel-key-desired-mode", "640",
    "--channel-key-desired-uid", String(metadata.uid), "--channel-key-desired-gid", String(metadata.gid),
  ]);
  execute(["--root", root, "--record", record, "--channel-key-action", "apply"]);
  assert.equal((await lstat(key)).mode & 0o777, 0o640);
  assert.equal(crypto.createHash("sha256").update(await readFile(key)).digest("hex"), digest);
  execute(["--root", root, "--record", record, "--channel-key-action", "restore"]);
  assert.equal((await lstat(key)).mode & 0o777, 0o600);
  assert.equal(crypto.createHash("sha256").update(await readFile(key)).digest("hex"), digest);
  assert.match(await readFile(path.join(record, "CHANNEL_KEY_METADATA_COMMITTED"), "utf8"), /apply/u);
  assert.match(await readFile(path.join(record, "CHANNEL_KEY_METADATA_RESTORED"), "utf8"), /restore/u);
});

test("trust-root evidence binds the exact live inodes, bytes, modes, owners, and extended metadata", async () => {
  const root = await fixture();
  const record = path.join(root, "deployments", "deploy-b");
  const paths = {};
  for (const kind of ["attest", "duc"]) {
    const directory = path.join(root, "live", kind);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, kind === "attest" ? "ca.key" : "duc-ca.key"), `${kind}\n`, { mode: 0o600 });
    paths[`live_${kind}`] = directory;
  }
  execute([
    "--root", root, "--record", record, "--trust-root-action", "record",
    "--staged-attest", paths.live_attest, "--staged-duc", paths.live_duc,
    "--live-attest", paths.live_attest, "--live-duc", paths.live_duc,
  ]);
  execute([
    "--root", root, "--record", record, "--trust-root-action", "verify",
    "--live-attest", paths.live_attest, "--live-duc", paths.live_duc,
  ]);
  const original = path.join(paths.live_attest, "ca.key");
  const displaced = `${original}.old`;
  await rename(original, displaced);
  await writeFile(original, "attest\n", { mode: 0o600 });
  const swapped = spawnSync("python3", [
    transaction, "--root", root, "--record", record, "--trust-root-action", "verify",
    "--live-attest", paths.live_attest, "--live-duc", paths.live_duc,
  ], { encoding: "utf8" });
  assert.notEqual(swapped.status, 0);
  assert.match(swapped.stderr, /drifted from the staged zero-delta evidence/u);
});

test("deploy and rollback wire global inventory, trust proof, and reversible key ownership before starts", async () => {
  const deploy = await readFile(path.join(remote, "deploy.sh"), "utf8");
  const rollback = await readFile(path.join(remote, "rollback.sh"), "utf8");
  const candidateStart = lastAt(deploy, '"${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans');
  assert.ok(
    at(deploy, "--inventory") < at(deploy, "record_project_state"),
    "deploy must take the global authority inventory before it records project state",
  );
  assert.ok(
    lastAt(deploy, "--channel-key-action apply", candidateStart) < candidateStart,
    "the wearer channel key must be applied before the candidate containers start",
  );
  assert.ok(
    lastAt(deploy, "--trust-root-action", candidateStart) < candidateStart,
    "staged trust roots must be proven before the candidate containers start",
  );
  assert.ok(
    at(rollback, "--inventory") < at(rollback, "snapshot_current_config"),
    "rollback must take the global authority inventory before it snapshots live configuration",
  );
  const targetStart = lastAt(rollback, '"${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans');
  assert.ok(
    lastAt(rollback, "--channel-key-action restore", targetStart) < targetStart,
    "the wearer channel key must be restored before the rollback target containers start",
  );
  assert.ok(
    lastAt(rollback, "--trust-root-action record", targetStart) < targetStart,
    "the rollback target's trust roots must be recorded before its containers start",
  );
  assert.doesNotMatch(deploy + rollback, /confirm-database-restore/u);
});

/*
 * The `--confirm-database-restore` refusals, executed.
 *
 * The flag was documented on three surfaces and implemented in none, so the one
 * command the runbook named as the safe path answered a bare `usage:` —
 * indistinguishable from an operator typo — at exactly the moment someone
 * reached for it. Round 4 replaced that with a loud, named refusal on both
 * surfaces that can receive the argument: the local wrapper
 * (platform/deploy/vps/rollback.sh) and the CLI (`./revival rollback`).
 *
 * Neither refusal was pinned. The assertion directly above this block —
 * `assert.doesNotMatch(deploy + rollback, /confirm-database-restore/u)` — reads
 * the two REMOTE drivers and asserts the flag's ABSENCE there; it says nothing
 * about the two places the refusal actually lives. Deleting the case arm, or the
 * `args.includes(...)` branch in the CLI, put the flag straight back to being
 * silently accepted and dropped, with the whole suite green.
 *
 * These run the real programs. `ssh` is stubbed onto PATH and asserted never to
 * have been called, because the property is not only "it refuses" but "it
 * refuses before it touches the host" — a refusal that happens after a
 * connection has already been made is a different, and much later, failure.
 */

const wrapperPath = path.join(workspace, "platform/deploy/vps/rollback.sh");
const cliPath = path.join(workspace, "revival");

async function refusalHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-restore-refusal-"));
  const marker = path.join(directory, "ssh-was-called");
  const stub = path.join(directory, "ssh");
  await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >>"${marker}"\nexit 1\n`);
  await chmod(stub, 0o755);
  return {
    marker,
    run(command, args) {
      return spawnSync(command, args, {
        encoding: "utf8",
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          // If a future edit ever let one of these reach the network, it must not
          // reach the production host from a test run.
          REVIVAL_DEPLOY_REMOTE: "revival-acceptance-must-not-connect",
        },
      });
    },
  };
}

test("the rollback wrapper refuses --confirm-database-restore by name, before any host contact", async () => {
  const harness = await refusalHarness();
  for (const argv of [
    ["--deployment", "deploy-a", "--confirm-database-restore"],
    // The arm is a glob (`--confirm-database-restore*`) precisely so the `=value`
    // spelling an operator might type is answered with the reason too.
    ["--confirm-database-restore=yes", "--deployment", "deploy-a"],
  ]) {
    const result = harness.run("bash", [wrapperPath, ...argv]);
    assert.equal(result.status, 64, `wrapper exited ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /rollback never restores a database; --confirm-database-restore is not implemented anywhere\./u);
    // The refusal has to end somewhere an operator can act on, or it is a
    // slightly politer usage error.
    assert.match(result.stderr, /docs\/recovery\.md \(Restoring a database\)/u);
    assert.equal(existsSync(harness.marker), false, "the wrapper contacted the host before refusing");
  }

  // A genuinely unknown argument must still be a bare usage error. Without this,
  // the two assertions above are satisfied by a catch-all that prints the
  // database sentence for every typo — which would make the specific,
  // reason-giving refusal indistinguishable from the failure it replaced.
  const unknown = harness.run("bash", [wrapperPath, "--deployment", "deploy-a", "--not-a-flag"]);
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /^usage: /mu);
  assert.doesNotMatch(unknown.stderr, /confirm-database-restore/u);
  assert.equal(existsSync(harness.marker), false);
});

test("the CLI refuses --confirm-database-restore by name, before any host contact", async () => {
  const harness = await refusalHarness();
  const result = harness.run("node", [cliPath, "rollback", "--deployment", "deploy-a", "--confirm-database-restore"]);
  assert.equal(result.status, 64, `CLI exited ${result.status}: ${result.stderr}${result.stdout}`);
  const said = `${result.stderr}${result.stdout}`;
  assert.match(said, /--confirm-database-restore is not a command this project implements\./u);
  assert.match(said, /docs\/recovery\.md \(Restoring a database\)/u);
  // And it must say what rollback DOES do, because the operator reaching for
  // this flag believes rollback discards post-cutover writes and it does not.
  assert.match(said, /leaves every\s+post-cutover write in place/u);
  assert.equal(existsSync(harness.marker), false, "the CLI contacted the host before refusing");
});

test("no runbook offers --confirm-database-restore as a command again", async () => {
  /*
   * The docs are the surface that created this bug: operations.md and
   * recovery.md advertised the flag for long enough that it entered muscle
   * memory. Both now describe it only in the past tense, as a claim that was
   * removed — so the rule is about RUNNABLE text. A fenced block is what someone
   * copies; prose that says the flag never existed is the correction and must
   * stay.
   */
  for (const name of ["operations.md", "recovery.md"]) {
    const body = await readFile(path.join(workspace, "docs", name), "utf8");
    const fenced = [...body.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gmu)].map((block) => block[1]);
    assert.ok(fenced.length > 0, `docs/${name} has no fenced command blocks; the scan below would be vacuous`);
    for (const block of fenced) {
      assert.doesNotMatch(
        block,
        /--confirm-database-restore/u,
        `docs/${name} offers --confirm-database-restore in a copyable command block`,
      );
    }
  }

  // And the correction itself is pinned, because deleting the paragraph is how
  // the claim comes back: a reader who finds neither the flag nor a statement
  // that it never existed is back where this started.
  const operations = await readFile(path.join(workspace, "docs/operations.md"), "utf8");
  assert.match(operations, /\*\*There is no database-restore command, and rollback has no flag that adds\s+one\.\*\*/u);
  const recovery = await readFile(path.join(workspace, "docs/recovery.md"), "utf8");
  assert.match(recovery, /^\*\*There is no command for this, and rollback is not one\.\*\*$/mu);
  assert.match(recovery, /^## Restoring a database$/mu);
});
