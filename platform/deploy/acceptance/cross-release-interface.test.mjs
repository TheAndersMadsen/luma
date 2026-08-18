import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * THE CROSS-RELEASE INTERFACE BOUNDARY.
 *
 * deploy.sh reconciles a transaction that a PREVIOUS release armed, and the
 * scripts that finish or unwind it must be that release's — the partial effects
 * on disk are its. So those invocations cross a release boundary, and the invoked
 * script's interface is whatever it was when that release was cut.
 *
 * Deploy 14 assumed otherwise: the new deploy.sh passed --data-columns-source to
 * the pending release's backup.sh, which exited 64 on its own usage line. The
 * transaction was already CANDIDATE_ACTIVATION_ARMED — which by design has no
 * abort path, because live mutation has begun — so the only code that could
 * finish it was the code that could not run. That is a production deadlock, and
 * every future option added to any invoked script re-creates it for every
 * transaction armed before the option existed.
 *
 * These tests pin the class rather than the instance:
 *   1. the guard exists and actually refuses a newer-than-baseline option;
 *   2. EVERY invocation of another release's tree goes through it, statically —
 *      including the ones that are python helpers and cannot use the wrapper;
 *   3. the specific option that caused the deadlock is not passed across the
 *      boundary, and the evidence it produced is produced by the new code instead.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = path.join(root, "platform/deploy/vps/remote");
const common = path.join(remote, "common.sh");
const commonSource = (
  await Promise.all(
    [common, ...(await readdir(path.join(path.dirname(common), "lib")))
      .filter((name) => name.endsWith(".sh"))
      .sort()
      .map((name) => path.join(path.dirname(common), "lib", name))]
      .map((file) => readFile(file, "utf8")),
  )
).join("\n");
const deploySource = await readFile(path.join(remote, "deploy.sh"), "utf8");
const preflightSource = await readFile(path.join(remote, "preflight.sh"), "utf8");
const rollbackSource = await readFile(path.join(remote, "rollback.sh"), "utf8");

function guard(program, args) {
  return spawnSync("bash", ["-c", String.raw`
source "$1"
shift
assert_cross_release_options "$@"
`, "fixture", common, program, ...args], { cwd: root, encoding: "utf8" });
}

/* ---------- 1. the guard itself --------------------------------------------- */

test("the guard accepts the baseline interface and refuses anything newer", () => {
  // Exactly what the resume passes to a possibly-older backup.sh today.
  const accepted = guard("backup.sh", [
    "--backup-id", "precommit-resume-fixture", "--leave-quiesced", "--already-locked",
    "--public-ingress-quiesced", "--cloudflared-record", "/fixture/record",
    "--cloudflared-state", "desired", "--ingress-evidence", "/fixture/ingress.tsv",
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);

  // The one that deadlocked deploy 14.
  const refused = guard("backup.sh", [
    "--backup-id", "precommit-resume-fixture", "--leave-quiesced",
    "--data-columns-source", "/fixture/backup/postgres-data.tsv.columns",
  ]);
  assert.notEqual(refused.status, 0, "--data-columns-source must not cross a release boundary");
  assert.match(refused.stderr, /--data-columns-source/u);
  assert.match(refused.stderr, /newer than the release-boundary baseline/u);

  // And it is not special-cased: ANY unknown option is refused the same way.
  const future = guard("canary.sh", ["--release-id", "0".repeat(64), "--some-option-added-later"]);
  assert.notEqual(future.status, 0, "an option added after the boundary must be refused");
  assert.match(future.stderr, /--some-option-added-later/u);

  // A program with no declared baseline cannot be invoked across the boundary at
  // all -- silence is not permission.
  const undeclared = guard("staging-smoke.sh", ["--release-id", "0".repeat(64)]);
  assert.notEqual(undeclared.status, 0, "an undeclared program must not pass the guard");
  assert.match(undeclared.stderr, /no cross-release interface baseline is declared/u);
});

test("the declared baseline is a subset of what this release's own scripts accept", () => {
  // The baseline is a promise about OLDER releases, so it can never name an
  // option even the current release does not have; that would be a typo the
  // guard would then happily let through.
  for (const script of ["backup.sh", "canary.sh"]) {
    const source = spawnSync("bash", ["-c", String.raw`
source "$1"
cross_release_baseline_options "$2"
`, "fixture", common, script], { cwd: root, encoding: "utf8" });
    assert.equal(source.status, 0, source.stderr);
    const declared = source.stdout.trim().split("\n");
    assert.ok(declared.length > 0);
    const text = readFileSyncish(path.join(remote, script));
    for (const option of declared) {
      assert.ok(
        text.includes(`    ${option})`) || text.includes(`${option}) `),
        `${script} does not accept ${option}, which the cross-release baseline claims every release does`,
      );
    }
  }
});

function readFileSyncish(file) {
  const result = spawnSync("cat", [file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/* ---------- 2. every cross-release invocation, statically ------------------- */

/*
 * The enumeration this class needs: every place a script or helper is executed
 * out of a release tree that is not the running code's own. Those trees are named
 * by exactly three variables -- $pending_release (deploy.sh, preflight.sh) and
 * $target_release (rollback.sh) -- plus the two helper paths derived from them.
 */
const CROSS_RELEASE_TREE = /\$(?:pending_release|target_release)\b|\$(?:pending_verifier|pending_transaction_driver|target_verifier)\b/u;

function invocations(source) {
  // Logical lines: a trailing backslash continues an invocation.
  const lines = source.split("\n");
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    let statement = lines[index];
    while (statement.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      statement = `${statement.slice(0, -1)} ${lines[index].trim()}`;
    }
    out.push(statement);
  }
  return out;
}

const PROGRAM_OF = [
  [/^(?:sudo -n )?python3 "\$(?:pending_verifier|target_verifier)"/u, "verify-release.py"],
  [/^(?:sudo -n )?python3 "\$pending_transaction_driver"/u, "transaction.py"],
];

test("nothing executes another release's tree except through the guarded entry points", () => {
  let checked = 0;
  for (const [label, source] of Object.entries({ deploySource, preflightSource, rollbackSource })) {
    const statements = invocations(source).map((value) => value.trim());
    for (const [index, statement] of statements.entries()) {
      if (statement.startsWith("#") || !CROSS_RELEASE_TREE.test(statement)) continue;

      // A shell script out of another tree must go through the wrapper, which
      // resolves the entry and asserts the argv for itself.
      assert.doesNotMatch(statement, /^(?:sudo -n )?bash "\$(?:pending_release|target_release)\//u,
        `${label} runs another release's script directly instead of run_cross_release_script: ${statement}`);

      // A python helper cannot use the wrapper (sudo, and the verifier's output is
      // redirected), so the assertion must stand immediately before the call and
      // must name the same program.
      const program = PROGRAM_OF.find(([pattern]) => pattern.test(statement))?.[1];
      if (!program) continue;
      const previous = statements.slice(0, index).reverse()
        .find((value) => value.length > 0 && !value.startsWith("#"));
      assert.match(previous ?? "", new RegExp(String.raw`^assert_cross_release_options ${program.replace(".", "\\.")}\b`, "u"),
        `${label} runs another release's ${program} without an immediately preceding cross-release assertion: ${statement}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 4, `expected every cross-release helper call to be examined, saw ${checked}`);
});

test("every remaining cross-release helper call is preceded by an explicit assertion", () => {
  // The three python invocations that cannot use the wrapper. Each is immediately
  // preceded by assert_cross_release_options naming the same program.
  const sites = [
    [deploySource, /assert_cross_release_options verify-release\.py [^\n]*\n\s*python3 "\$pending_verifier"/u],
    [preflightSource, /assert_cross_release_options verify-release\.py [^\n]*\n\s*python3 "\$pending_verifier"/u],
    [preflightSource, /assert_cross_release_options transaction\.py [^\n]*\n\s*python3 "\$pending_transaction_driver"/u],
    [rollbackSource, /assert_cross_release_options verify-release\.py [^\n]*\n\s*python3 "\$target_verifier"/u],
  ];
  for (const [source, pattern] of sites) assert.match(source, pattern);
});

test("every cross-release invocation carries the comment that says why it is one", () => {
  // Requested explicitly after deploy 14: a reader who does not already know the
  // boundary exists must be told at the call, not only in common.sh.
  const marked = [...deploySource.matchAll(/CROSS-RELEASE INVOCATION/gu)].length;
  const wrapped = [...deploySource.matchAll(/^\s*run_cross_release_script "\$pending_release"/gmu)].length;
  assert.ok(wrapped >= 7, `expected every reconcile-path script invocation to be wrapped, found ${wrapped}`);
  assert.ok(marked >= wrapped, "each cross-release invocation must contain its comment");
  assert.match(preflightSource, /CROSS-RELEASE INVOCATION/u);
  assert.match(rollbackSource, /CROSS-RELEASE INVOCATION/u);
  assert.match(commonSource, /^# CROSS-RELEASE INVOCATION: running a script that belongs to a DIFFERENT release$/mu);
});

/* ---------- 3. the resume owns the evidence it compares --------------------- */

test("the resume captures its own zero-delta manifests instead of asking an older release", () => {
  // The backup still runs, and still supplies every artifact compared
  // byte-for-byte against a baseline the same code produced.
  assert.match(deploySource,
    /^    run_cross_release_script "\$pending_release" backup\.sh \\\n      --backup-id "\$resume_backup_id" --leave-quiesced --already-locked --public-ingress-quiesced \\\n      --cloudflared-record "\$pending_record" --cloudflared-state desired \\\n      --ingress-evidence "\$pending_record\/ingress-active\.tsv"$/mu);
  // Its two format-bound manifests are captured here, by this release.
  assert.match(deploySource, /^capture_resume_candidate_evidence\(\) \{$/mu);
  assert.match(deploySource, /^resume_baseline_schema_manifest\(\) \{$/mu);
  assert.match(deploySource,
    /^    capture_resume_candidate_evidence "\$resume_evidence" "\$baseline" \\$/mu);
  // ...and they are what the one comparison is handed.
  assert.match(deploySource,
    /^    compare_precommit_compatibility_state "\$baseline" "\$resume_backup" \\\n      "resumed candidate changed compatibility state before acceptance" \\\n      "\$resume_evidence\/candidate-data\.tsv" \\\n      "\$resume_baseline_schema" "\$resume_evidence\/candidate-schema\.tsv"$/mu);
  // The new evidence never lands inside the backup: that directory's SHA256SUMS
  // and BACKUP_MANIFEST.json are sealed and verified before this point.
  assert.match(deploySource, /^    resume_evidence="\$pending_record\/precommit-resume-evidence"$/mu);
});

test("the pre-candidate retained dump is recovered by binding, never by trust", () => {
  // classify_schema_delta re-hashes whatever text it is given and refuses unless
  // it reproduces the digest, byte count and line count of the manifest the gate
  // compared. So the recovered text is bound to the BASELINE's own manifest,
  // which is copied byte-for-byte and verified.
  const body = deploySource.slice(deploySource.indexOf("resume_baseline_schema_manifest() {"));
  const end = body.indexOf("\n}\n");
  const fn = body.slice(0, end);
  assert.match(fn, /install -m 600 "\$baseline\/postgres-schema\.tsv" "\$manifest"/u);
  assert.match(fn, /cmp -s "\$baseline\/postgres-schema\.tsv" "\$manifest"/u);
  assert.match(fn, /cmp -s "\$source" "\$manifest\.\$database\.sql"/u);
  // The baseline's own sidecar wins when it has one; the rehearsal's is only a
  // fallback for baselines older than retain-sql.
  assert.ok(fn.indexOf('"$baseline/postgres-schema.tsv.$database.sql"')
    < fn.indexOf("staging-smoke-evidence/postgres-schema.before.tsv"));
  // And when neither exists, nothing is written and the classifier refuses.
  assert.match(fn, /\[\[ -n "\$source" \]\] \|\| continue/u);
  assert.match(commonSource, /retained pg_dump text is missing beside the manifest/u);
});
