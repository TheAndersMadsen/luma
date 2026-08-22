import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * THE FAILURE THIS COMMAND EXISTS FOR, AND WHY RETENTION HAD TO BE PROVEN
 * RATHER THAN COUNTED.
 *
 * backups/ and releases/ only ever grow. deploy.sh writes a restore-tested
 * baseline backup, a post-candidate backup and a release tree on every attempt,
 * rollback.sh writes another, and the resume paths write two more each time they
 * run. Nothing in this tree has ever removed any of it. On the host as measured
 * that is 80 backup directories totalling 3.6 GB and 65 release trees totalling
 * 545 MB on a disk at 88%, and preflight.sh:290 refuses a deploy below 8 GiB
 * free. The end state is a production that cannot be deployed to, arrived at
 * silently, while the wearer is served normally the whole time.
 *
 * The obvious retention rule -- keep the newest N -- is WRONG HERE, and would
 * have been wrong on the exact state measured:
 *
 *   * the release the `previous` pointer names was the 53rd newest of 65. It is
 *     read by deploy.sh:1519 and rollback.sh:403 into `oldPrevious`, and
 *     transaction.py's validate_old_precondition compares it against the LIVE
 *     pointer through optional_target -> direct_child, which lstat()s the target
 *     and dies if it is not a directory. Removing it breaks the next deploy AND
 *     the next rollback, at the point of publishing authority, with no earlier
 *     signal at all.
 *   * the backup a LEGACY rollback reads is `backups/<first-cutover record id>`
 *     (rollback.sh:873) -- the OLDEST complete backup on the host, and the whole
 *     pre-cutover recovery position.
 *   * `backups/<current deployment record id>` is not referenced by any obvious
 *     index. It is reconstructed by NAME in three places: transaction.py:667
 *     pins the production channel-key contract to
 *     `<root>/backups/<record>/invariants.tsv`, domain.py:1451 re-hashes
 *     `backupManifest` out of the record's Keycloak journal on every
 *     client-verify and client-check-marker, and deploy.sh:811 rebuilds it as the
 *     activation baseline of a pending transaction. Remove it and BOTH
 *     `./revival drift` and `./revival rollback` die on a FileNotFoundError
 *     traceback, from a directory nothing appeared to point at.
 *
 * These tests pin the CLASS of guarantee `revival prune-state` has to keep, not
 * the spelling of how it keeps it. Rewrite the implementation freely; these must
 * still hold:
 *
 *   1. it shows before it acts, and without --confirm it removes nothing;
 *   2. every retained item names the reason it is retained;
 *   3. the authority pointers, the rollback chain, pending transactions and the
 *      backup drift.sh selects are retained whatever their age or ordinal;
 *   4. retention along the rollback chain is TRANSITIVE, because rolling back
 *      makes the predecessor current and therefore itself rollback-eligible;
 *   5. anything it cannot classify is not eligible, ever;
 *   6. it can never be reached from a deploy, and never runs beside one.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = path.join(root, "platform/deploy/vps/remote");
const driver = path.join(remote, "prune-state.py");
const entryPoint = path.join(remote, "prune-state.sh");
const retentionStore = path.join(remote, "retention-store.py");
const localWrapper = path.join(root, "platform/deploy/vps/prune-state.sh");
const commonPath = path.join(remote, "common.sh");
const localLib = path.join(root, "platform/deploy/vps/lib/local.sh");
const cli = path.join(root, "revival");

const entrySource = await readFile(entryPoint, "utf8");
const localSource = await readFile(localWrapper, "utf8");
const driverSource = await readFile(driver, "utf8");
const localLibSource = await readFile(localLib, "utf8");
const cliModulesDir = path.join(root, "platform", "cli");
const cliSource = [
  await readFile(cli, "utf8"),
  ...(await Promise.all((await readdir(cliModulesDir)).filter((name) => name.endsWith(".js")).sort()
    .map((name) => readFile(path.join(cliModulesDir, name), "utf8")))),
].join("\n");

const ROOT = "/home/anders/ai-pin-revival";
const HOUR = 3600;
const NOW = 1_800_000_000;
const SUCCEEDED = [
  "SUCCEEDED", "INGRESS_ACTIVATED", "POINTER_TRANSACTION_PREPARED",
  "POINTER_TRANSACTION_COMMITTED", "OPERATION_TRANSACTION_PREPARED",
  "OPERATION_TRANSACTION_COMPLETED",
];
const ABORTED = [
  "POINTER_TRANSACTION_PREPARED", "POINTER_TRANSACTION_ABORTED",
  "OPERATION_TRANSACTION_PREPARED", "OPERATION_TRANSACTION_ABORTED",
];

function releaseId(seed) {
  return seed.repeat(64).slice(0, 64);
}

// Records and backups are named the way deploy.sh names them -- long enough to
// satisfy backup.sh:39's own id regex, which is also what decides whether this
// command is willing to classify a directory at all.
function rid(label) {
  return `20260810T0000${label}Z-fixture`;
}

function record(name, { release, candidate = "", oldCurrent = "", oldRecord = "", markers = SUCCEEDED, references = [] }) {
  return {
    name,
    path: `${ROOT}/deployments/${name}`,
    releaseId: release,
    candidateId: candidate,
    oldCurrent: oldCurrent ? `${ROOT}/releases/${oldCurrent}` : "",
    oldCurrentDeployment: oldRecord ? `${ROOT}/deployments/${oldRecord}` : "",
    markers: [...markers],
    // Every real record on the host references exactly its own backup, from its
    // Keycloak migration journal and its channel-key metadata journal.
    backupReferences: references.length
      ? references
      : [{ backup: name, source: "journal" }, { backup: name, source: "channel_key_metadata_transaction" }],
  };
}

function authority(name, mtime) {
  const selected = {
    dev: 1,
    ino: Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 10), 16),
    mode: 0o700,
    uid: 1000,
    gid: 1000,
    nlink: 2,
    size: 4096,
    mtimeNs: mtime,
    ctimeNs: mtime + 1,
    inventorySha256: createHash("sha256").update(`inventory:${name}`).digest("hex"),
  };
  const canonical = JSON.stringify(selected, Object.keys(selected).sort());
  return {
    ...selected,
    authorityToken: createHash("sha256").update(canonical).digest("hex"),
  };
}

function backup(name, { bytes = 50 * 1024 * 1024, ageHours = 72, complete = true } = {}) {
  const mtime = NOW - ageHours * HOUR;
  return { name, path: `${ROOT}/backups/${name}`, bytes, mtime, complete, ...authority(name, mtime) };
}

function release(name, { bytes = 8 * 1024 * 1024, ageHours = 72 } = {}) {
  const mtime = NOW - ageHours * HOUR;
  return { name, path: `${ROOT}/releases/${name}`, bytes, mtime, ...authority(name, mtime) };
}

function candidate(name, { bytes = 3 * 1024 * 1024 * 1024, ageHours = 72 } = {}) {
  const mtime = NOW - ageHours * HOUR;
  return { name, path: `${ROOT}/release-candidates/${name}`, bytes, mtime, ...authority(name, mtime) };
}

function incoming(name, { bytes = 3 * 1024 * 1024 * 1024, ageHours = 72 } = {}) {
  const mtime = NOW - ageHours * HOUR;
  return { name, path: `${ROOT}/incoming/${name}`, bytes, mtime, ...authority(name, mtime) };
}

/*
 * The measured production shape, reduced to its structure: a current deployment
 * whose rollback lineage runs back through four successful predecessors to a
 * first cutover with an empty old-current-deployment (the legacy predecessor),
 * a crowd of aborted attempts, and the precommit/resume backups each attempt
 * left behind.
 */
function productionShape(overrides = {}) {
  const chain = [
    [rid("D5"), "5"], [rid("D4"), "4"], [rid("D3"), "3"], [rid("D2"), "2"], [rid("D1"), "1"],
  ];
  const deployments = chain.map(([name, seed], index) => {
    const previous = chain[index + 1];
    return record(name, {
      release: releaseId(seed),
      oldCurrent: previous ? releaseId(previous[1]) : "",
      oldRecord: previous ? previous[0] : "",
    });
  });
  deployments.push(record(rid("A1"), { release: releaseId("a"), markers: ABORTED }));
  deployments.push(record(rid("A2"), { release: releaseId("b"), markers: ABORTED }));

  const backups = [
    ...chain.map(([name]) => backup(name)),
    backup(rid("A1")), backup(rid("A2")),
    backup("precommit-D5-20260812T142046Z"),
    backup("precommit-D4-20260811T212843Z"),
    backup("precommit-resume-D4-20260812T133047Z-5ad7eadf"),
    backup("precommit-resume-baseline-D4-20260812T132828Z-a5403f29"),
    backup("rollback-D3-20260810T120000Z"),
    backup("20260812T170000Z-deadbeef", { ageHours: 40 }),
  ];
  const releases = [
    ...chain.map(([, seed]) => release(releaseId(seed))),
    release(releaseId("a")), release(releaseId("b")),
  ];

  return {
    schemaVersion: 1,
    root: ROOT,
    now: NOW,
    minAgeSeconds: 24 * HOUR,
    includeIncomplete: false,
    pointers: {
      current: `${ROOT}/releases/${releaseId("5")}`,
      // The trap. `previous` names D4's release, and nothing about its position
      // in an mtime or lexical ordering says so.
      previous: `${ROOT}/releases/${releaseId("4")}`,
      currentDeployment: `${ROOT}/deployments/${rid("D5")}`,
    },
    activeTransactions: [],
    newestVerifiedBackup: `${ROOT}/backups/20260812T170000Z-deadbeef`,
    deployments,
    backups,
    releases,
    candidates: [],
    incoming: [],
    ...overrides,
  };
}

let fixtureDirectory;
async function plan(request, extra = []) {
  fixtureDirectory ??= await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-retention-")));
  const file = path.join(fixtureDirectory, `request-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(request));
  const result = spawnSync("python3", [driver, "--request", file, "--json", ...extra], { encoding: "utf8" });
  return { result, file };
}

async function planned(request, extra = []) {
  const { result } = await plan(request, extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function action(document, kind, name) {
  const entry = document[kind].find((item) => item.name === name);
  assert.ok(entry, `${kind} fixture is missing ${name}`);
  return entry;
}

function removed(document, kind) {
  return document[kind].filter((item) => item.action === "remove").map((item) => item.name).sort();
}

/* ---------- 1. it shows before it acts -------------------------------------- */

test("the dry run prints every removal and every retention reason, and removes nothing", async () => {
  fixtureDirectory ??= await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-retention-")));
  const file = path.join(fixtureDirectory, "human.json");
  await writeFile(file, JSON.stringify(productionShape()));
  const result = spawnSync("python3", [driver, "--request", file, "--show-all"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  // Named items, not counts. A plan that says "would remove 12 backups" is the
  // same class of answer as a gate that says only "drift".
  assert.match(result.stdout, /REMOVE\s+precommit-D5-20260812T142046Z/u);
  assert.match(result.stdout, new RegExp(`KEEP\\s+${rid("D5")}`, "u"));
  assert.match(result.stdout, /because authoritative-current-deployment/u);
  assert.match(result.stdout, /because previous-release-pointer/u);
  assert.match(result.stdout, /because newest-verified-backup-drift-gate/u);
  assert.match(result.stdout, /plan token: [0-9a-f]{64}/u);

  // The driver is pure: it is handed a facts document and never opens the store
  // itself, so a dry run cannot remove anything even in principle. The removal
  // list it can be asked for is a list of PATHS, written where the caller says.
  assert.doesNotMatch(driverSource, /shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir/u,
    "the retention driver must have no way to delete anything");
});

test("--emit-removals names only paths the plan marked remove, under the two guarded stores", async () => {
  fixtureDirectory ??= await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-retention-")));
  const file = path.join(fixtureDirectory, "emit.json");
  const request = productionShape();
  await writeFile(file, JSON.stringify(request));
  const result = spawnSync("python3", [driver, "--request", file, "--json", "--emit-removals", "-"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n")));
  const rows = result.stdout.slice(result.stdout.indexOf("\n") + 1).trim().split("\n").filter(Boolean);

  const expected = new Set([
    ...removed(document, "backups").map((name) => `${ROOT}/backups/${name}`),
    ...removed(document, "releases").map((name) => `${ROOT}/releases/${name}`),
  ]);
  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    const [kind, emitted] = row.split("\t");
    assert.ok(["backup", "release"].includes(kind), `unknown store in removal row: ${row}`);
    assert.ok(expected.has(emitted), `a path was emitted that the plan did not mark remove: ${emitted}`);
    assert.ok(
      emitted.startsWith(`${ROOT}/backups/`) || emitted.startsWith(`${ROOT}/releases/`),
      `a removal path escaped the guarded stores: ${emitted}`,
    );
    assert.doesNotMatch(emitted, /\/\.\.\/|\/\.$|\/\.\.$/u);
  }
});

/* ---------- 2/3. what may never be removed ---------------------------------- */

test("the release the previous pointer names is retained even though no record makes it current", async () => {
  // deploy.sh:1519 and rollback.sh:403 read `previous` into oldPrevious, and
  // transaction.py's direct_child() lstat()s whatever it names. This is the item
  // a newest-N rule loses first and notices last.
  const document = await planned(productionShape());
  const entry = action(document, "releases", releaseId("4"));
  assert.equal(entry.action, "keep");
  assert.ok(entry.reasons.includes("previous-release-pointer"),
    `the previous pointer must be a reason in its own right: ${entry.reasons.join(", ")}`);

  // And it stays retained when it is the ONLY thing naming it: drop the record
  // lineage entirely and the pointer alone must still hold it.
  const orphaned = productionShape({ deployments: [], pointers: {
    current: `${ROOT}/releases/${releaseId("5")}`,
    previous: `${ROOT}/releases/${releaseId("4")}`,
    currentDeployment: null,
  } });
  const second = await planned(orphaned);
  assert.equal(action(second, "releases", releaseId("4")).action, "keep");
  assert.equal(action(second, "releases", releaseId("5")).action, "keep");
});

test("the current deployment's own backup is retained by name, not only by reference", async () => {
  // transaction.py:667, domain.py:1451 and deploy.sh:811 all RECONSTRUCT this
  // path from the record's name. A record whose journals happen to be missing
  // must not make its backup eligible.
  const request = productionShape();
  for (const entry of request.deployments) entry.backupReferences = [];
  const document = await planned(request);
  const entry = action(document, "backups", rid("D5"));
  assert.equal(entry.action, "keep");
  assert.ok(entry.reasons.some((reason) => reason.startsWith("named-by-retained-record:")),
    `the name-derived reference must stand alone: ${entry.reasons.join(", ")}`);
});

test("retention along the rollback chain is transitive and stops where rollback would", async () => {
  // Rolling back makes the predecessor the current deployment (rollback.sh:1055),
  // and rollback.sh:55 will then accept THAT record too. So the second rollback
  // reads the predecessor's own journals and its predecessor's backup, and so on
  // to the legacy cutover. A one-deep rule silently caps recovery at one step.
  const document = await planned(productionShape());
  for (const name of [rid("D1"), rid("D2"), rid("D3"), rid("D4"), rid("D5")]) {
    assert.equal(action(document, "backups", name).action, "keep", `${name}'s backup must survive`);
    assert.ok(document.retainedRecords[name], `${name} must be a retained record`);
  }
  assert.deepEqual(document.retainedRecords[rid("D5")], ["authoritative-current-deployment"]);
  assert.deepEqual(document.retainedRecords[rid("D1")], ["current-rollback-target-depth-4"]);

  // D1's old-current-deployment is empty: that is the legacy predecessor, where
  // rollback.sh:124 takes the branch that reads backups/<D1> and no further
  // record. The chain ends there rather than wandering.
  assert.equal(action(document, "backups", rid("A1")).action, "remove");

  // And the walk stops at a predecessor a rollback could not hand authority to.
  // The immediate target is still retained -- rollback.sh:120 reads it out of the
  // current record regardless, and a refusal should come from the evidence, not
  // from a directory this command deleted -- but nothing beyond it is reachable.
  const capped = productionShape();
  capped.deployments = capped.deployments.map((entry) =>
    entry.name === rid("D4") ? { ...entry, markers: [...SUCCEEDED, "MANUAL_ROLLBACK"] } : entry);
  const second = await planned(capped);
  assert.equal(action(second, "backups", rid("D4")).action, "keep", "the immediate rollback target is always retained");
  assert.equal(action(second, "backups", rid("D3")).action, "remove", "nothing past an already-rolled-back record is reachable");
});

test("the newest verified backup is retained whatever else is true of it", async () => {
  // drift.sh:110 selects it by SHA256SUMS mtime and refuses if it is older than
  // 36 hours. Removing it changes the answer `./revival drift` gives, so it is
  // retained even though nothing references it and it is old enough to be
  // eligible on every other test.
  const document = await planned(productionShape());
  const entry = action(document, "backups", "20260812T170000Z-deadbeef");
  assert.equal(entry.action, "keep");
  assert.deepEqual(entry.reasons, ["newest-verified-backup-drift-gate"]);
});

test("retained candidates survive while unreferenced candidates and stale incoming staging are bounded", async () => {
  const request = productionShape();
  const currentCandidate = releaseId("c");
  const abandonedCandidate = releaseId("d");
  request.deployments = request.deployments.map((entry) => entry.name === rid("D5")
    ? { ...entry, candidateId: currentCandidate }
    : entry);
  request.candidates = [candidate(currentCandidate), candidate(abandonedCandidate)];
  request.incoming = [incoming(releaseId("e")), incoming(releaseId("f"), { ageHours: 1 })];
  const document = await planned(request);
  assert.equal(action(document, "candidates", currentCandidate).action, "keep");
  assert.match(action(document, "candidates", currentCandidate).reasons.join(" "), /candidate-of-retained-record/u);
  assert.equal(action(document, "candidates", abandonedCandidate).action, "remove");
  assert.equal(action(document, "incoming", releaseId("e")).action, "remove");
  assert.equal(action(document, "incoming", releaseId("f")).action, "ineligible");
  assert.ok(document.totals.candidateBytesRemoved >= 3 * 1024 * 1024 * 1024);
  assert.ok(document.totals.incomingBytesRemoved >= 3 * 1024 * 1024 * 1024);
});

test("a pending or armed transaction retains its record, its release and its recovery target", async () => {
  // deploy.sh:811 reconstructs the pending record's baseline backup, and
  // preflight.sh:83 binds the pending record to its immutable release tree.
  // Neither exists to be resumed if this command removed them first.
  const request = productionShape();
  request.deployments.push(record(rid("P1"), {
    release: releaseId("p"),
    oldCurrent: releaseId("5"),
    oldRecord: rid("D5"),
    markers: ["POINTER_TRANSACTION_PREPARED", "OPERATION_TRANSACTION_PREPARED", "CANDIDATE_ACTIVATION_ARMED"],
  }));
  request.backups.push(backup(rid("P1")));
  request.releases.push(release(releaseId("p")));
  request.activeTransactions = [{ namespace: "deploy", record: `${ROOT}/deployments/${rid("P1")}` }];

  const document = await planned(request);
  assert.equal(action(document, "backups", rid("P1")).action, "keep");
  assert.equal(action(document, "releases", releaseId("p")).action, "keep");
  assert.ok(document.retainedRecords[rid("P1")].includes("pending-deploy-authority-transaction"));
  assert.ok(document.retainedRecords[rid("D5")].length > 0, "the pending record's recovery target stays retained");
});

test("non-terminal markers retain a record on their own, and say so, when the inventory is silent", async () => {
  // transaction.py --inventory is the authority for refusing. This is the second
  // opinion: a record whose markers say "unfinished" while the inventory reports
  // nothing must be RETAINED and the disagreement made visible, never resolved
  // silently in the direction of deleting a recovery position.
  const request = productionShape();
  request.deployments.push(record(rid("P2"), {
    release: releaseId("q"),
    markers: ["POINTER_TRANSACTION_PREPARED", "OPERATION_TRANSACTION_PREPARED"],
  }));
  request.backups.push(backup(rid("P2")));
  request.releases.push(release(releaseId("q")));
  request.activeTransactions = [];

  const document = await planned(request);
  assert.equal(action(document, "backups", rid("P2")).action, "keep");
  assert.equal(action(document, "releases", releaseId("q")).action, "keep");
  assert.ok(document.retainedRecords[rid("P2")].includes("non-terminal-transaction-markers"));
  assert.ok(
    document.warnings.some((warning) => warning.includes(rid("P2")) && warning.includes("transaction.py --inventory")),
    `the disagreement must be reported: ${JSON.stringify(document.warnings)}`,
  );

  // A durably ABORTED transaction is terminal in both namespaces and releases
  // its hold -- that is the whole reason anything is reclaimable at all.
  assert.equal(action(document, "backups", rid("A1")).action, "remove");
  assert.equal(action(document, "backups", rid("A2")).action, "remove");
});

test("a rolled-back record's own rollback backup pointer is honoured", async () => {
  // rollback.sh:789 stores the restore-tested backup it took in
  // `rollback-backup-path` and re-verifies it when a rollback resumes.
  const request = productionShape();
  request.deployments = request.deployments.map((entry) =>
    entry.name === rid("D5")
      ? {
          ...entry,
          markers: [...entry.markers, "ROLLBACK_POINTER_TRANSACTION_PREPARED", "ROLLBACK_ACTIVATION_ARMED"],
          backupReferences: [
            ...entry.backupReferences,
            { backup: "rollback-D3-20260810T120000Z", source: "rollback-backup-path" },
          ],
        }
      : entry);
  const document = await planned(request);
  const entry = action(document, "backups", "rollback-D3-20260810T120000Z");
  assert.equal(entry.action, "keep");
  assert.ok(entry.reasons.some((reason) => reason.endsWith(":rollback-backup-path")));
});

test("an unclassified reference found only by the raw scan is still retained", async () => {
  // The structured readers know three journals. The scan exists to catch the
  // fourth -- a reference some later release writes that this code has not been
  // taught. Its finds must retain, not merely be reported.
  const request = productionShape();
  request.deployments = request.deployments.map((entry) =>
    entry.name === rid("D5")
      ? { ...entry, backupReferences: [...entry.backupReferences, { backup: "precommit-D5-20260812T142046Z", source: "scan" }] }
      : entry);
  const document = await planned(request);
  const entry = action(document, "backups", "precommit-D5-20260812T142046Z");
  assert.equal(entry.action, "keep");
  assert.ok(entry.reasons.some((reason) => reason.endsWith(":scan")));
});

/* ---------- 5. anything unclassifiable is not eligible ---------------------- */

test("incomplete, unrecognised and too-recent items are never removed by default", async () => {
  const request = productionShape();
  request.backups.push(backup("half-written-000001", { complete: false }));
  request.backups.push(backup("nope", { complete: true }));           // too short for backup.sh's id regex
  request.backups.push(backup("20260812T190000Z-cafe1234", { ageHours: 2 }));
  request.releases.push(release("not-a-release-id"));
  request.releases.push(release(releaseId("z"), { ageHours: 2 }));

  const document = await planned(request);
  for (const [kind, name, reason] of [
    ["backups", "half-written-000001", "incomplete-missing-sha256sums-or-manifest"],
    ["backups", "nope", "name-is-not-a-backup-id"],
    ["backups", "20260812T190000Z-cafe1234", "newer-than-age-floor-86400s"],
    ["releases", "not-a-release-id", "name-is-not-a-release-id"],
    ["releases", releaseId("z"), "newer-than-age-floor-86400s"],
  ]) {
    const entry = action(document, kind, name);
    assert.equal(entry.action, "ineligible", `${name} must not be eligible`);
    assert.ok(entry.reasons.includes(reason), `${name}: ${entry.reasons.join(", ")}`);
  }

  // Incomplete backups become eligible only when the operator asks by name. An
  // incomplete backup can only ever make a reader fail -- every one of them tests
  // for SHA256SUMS first -- so this is a decision about residue, not about risk,
  // and it is still the operator's to take rather than this command's.
  const opted = await planned({ ...request, includeIncomplete: true });
  assert.equal(action(opted, "backups", "half-written-000001").action, "remove");
  assert.equal(action(opted, "backups", "nope").action, "ineligible", "an unclassifiable name is never eligible");
});

test("a retained item that is already missing from disk is reported rather than passed over", async () => {
  const request = productionShape();
  request.backups = request.backups.filter((entry) => entry.name !== rid("D4"));
  const document = await planned(request);
  assert.ok(
    document.warnings.some((warning) => warning.includes("already missing") && warning.includes(rid("D4"))),
    `a broken recovery path must be surfaced here: ${JSON.stringify(document.warnings)}`,
  );
});

test("a facts document that does not describe the guarded stores is refused outright", async () => {
  for (const [label, mutate] of [
    ["a backup path outside the store", (request) => { request.backups[0].path = "/tmp/elsewhere"; }],
    ["a release path outside the store", (request) => { request.releases[0].path = "/tmp/elsewhere"; }],
    ["a record path outside the store", (request) => { request.deployments[0].path = "/tmp/elsewhere"; }],
    ["a current-deployment pointer with no record", (request) => { request.pointers.currentDeployment = `${ROOT}/deployments/ghost`; }],
    ["a pending transaction with no record", (request) => {
      request.activeTransactions = [{ namespace: "deploy", record: `${ROOT}/deployments/ghost` }];
    }],
  ]) {
    const request = productionShape();
    mutate(request);
    const { result } = await plan(request);
    assert.notEqual(result.status, 0, `${label} must be refused`);
    assert.match(result.stderr, /prune-state error/u);
  }
});

test("an unreadable authority pointer refuses; it never becomes an empty retained set", async () => {
  /*
   * THE WORST PLAN THIS COMMAND CAN PRODUCE, AND WHY IT IS A REFUSAL.
   *
   * Every backup is retained because a RETAINED RECORD names or references it,
   * and the only root the record set hangs from is the current-deployment
   * pointer. Read nothing there and the retained set is empty, so the plan that
   * falls out is "remove EVERY backup on the host" -- including
   * backups/<current record>, which transaction.py:667 pins the production
   * channel-key contract to and deploy.sh:811 rebuilds as a pending
   * transaction's activation baseline. Before this guard that plan was produced
   * with one line of warning text buried among the removals.
   *
   * The entry point could not catch it either, in either half:
   *   * the last-ditch guard before each rm compares the path against
   *     `readlink -f current|previous|current-deployment`, and the only way this
   *     state is reached is that those did not resolve -- so it matches nothing;
   *   * every recovery post-condition is wrapped in `[[ -n "$current_deployment" ]]`
   *     / `[[ -n "$current_release" ]]`, so all of them are SKIPPED in exactly
   *     this case and the command exits 0 reporting success.
   *
   * safe_deployment_pointer (common.sh:4153) returns non-zero when the pointer
   * is not a symlink, resolves outside deployments/, or names a non-directory --
   * the half-published and hand-disturbed authority states an operator is most
   * likely to be staring at when they reach for this command to free space.
   */
  const noDeploymentPointer = productionShape();
  noDeploymentPointer.pointers.currentDeployment = null;
  const first = await plan(noDeploymentPointer);
  assert.notEqual(first.result.status, 0, "an unresolvable current-deployment pointer must be refused");
  assert.match(first.result.stderr, /current-deployment pointer could not be resolved/u);

  const noReleasePointer = productionShape({ deployments: [], pointers: {
    current: null, previous: null, currentDeployment: null,
  } });
  const second = await plan(noReleasePointer);
  assert.notEqual(second.result.status, 0, "an unresolvable current release pointer must be refused");
  assert.match(second.result.stderr, /current release pointer could not be resolved/u);

  // A host with nothing to lose still plans, and plans nothing: the guard is
  // about protecting a recovery position, not about demanding pointers exist.
  const empty = productionShape({ deployments: [], backups: [], releases: [],
    newestVerifiedBackup: null,
    pointers: { current: null, previous: null, currentDeployment: null } });
  const bare = await planned(empty);
  assert.equal(bare.totals.backupsRemoved, 0);
  assert.equal(bare.totals.releasesRemoved, 0);
});

/* ---------- the plan token ------------------------------------------------- */

test("the plan token gates --confirm and binds exact measurements and authority", async () => {
  const base = await planned(productionShape());

  // A same-name object with changed measurements is a different deletion
  // authority even when the high-level keep/remove decision is unchanged.
  const resized = productionShape();
  resized.backups = resized.backups.map((entry) => ({ ...entry, bytes: entry.bytes + 4096 }));
  assert.notEqual((await planned(resized)).planToken, base.planToken);

  // A changed decision must invalidate it.
  const moved = productionShape();
  moved.pointers.previous = null;
  assert.notEqual((await planned(moved)).planToken, base.planToken);

  const stale = await plan(productionShape(), ["--expect-plan", "0".repeat(64)]);
  assert.notEqual(stale.result.status, 0);
  assert.match(stale.result.stderr, /the plan changed since the dry run/u);

  const fresh = await plan(productionShape(), ["--expect-plan", base.planToken]);
  assert.equal(fresh.result.status, 0, fresh.result.stderr);
});

/* ---------- 6. it can never be reached from a deploy ------------------------ */

test("no deploy or recovery path can reach state retention", async () => {
  // A deploy that could free its own headroom by removing the position it would
  // recover to is the worst version of this command. Nothing on the deploy or
  // recovery path may name it.
  for (const name of ["deploy.sh", "preflight.sh", "rollback.sh", "drift.sh", "backup.sh", "canary.sh", "staging-smoke.sh"]) {
    const source = await readFile(path.join(remote, name), "utf8");
    assert.doesNotMatch(source, /prune-state/u, `${name} must not reference state retention`);
  }
  for (const name of ["deploy.sh", "preflight.sh", "rollback.sh", "drift.sh", "backup.sh", "canary.sh"]) {
    const source = await readFile(path.join(root, "platform/deploy/vps", name), "utf8");
    assert.doesNotMatch(source, /prune-state/u, `local ${name} must not reference state retention`);
  }

  // Nor may it be dispatched as a stateful release operation. That path executes
  // out of `current` -- one of the things this command reasons about -- and takes
  // the deployment lock for its callers before the entry point could decide
  // whether taking it is appropriate.
  const allowlist = /case "\$operation" in ([^\n]*)\) ;;/u.exec(localLibSource);
  assert.ok(allowlist, "run_current_release_operation no longer has an operation allowlist");
  assert.doesNotMatch(allowlist[1], /prune-state/u);

  assert.match(cliSource, /command === 'prune-state'/u);
  const deployBody = /function deployProduction\([\s\S]*?\n\}\n/u.exec(cliSource)[0];
  assert.doesNotMatch(deployBody, /prune|retention/u, "the deploy command must not be able to prune anything");
  const pruneBody = /function pruneState\([\s\S]*?\n\}\n/u.exec(cliSource)[0];
  assert.doesNotMatch(pruneBody, /deploy\.sh|rollback\.sh/u, "retention must not dispatch a deployment driver");
});

test("retention holds the deployment lock and refuses to run inside a deployment driver", async () => {
  assert.match(entrySource, /exec 9>"\$LOCK_FILE"/u);
  assert.match(entrySource, /flock -n 9/u);

  // A guard that is defined and never called is decoration; pin the CALL.
  const callSites = entrySource
    .split("\n")
    .filter((line) => /^\s*assert_not_inside_deployment_driver\s*$/u.test(line));
  assert.equal(callSites.length, 1, "the entry point must actually invoke the ancestry guard");
  assert.ok(
    entrySource.indexOf("\nassert_not_inside_deployment_driver\n") < entrySource.indexOf('exec 9>"$LOCK_FILE"'),
    "the ancestry guard runs before anything is locked or read",
  );

  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-retention-ancestry-")));
  const start = entrySource.indexOf("assert_not_inside_deployment_driver() {");
  const guard = entrySource.slice(start, entrySource.indexOf("\n}\n", start) + 3);
  const probe = path.join(directory, "probe.sh");
  await writeFile(probe, [
    "#!/usr/bin/env bash",
    `source ${JSON.stringify(commonPath)}`,
    guard,
    "assert_not_inside_deployment_driver",
    "echo permitted",
    "",
  ].join("\n"), { mode: 0o700 });

  for (const [parentName, extraArgument, permitted] of [
    ["deploy.sh", [], false],
    ["rollback.sh", [], false],
    ["backup.sh", [], false],
    ["operator-shell.sh", [], true],
    // A guard that reads the whole command line refuses the operator shell that
    // has merely TYPED one of these names -- which is exactly the shell someone
    // is sitting in when the disk is full and this is the way out.
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

test("the entry point re-proves the recovery path after it removes anything", async () => {
  // The removals have already happened by the time these run, so they are not a
  // gate -- they are the difference between "the rollback is gone and nobody
  // knows" and "the rollback is gone and the command said so, loudly, at once".
  const confirmAt = entrySource.indexOf("if ((confirm == 0)); then");
  assert.ok(confirmAt > 0);
  const after = entrySource.slice(confirmAt);
  for (const [what, pattern] of [
    ["the current release pointer", /safe_release_pointer "\$REMOTE_ROOT\/current"/u],
    ["the previous release pointer", /safe_release_pointer "\$REMOTE_ROOT\/previous"/u],
    ["the current-deployment pointer", /safe_deployment_pointer "\$REMOTE_ROOT\/current-deployment"/u],
    ["the rollback baseline's own checksums", /sha256sum -c SHA256SUMS/u],
    ["drift.sh's newest-backup selection", /name SHA256SUMS/u],
    // Every control-plane command begins by walking every deployment record's
    // transaction journals, and an abandoned record's journal still names the
    // release tree it never published. That scan must still parse afterwards.
    ["the global authority transaction inventory", /transaction_driver" --root "\$REMOTE_ROOT" --inventory/u],
  ]) {
    assert.match(after, pattern, `${what} must be re-proved after removal`);
  }
  assert.match(after, /recovery_ok/u);

  /*
   * THE EXIT STATUS IS THE POST-CONDITION, NOT THE SENTENCE.
   *
   * Matching the fail TEXT alone passes just as happily when the condition in
   * front of it has been neutered -- `true || fail "..."` keeps every word of
   * the message and never prints it. That is not hypothetical: it is the one
   * edit that turns "the rollback is gone and the command said so, loudly" back
   * into "the rollback is gone and the command exited 0", which is the exact
   * failure this test was written to prevent. So pin the guard and the message
   * as one thing.
   */
  assert.match(
    after,
    /^\(\(recovery_ok\)\) \|\| fail "state retention completed its removals but a recovery-path post-condition FAILED/mu,
    "a failed post-condition must set the exit status, not merely print a sentence",
  );

  /*
   * And every post-condition has to participate. Each one is written as
   * `|| { warn "..."; recovery_ok=0; }`, so a warn in this region that does NOT
   * clear recovery_ok is a check whose failure the command would report as
   * success. Counting them is what stops the next post-condition from being
   * added as a warn-only line.
   */
  const warns = after.match(/warn "/gu) ?? [];
  const clears = after.match(/recovery_ok=0/gu) ?? [];
  assert.ok(warns.length >= 6, `expected the recovery post-conditions to still be here: ${warns.length}`);
  assert.equal(
    clears.length,
    warns.length,
    "every post-condition warning must also fail the command; a warn-only check reports a broken recovery path as success",
  );
});

test("every removal is exact-object logical retirement, never path rm", async () => {
  const removalLoop = entrySource.slice(entrySource.indexOf('while IFS=$\'\\t\' read -r kind path bytes'));
  assert.match(removalLoop, /\[\[ "\$path" == "\$store_root\/"\* \]\]/u, "the path must still be inside its store");
  assert.match(removalLoop, /"\$name" != \*\/\*/u, "a nested path is refused");
  assert.match(removalLoop, /retention_store" remove[\s\S]*--authority-token/u,
    "the planned object token must reach descriptor-held retirement");
  assert.match(removalLoop, /retirement_receipt="\$\(python3 -I "\$retention_store" remove[\s\S]*\^\\\.prune-retired-\[0-9a-f\]\{32\}\$/u,
    "the caller must capture and validate the content-addressed retirement receipt");
  assert.doesNotMatch(removalLoop, /rm -rf -- "\$path"/u);
  assert.match(removalLoop, /for pointer in current previous current-deployment/u,
    "a path a live authority pointer still names is refused whatever the plan said");
  const descriptorRemoval = removalLoop.indexOf('python3 -I "$retention_store" remove');
  assert.ok(descriptorRemoval >= 0, "retention removal no longer uses the descriptor-safe helper");
  assert.ok(
    removalLoop.indexOf("readlink -f -- \"$REMOTE_ROOT/$pointer\"") < descriptorRemoval,
    "the pointer check runs before descriptor-safe removal, not after it",
  );
});

test("retention retirement rejects post-plan swaps, links, and writable authority", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "revival-retention-store-")));
  await chmod(directory, 0o700);
  const script = String.raw`
import ctypes,importlib.util,os,stat,sys
root,helper_path=sys.argv[1:]
spec=importlib.util.spec_from_file_location("retention_store",helper_path)
store=importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
store.REMOTE_ROOT=root
def exchange(source_parent,source,destination_parent,destination):
    function=getattr(ctypes.CDLL(None,use_errno=True),"renameat2",None)
    assert function is not None
    assert function(source_parent,os.fsencode(source),destination_parent,os.fsencode(destination),2)==0
name="a"*64
item=os.path.join(root,name); os.mkdir(item,0o700)
fd=os.open(os.path.join(item,"payload"),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.write(fd,b"planned bytes\n"); os.fchmod(fd,0o600); os.close(fd)
parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    # A real retained backup/release is nested. Retirement is intentionally
    # logical: the public name disappears, while a content-addressed quarantine
    # retains every byte so a later authority failure remains recoverable.
    success_name="f"*64
    os.mkdir(success_name,0o700,dir_fd=parent)
    success=os.open(success_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    os.mkdir("branch",0o700,dir_fd=success)
    branch=os.open("branch",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=success)
    payload=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=branch)
    os.write(payload,b"nested retained bytes\n"); os.fchmod(payload,0o600); os.close(payload)
    os.close(branch); os.close(success)
    success_plan=store.capture(parent,success_name,"release")
    store.remove(parent,success_name,"release",success_plan["authorityToken"])
    assert not os.path.lexists(os.path.join(root,success_name))
    successful_retired=[entry for entry in os.listdir(parent) if entry.startswith(".prune-retired-")]
    assert len(successful_retired)==1
    retired=os.open(successful_retired[0],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    retired_authority=store.RetirementAuthority(retired)
    try:
        assert successful_retired[0]==".prune-retired-"+retired_authority.digest[:32]
        branch=os.open("branch",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=retired)
        payload=os.open("payload",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=branch)
        assert os.read(payload,64)==b"nested retained bytes\n"
        os.close(payload); os.close(branch)
    finally: retired_authority.close(); os.close(retired)

    plan=store.capture(parent,name,"release")
    os.mkdir("outside-substitute",0o700,dir_fd=parent)
    outside_dir=os.open("outside-substitute",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    outside_file=os.open("substitute",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=outside_dir)
    os.write(outside_file,b"substitute survives\n"); os.fchmod(outside_file,0o600); os.close(outside_file); os.close(outside_dir)
    original_rename=store.rename_no_replace
    def race(source_parent,source,destination_parent,destination):
        exchange(source_parent,source,source_parent,"outside-substitute")
        original_rename(source_parent,source,destination_parent,destination)
    store.rename_no_replace=race
    try: store.remove(parent,name,"release",plan["authorityToken"])
    except SystemExit: pass
    else: raise AssertionError("post-plan same-name replacement was deleted")
    planned_original=os.open("outside-substitute",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    planned_payload=os.open("payload",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=planned_original)
    assert os.read(planned_payload,64)==b"planned bytes\n"; os.close(planned_payload); os.close(planned_original)
    quarantines=[entry for entry in os.listdir(parent) if entry.startswith(".prune-retired-")]
    preserved=[]
    for quarantine_name in quarantines:
        quarantine=os.open(quarantine_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            try: substitute=os.open("substitute",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=quarantine)
            except FileNotFoundError: continue
            assert os.read(substitute,64)==b"substitute survives\n"; os.close(substitute)
            preserved.append(quarantine_name)
        finally: os.close(quarantine)
    assert len(preserved)==1
    store.rename_no_replace=original_rename

    # A child replaced after its held descriptor is opened must be preserved,
    # even though the root still matches the approved plan token.
    nested_name="e"*64
    os.mkdir(nested_name,0o700,dir_fd=parent)
    nested=os.open(nested_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    payload=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=nested)
    os.write(payload,b"planned nested bytes\n"); os.fchmod(payload,0o600); os.close(payload); os.close(nested)
    nested_plan=store.capture(parent,nested_name,"release")
    outside_file=os.open("outside-file",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    os.write(outside_file,b"nested substitute survives\n"); os.fchmod(outside_file,0o600); os.close(outside_file)
    original_checkpoint=store.retirement_checkpoint; fired=False
    def racing_checkpoint(label,source_parent,root_fd):
        global fired
        if label=="after-quarantine" and not fired:
            retired_name=next(entry for entry in os.listdir(parent)
                              if entry.startswith(".prune-retired-") and
                              "payload" in os.listdir(os.path.join(root,entry)))
            retired=os.open(retired_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            fired=True; exchange(retired,"payload",parent,"outside-file"); os.close(retired)
        original_checkpoint(label,source_parent,root_fd)
    store.retirement_checkpoint=racing_checkpoint
    try:
        try: store.remove(parent,nested_name,"release",nested_plan["authorityToken"])
        except SystemExit: pass
        else: raise AssertionError("nested same-name replacement was deleted")
    finally:
        store.retirement_checkpoint=original_checkpoint
    assert fired
    original_payload=os.open("outside-file",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
    assert os.read(original_payload,64)==b"planned nested bytes\n"; os.close(original_payload)
    nested_quarantines=[]
    for entry in os.listdir(parent):
        if not entry.startswith(".prune-retired-"): continue
        descriptor=os.open(entry,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            for member in os.listdir(descriptor):
                if not stat.S_ISREG(os.stat(member,dir_fd=descriptor,follow_symlinks=False).st_mode): continue
                try: substitute=os.open(member,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=descriptor)
                except OSError: continue
                try:
                    if os.read(substitute,64)==b"nested substitute survives\n":
                        nested_quarantines.append(entry)
                finally: os.close(substitute)
        finally: os.close(descriptor)
    assert len(nested_quarantines)==1

    victim=os.path.join(root,"victim"); os.mkdir(victim,0o700)
    os.symlink(victim,os.path.join(root,"b"*64))
    try: store.capture(parent,"b"*64,"release")
    except SystemExit: pass
    else: raise AssertionError("retention accepted a symlink root")

    os.mkdir("c"*64,0o700,dir_fd=parent)
    hard=os.open("c"*64,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    payload=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=hard)
    os.write(payload,b"linked\n"); os.fchmod(payload,0o600); os.close(payload)
    os.link("payload","external-hardlink",src_dir_fd=hard,dst_dir_fd=parent,follow_symlinks=False)
    try: store.capture(parent,"c"*64,"release")
    except SystemExit: pass
    else: raise AssertionError("retention accepted a hardlinked member")
    os.close(hard)

    os.mkdir("d"*64,0o700,dir_fd=parent); os.chmod(os.path.join(root,"d"*64),0o777)
    try: store.capture(parent,"d"*64,"release")
    except SystemExit: pass
    else: raise AssertionError("retention accepted a writable root")
finally: os.close(parent)
`;
  const result = spawnSync("python3", ["-I", "-B", "-c", script, directory, retentionStore], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the upload lease spans preflight, all retries, and deployment handoff", async () => {
  const deploy = await readFile(path.join(root, "platform/deploy/vps/deploy.sh"), "utf8");
  const start = deploy.indexOf("start_remote_upload_lease");
  const preflight = deploy.indexOf("remote_preupload_gate", start);
  const transfer = deploy.indexOf("transfer_candidate_resumably", preflight);
  const handoff = deploy.indexOf("run_verified_release_deploy", transfer);
  const stop = deploy.indexOf("stop_remote_upload_lease", handoff);
  assert.ok(start >= 0 && start < preflight && preflight < transfer && transfer < handoff && handoff < stop,
    "one remote lease must cover staging creation, resumable transfer, and handoff");
  assert.match(localLibSource, /fcntl\.flock\(lock,fcntl\.LOCK_EX\|fcntl\.LOCK_NB\)[\s\S]*sys\.stdin\.buffer\.read\(\)/u);
  const deployLock = entrySource.indexOf('flock -n 9');
  const uploadLock = entrySource.indexOf('fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)');
  assert.ok(deployLock >= 0 && uploadLock > deployLock,
    "retention must nonblocking-prove both the deployment lock and active-upload lease");
});

/* ---------- the wrappers ---------------------------------------------------- */

const SSH_REACHED = "REVIVAL-TEST-SSH-WAS-INVOKED";
const shimBin = await mkdtemp(path.join(os.tmpdir(), "revival-retention-noconnect-"));
await writeFile(path.join(shimBin, "ssh"), `#!/bin/sh\necho ${SSH_REACHED} >&2\nexit 41\n`, { mode: 0o755 });
await chmod(path.join(shimBin, "ssh"), 0o755);

function runLocalWrapper(...args) {
  return spawnSync("bash", [localWrapper, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimBin}${path.delimiter}${process.env.PATH}` },
  });
}

test("the argument lists are closed on both sides, and refuse before connecting", async () => {
  const optionLoop = (source, label) => {
    const start = source.indexOf("while (($#)); do");
    assert.ok(start >= 0, `${label} has no argument loop to close`);
    const end = source.indexOf("\ndone", start);
    assert.ok(end > start, `${label}'s argument loop is unterminated`);
    return source.slice(start, end);
  };
  assert.match(optionLoop(localSource, "local wrapper"), /\*\) usage ;;/u);
  assert.match(optionLoop(entrySource, "remote entry"), /\*\) usage ;;/u);
  assert.doesNotMatch(localSource, /run_remote_impl prune-state\.sh "\$@"/u,
    "the local wrapper must not forward an unread option list");

  for (const args of [["--some-option-added-later"], ["--min-age-hours", "soon"], ["--expect-plan", "nonsense"]]) {
    const rejected = runLocalWrapper(...args);
    assert.equal(rejected.status, 64, `${args.join(" ")} must be a usage error`);
    assert.doesNotMatch(rejected.stderr ?? "", new RegExp(SSH_REACHED, "u"),
      `${args.join(" ")} must be refused before any connection`);
  }

  // --expect-plan without --confirm is a misunderstanding worth naming: without
  // --confirm nothing is removed, so a token there proves nothing.
  const tokenAlone = runLocalWrapper("--expect-plan", "0".repeat(64));
  assert.equal(tokenAlone.status, 64);
  assert.match(tokenAlone.stderr, /only meaningful with --confirm/u);

  // And the far side refuses an option nobody has read it to allow, out of its
  // own argument loop, before it touches a lock or a store.
  const remoteRejected = spawnSync("bash", [entryPoint, "--some-option-added-later"], { encoding: "utf8" });
  assert.equal(remoteRejected.status, 64, "the remote entry point must not swallow an unknown option");
});

test("there is no option anywhere that forces, skips or overrides the retention proof", async () => {
  for (const [label, source] of [["remote entry", entrySource], ["local wrapper", localSource], ["driver", driverSource]]) {
    assert.doesNotMatch(source, /--(?:force|skip|no-verify|ignore|disable|all|purge|everything)[a-z-]*/u,
      `${label} must not offer a way around the proof`);
  }
  // --include-incomplete is the one widening flag, and it widens exactly one
  // named class. It must not be able to reach anything the proof retained.
  const request = productionShape();
  const opened = await planned({ ...request, includeIncomplete: true });
  for (const name of [rid("D1"), rid("D2"), rid("D3"), rid("D4"), rid("D5"), "20260812T170000Z-deadbeef"]) {
    assert.equal(action(opened, "backups", name).action, "keep",
      `--include-incomplete must not reach ${name}`);
  }
});

test("retention planner and descriptor store are streamed together", async () => {
  // The command has to work when the disk is too full for a deploy, so it cannot
  // depend on a release having shipped it. run_remote_impl streams the reviewed
  // files over stdin; the driver has to be one of them or the entry point finds
  // nothing to run.
  assert.match(localLibSource, /prune-state\.py/u);
  assert.match(localLibSource, /retention-store\.py/u);
  assert.match(localSource, /run_remote_impl prune-state\.sh/u);
  const chmodAt = localLibSource.indexOf('chmod 600 "$tmp_dir/common.sh"');
  assert.ok(chmodAt >= 0, "the streamed helper chmod line is gone");
  const chmodStatement = localLibSource.slice(chmodAt, localLibSource.indexOf("\nBOOTSTRAP", chmodAt));
  assert.match(chmodStatement, /prune-state\.py/u, "the streamed driver must be mode 600 like its peers");
  assert.match(chmodStatement, /retention-store\.py/u, "the descriptor retirement helper must be streamed read-only");
});

test("deployments and manifests are never removed", async () => {
  // A removed record is a removed proof: records are what every retention reason
  // above is derived from, and they total 19 MB against 3.6 GB of backups. A
  // manifest whose release is gone is inert; a release whose manifest is gone
  // cannot be verified. Neither store has any business being pruned here.
  assert.doesNotMatch(entrySource, /rm -rf[^\n]*DEPLOYMENTS_DIR|rm -rf[^\n]*MANIFESTS_DIR/u);
  const document = await planned(productionShape());
  assert.ok(!("deployments" in document) || !Array.isArray(document.deployments),
    "the plan must not contain a removal list for deployment records");
  assert.deepEqual(Object.keys(document).filter((key) => ["backups", "releases"].includes(key)).sort(),
    ["backups", "releases"]);
  const stores = /case "\$kind" in\n\s+backup\)[\s\S]*?esac/u.exec(entrySource);
  assert.ok(stores, "the removal loop no longer switches on a closed set of stores");
  assert.doesNotMatch(stores[0], /DEPLOYMENTS_DIR|MANIFESTS_DIR|PRIVATE_DIR|DATA_DIR/u);
});
