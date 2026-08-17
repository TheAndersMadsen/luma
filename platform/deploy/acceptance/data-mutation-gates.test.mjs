import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { at } from "./source-offsets.mjs";

/*
 * "A candidate's startup must not move a wearer's rows", from both ends.
 *
 * Two halves, landed by two different agents, that only work together:
 *
 *   1. The RUNTIME half, in cosmos/crates/cosmos/src/store_postgres.rs. Starting
 *      a candidate runs migrations, and the one reviewed data removal in that
 *      history (`DELETE FROM carry_account_blob …`) plus the thumbnail backfill
 *      (`UPDATE carry_memory …`) both rewrite existing rows. Both are now held
 *      back unless CARRY_ALLOW_DATA_REMOVALS is set, so shipping a release
 *      cannot delete or rewrite a wearer's data as a side effect.
 *
 *   2. The DEPLOY half, in remote/staging-smoke.sh + common.sh. The smoke
 *      fingerprints every relation in both databases before and after the
 *      candidate starts and refuses the deploy if any digest moved.
 *
 *      Each half is the other's enforcement. store_postgres.rs says so in its
 *      own comment ("the deploy's staging smoke fingerprints every relation
 *      before and after startup … so a cleanup riding along with a release is
 *      either blocked, or — if that gate were ever relaxed — deletes data as an
 *      invisible side effect of shipping").
 *
 * Neither half had a test that noticed it being unwired. The Rust suite checks
 * the TEXT of the migrations (every_migration_statement_is_restart_safe_and_
 * non_destructive) and nothing checks that the runtime gate around them still
 * exists; `cargo test` does not run in the deploy path at all. The staging
 * fingerprint comparison is executed only against a VPS with a restored backup.
 *
 * So the pins here are source-level and line-anchored, in the style of
 * deploy-gates.test.mjs: `^…$` with the `m` flag, matching the executable line
 * rather than the words, because both files explain themselves at length and a
 * substring match is satisfied by the paragraph describing the check.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// The splitter tests below EXECUTE common.sh rather than reading it, so they
// need its path as well as its text.
const commonPath = path.join(root, "platform/deploy/vps/remote/common.sh");
function bash(script, args = []) {
  return spawnSync("bash", ["-c", script, "fixture", commonPath, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

const store = read("cosmos/crates/cosmos/src/store_postgres.rs");
const staging = read("platform/deploy/vps/remote/staging-smoke.sh");
const common = [
  read("platform/deploy/vps/remote/common.sh"),
  ...fs.readdirSync(path.join(root, "platform/deploy/vps/remote/lib"))
    .filter((name) => name.endsWith(".sh")).sort()
    .map((name) => read(path.join("platform/deploy/vps/remote/lib", name))),
].join("\n");
const smoke = read("platform/deploy/vps/remote/staging-smoke.sh");
const deploy = read("platform/deploy/vps/remote/deploy.sh");

test("data removals are off unless the operator asked for them, by exact value", () => {
  /*
   * The whole gate is one predicate, so it is pinned as one contiguous block:
   * an `unwrap_or("1")`, an `is_ok()`, or a `!= "0"` would each turn "the
   * operator asked" into "the variable is mentioned", and every line-by-line
   * pin would still match.
   */
  assert.ok(
    store.includes([
      "fn data_removals_enabled() -> bool {",
      "    matches!(",
      '        std::env::var("CARRY_ALLOW_DATA_REMOVALS").as_deref(),',
      '        Ok("1") | Ok("true")',
      "    )",
      "}",
    ].join("\n")),
    "data_removals_enabled must stay an exact-value match on CARRY_ALLOW_DATA_REMOVALS",
  );

  // Two gates, two call sites: the migration loop and the thumbnail backfill.
  // Counted, because each of the two pins below would still match with the
  // other's guard deleted.
  assert.equal(
    [...store.matchAll(/data_removals_enabled\(\)/g)].length,
    3,
    "the predicate is declared once and consulted at exactly the migration gate and the backfill gate",
  );

  // And the verb set that decides what "removal" means. It is deliberately the
  // same list the migration-text gate uses, so the runtime and the test cannot
  // drift into disagreeing about what is destructive.
  assert.match(store, /^\s*\[" DELETE ", " TRUNCATE ", " DROP "\]$/m);
  assert.match(store, /^\s*let padded = format!\(" \{\} ", normalized\.to_uppercase\(\)\);$/m);
});

test("a migration that removes data is held back, and the release still starts", () => {
  /*
   * The blast radius of an accidental removal here is the wearer's own data, and
   * the reviewed removal in 0005 is legitimate — it just must not run because
   * someone shipped a release. Holding it back has to be a `continue` inside the
   * statement loop: anything that aborts the migration instead would turn a
   * held-back cleanup into a crash loop on startup.
   */
  assert.match(store, /^        let removals_allowed = data_removals_enabled\(\);$/m);
  assert.match(store, /^                if !removals_allowed && statement_removes_data\(statement\) \{$/m);
  assert.match(store, /^                    continue;$/m);
  // The log line is the only thing that tells an operator a statement did not
  // run and how to run it, so the variable name in it is part of the contract.
  assert.match(store, /^                         set CARRY_ALLOW_DATA_REMOVALS=1 to run it deliberately"$/m);

  // Order inside migrate(): the guard must precede the execute it guards.
  const guard = at(store, "if !removals_allowed && statement_removes_data(statement) {");
  const execute = at(store, "sqlx::query(statement).execute(&mut *tx).await?;");
  assert.ok(guard < execute, "the removal guard must sit before the statement it holds back");
});

test("the thumbnail backfill is gated too, because it REWRITES rows the smoke fingerprints", () => {
  /*
   * backfill_thumbnail_counts is an `UPDATE carry_memory …` — a data repair, not
   * a migration, precisely so the migration suite's ban on UPDATE stays intact.
   * That makes it invisible to every existing gate: it is not migration text, so
   * every_migration_statement_is_restart_safe_and_non_destructive never sees it,
   * and it runs on every connect(). Ungated, an ordinary deploy rewrites every
   * capture row whose thumbnail_count is NULL and the staging smoke then refuses
   * the deploy for a change the deploy itself caused.
   *
   * Pinned as a contiguous block: a call that stays in the file but drifts out of
   * the `if` is not gated, and three separate line pins would not notice.
   */
  assert.ok(
    store.includes([
      "        if data_removals_enabled() {",
      "            store.backfill_thumbnail_counts().await;",
      "        }",
    ].join("\n")),
    "the thumbnail backfill must run only when data removals were asked for",
  );
  // And the read path must still answer correctly without it, or gating it would
  // be a correctness change rather than a deferral.
  assert.match(store, /^\s*async fn backfill_thumbnail_counts\(&self\) \{$/m);
  assert.match(store, /THUMBNAIL_COUNT_EXPRESSION/);

  const gate = at(store, "if data_removals_enabled() {\n            store.backfill_thumbnail_counts().await;");
  const migrated = at(store, "store.migrate().await?;");
  assert.ok(migrated < gate, "the backfill runs after the schema exists, and only behind the gate");
});

test("the staging smoke fingerprints every relation's ROWS, not just its row count", () => {
  /*
   * The evidence that makes the runtime gate above enforceable. A count-only
   * manifest is satisfied by a migration that rewrites every row in place, which
   * is exactly what the reviewed removal's sibling operations do; the digest is
   * what makes "no wearer byte moved" checkable.
   *
   * These pin common.sh's capture_postgres_data — the canonical one, the one the
   * backup producer, deploy.sh and rollback.sh all call.
   */
  // These statements moved from `psql -c` into a batched script fed to `psql -f -`
  // (see "ONE psql SESSION PER DATABASE" in common.sh). The STATEMENT TEXT is what
  // this pins, and it is unchanged to the byte — a batched capture whose SQL drifts
  // produces a manifest that is not comparable with one taken by any other release,
  // which is the whole property the zero-delta chain rests on.
  assert.match(
    common,
    /^copy \(select to_jsonb\(x\)::text from \(select \$columns from only \$qualified\) x order by 1\) to stdout;$/m,
    "ordinary tables must be digested row by row over their projected columns",
  );
  // Sequences and large objects are in the manifest too: a sequence the candidate
  // bumped is data movement, and pg_largeobject is where Keycloak keeps blobs.
  assert.match(
    common,
    /^copy \(select jsonb_build_object\('last_value',last_value,'is_called',is_called\)::text from \$qualified\) to stdout;$/m,
  );
  // Materialized views keep their own ordering, which is NOT the projected-column
  // form above: there is no `only` and the sort is over the whole row.
  assert.match(
    common,
    /^copy \(select to_jsonb\(t\)::text from \$qualified t order by to_jsonb\(t\)::text\) to stdout;$/m,
  );
  // The counts are still `from only` for tables and plain for matviews, so a
  // partitioned parent and its leaves stay disjoint instead of double-counted.
  assert.match(common, /^select count\(\*\) from only \$qualified;$/m);
  assert.match(common, /^select count\(\*\) from \$qualified;$/m);
  assert.match(common, /^\s*printf '%s\\tpg_catalog\\tpg_largeobject\\tL\\t%s\\t%s\\n' "\$database" "\$lo_count" "\$lo_digest" >>"\$output"$/m);
  // Both halves validated: an empty count or a short digest is a failed capture,
  // not an empty comparison.
  assert.match(common, /^\s*\[\[ "\$count" =~ \^\[0-9\]\+\$ && "\$digest" =~ \^\[0-9a-f\]\{64\}\$ \]\] \\$/m);
  assert.match(common, /^\s*\|\| fail "database relation manifest failed"$/m);
  // And the relation catalog itself must be non-empty, or a database that
  // answered nothing would fingerprint as "no relations changed".
  assert.match(common, /^\s*\[\[ -n "\$relations" \]\] \|\| fail "database relation catalog is empty"$/m);
});

/*
 * Reads capture_postgres_data's body out of common.sh. The batching invariants
 * below are about WHERE a statement sits — inside the per-relation loop or
 * outside it — and that is not expressible as a line-anchored regex over the
 * whole file, because the same text is legal in one place and a regression in
 * the other.
 */
function shellFunction(source, name) {
  const start = source.indexOf(`\n${name}() {\n`);
  assert.ok(start >= 0, `${name} is not defined at column 0 in common.sh`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} has no closing brace at column 0`);
  return source.slice(start + 1, end + 2);
}

/*
 * The body of the loop whose header line ENDS with `marker`, delimited by the
 * `done` at the header's own indentation.
 *
 * Slicing to the last `done` instead is what a first draft of this test did, and
 * it silently swallowed the large-object section that legitimately follows the
 * relation loops — so the assertion "no docker exec in this loop" was really
 * asserting something about a region three statements wider, and failed on
 * correct code. Matching the closing `done` by indentation is the difference
 * between a test that pins the loop and a test that pins a coincidence.
 */
function allShellLoopBodies(body, marker) {
  const lines = body.split("\n");
  const bodies = [];
  lines.forEach((line, header) => {
    if (!line.trimEnd().endsWith(marker)) return;
    const indent = line.match(/^\s*/)[0];
    const close = lines.findIndex(
      (candidate, index) =>
        index > header &&
        (candidate === `${indent}done` || candidate.startsWith(`${indent}done `)),
    );
    assert.ok(close > header, `loop ${marker} has no matching done`);
    bodies.push(lines.slice(header + 1, close).join("\n"));
  });
  assert.ok(bodies.length > 0, `no loop header ending in ${marker}`);
  return bodies;
}

test("the capture spends a fixed number of container round trips, not one per relation", () => {
  /*
   * THE COST, AND WHY IT IS A GATE PROBLEM RATHER THAN A TIDINESS ONE.
   *
   * capture_postgres_data used to spend three to four `docker exec` calls per
   * relation — a count, a column lookup, a digest — over 103 relations in two
   * databases. Measured on the production host: 313 container round trips at
   * ~50ms of namespace and process setup each, 20.2s per call, against two
   * databases totalling 25MB. Eleven of those calls run inside the quiesced
   * public-ingress window (four in the pre-candidate backup, two in the staging
   * smoke, five in the post-candidate backup), so most of ~166s of a 420s budget
   * was process spawning, during which the wearer gets a Cloudflare 530 and the
   * Pin's device plane is unreachable.
   *
   * The fix is one psql SESSION per database. What must not come back is a
   * per-relation round trip, and the only durable way to say that is
   * structurally: no `docker exec` inside either loop over relations. A count or
   * a digest that drifts back into the loop is correct, passes every other test
   * in this file, and silently restores the whole 166s.
   */
  const body = shellFunction(common, "capture_postgres_data");

  // Every loop that runs once per relation. There are three: the catalog walk
  // that plans the work, the walk that generates the digest SQL, and the walk
  // that reads the results back onto manifest lines.
  const perRelationLoops = [
    "read -r schema relation kind; do",
    'for index in "${!rel_kind[@]}"; do',
  ];
  for (const marker of perRelationLoops) {
    for (const loop of allShellLoopBodies(body, marker)) {
      assert.ok(loop.length > 100, `the loop ${marker} was not located`);
      assert.doesNotMatch(
        loop,
        /docker exec/,
        `a per-relation loop must not open a container round trip (${marker}); that is the 20.2s`,
      );
    }
  }

  // The large-object pair is the one place a `docker exec` still legitimately
  // sits inside the database loop — twice per database, not per relation — so
  // the count above is fixed at ten round trips regardless of schema size.
  const execCount = (body.match(/docker exec/g) || []).length;
  assert.equal(
    execCount,
    3,
    "capture_postgres_data should reach the container in exactly three places: the relation catalog, the large-object count and the large-object digest (the batches go through postgres_segment_batch)",
  );

  // The live column lookup moved out of relation_column_projection entirely, so
  // that helper is now pure: given a recorded list and a live list it picks one.
  // A `docker exec` reappearing here is the same per-relation cost wearing a
  // different hat, and it would be invisible to the loop assertions above.
  assert.doesNotMatch(
    shellFunction(common, "relation_column_projection"),
    /docker exec/,
    "the projection helper must not query; the live lookups are batched by the caller",
  );
  assert.doesNotMatch(
    shellFunction(common, "relation_recorded_columns"),
    /docker exec/,
    "reading the recorded sidecar is a local awk and must stay one",
  );
});

test("a batch is one psql SESSION, never one transaction, and each statement keeps its own environment", () => {
  /*
   * The three properties that make batching safe to compare against a manifest
   * taken by the OLD per-statement implementation. All three were verified
   * empirically against the live production cluster before this landed — old and
   * new produced byte-identical manifests, 105 lines, over the real 103-relation
   * schema — but a passing diff on one day is not a contract, and these are the
   * things whose loss would move a digest.
   *
   *   1. NOT A TRANSACTION. psql stays in autocommit, so every statement takes
   *      its own snapshot exactly as a separate `docker exec` did. Wrapping the
   *      relations in one transaction would arguably be MORE consistent, and is
   *      exactly why it must not happen silently: it would change what the digest
   *      means, so two releases would disagree about an unchanged cluster.
   *   2. THE ENVIRONMENT IS PER-BATCH, SO THE BATCHES ARE SPLIT BY ENVIRONMENT.
   *      Counts and COPYs ran with PGOPTIONS statement_timeout/lock_timeout; the
   *      catalog list and the column lookups ran without. That is the whole
   *      reason the column lookups get their own session instead of riding along
   *      with the digests.
   *   3. THE DIGEST IS STILL sha256 OF THE BYTES PSQL WROTE, computed on the
   *      host. Moving it into SQL would mean re-implementing COPY's text escaping
   *      in SQL — a second implementation of the manifest format, which is the
   *      defect class this file already documents twice.
   */
  const body = shellFunction(common, "capture_postgres_data");

  assert.doesNotMatch(
    body,
    /\b(begin|start transaction|commit|rollback|set transaction)\b/i,
    "the batch must stay in autocommit: one session, not one transaction",
  );
  /*
   * The psql invocation, pinned exactly rather than by "does not contain -1".
   *
   * Two things ride on this one line. `-1`/`--single-transaction` would wrap the
   * whole batch in a transaction and change what every digest means. And `-qAt`
   * is not cosmetic: quiet suppresses the command status tag, unaligned drops
   * column padding, and tuples-only drops headers — any of the three coming off
   * would put extra bytes into the hashed stream and move every digest in the
   * manifest at once.
   */
  assert.match(
    common,
    /^\s*command\+=\("\$container" psql -X -qAt -v ON_ERROR_STOP=1 -U "\$database_user" -d "\$database" -f -\)$/m,
    "the batch psql invocation must stay exactly as the per-statement calls were, minus -c",
  );

  // Exactly two batch environments exist, and the call sites say which is which.
  assert.match(
    common,
    /^\s*postgres_segment_batch "\$container" "\$database_user" "\$database" plain \\$/m,
    "the column lookups must run in the timeout-free session, as they did per-statement",
  );
  assert.match(
    common,
    /^\s*postgres_segment_batch "\$container" "\$database_user" "\$database" timeouts \\$/m,
    "the counts and COPYs must keep statement_timeout and lock_timeout",
  );
  assert.match(
    common,
    /^\s*\[\[ "\$timeouts" != timeouts \]\] \\\n\s*\|\| command\+=\(-e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=5000'\)$/m,
    "the timeout batch must set the same PGOPTIONS the per-statement calls set",
  );

  // The digest is computed here, on the host, over psql's exact bytes.
  assert.match(
    shellFunction(common, "split_postgres_segments"),
    /digest\.update\(raw\)/,
    "the digest must be sha256 of the bytes psql wrote",
  );
  assert.doesNotMatch(
    body,
    /sha256\(|digest\('sha256'|encode\(sha256/i,
    "the digest must not be re-implemented in SQL; that is a second manifest format",
  );
});

test("the stream splitter cannot be fooled by data, and a miscount is fatal", () => {
  /*
   * psql writes every statement's output to one stdout, so the batch is cut on
   * `\echo <marker>` lines. Two ways that could go wrong, both closed here.
   *
   * FORGERY. If a data row could begin with the marker, a wearer's note would
   * split a segment and shift one relation's digest onto the next. It cannot: the
   * marker is a per-run random nonce wrapped in '#', and COPY renders every row of
   * this manifest as either a jsonb object ('{'…) or a large-object page (a
   * digit…), with JSON escaping every control character and COPY escaping every
   * newline. A fixture row whose body is literally
   * `#0123456789abcdef0123456789abcdef#` was captured by both the old and the new
   * implementation and produced identical digests.
   *
   * MISCOUNT. If psql emitted fewer segments than the plan — a statement that
   * failed after its marker — the old implementation would have taken sha256 of
   * an empty stream, which is a well-formed 64-hex digest, and written a
   * confidently wrong manifest line. Every arm here exits instead.
   */
  assert.match(
    common,
    /^\s*marker="#\$\(od -An -N16 -tx1 \/dev\/urandom \| tr -d ' \\n'\)#"$/m,
    "the marker must be a fresh random nonce, not a constant a row could contain",
  );
  assert.match(
    common,
    /^\s*\[\[ "\$marker" =~ \^#\[0-9a-f\]\{32\}#\$ \]\] \|\| fail "segment marker nonce is unavailable"$/m,
    "an unreadable nonce must fail rather than degrade to an empty or partial marker",
  );

  /*
   * IDENTIFIERS, which the batching made more load-bearing than they were.
   *
   * Every schema and relation name is interpolated into SQL. That was already
   * true per-statement, but those strings now land in a SCRIPT FILE that psql
   * reads with -f, so a name carrying a newline could introduce statements of
   * its own AND desynchronise the marker/plan correspondence at the same time.
   * The guard runs before any name reaches the generated SQL; without it the
   * whole suite still passes.
   */
  assert.match(
    common,
    /^\s*\[\[ "\$schema" =~ \^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$ && "\$relation" =~ \^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$ \]\] \\\n\s*\|\| fail "database contains an unsafe relation identifier"$/m,
    "relation identifiers must be validated before they are written into the batch script",
  );

  const splitter = shellFunction(common, "split_postgres_segments");
  for (const guard of [
    "psql batch plan is empty",
    "psql batch produced more segments than its plan",
    "psql batch wrote output before its first segment marker",
    "psql batch segment count differs from its plan",
  ]) {
    assert.ok(
      splitter.includes(`raise SystemExit("${guard}")`),
      `the splitter must abort on: ${guard}`,
    );
  }

  // And the batch runner must turn any of that into a hard failure. This is the
  // arm that made a dropped column fail loudly instead of digesting nothing.
  assert.match(
    common,
    /^\s*\|\| fail "batched PostgreSQL capture failed for database \$database"$/m,
  );
  // The results are then checked against the plan on the bash side too: a short
  // batch must not leave later relations reading `${values[...]:-}` as empty.
  assert.match(common, /^\s*\(\( \$\{#values\[@\]\} == \$\{#pending\[@\]\} \)\) \|\| fail "database relation column batch is incomplete"$/m);
  assert.match(common, /^\s*\(\( consumed == \$\{#values\[@\]\} \)\) \|\| fail "database relation manifest is incomplete"$/m);
});

/*
 * EXECUTED, NOT PINNED — and the difference is the whole point of this block.
 *
 * split_postgres_segments computes EVERY digest in the manifest. Everything
 * above pins its SOURCE TEXT: the four `raise SystemExit(...)` strings and the
 * presence of `digest.update(raw)`. That turned out to be much weaker than it
 * reads. Mutation testing found four separate edits that leave every one of
 * those pinned strings intact and still change what a digest MEANS:
 *
 *   * seeding the hash (`hashlib.sha256(b"x")`),
 *   * folding the marker line into the segment it opens,
 *   * dropping `.strip()` from the scalar path,
 *   * emitting the count and the COPY into data.sql in the opposite order from
 *     the plan that reads them back.
 *
 * The first of those is the dangerous one. It is SILENT: every digest changes,
 * the manifest is still 105 well-formed lines, every count still matches
 * `^[0-9]+$`, every digest still matches `^[0-9a-f]{64}$`, and the whole
 * acceptance suite stayed green. A release carrying it would produce a manifest
 * that disagrees with every other release's about an unchanged cluster — which
 * is precisely the property the batching was allowed to land on.
 *
 * A regex cannot close that, because the defect is in what the bytes DO, not in
 * how they are spelled. So this runs the real function out of common.sh against
 * a crafted stream and compares against sha256 computed independently here. The
 * suite already executes bash this way in backup-contract and schema-delta-gate.
 */
test("split_postgres_segments digests exactly the segment bytes, and nothing else", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-splitter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  // A fixed marker here on purpose: that the REAL marker is a random nonce is a
  // separate property, pinned above. What is under test is the cutting itself.
  const marker = "#0123456789abcdef0123456789abcdef#";
  const segments = [
    // A scalar with padding on both sides — the `.strip()` path.
    "  42  \n",
    // A relation whose data CONTAINS the marker. This is the forgery case: the
    // splitter must cut only on a marker that is the entire line, so this row
    // stays inside its own segment instead of opening a new one.
    `{"id":1,"note":"${marker}"}\n{"id":2,"body":"tab\\there"}\n`,
    // An empty relation: sha256 of nothing is still a valid, meaningful digest.
    "",
  ];
  const plan = ["text", "digest", "digest"];
  fs.writeFileSync(path.join(directory, "plan"), `${plan.join("\n")}\n`);
  fs.writeFileSync(
    path.join(directory, "stream"),
    segments.map((body) => `${marker}\n${body}`).join(""),
  );

  const result = bash(
    'source "$1"; split_postgres_segments "$3" "$2/plan" <"$2/stream"',
    [directory, marker],
  );
  assert.equal(result.status, 0, `splitter failed: ${result.stderr}`);

  const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");
  assert.deepEqual(
    result.stdout.split("\n").slice(0, -1),
    [
      // Stripped, exactly as `| tr -d '[:space:]'` left the per-statement count.
      "42",
      // Byte-for-byte over the segment body, marker line EXCLUDED and no seed.
      sha256(segments[1]),
      sha256(segments[2]),
    ],
    "a digest must be sha256 of the segment body alone: no seed, no marker line, no separator",
  );

  // And the empty-relation digest is the well-known one, so a future reader can
  // see at a glance that nothing is being folded in.
  assert.equal(
    sha256(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("split_postgres_segments aborts on every way a batch can come back wrong", (t) => {
  /*
   * The four guards are pinned by message above; these prove they FIRE. A
   * miscount that did not abort would take sha256 of an empty stream — a
   * well-formed 64-hex digest — and write a confidently wrong manifest line.
   */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-splitter-abort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = "#0123456789abcdef0123456789abcdef#";

  const cases = [
    {
      name: "more segments than the plan",
      plan: ["digest"],
      stream: `${marker}\na\n${marker}\nb\n`,
      message: "psql batch produced more segments than its plan",
    },
    {
      name: "fewer segments than the plan (a statement that failed after its marker)",
      plan: ["digest", "digest"],
      stream: `${marker}\na\n`,
      message: "psql batch segment count differs from its plan",
    },
    {
      name: "output before the first marker",
      plan: ["digest"],
      stream: `stray\n${marker}\na\n`,
      message: "psql batch wrote output before its first segment marker",
    },
    { name: "an empty plan", plan: [], stream: "", message: "psql batch plan is empty" },
  ];

  for (const scenario of cases) {
    const planPath = path.join(directory, "plan");
    const streamPath = path.join(directory, "stream");
    fs.writeFileSync(planPath, scenario.plan.length ? `${scenario.plan.join("\n")}\n` : "");
    fs.writeFileSync(streamPath, scenario.stream);
    const result = bash(
      'source "$1"; split_postgres_segments "$3" "$2/plan" <"$2/stream"',
      [directory, marker],
    );
    assert.notEqual(result.status, 0, `${scenario.name}: the splitter exited 0`);
    assert.match(
      result.stderr,
      new RegExp(scenario.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${scenario.name}: wrong abort`,
    );
    assert.equal(result.stdout, "", `${scenario.name}: a failed batch must emit no values`);
  }
});

test("the generated SQL and the plan that reads it back stay in the same order", () => {
  /*
   * The plan is what tells the splitter whether a segment is a scalar or a
   * digest, and the manifest loop then walks the results with a cursor. If
   * data.sql emitted the COPY before the count while the plan still said
   * `text\ndigest`, the count and the digest would swap places for every table
   * at once. Nothing else in this file notices: the count line, the COPY line
   * and the printf are each pinned individually and all three survive the swap.
   *
   * So each arm is pinned as ONE contiguous block — statements and plan
   * together — because their ORDER RELATIVE TO EACH OTHER is the invariant.
   */
  const body = shellFunction(common, "capture_postgres_data");
  const arms = [
    // An ordinary or partitioned table: count first, then the projected COPY.
    String.raw`          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from only $qualified;
\echo $marker
copy (select to_jsonb(x)::text from (select $columns from only $qualified) x order by 1) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"`,
    // A materialized view: no `only`, ordered over the whole row, same shape.
    String.raw`          cat >>"$work/data.sql" <<SQL
\echo $marker
select count(*) from $qualified;
\echo $marker
copy (select to_jsonb(t)::text from $qualified t order by to_jsonb(t)::text) to stdout;
SQL
          printf 'text\ndigest\n' >>"$work/data.plan"`,
    // A sequence: one statement, one plan entry, no count.
    String.raw`          cat >>"$work/data.sql" <<SQL
\echo $marker
copy (select jsonb_build_object('last_value',last_value,'is_called',is_called)::text from $qualified) to stdout;
SQL
          printf 'digest\n' >>"$work/data.plan"`,
  ];
  for (const arm of arms) {
    assert.ok(
      body.includes(arm),
      `the statements and the plan entry must stay in this exact order:\n${arm}`,
    );
  }

  /*
   * The column lookup is pinned the same way and for a sharper reason: it does
   * not move a digest, so nothing else can notice it drifting.
   *
   * `order by attnum` decides the ORDER of the sidecar's column list, and
   * `not attisdropped` decides its CONTENTS. Reordering it to `attname` leaves
   * every manifest digest byte-identical — jsonb normalises key order — while
   * silently rewriting postgres-data.tsv.columns, which backup.sh persists and
   * staging-smoke.sh compares byte-for-byte against its own capture. That is a
   * cross-release disagreement about an unchanged cluster with no failing
   * digest anywhere to point at it. Both were verified to slip past every other
   * assertion in this file.
   */
  assert.ok(
    body.includes(
      String.raw`            cat >>"$work/columns.sql" <<SQL
\echo $marker
select string_agg(quote_ident(attname), ',' order by attnum)
  from pg_attribute
 where attrelid = '$qualified'::regclass and attnum > 0 and not attisdropped;
SQL
            printf 'text\n' >>"$work/columns.plan"`,
    ),
    "the batched column lookup must stay in attnum order, exclude dropped columns, and queue exactly one plan entry",
  );
});

test("the manifest is still assembled in catalog order and sorted, and the sidecar still tracks it", () => {
  /*
   * The batch collects results into an array and replays them onto relations by
   * index, which is the one place an off-by-one would put carry_memory's digest
   * on carry_note's line — a defect that looks exactly like data movement and
   * would fail a deploy for no reason, or worse, pass one.
   *
   * Two structural facts keep that honest: the digest loop walks the SAME array
   * the SQL was generated from, and each relation kind advances `consumed` by
   * exactly as many plan entries as it contributed (two for a table or matview,
   * one for a sequence, which has no count query because it has one row by
   * construction).
   */
  const body = shellFunction(common, "capture_postgres_data");
  assert.match(
    body,
    /^\s*r\|p\|m\) count="\$\{values\[consumed\]:-\}"; digest="\$\{values\[consumed \+ 1\]:-\}"; consumed=\$\(\(consumed \+ 2\)\) ;;$/m,
    "a table or matview contributes exactly a count and a digest, in that order",
  );
  assert.match(
    body,
    /^\s*S\) count=1; digest="\$\{values\[consumed\]:-\}"; consumed=\$\(\(consumed \+ 1\)\) ;;$/m,
    "a sequence contributes only a digest; its count is 1 by construction",
  );
  // The recorded-column lookups that DID need a query are replayed by the index
  // they were queued under, not by position in the results.
  assert.match(
    body,
    /^\s*rel_columns\[\$\{pending\[index\]\}\]="\$\{values\[index\]\}"$/m,
    "batched column lookups must land back on the relation that asked for them",
  );
  /*
   * Only tables contribute to the sidecar. A sequence or a materialized view
   * adding a line to it would never be READ back — nothing looks those keys up —
   * so no digest would move and no comparison would fail; it would simply make
   * postgres-data.tsv.columns disagree, byte-for-byte, with the one a different
   * release wrote for the same cluster. staging-smoke.sh compares that file
   * directly, so the disagreement surfaces as an unexplained smoke failure far
   * from its cause.
   */
  assert.match(body, /^\s*m\|S\) ;;$/m,
    "sequences and matviews must contribute nothing to the column sidecar");

  // Unchanged tail: the manifest is byte-comparable across hosts only if it is
  // sorted under a fixed collation, and it is 0600 because it names relations.
  assert.match(body, /^\s*LC_ALL=C sort -o "\$output" "\$output"$/m);
  assert.match(body, /^\s*chmod 600 "\$output" "\$output\.columns"$/m);
  // The scratch workspace holds generated SQL and digests only — the COPY stream
  // is piped, so no wearer row body is ever written to disk.
  // Self-clearing: an uncleared RETURN trap fires AGAIN when the caller returns,
  // in the caller's scope, and deleted the resume's evidence directory between
  // writing it and reading it.
  assert.match(body, /^\s*trap 'rm -rf -- "\$\{work:-\}"; trap - RETURN' RETURN$/m);
  assert.match(body, /^\s*chmod 700 "\$work"$/m);
});

test("the row-digest evidence names WHICH rows moved, and carries no wearer values", () => {
  /*
   * A failed fingerprint comparison says "something in carry_memory changed",
   * which costs a whole deploy cycle to turn into "these four rows changed". The
   * per-relation row digests are what close that, and they are digests rather
   * than values ON PURPOSE: this lands in a deployment record on the host, and a
   * wearer's note text must not.
   *
   * Restricted to the `carry` database for the same reason — Keycloak's tables
   * hold credential material.
   */
  // The capture lives in the WEARER-table pass, not the full relation sweep:
  // that pass already iterates only the tables invariants.tsv names and already
  // holds the projected column list, so the evidence costs one cheap query per
  // wearer table instead of a second walk of every relation in both databases.
  assert.match(smoke, /^\s*if \[\[ -n "\$\{WEARER_ROW_EVIDENCE:-\}" \]\]; then$/m);
  assert.match(
    smoke,
    /select md5\(to_jsonb\(x\)::text\) from \(select \$columns from \$table\) x/,
    "row evidence must be a digest per row, never the row",
  );
  assert.doesNotMatch(
    smoke,
    /WEARER_ROW_EVIDENCE[\s\S]{0,400}?2>\/dev\/null \|\| true/,
    "the row evidence must not silence its own failures; a diagnostic that fails quietly produced an empty evidence directory once already",
  );
  assert.match(smoke, /\|\| fail "wearer row evidence failed for \$table"/);

  // The AFTER rows must be captured by the same pass that produces the AFTER
  // fingerprints, because the comparison below them is what fails — evidence
  // gathered after it would never be written on the run that needs it.
  const afterCapture = smoke.indexOf('WEARER_ROW_EVIDENCE="$projection_work/rows-after"');
  const comparison = smoke.indexOf('candidate startup changed wearer table content');
  assert.ok(afterCapture > 0 && comparison > afterCapture,
    "after-row evidence must be captured before the comparison that can fail");

  /*
   * The column projection that keeps the comparison honest across an additive
   * migration. `to_jsonb(t)` encodes the SCHEMA as well as the data, so
   * `ADD COLUMN IF NOT EXISTS` — which this project's migration policy
   * explicitly permits and store_postgres.rs asserts — rewrote every row's JSON
   * and failed the deploy without a wearer byte moving. Projecting the AFTER
   * capture onto the BEFORE columns makes a new column invisible and a changed
   * value or a vanished row still fatal.
   */
  assert.match(common, /^capture_postgres_data\(\) \{$/m);
  assert.match(common, /^\s*local container="\$1" database_user="\$2" output="\$3" columns_source="\$\{4:-\}"$/m);
  assert.match(common, /^\s*columns="\$\(awk -F'\\t' -v want="\$key" '\$1 == want \{ print \$2 \}' "\$columns_source"\)"$/m);
  assert.match(common, /^\s*printf '%s\.%s\.%s\\t%s\\n' "\$database" "\$schema" "\$relation" "\$columns" >>"\$output\.columns"$/m);
  // The sidecar has to survive in the backup or the AFTER pass has nothing to
  // project onto.
  assert.match(common, /^\s*postgres-data\.tsv\.columns postgres-data\.after-physical\.tsv\.columns \\$/m);
});

test("the staging smoke refuses a candidate that moved a row, and keeps the proof", () => {
  /*
   * The baseline is the RESTORED capture, NOT production's backup manifest.
   *
   * These are two different questions and the file keeps them apart on purpose.
   * The restore-fidelity comparison (backup vs restored, before any candidate
   * code runs) already answers "did the backup survive the round trip", and it
   * runs first — so by the time this comparison executes, "restored == backup"
   * is established. Baselining THIS one on the restored capture leaves exactly
   * one variable, the candidate, so its failure can name the candidate without
   * hedging. Pointing it back at "$backup_dir/postgres-data.tsv" would make it
   * span the restore boundary again and conflate a restore defect with a
   * candidate defect — which is what it used to do.
   */
  assert.match(staging, /^if ! cmp -s "\$projection_work\/postgres-data\.restored\.tsv" "\$projection_work\/postgres-data\.after\.tsv"; then$/m);
  assert.doesNotMatch(
    staging,
    /^if ! cmp -s "\$backup_dir\/postgres-data\.tsv" "\$projection_work\/postgres-data\.after\.tsv"; then$/m,
    "the candidate-mutation comparison must not be re-baselined on production; that spans the restore boundary",
  );
  // And it must be projected onto the columns the restored baseline was captured
  // over, or an additive migration fails the deploy again.
  assert.match(
    staging,
    /^\s*"\$projection_work\/postgres-data\.restored\.tsv\.columns"$/m,
    "the after capture must be projected onto the restored baseline's columns",
  );
  assert.match(
    staging,
    /^\s*fail "candidate mutation: candidate startup changed PostgreSQL relation data or sequence state: \$\{changed_relations:-<relation set itself differs>\}[^"]*"$/m,
    "the refusal must name the relations that moved, or the next run is the only way to find out",
  );
  // Each of the two comparisons must say WHICH SIDE OF THE RESTORE the difference
  // arrived on. The bare messages were indistinguishable and cost deploy cycles.
  assert.match(
    staging,
    /^\s*\|\| fail "restore fidelity: [^"]*RESTORE[^"]*"$/m,
    "the restore comparison must attribute its difference to the restore",
  );
  assert.match(
    staging,
    /fail "candidate mutation: [^"]*CANDIDATE[^"]*"/,
    "the candidate comparison must attribute its difference to the candidate",
  );
  // The join that computes those names compares BOTH the count and the digest
  // columns, so a rewrite that preserves the row count is still named.
  assert.match(staging, /^\s*2>\/dev\/null \| awk -F'\\t' '\$2 != \$4 \|\| \$3 != \$5 \{ printf "%s ", \$1 \}'\)"$/m);

  // The manifests are copied out of $projection_work, which is a mktemp
  // directory that vanishes with the run: without this, a failure proves
  // something changed and then destroys the proof.
  assert.match(staging, /^\s*if \[\[ -n "\$\{REVIVAL_STAGING_SMOKE_EVIDENCE:-\}" \]\]; then$/m);
  assert.match(staging, /^\s*"\$REVIVAL_STAGING_SMOKE_EVIDENCE\/postgres-data\.before\.tsv" 2>\/dev\/null \|\| true$/m);
  assert.match(staging, /^\s*"\$REVIVAL_STAGING_SMOKE_EVIDENCE\/postgres-data\.after\.tsv" 2>\/dev\/null \|\| true$/m);
  assert.match(staging, /^\s*chmod 600 "\$REVIVAL_STAGING_SMOKE_EVIDENCE"\/postgres-data\.\* 2>\/dev\/null \|\| true$/m);

  // …and the deploy actually points that variable at the deployment record. An
  // evidence block whose destination is never set writes nothing, which is the
  // same as not having one.
  assert.match(
    deploy,
    /^\s*REVIVAL_STAGING_SMOKE_EVIDENCE="\$record\/staging-smoke-evidence" \\$/m,
    "the deploy must give the staging smoke somewhere durable to leave its evidence",
  );
  const evidenceDirectory = at(deploy, 'REVIVAL_STAGING_SMOKE_EVIDENCE="$record/staging-smoke-evidence"');
  const smokeRun = at(deploy, 'bash "$release_dir/platform/deploy/vps/remote/staging-smoke.sh"');
  assert.ok(evidenceDirectory < smokeRun, "the evidence directory must be in the smoke's environment, not set after it");
});

/*
 * FIXED — twice now — and the lists below must stay as they are.
 *
 * The defect class is "one data format, two function bodies", and it has two
 * shapes, both of which have actually happened here:
 *
 *   1. SHADOWING. staging-smoke.sh sources common.sh at its line 16 and used to
 *      redefine `capture_postgres_data` with an OLDER three-argument body
 *      further down. Bash takes the later definition, so every capture the
 *      staging smoke performed ran the stale copy, and the `columns_source`
 *      fourth argument its own call sites already passed was silently
 *      discarded. The AFTER capture was therefore NOT projected onto the BEFORE
 *      columns, so cosmos/migrations/0004_listing.sql adding
 *      `carry_memory.thumbnail_count` (`ADD COLUMN IF NOT EXISTS` — additive,
 *      and explicitly permitted by this project's migration policy) changed
 *      every row's `to_jsonb` and failed the deploy with "candidate startup
 *      changed PostgreSQL relation data" without a wearer byte moving. That
 *      contradiction blocked twelve deploys.
 *
 *   2. PRODUCER/CONSUMER DIVERGENCE. `capture_postgres_schema` and
 *      `capture_postgres_security` were each defined in BOTH backup.sh (the
 *      producer of postgres-schema.tsv / postgres-security.json) and
 *      staging-smoke.sh (which compares its own captures against those files
 *      byte-for-byte). backup.sh and staging-smoke.sh do not source each other,
 *      so nothing shadowed anything — the two schema bodies simply diverged
 *      (staging grew the retained-.sql sidecar) and the comparisons kept
 *      passing only because the emitted digest line happened to still match.
 *
 * Both helpers now live once, in common.sh, beside capture_postgres_data. The
 * pairwise lists are EXACT in both directions on purpose: re-adding a duplicate
 * fails here, so the defect cannot come back by copy-paste in either shape.
 */
const KNOWN_DUPLICATE_HELPERS = {
  // Shadowing pairs: the second script sources the first, bash keeps the last
  // definition, and the canonical body silently stops running.
  "staging-smoke.sh shadows common.sh": [],
  "backup.sh shadows common.sh": [],
  // Divergence pair: neither sources the other, but staging compares files
  // backup produced against files it captures itself, so a same-named helper in
  // both is two interpretations of one format.
  // `usage` is the one accepted duplicate: each entry-point script prints its
  // own argv contract, and the two bodies share no data format at all.
  "staging-smoke.sh duplicates backup.sh": ["usage"],
};

test("the capture helpers are defined once, in common.sh, and nowhere else", () => {
  const backup = read("platform/deploy/vps/remote/backup.sh");
  const declarations = (source) =>
    [...source.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{$/gm)].map((found) => found[1]);
  const overlaps = {
    "staging-smoke.sh shadows common.sh": [staging, common],
    "backup.sh shadows common.sh": [backup, common],
    "staging-smoke.sh duplicates backup.sh": [staging, backup],
  };
  for (const [pair, [left, right]] of Object.entries(overlaps)) {
    const canonical = new Set(declarations(right));
    const duplicated = declarations(left).filter((name) => canonical.has(name)).sort();
    assert.deepEqual(
      duplicated,
      KNOWN_DUPLICATE_HELPERS[pair],
      `${pair}: a helper is defined in both files; if you just deleted the stale copy, `
        + "delete its name from KNOWN_DUPLICATE_HELPERS above — do not re-add it",
    );
  }
});
