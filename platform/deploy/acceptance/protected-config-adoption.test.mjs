import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * THE PROTECTED-CONFIGURATION DEADLOCK, AND THE SHAPE OF ITS ONLY SAFE EXIT.
 *
 * `record_configuration_evidence` fingerprints every protected input of a
 * deployment into that deployment's config-digests.tsv, and
 * `verify_configuration_evidence` re-records them at each later gate and refuses
 * the deploy if one row moved. Correct, and untouched by any of this.
 *
 * What had no answer was a LEGITIMATE change. The Pin's server package was
 * reinstalled during boot-loop recovery and its iroh node identity was
 * regenerated, so the ticket in /etc/penumbra addressed a node that no longer
 * existed: every request hung at "connecting to Pin via iroh", the Spotify
 * adapter answered {"adapter":"ready","upstream":"unavailable"}, and the canary
 * refused. Repairing it means editing /etc/penumbra, which IS the bridge.config
 * row. Old ticket => canary fails. New ticket => "protected configuration or
 * rendered Compose model drift", refused before quiescing. Four attempts, a long
 * outage window, and it ended with a digest row hand-edited into a deployment
 * record: the exact act the control exists to prevent, done with no record and
 * no signal at all.
 *
 * A second trap cost an hour on top. THERE ARE TWO DRIFT COMPARISONS AND THEY
 * USE DIFFERENT BASELINES. On the resume path verify_configuration_evidence runs
 * against the PENDING/ARMED record (deploy.sh:722 and :810) and fires BEFORE
 * preflight's comparison against current-deployment (deploy.sh:1384). Diagnosing
 * against the wrong one led to adopting a digest into a record nothing was
 * consulting; that edit had to be reverted.
 *
 * These tests pin the CLASS of guarantee `revival adopt-config` has to keep, not
 * the spelling of how it keeps it. Rewrite the implementation freely; these must
 * still hold:
 *
 *   1. it shows before it acts, down to the file under a changed directory;
 *   2. it names the baseline it picked and why, and handles both when both apply;
 *   3. nothing changes without --confirm and a reason in the operator's words;
 *   4. the deployment record learns what happened, durably;
 *   5. it rewrites the rows it displayed and nothing else, and refuses if the
 *      file moved between showing and adopting;
 *   6. it can never be reached from, or weaken, the gate it exists beside.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = path.join(root, "platform/deploy/vps/remote");
const driver = path.join(remote, "adopt-config.py");
const entryPoint = path.join(remote, "adopt-config.sh");
const localWrapper = path.join(root, "platform/deploy/vps/adopt-config.sh");
const commonPath = path.join(remote, "common.sh");
const cli = path.join(root, "revival");

const commonSource = await readFile(commonPath, "utf8");
const entrySource = await readFile(entryPoint, "utf8");
const localSource = await readFile(localWrapper, "utf8");
const driverSource = await readFile(driver, "utf8");
const cliSource = await readFile(cli, "utf8");

const REASON = "Pin regenerated its iroh node identity during boot-loop recovery; re-ticketed the bridge.";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortRows(rows) {
  // record_configuration_evidence sorts with LC_ALL=C over whole lines, and a
  // rewritten file has to come out byte-identical to a fresh recording or the
  // gate it is meant to satisfy still refuses it.
  return [...rows].sort((left, right) => (Buffer.from(left).compare(Buffer.from(right))));
}

function evidence(rows) {
  return sortRows(rows).map((row) => `${row}\n`).join("");
}

/* The row shapes record_configuration_evidence_with_env actually writes. */
function baseRows({ bridgeConfig = "old", bridgeState = "state-old" } = {}) {
  return [
    `file\tcenter.env\t${digest("center")}\t600\t1000:1000`,
    `file\tcosmos.env\t${digest("cosmos")}\t600\t1000:1000`,
    `file\truntime.env\t${digest("runtime")}\t600\t1000:1000`,
    `symlink\tnginx.enabled\t${digest("link")}\t777\t0:0`,
    `protected\tbridge.config\t${digest(bridgeConfig)}\t-\t-`,
    `protected\tbridge.state\t${digest(bridgeState)}\t-\t-`,
    `protected\tedge.security\t${digest("edge")}\t-\t-`,
    `rendered\tcompose.json\t${digest("compose")}\t-\t-`,
  ];
}

async function fixture(options = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-adopt-")));
  const records = options.records ?? ["deploy-current"];
  for (const name of records) {
    await mkdir(path.join(directory, "deployments", name), { recursive: true });
    await writeFile(
      path.join(directory, "deployments", name, "config-digests.tsv"),
      evidence(options.recordedRows ?? baseRows()),
      { mode: 0o600 },
    );
  }
  await writeFile(path.join(directory, "live.tsv"), evidence(options.liveRows ?? baseRows()), { mode: 0o600 });
  return directory;
}

async function writeRequest(directory, baselines, { inventory = null } = {}) {
  const request = {
    schemaVersion: 1,
    inventory: inventory ?? path.join(directory, "absent-inventory.tsv"),
    appliedList: path.join(directory, "applied.tsv"),
    baselines,
  };
  const file = path.join(directory, "request.json");
  await writeFile(file, JSON.stringify(request), { mode: 0o600 });
  return file;
}

function baseline(directory, kind, record, { protectedPaths = {} } = {}) {
  return {
    kind,
    record: path.join(directory, "deployments", record),
    releaseDir: path.join(directory, "releases", kind === "pending" ? "b".repeat(64) : "a".repeat(64)),
    releaseId: (kind === "pending" ? "b" : "a").repeat(64),
    evidence: path.join(directory, "deployments", record, "config-digests.tsv"),
    live: path.join(directory, "live.tsv"),
    protectedPaths,
  };
}

function runDriver(request, extra = []) {
  return spawnSync("python3", [driver, "--request", request, ...extra], { encoding: "utf8" });
}

/*
 * Every invocation of the LOCAL wrapper in this file runs with an `ssh` that
 * cannot connect and says so loudly. Two reasons, and the second is the
 * important one:
 *
 *   - a test suite must never dial production, and the local wrapper's default
 *     remote is the real server;
 *   - "this refusal happens before any connection" is a property worth pinning,
 *     and the only way to pin it is to make a connection observable. A test that
 *     merely asserts a non-zero exit is satisfied by a wrapper that ssh'd to the
 *     server and had the far side refuse instead.
 */
const SSH_REACHED = "REVIVAL-TEST-SSH-WAS-INVOKED";
const shimBin = await mkdtemp(path.join(os.tmpdir(), "revival-adopt-noconnect-"));
await writeFile(path.join(shimBin, "ssh"), `#!/bin/sh\necho ${SSH_REACHED} >&2\nexit 41\n`, { mode: 0o755 });
await chmod(path.join(shimBin, "ssh"), 0o755);

function runLocalWrapper(...args) {
  return spawnSync("bash", [localWrapper, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimBin}${path.delimiter}${process.env.PATH}` },
  });
}

function assertNoConnectionAttempted(result, label) {
  assert.doesNotMatch(result.stderr ?? "", new RegExp(SSH_REACHED, "u"), `${label} must refuse before it connects`);
}

function tokenOf(output) {
  const match = /plan token\s+([0-9a-f]{64})/u.exec(output);
  assert.ok(match, `no plan token in output:\n${output}`);
  return match[1];
}

/* ---------- 1. it shows before it acts -------------------------------------- */

test("the plan names every differing row with both digests, and changes nothing", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);
  const evidencePath = path.join(directory, "deployments", "deploy-current", "config-digests.tsv");
  const before = await readFile(evidencePath, "utf8");

  const result = runDriver(request);
  assert.equal(result.status, 0, result.stderr);

  // The row by name, and BOTH sides of it. A gate that says only "drift" is the
  // reason this tool exists; a plan that says only "bridge.config changed" would
  // repeat the mistake one level up.
  assert.match(result.stdout, /bridge\.config/u);
  assert.match(result.stdout, new RegExp(digest("old"), "u"));
  assert.match(result.stdout, new RegExp(digest("new"), "u"));
  // And the rows that did NOT move are accounted for, so "only what I intended
  // changed" is a thing the operator can actually read off the screen.
  assert.match(result.stdout, /ROWS THAT MATCH \(\d+\)/u);

  assert.equal(await readFile(evidencePath, "utf8"), before, "a plan must not write");
});

test("a changed protected directory is reported down to the files underneath it", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const penumbra = path.join(directory, "etc-penumbra");
  await mkdir(penumbra, { recursive: true });

  // No per-file baseline exists on a first adoption, so the honest cheap answer
  // is "written after the recorded evidence" -- which is exactly the signal that
  // was missing on the night this was built: the operator needed to see
  // center-bridge.env, not a digest.
  const inventory = path.join(directory, "inventory.tsv");
  const recordedAt = (await stat(
    path.join(directory, "deployments", "deploy-current", "config-digests.tsv"),
    { bigint: true },
  )).mtimeNs;
  await writeFile(inventory, [
    `bridge.config\t.\tdir\t755\t0:0\t0\t-\t${recordedAt - 1000n}`,
    `bridge.config\t./center-bridge.env\treg\t600\t0:0\t64\t${digest("ticket-new")}\t${recordedAt + 5_000_000_000n}`,
    `bridge.config\t./unrelated.conf\treg\t644\t0:0\t3\t${digest("unrelated")}\t${recordedAt - 5_000_000_000n}`,
  ].join("\n") + "\n", { mode: 0o600 });

  const request = await writeRequest(
    directory,
    [baseline(directory, "current", "deploy-current", { protectedPaths: { "bridge.config": penumbra } })],
    { inventory },
  );
  const planned = runDriver(request);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /center-bridge\.env/u);
  assert.doesNotMatch(planned.stdout, /unrelated\.conf/u, "a file older than the baseline is not evidence of this change");
  // Whatever the basis, it has to be labelled: an mtime answer presented as
  // proof is worse than no answer.
  assert.match(planned.stdout, /heuristic|exact/u);

  // Adopting records the per-file baseline, so the NEXT change is answered
  // exactly rather than by mtime.
  const adopted = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.equal(adopted.status, 0, adopted.stderr);
  const inventoryCopy = await readFile(
    path.join(directory, "deployments", "deploy-current", "protected-inventory.tsv"),
    "utf8",
  );
  assert.match(inventoryCopy, /center-bridge\.env/u);

  // Second change: only center-bridge.env moves, and only it is named.
  await writeFile(path.join(directory, "live.tsv"), evidence(baseRows({ bridgeConfig: "newer" })), { mode: 0o600 });
  await writeFile(inventory, [
    `bridge.config\t.\tdir\t755\t0:0\t0\t-\t${recordedAt - 1000n}`,
    `bridge.config\t./center-bridge.env\treg\t600\t0:0\t64\t${digest("ticket-newer")}\t${recordedAt + 9_000_000_000n}`,
    `bridge.config\t./unrelated.conf\treg\t644\t0:0\t3\t${digest("unrelated")}\t${recordedAt - 5_000_000_000n}`,
  ].join("\n") + "\n", { mode: 0o600 });
  const exact = runDriver(request);
  assert.equal(exact.status, 0, exact.stderr);
  // Against the BASIS LINE, not the bare word "exact": the dry-run footer says
  // "adopt exactly the rows above", so /exact/ alone is satisfied by boilerplate
  // and passes just as happily against a tool that never learned the exact basis.
  assert.match(exact.stdout, /files changed under it \(exact, against this record's inventory\)/u);
  assert.doesNotMatch(exact.stdout, /heuristic/u, "with a per-file baseline recorded, the answer is no longer a guess");
  assert.match(exact.stdout, /changed\s+\.\/center-bridge\.env/u);
  assert.doesNotMatch(exact.stdout, /unrelated\.conf/u);
});

test("a row that is added or removed comes out byte-identical to a fresh recording", async () => {
  // The row set is NOT fixed. common.sh records nginx.center.available and
  // nginx.center.enabled only when the Center vhost exists, so a legitimate
  // change can add or drop a row rather than move one -- and an added row
  // substituted in place lands at the end of the file. verify_configuration_evidence
  // compares the two recordings as ORDERED LISTS, so a correctly-digested file
  // in the wrong order is still "protected configuration drift": the deadlock
  // this tool exists to break, re-created by the tool itself.
  const added = `file\tnginx.center.available\t${digest("center-nginx")}\t644\t0:0`;
  const dropped = `symlink\tnginx.enabled\t${digest("link")}\t777\t0:0`;
  const recordedRows = baseRows();
  assert.ok(recordedRows.includes(dropped), "the fixture must start with the row this test drops");
  const liveRows = [...baseRows({ bridgeConfig: "new" }).filter((row) => row !== dropped), added];
  const directory = await fixture({ recordedRows, liveRows });
  const record = path.join(directory, "deployments", "deploy-current");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);

  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ADDED\s+file nginx\.center\.available/u);
  assert.match(result.stdout, /REMOVED\s+symlink nginx\.enabled/u);

  // The gate re-records the live inputs and compares ordered lists, dropping only
  // bridge.state. So the adopted file has to equal a fresh recording byte for
  // byte, not merely row for row.
  const after = await readFile(path.join(record, "config-digests.tsv"), "utf8");
  const live = await readFile(path.join(directory, "live.tsv"), "utf8");
  assert.equal(after, live, "an adopted record must be what record_configuration_evidence would have written");
  const lines = after.split("\n").filter(Boolean);
  assert.deepEqual(lines, sortRows(lines), "the rewritten evidence is sorted the way common.sh sorts it");
});

/* ---------- 2. the baseline, and why -------------------------------------- */

test("both baselines are handled explicitly and each one says why it is relevant", async () => {
  const directory = await fixture({
    records: ["deploy-pending", "deploy-current"],
    liveRows: baseRows({ bridgeConfig: "new" }),
  });
  const request = await writeRequest(directory, [
    baseline(directory, "pending", "deploy-pending"),
    baseline(directory, "current", "deploy-current"),
  ]);
  const result = runDriver(request);
  assert.equal(result.status, 0, result.stderr);

  // Neither is guessed at and neither is silently skipped.
  assert.match(result.stdout, /deploy-pending/u);
  assert.match(result.stdout, /deploy-current/u);

  // The pending record is the one the next deploy hits FIRST. Reporting them in
  // the other order is how an hour goes into adopting a digest into a file the
  // failing gate never reads.
  assert.ok(
    result.stdout.indexOf("deploy-pending") < result.stdout.indexOf("deploy-current"),
    "the pending record must be presented before current-deployment",
  );

  // And "why" is a real answer naming the gate, not a label.
  assert.match(result.stdout, /why this one/u);
  assert.match(result.stdout, /resume|prepared/iu);
  assert.match(result.stdout, /current-deployment/u);
});

test("when both roles resolve to one record it is reported once, for both roles", async () => {
  // Real, not hypothetical: between POINTER_TRANSACTION_COMMITTED and SUCCEEDED
  // the current-deployment pointer already names the record the transaction
  // inventory still reports as active. Showing it twice would also mean adopting
  // it twice -- the second pass tripping over the first pass's own write.
  const directory = await fixture({ records: ["deploy-one"], liveRows: baseRows({ bridgeConfig: "new" }) });
  const request = await writeRequest(directory, [
    baseline(directory, "pending", "deploy-one"),
    baseline(directory, "current", "deploy-one"),
  ]);
  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/ROWS THAT DIFFER/gu) ?? []).length, 1);
  assert.match(result.stdout, /Baseline 1 of 1/u);
  // Both roles are still named, because which gates were satisfied is the point.
  assert.match(result.stdout, /prepared/iu);
  assert.match(result.stdout, /current-deployment/u);
});

/* ---------- 3. explicit intent -------------------------------------------- */

test("nothing is adopted without --confirm and a reason in the operator's own words", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);
  const evidencePath = path.join(directory, "deployments", "deploy-current", "config-digests.tsv");
  const before = await readFile(evidencePath, "utf8");

  // Default is the dry run, exactly as `revival pin install` is.
  const planned = runDriver(request);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /Dry run/u);
  assert.equal(await readFile(evidencePath, "utf8"), before);

  // Intent without a reason is refused: an adoption nobody has to explain is the
  // hand-edit again, with better formatting.
  const unreasoned = runDriver(request, ["--adopt"]);
  assert.notEqual(unreasoned.status, 0);
  assert.match(unreasoned.stderr, /--reason/u);
  assert.equal(await readFile(evidencePath, "utf8"), before);

  const placeholder = runDriver(request, ["--adopt", "--reason", "fix"]);
  assert.notEqual(placeholder.status, 0);
  assert.equal(await readFile(evidencePath, "utf8"), before);
});

/* ---------- 4. the durable record ----------------------------------------- */

test("the deployment record durably learns what changed, from what, to what, and why", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const record = path.join(directory, "deployments", "deploy-current");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);
  const before = digest(await readFile(path.join(record, "config-digests.tsv")));

  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.equal(result.status, 0, result.stderr);

  const journal = (await readFile(path.join(record, "CONFIG_ADOPTION_JOURNAL.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(journal.length >= 2, "an adoption is journalled as an intent and then as a fact");
  const committed = journal.find((entry) => entry.phase === "committed");
  assert.ok(committed, "a completed adoption records that it completed");
  assert.equal(committed.reason, REASON);
  assert.equal(committed.evidenceSha256Before, before);
  assert.equal(committed.evidenceSha256After, digest(await readFile(path.join(record, "config-digests.tsv"))));
  const row = committed.rows.find((entry) => entry.label === "bridge.config");
  assert.ok(row, "the journal names the rows, not just a count");
  assert.equal(row.recorded, digest("old"));
  assert.equal(row.live, digest("new"));

  // Visible without parsing anything: an auditor scanning a record directory
  // sees at a glance that its evidence was adopted rather than recorded.
  const marker = await readFile(path.join(record, "PROTECTED_CONFIGURATION_ADOPTED"), "utf8");
  assert.match(marker, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/u);
  assert.match(marker, new RegExp(REASON.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

/* ---------- 5. only what it showed, and only if nothing moved -------------- */

test("only the displayed rows are rewritten; every other byte is carried across", async () => {
  // bridge.state moves on its own -- it is live bridge working state, and
  // verify_configuration_evidence drops it before comparing. So it is NOT drift,
  // it is NOT displayed, and it must NOT be rewritten: adopting a row no gate
  // reads is churn that looks like a change.
  const directory = await fixture({
    recordedRows: baseRows({ bridgeConfig: "old", bridgeState: "state-old" }),
    liveRows: baseRows({ bridgeConfig: "new", bridgeState: "state-new" }),
  });
  const record = path.join(directory, "deployments", "deploy-current");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);
  const before = (await readFile(path.join(record, "config-digests.tsv"), "utf8")).split("\n").filter(Boolean);

  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.equal(result.status, 0, result.stderr);
  const differing = result.stdout.slice(
    result.stdout.indexOf("ROWS THAT DIFFER"),
    result.stdout.indexOf("ROWS THAT MATCH"),
  );
  assert.match(differing, /bridge\.config/u);
  assert.doesNotMatch(differing, /bridge\.state/u, "a row the gate drops is not drift");

  const after = (await readFile(path.join(record, "config-digests.tsv"), "utf8")).split("\n").filter(Boolean);
  const key = (row) => row.split("\t").slice(0, 2).join("\t");
  const beforeByKey = new Map(before.map((row) => [key(row), row]));
  const afterByKey = new Map(after.map((row) => [key(row), row]));
  const moved = [...afterByKey].filter(([rowKey, row]) => beforeByKey.get(rowKey) !== row).map(([rowKey]) => rowKey);
  assert.deepEqual(moved, ["protected\tbridge.config"], "exactly the displayed row changed");
  assert.equal(afterByKey.get("protected\tbridge.state"), beforeByKey.get("protected\tbridge.state"));

  // And the file now satisfies the real comparison: identical to a fresh
  // recording once bridge.state is dropped, which is precisely what
  // verify_configuration_evidence does.
  const live = (await readFile(path.join(directory, "live.tsv"), "utf8")).split("\n").filter(Boolean);
  const compared = (rows) => rows.filter((row) => key(row) !== "protected\tbridge.state");
  assert.deepEqual(compared(after), compared(live));
});

test("it refuses to adopt a plan whose evidence file moved after it was shown", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const record = path.join(directory, "deployments", "deploy-current");
  const evidencePath = path.join(record, "config-digests.tsv");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);

  const planned = runDriver(request);
  assert.equal(planned.status, 0, planned.stderr);
  const token = tokenOf(planned.stdout);

  // Something else edits the record between the review and the confirmation.
  const meddled = evidence([...baseRows(), `file\tproviders.env\t${digest("providers")}\t600\t1000:1000`]);
  await writeFile(evidencePath, meddled, { mode: 0o600 });

  const refused = runDriver(request, ["--adopt", "--reason", REASON, "--expect-plan", token]);
  assert.notEqual(refused.status, 0, "the reviewed plan no longer describes the file on disk");
  assert.equal(await readFile(evidencePath, "utf8"), meddled, "a refusal writes nothing");
  const journalled = spawnSync("cat", [path.join(record, "CONFIG_ADOPTION_JOURNAL.jsonl")], { encoding: "utf8" });
  assert.doesNotMatch(journalled.stdout ?? "", /"phase": ?"committed"/u);
});

test("the plan token binds the evidence bytes, not merely the list of changes", async () => {
  // ONE record, planned twice. The surrounding rows move between the two plans
  // while the change itself stays identical, so the ONLY input that differs is
  // the bytes of the file being adopted into.
  //
  // Two separate fixtures would not prove this: they live in two temporary
  // directories, so their record paths differ and the tokens would come out
  // different even from a token that ignored the file's contents entirely.
  const extra = `file\tproviders.env\t${digest("providers")}\t600\t1000:1000`;
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const evidencePath = path.join(directory, "deployments", "deploy-current", "config-digests.tsv");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);

  const first = runDriver(request, ["--json"]);
  assert.equal(first.status, 0, first.stderr);

  await writeFile(evidencePath, evidence([...baseRows(), extra]), { mode: 0o600 });
  await writeFile(
    path.join(directory, "live.tsv"),
    evidence([...baseRows({ bridgeConfig: "new" }), extra]),
    { mode: 0o600 },
  );
  const second = runDriver(request, ["--json"]);
  assert.equal(second.status, 0, second.stderr);

  const firstPlan = JSON.parse(first.stdout);
  const secondPlan = JSON.parse(second.stdout);
  const shown = (plan) =>
    plan.baselines.map((entry) => ({ record: entry.record, kind: entry.kind, changes: entry.changes }));
  assert.deepEqual(shown(secondPlan), shown(firstPlan), "same record, same displayed change, by construction");
  assert.notEqual(
    secondPlan.baselines[0].evidenceSha256,
    firstPlan.baselines[0].evidenceSha256,
    "the file really did move between the two plans",
  );
  assert.notEqual(
    secondPlan.planToken,
    firstPlan.planToken,
    "a token that ignores the evidence bytes would let a plan reviewed against one file authorize an adoption into another",
  );
});

test("an adoption refuses the moment the evidence it displayed moves underneath it", async () => {
  // --expect-plan binds one INVOCATION's confirmation to an earlier plan. This
  // is the other half: inside a single run, between the rows being fixed for
  // display and the rewrite that acts on them. The window is real as soon as
  // more than one record is adopted, because the first rewrite lands while the
  // second record's displayed rows are already decided.
  //
  // Made deterministic with a hardlink: two records, one inode. Replacing the
  // first name unlinks the shared inode, which bumps its ctime -- so the second
  // record's evidence file is byte-identical but is provably no longer the file
  // whose differences were shown. That is exactly the "something else is editing
  // this record" signal the re-read exists to catch.
  const directory = await fixture({ records: ["deploy-first"], liveRows: baseRows({ bridgeConfig: "new" }) });
  const second = path.join(directory, "deployments", "deploy-second");
  await mkdir(second, { recursive: true });
  await link(
    path.join(directory, "deployments", "deploy-first", "config-digests.tsv"),
    path.join(second, "config-digests.tsv"),
  );
  const request = await writeRequest(directory, [
    baseline(directory, "pending", "deploy-first"),
    baseline(directory, "current", "deploy-second"),
  ]);
  const before = await readFile(path.join(second, "config-digests.tsv"), "utf8");

  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.notEqual(result.status, 0, "the second record's evidence is no longer the file that was displayed");
  assert.match(result.stderr, /changed after its differences were displayed/u);
  assert.doesNotMatch(result.stderr, /Traceback/u);
  assert.equal(
    await readFile(path.join(second, "config-digests.tsv"), "utf8"),
    before,
    "the record it refused is left exactly as it was",
  );

  const journal = (await readFile(path.join(second, "CONFIG_ADOPTION_JOURNAL.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(journal.some((entry) => entry.phase === "intent"), "the attempt is on the record");
  assert.ok(!journal.some((entry) => entry.phase === "committed"), "and it does not claim to have completed");
});

test("a write that cannot complete leaves the evidence untouched and says which half ran", async () => {
  const directory = await fixture({ liveRows: baseRows({ bridgeConfig: "new" }) });
  const record = path.join(directory, "deployments", "deploy-current");
  const evidencePath = path.join(record, "config-digests.tsv");
  const before = await readFile(evidencePath, "utf8");
  const request = await writeRequest(directory, [baseline(directory, "current", "deploy-current")]);

  // Occupy the atomic staging path so the replace cannot proceed.
  await mkdir(path.join(record, ".config-digests.tsv.adopt.tmp"), { recursive: true });

  const result = runDriver(request, ["--adopt", "--reason", REASON]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /Traceback/u, "a refused write is a refusal, not a crash");
  assert.equal(await readFile(evidencePath, "utf8"), before, "the evidence is replaced atomically or not at all");

  const journal = (await readFile(path.join(record, "CONFIG_ADOPTION_JOURNAL.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(journal.some((entry) => entry.phase === "intent"), "the attempt is on the record");
  assert.ok(!journal.some((entry) => entry.phase === "committed"), "and it does not claim to have completed");
});

/* ---------- 6. it can never weaken, or be reached from, the gate ----------- */

test("no deploy path can reach protected-configuration adoption", async () => {
  // The gate and its override may not be reachable from one another. If a deploy
  // could call this, "the deploy refused" would stop meaning anything.
  for (const name of ["deploy.sh", "preflight.sh", "rollback.sh", "drift.sh", "backup.sh", "canary.sh"]) {
    const source = await readFile(path.join(remote, name), "utf8");
    assert.doesNotMatch(source, /adopt-config/u, `${name} must not reference protected-configuration adoption`);
  }
  const localDeploy = await readFile(path.join(root, "platform/deploy/vps/deploy.sh"), "utf8");
  assert.doesNotMatch(localDeploy, /adopt-config/u);

  // And it is a separate top-level command reached on its own, not something a
  // deploy can decide to do for itself when a gate refuses.
  assert.match(cliSource, /command === 'adopt-config'/u);
  const deployBody = jsFunction(cliSource, "deployProduction");
  assert.doesNotMatch(deployBody, /adopt/u, "the deploy command must not be able to adopt anything");
  const adoptBody = jsFunction(cliSource, "adoptProtectedConfiguration");
  assert.doesNotMatch(adoptBody, /deploy\.sh|rollback\.sh/u, "adoption must not dispatch a deployment driver");
});

test("adoption holds the deployment lock and refuses to run inside a deployment driver", async () => {
  // Two independent reasons it cannot happen mid-deploy. The lock is the same
  // one deploy.sh takes, so concurrency is impossible; the ancestry check closes
  // the case where some future driver invokes it between its own lock windows.
  assert.match(entrySource, /exec 9>"\$LOCK_FILE"/u);
  assert.match(entrySource, /flock -n 9/u);

  // A guard that is defined and never called is decoration. Pin the CALL, not
  // just the definition: deleting the invocation leaves the function, its
  // comment and every behavioural probe below intact.
  const callSites = entrySource
    .split("\n")
    .filter((line) => /^\s*assert_not_inside_deployment_driver\s*$/u.test(line));
  assert.equal(callSites.length, 1, "the entry point must actually invoke the ancestry guard");
  const definedAt = entrySource.indexOf("assert_not_inside_deployment_driver() {");
  const invokedAt = entrySource.indexOf("\nassert_not_inside_deployment_driver\n");
  assert.ok(invokedAt > definedAt, "the guard is invoked after it is defined");
  assert.ok(
    invokedAt < entrySource.indexOf('exec 9>"$LOCK_FILE"'),
    "and before the tool starts taking locks and reading protected paths",
  );

  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-adopt-ancestry-")));
  const guard = bashFunction(entrySource, "assert_not_inside_deployment_driver");
  const probe = path.join(directory, "probe.sh");
  await writeFile(probe, [
    "#!/usr/bin/env bash",
    `source ${JSON.stringify(commonPath)}`,
    guard,
    "assert_not_inside_deployment_driver",
    "echo permitted",
    "",
  ].join("\n"), { mode: 0o700 });

  // `bash -euo pipefail /srv/.../deploy.sh` is still bash running the driver, so
  // interpreter options must not push the script name out of view.
  const optioned = path.join(directory, "deploy.sh");
  await writeFile(optioned, `#!/usr/bin/env bash\nbash "$1"\n`, { mode: 0o700 });
  const viaOptions = spawnSync("bash", ["-u", optioned, probe], { encoding: "utf8" });
  assert.notEqual(viaOptions.status, 0, "interpreter options must not hide the driver being run");
  assert.match(viaOptions.stderr, /deployment driver/u);

  for (const [parentName, extraArgument, permitted] of [
    ["deploy.sh", [], false],
    ["rollback.sh", [], false],
    ["operator-shell.sh", [], true],
    // THE CASE THAT MATTERS AS MUCH AS THE REFUSAL. A guard that reads the whole
    // command line of every ancestor refuses any shell that has merely TYPED one
    // of these names -- `for f in common.sh deploy.sh; do ...`, `less deploy.sh`,
    // the ssh command line quoting one. That shell is exactly where an operator
    // is standing when a deploy has just failed, so a false refusal there makes
    // the supported path unavailable and the hand-edit the only way out again.
    ["operator-shell.sh", ["notes-about-deploy.sh"], true],
    ["operator-shell.sh", ["deploy.sh"], true],
  ]) {
    const parent = path.join(directory, parentName);
    await writeFile(parent, `#!/usr/bin/env bash\nbash "$1"\n`, { mode: 0o700 });
    await chmod(parent, 0o700);
    const result = spawnSync("bash", [parent, probe, ...extraArgument], { encoding: "utf8" });
    const what = `${parentName} ${extraArgument.join(" ")}`.trim();
    if (permitted) {
      assert.equal(result.status, 0, `an ordinary operator invocation must be allowed (${what}): ${result.stderr}`);
    } else {
      assert.notEqual(result.status, 0, `a deployment driver in the ancestry must refuse (${what})`);
      assert.match(result.stderr, /deployment driver/u);
    }
  }
});

test("there is no option anywhere that skips, forces or disables a comparison", async () => {
  // The failure this whole tool exists to prevent is a gate that can be talked
  // out of refusing. Adoption changes what the RECORDED baseline says; it must
  // never change whether the comparison happens.
  for (const [label, source] of [["remote entry", entrySource], ["local wrapper", localSource], ["driver", driverSource]]) {
    assert.doesNotMatch(source, /--(?:force|skip|no-verify|ignore-drift|disable)[a-z-]*/u,
      `${label} must not offer an escape hatch from the comparison`);
  }
  // The argument lists are closed: neither wrapper forwards unrecognized options
  // to the other side, so nothing can be smuggled through later. The catch-all
  // has to be in the ARGUMENT LOOP -- `*) usage ;;` also appears in the
  // --baseline validation line, so a bare search for it is satisfied even by a
  // loop that silently swallows every option it does not recognise.
  const optionLoop = (source, label) => {
    const start = source.indexOf("while (($#)); do");
    assert.ok(start >= 0, `${label} has no argument loop to close`);
    const end = source.indexOf("\ndone", start);
    assert.ok(end > start, `${label}'s argument loop is unterminated`);
    return source.slice(start, end);
  };
  assert.match(optionLoop(localSource, "local wrapper"), /\*\) usage ;;/u);
  assert.match(optionLoop(entrySource, "remote entry"), /\*\) usage ;;/u);
  assert.doesNotMatch(localSource, /run_remote_impl adopt-config\.sh "\$@"/u);

  const rejected = runLocalWrapper("--some-option-added-later");
  assert.equal(rejected.status, 64, "an unknown option is a usage error, not a pass-through");
  assertNoConnectionAttempted(rejected, "an unknown option");
  const badBaseline = runLocalWrapper("--baseline", "whatever");
  assert.equal(badBaseline.status, 64);
  assertNoConnectionAttempted(badBaseline, "an invalid baseline");

  // And the same is true on the far side. The remote entry point is the half
  // that does the privileged reading and the rewriting, so it must refuse an
  // option nobody has read it to allow -- and refuse it before it touches
  // anything, which an exit of 64 out of the argument loop is.
  const remoteRejected = spawnSync("bash", [entryPoint, "--some-option-added-later"], { encoding: "utf8" });
  assert.equal(remoteRejected.status, 64, "the remote entry point must not swallow an option it does not know");
});

test("the local wrapper refuses an unexplained confirmation before it opens a connection", () => {
  // Three layers refuse this -- the CLI, this wrapper, and the driver -- and the
  // wrapper is the one an operator reaches by running the script directly. Both
  // refusals below happen above `need_local ssh`, so neither contacts a server:
  // the moment this tool is needed is the moment a deploy has already failed,
  // and it must not need a working connection to tell an operator they forgot
  // to say why.
  const unreasoned = runLocalWrapper("--confirm");
  assert.equal(unreasoned.status, 64, "--confirm with no --reason is a usage error here, not a far-side refusal");
  assert.match(unreasoned.stderr, /--confirm requires --reason/u);
  assertNoConnectionAttempted(unreasoned, "a confirmation with no reason");

  const stray = runLocalWrapper("--reason", "a reason with no confirmation");
  assert.equal(stray.status, 64, "a reason without --confirm is a mistake worth naming, not a silent dry run");
  assert.match(stray.stderr, /--reason is only meaningful with --confirm/u);
  assertNoConnectionAttempted(stray, "a reason with no confirmation");

  // And in the source, so the ordering is not an accident of how the shim fails.
  const beforeConnecting = localSource.slice(0, localSource.indexOf("need_local ssh"));
  assert.match(beforeConnecting, /--confirm requires --reason/u, "the reason check must sit above need_local ssh");
});

test("an adoption is re-proved by the real gate, not by the tool's own opinion", async () => {
  // After rewriting, the entry point runs verify_configuration_evidence -- the
  // same function every deploy gate calls -- against every record it touched. If
  // the adoption produced something the gate would still refuse, that surfaces
  // here rather than in the middle of the next cutover.
  const call = 'verify_configuration_evidence "$adopted_record/config-digests.tsv" "$adopted_release"';
  assert.ok(entrySource.includes(call), "the entry point must re-prove adopted records with the real gate");
  const driverAt = entrySource.indexOf('python3 "$driver"');
  assert.ok(driverAt >= 0 && entrySource.indexOf(call) > driverAt, "the gate runs after the rewrite, not before it");
});

/* ---------- the entry point, end to end, against a fixture root ------------ */

/*
 * The privileged half, driven for real. adopt-config.sh resolves the baselines,
 * records the live evidence and re-proves the result; all of that is where the
 * baseline mix-up actually happens, so it is worth exercising rather than
 * asserting about.
 *
 * The fixture supplies its own common.sh -- the same technique
 * deployment-transaction.test.mjs uses -- so `record_configuration_evidence` and
 * `verify_configuration_evidence` are observable, and shims for `flock` and
 * `sudo`, which a test host has neither the platform nor the rights for. The
 * lock and the privileged read are pinned separately, by inspection, above.
 */
async function entryFixture({ transactionInventory } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-adopt-entry-")));
  const releaseA = "a".repeat(64);
  const releaseB = "b".repeat(64);
  const remoteDir = path.join(directory, "remote");
  const root = path.join(directory, "root");
  const bin = path.join(directory, "bin");
  for (const created of [remoteDir, bin, path.join(root, "deployments", "deploy-pending"),
    path.join(root, "deployments", "deploy-current"), path.join(root, "releases", releaseA),
    path.join(root, "releases", releaseB)]) {
    await mkdir(created, { recursive: true });
  }
  await copyFile(entryPoint, path.join(remoteDir, "adopt-config.sh"));
  await copyFile(driver, path.join(remoteDir, "adopt-config.py"));
  await symlink(path.join(root, "releases", releaseA), path.join(root, "current"));
  await symlink(path.join(root, "deployments", "deploy-current"), path.join(root, "current-deployment"));
  await writeFile(path.join(root, "deployments", "deploy-current", "release-id"), `${releaseA}\n`, { mode: 0o600 });
  await writeFile(path.join(root, "deployments", "deploy-pending", "release-id"), `${releaseB}\n`, { mode: 0o600 });

  const gateLog = path.join(directory, "gate.log");
  await writeFile(path.join(remoteDir, "common.sh"), `set -euo pipefail
REMOTE_ROOT=${JSON.stringify(root)}
PRIVATE_DIR="$REMOTE_ROOT/private"
RELEASES_DIR="$REMOTE_ROOT/releases"
DEPLOYMENTS_DIR="$REMOTE_ROOT/deployments"
LOCK_FILE="$REMOTE_ROOT/deploy.lock"
log() { printf '[ai-pin-revival] %s\\n' "$*"; }
fail() { printf '[ai-pin-revival] error: %s\\n' "$*" >&2; exit 1; }
usage_fail() { printf '[ai-pin-revival] error: %s\\n' "$*" >&2; exit 64; }
need() { :; }
assert_target() { :; }
assert_remote_root() { :; }
validate_release_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail "invalid release id"; }
resolve_path() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
safe_release_pointer() { [[ -L "$1" ]] || return 1; local r; r="$(resolve_path "$1")"; [[ "$r" == "$RELEASES_DIR/"* && -d "$r" ]] || return 1; printf '%s\\n' "$r"; }
safe_deployment_pointer() { [[ -L "$1" ]] || return 1; local r; r="$(resolve_path "$1")"; [[ "$r" == "$DEPLOYMENTS_DIR/"* && -d "$r" ]] || return 1; printf '%s\\n' "$r"; }
# The live recording is a function of the release tree, so the fixture keeps one
# per release: a shared answer would hide the bug where a record is compared
# against another release's rendered Compose model.
record_configuration_evidence() { cp "$REMOTE_ROOT/live-$(basename "$1").tsv" "$2"; }
verify_configuration_evidence() {
  printf 'GATE\\t%s\\t%s\\n' "$1" "$(basename "$2")" >> ${JSON.stringify(gateLog)}
  python3 - "$1" "$REMOTE_ROOT/live-$(basename "$2").tsv" <<'PY'
import sys
def stable(path):
    return [line.rstrip("\\n").split("\\t") for line in open(path, encoding="utf-8")
            if line.strip() and line.split("\\t")[:2] != ["protected", "bridge.state"]]
assert stable(sys.argv[1]) == stable(sys.argv[2]), "gate refused"
PY
}
`, { mode: 0o600 });

  const pendingRecord = path.join(root, "deployments", "deploy-pending");
  const reported = transactionInventory
    ? transactionInventory(pendingRecord)
    : { schemaVersion: 1, active: [{ namespace: "deploy", record: pendingRecord }] };
  await writeFile(path.join(remoteDir, "transaction.py"),
    `print(${JSON.stringify(typeof reported === "string" ? reported : JSON.stringify(reported))})\n`,
    { mode: 0o600 });
  await writeFile(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(bin, "sudo"), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  await chmod(path.join(bin, "flock"), 0o755);
  await chmod(path.join(bin, "sudo"), 0o755);

  const rows = (bridge, compose) => evidence([
    `file\tcenter.env\t${digest("center")}\t600\t1000:1000`,
    `protected\tbridge.config\t${digest(bridge)}\t-\t-`,
    `protected\tbridge.state\t${digest("state")}\t-\t-`,
    `rendered\tcompose.json\t${digest(compose)}\t-\t-`,
  ]);
  await writeFile(path.join(root, "deployments", "deploy-current", "config-digests.tsv"), rows("old", "compose-a"), { mode: 0o600 });
  await writeFile(path.join(root, "deployments", "deploy-pending", "config-digests.tsv"), rows("old", "compose-b"), { mode: 0o600 });
  await writeFile(path.join(root, `live-${releaseA}.tsv`), rows("new", "compose-a"), { mode: 0o600 });
  await writeFile(path.join(root, `live-${releaseB}.tsv`), rows("new", "compose-b"), { mode: 0o600 });

  const run = (...args) => spawnSync("bash", [path.join(remoteDir, "adopt-config.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { directory, root, gateLog, releaseA, releaseB, run };
}

test("the entry point resolves both baselines, records live evidence per release, and re-proves with the gate", async () => {
  const fix = await entryFixture();

  const planned = fix.run("--baseline", "all");
  assert.equal(planned.status, 0, planned.stderr);
  assert.ok(
    planned.stdout.indexOf("deploy-pending") < planned.stdout.indexOf("deploy-current"),
    "the record the next deploy verifies first must be presented first",
  );
  // Each record is compared against ITS OWN release's rendering. The two records
  // here point at different releases with different rendered Compose models; if
  // one live recording were shared, compose.json would show as false drift.
  assert.equal((planned.stdout.match(/ROWS THAT DIFFER \(1 of 4\)/gu) ?? []).length, 2);
  assert.doesNotMatch(planned.stdout, /compose\.json/u, "no row but the one that moved is reported");

  const token = tokenOf(planned.stdout);
  const refused = fix.run("--confirm", "--reason", REASON, "--expect-plan", "0".repeat(64));
  assert.notEqual(refused.status, 0, "a confirmation bound to a different plan must not proceed");

  const adopted = fix.run("--baseline", "all", "--confirm", "--reason", REASON, "--expect-plan", token);
  assert.equal(adopted.status, 0, adopted.stderr);

  // The real gate ran once per adopted record, each against its own release.
  const gate = (await readFile(fix.gateLog, "utf8")).trim().split("\n").map((line) => line.split("\t"));
  assert.equal(gate.length, 2);
  assert.ok(gate.some(([, record, release]) => record.includes("deploy-pending") && release === fix.releaseB));
  assert.ok(gate.some(([, record, release]) => record.includes("deploy-current") && release === fix.releaseA));

  // And a second plan now finds nothing, which is the whole point: the deploy
  // that was deadlocked can proceed without anyone editing a digest by hand.
  const settled = fix.run("--baseline", "all");
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal((settled.stdout.match(/No row differs/gu) ?? []).length, 2);
});

test("--baseline current cannot quietly adopt past a record the deploy verifies first", async () => {
  // The wrong-baseline hour, reachable by a flag. With a transaction armed, the
  // resume path verifies THAT record's evidence and aborts before anything looks
  // at current-deployment -- so `--baseline current` rewriting current-deployment
  // and reporting success is a clean exit code for a deploy that will fail in
  // exactly the same place. Selecting one baseline must not hide the other.
  const fix = await entryFixture();
  const refused = fix.run("--baseline", "current", "--confirm", "--reason", REASON);
  assert.notEqual(refused.status, 0, "adopting into current-deployment alone must not succeed here");
  assert.match(refused.stderr, /deploy transaction is durably prepared/u);
  assert.match(refused.stderr, /--baseline all/u, "the refusal has to say what to do instead");

  // Nothing was written to either record.
  const gate = spawnSync("cat", [fix.gateLog], { encoding: "utf8" });
  assert.equal((gate.stdout ?? "").trim(), "", "a refusal re-proves nothing because it adopted nothing");
  for (const name of ["deploy-current", "deploy-pending"]) {
    const marker = spawnSync("cat", [path.join(fix.root, "deployments", name, "PROTECTED_CONFIGURATION_ADOPTED")], {
      encoding: "utf8",
    });
    assert.notEqual(marker.status, 0, `${name} must be untouched`);
  }

  // And with no transaction armed, `current` is an ordinary, useful selection.
  const alone = await entryFixture({ transactionInventory: () => ({ schemaVersion: 1, active: [] }) });
  const planned = alone.run("--baseline", "current");
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /Baseline 1 of 1/u);
  assert.doesNotMatch(planned.stdout, /deploy-pending/u);
});

test("an inventory it cannot read is never treated as 'no transaction is pending'", async () => {
  // The pending record is the baseline the next deploy verifies FIRST. If a
  // rejected or unrecognised transaction inventory collapsed to an empty list,
  // this tool would quietly answer for current-deployment alone -- which is
  // precisely the wrong-baseline diagnosis that cost an hour and an edit that
  // had to be reverted. Not resolving the pending record has to be a refusal.
  const unreadable = await entryFixture({ transactionInventory: () => "{not json at all" });
  const refused = unreadable.run("--baseline", "all");
  assert.notEqual(refused.status, 0, "an unreadable inventory must refuse, not fall back to current-deployment");
  assert.doesNotMatch(refused.stdout, /Baseline 1 of/u, "nothing is planned off a baseline set it could not resolve");

  const wrongShape = await entryFixture({
    transactionInventory: (record) => ({ schemaVersion: 2, active: [{ namespace: "deploy", record }] }),
  });
  const shapeRefused = wrongShape.run("--baseline", "all");
  assert.notEqual(shapeRefused.status, 0, "a shape it does not recognise is not an empty inventory either");
  assert.doesNotMatch(shapeRefused.stdout, /Baseline 1 of/u);

  // And a prepared transaction belonging to some other authority is not this
  // tool's to adopt configuration evidence into.
  const foreign = await entryFixture({
    transactionInventory: (record) => ({ schemaVersion: 1, active: [{ namespace: "domain", record }] }),
  });
  const foreignRefused = foreign.run("--baseline", "all");
  assert.notEqual(foreignRefused.status, 0);
  assert.match(foreignRefused.stderr, /authority transaction is pending/u);
});

/* ---------- the two lists that must not drift from common.sh -------------- */

test("the protected label to path map mirrors record_configuration_evidence", () => {
  // A label present in one list and not the other silently drops the per-file
  // explanation for exactly the row an operator is staring at, or invents a path
  // for a row that has none. Both sides are expanded by bash with common.sh
  // sourced, because both are written in terms of $PRIVATE_DIR.
  const expand = (body) => {
    const result = spawnSync("bash", ["-c", `
set -euo pipefail
source ${JSON.stringify(commonPath)}
${body}
`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return new Map(
      result.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("\t")),
    );
  };

  const recorded = expand(`cat <<EOF\n${protectedHeredocFromCommon(commonSource)}\nEOF`);
  const mirrored = expand(`${bashFunction(entrySource, "protected_configuration_paths")}\nprotected_configuration_paths`);

  assert.ok(recorded.has("bridge.config"), "the row this tool was built for is missing from common.sh");
  assert.deepEqual([...mirrored.keys()].sort(), [...recorded.keys()].sort());
  for (const [label, expected] of recorded) {
    assert.equal(mirrored.get(label), expected, `protected path for ${label} disagrees with common.sh`);
  }
});

test("the row the gate does not compare is the row adoption does not touch", async () => {
  // verify_configuration_evidence drops exactly one row before comparing. The
  // driver has to drop the same one: reporting it would be false drift, and
  // rewriting it would be an unexplained change to a record.
  const skipped = /fields\[:2\]==\["([a-z.]+)","([a-z.]+)"\]: continue/u.exec(commonSource);
  assert.ok(skipped, "common.sh no longer drops a row the way this test assumes; re-derive the pair");
  assert.match(driverSource, new RegExp(`UNCOMPARED_ROWS[\\s\\S]{0,200}\\("${skipped[1]}", "${skipped[2]}"\\)`, "u"));
});

/* ---------- CLI wiring ----------------------------------------------------- */

test("the CLI refuses a confirmation with no reason before it opens a connection", () => {
  const result = spawnSync("node", [cli, "adopt-config", "--confirm"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /--reason/u);

  const help = spawnSync("node", [cli, "help"], { encoding: "utf8", cwd: root });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /adopt-config/u, "an operator who does not know this exists has no supported path");
  assert.match(help.stdout, /--confirm/u);

  // Reached without a server, because the moment it is needed is the moment a
  // deploy has already failed and nobody wants to guess at the argument list.
  const own = spawnSync("node", [cli, "adopt-config", "--help"], { encoding: "utf8", cwd: root });
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /WITHOUT --confirm this only PLANS/u);
  assert.match(own.stdout, /pending/u, "the help has to name the baseline trap, not just the flags");
});

test("the streamed payload carries the driver the entry point needs", () => {
  // adopt-config is streamed with run_remote_impl rather than dispatched out of
  // the deployed release, because it is needed exactly when a deploy has not
  // completed -- so it cannot depend on a release having shipped it first.
  assert.match(localSource, /run_remote_impl adopt-config\.sh/u);
  const library = spawnSync("cat", [path.join(root, "platform/deploy/vps/lib/local.sh")], { encoding: "utf8" });
  assert.equal(library.status, 0, library.stderr);
  assert.match(library.stdout, /adopt-config\.py/u, "the entry point's driver must travel with it");
});

/* ---------- helpers -------------------------------------------------------- */

function bashFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing bash function ${name}`);
  const tail = source.slice(start);
  const end = tail.search(/^\}\n/mu);
  assert.ok(end >= 0, `unterminated bash function ${name}`);
  return tail.slice(0, end + 2);
}

function jsFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const tail = source.slice(start);
  const end = tail.search(/^\}\n/mu);
  assert.ok(end >= 0, `unterminated function ${name}`);
  return tail.slice(0, end + 2);
}

function protectedHeredocFromCommon(source) {
  // The heredoc record_configuration_evidence_with_env feeds its protected loop.
  const anchor = source.indexOf("edge.security\t");
  assert.ok(anchor >= 0, "common.sh no longer declares protected roots as a label/path heredoc");
  const end = source.indexOf("\nEOF", anchor);
  assert.ok(end > anchor, "the protected root heredoc in common.sh is unterminated");
  return source.slice(anchor, end);
}
