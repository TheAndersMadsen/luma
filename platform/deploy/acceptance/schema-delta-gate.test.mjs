import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The ADDITIVE-SCHEMA ALLOWANCE on the staging smoke's candidate-mutation schema
 * gate, exercised directly.
 *
 * The gate itself compares two sha256 digests over `pg_dump --schema-only`, so it
 * can prove the schema moved and cannot say how. cosmos/migrations/0004_listing.sql
 * is genuinely pending in production — `ADD COLUMN IF NOT EXISTS
 * cosmos_memory.thumbnail_count` plus three `CREATE INDEX IF NOT EXISTS` — so the
 * candidate legitimately changes the schema and the digest gate legitimately
 * refuses. classify_schema_delta is the explicit decision that unblocks exactly
 * that delta and nothing else. It lives in common.sh because three gates of the
 * same shape need it — the staging smoke's candidate-mutation gate, deploy.sh's
 * pre-commit zero-delta comparison, and rollback.sh's legacy-eligibility check.
 *
 * What makes this worth testing rather than reading: `pg_dump --schema-only` emits
 * CREATE TABLE with the FULL column list, so adding a column does not appear as a
 * tidy "ADD COLUMN" line — it rewrites the whole CREATE TABLE block. A classifier
 * that reasoned about lines instead of about the COLUMN SET would see one line
 * removed and one line added and could be talked into calling a DROPPED, RENAMED
 * or RETYPED column "additive". Every refusal case below is a dump that a naive
 * line- or subset-comparison would wave through.
 *
 * The fixtures are not hand-written manifests. They are run through the SAME
 * python normalizer that capture_postgres_schema uses in production — extracted
 * from common.sh, where the one canonical definition now lives (the staging and
 * backup copies were de-duplicated into it), so it cannot drift from what the
 * gate actually hashes — so these tests also prove the retained pg_dump text and
 * the digest line the gate compares stay consistent with each other.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staging = path.join(root, "platform/deploy/vps/remote/staging-smoke.sh");
const stagingSource = await readFile(staging, "utf8");
const common = path.join(root, "platform/deploy/vps/remote/common.sh");
const commonSource = (
  await Promise.all(
    [common, ...(await readdir(path.join(path.dirname(common), "lib")))
      .filter((name) => name.endsWith(".sh"))
      .sort()
      .map((name) => path.join(path.dirname(common), "lib", name))]
      .map((file) => readFile(file, "utf8")),
  )
).join("\n");
const deploySource = await readFile(path.join(root, "platform/deploy/vps/remote/deploy.sh"), "utf8");
const rollbackSource = await readFile(path.join(root, "platform/deploy/vps/remote/rollback.sh"), "utf8");

// The exact normalizer capture_postgres_schema pipes pg_dump into. Extracted, not
// re-implemented: a copy here would let the fixtures keep passing after the real
// capture stopped producing what the classifier reads.
// `[^']*` rather than a lazy `[\s\S]*?`: the shell holds this snippet in single
// quotes, so it contains none, and a lazy match would happily start at some other
// python3 -c earlier in the file and swallow everything in between.
const normalizerMatch = commonSource.match(/\| python3 -c '([^']*)'\s+"\$database" "\$canonical_path"/u);
assert.ok(normalizerMatch, "capture_postgres_schema must still pipe pg_dump into a python3 -c normalizer");
const normalizer = normalizerMatch[1];

function bash(script, args = []) {
  return spawnSync("bash", ["-c", script, "fixture", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

/* ---------- pg_dump --schema-only fixtures ---------------------------------- */

const header = (token) => `--
-- PostgreSQL database dump
--

\\restrict ${token}

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg120+1)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg120+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET default_table_access_method = "heap";

`;

const footer = (token) => `
\\unrestrict ${token}

--
-- PostgreSQL database dump complete
--

`;

function table(name, columns, owner = "cosmos") {
  const body = columns.map((column) => `    ${column}`).join(",\n");
  return `--
-- Name: ${name}; Type: TABLE; Schema: public; Owner: ${owner}
--

CREATE TABLE "public"."${name}" (
${body}
);


ALTER TABLE "public"."${name}" OWNER TO "${owner}";

`;
}

function index(name, target, definition, unique = false) {
  return `--
-- Name: ${name}; Type: INDEX; Schema: public; Owner: cosmos
--

CREATE${unique ? " UNIQUE" : ""} INDEX "${name}" ON "public"."${target}" USING "btree" (${definition});

`;
}

const MEMORY = [
  '"principal" "text" NOT NULL',
  '"numeric_id" bigint NOT NULL',
  '"created_seconds" bigint',
  '"device_created_seconds" bigint',
  '"deleted_seconds" bigint',
  '"thumbnails" "jsonb"',
];
// What 0004_listing.sql's ALTER TABLE ... ADD COLUMN produces: appended last,
// because pg_dump prints columns in attnum order.
const MEMORY_0004 = [...MEMORY, '"thumbnail_count" integer'];
const EVENT = [
  '"principal" "text" NOT NULL',
  '"event_identifier" "text" NOT NULL',
  '"originator_identifier" "text"',
  '"creation_seconds" bigint',
  '"creation_nanos" integer',
];
const NOTE = [
  '"principal" "text" NOT NULL',
  '"note_identifier" "text" NOT NULL',
  '"created_seconds" bigint',
  '"created_nanos" integer',
];

const PRIMARY_KEY = `--
-- Name: cosmos_memory cosmos_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: cosmos
--

ALTER TABLE ONLY "public"."cosmos_memory"
    ADD CONSTRAINT "cosmos_memory_pkey" PRIMARY KEY ("principal", "numeric_id");

`;

// The three indexes 0004_listing.sql creates, as pg_dump renders them.
const INDEXES_0004 = [
  index("cosmos_event_recent", "cosmos_event",
    '"principal", "originator_identifier", "creation_seconds" DESC NULLS LAST, "creation_nanos" DESC'),
  `CREATE INDEX "cosmos_memory_recent" ON "public"."cosmos_memory" USING "btree" ("principal", COALESCE("device_created_seconds", "created_seconds") DESC, "numeric_id" DESC) WHERE ("deleted_seconds" IS NULL);

`,
  index("cosmos_note_recent", "cosmos_note", '"principal", "created_seconds" DESC, "created_nanos" DESC'),
];

function cosmos({ token = "9dcd1c3b", memory = MEMORY, event = EVENT, note = NOTE, indexes = [], extra = "" } = {}) {
  return [
    header(token),
    table("cosmos_event", event),
    table("cosmos_memory", memory),
    table("cosmos_note", note),
    PRIMARY_KEY,
    ...indexes,
    extra,
    footer(token),
  ].join("");
}

const KEYCLOAK_COLUMNS = ['"id" character varying(36) NOT NULL', '"email" character varying(255)'];

function keycloak({ token = "9dcd1c3b", columns = KEYCLOAK_COLUMNS } = {}) {
  return header(token) + table("user_entity", columns, "keycloak") + footer(token);
}

/* ---------- capture, exactly as the gate captures --------------------------- */

/*
 * Runs each dump through capture_postgres_schema's own normalizer, which writes
 * the retained text sidecar and prints the digest line the gate compares. The
 * BEFORE and AFTER fixtures deliberately use DIFFERENT \restrict tokens, so a
 * regression in the token normalization would show up as an unexplained delta
 * rather than passing silently.
 */
async function capture(directory, label, dumps) {
  const manifest = path.join(directory, label);
  const rows = [];
  for (const database of Object.keys(dumps).sort()) {
    const result = spawnSync("python3", ["-c", normalizer, database, `${manifest}.${database}.sql`], {
      encoding: "utf8",
      input: dumps[database],
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), new RegExp(`^${database}\t[0-9]+\t[0-9]+\t[0-9a-f]{64}$`, "u"));
    rows.push(result.stdout.trim());
  }
  await writeFile(manifest, `${rows.join("\n")}\n`, { mode: 0o600 });
  return manifest;
}

// Sourced from common.sh, which is where the classifier now lives: it has three
// consumers (the staging smoke's candidate-mutation gate, deploy.sh's pre-commit
// zero-delta comparison, rollback.sh's legacy-eligibility check) and duplicating
// it per consumer is the defect that cost four deploy cycles the last time.
function classify(before, after) {
  return bash(String.raw`
source "$1"
classify_schema_delta "$2" "$3"
`, [common, before, after]);
}

async function verdict(t, before, after) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-schema-delta-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const beforeManifest = await capture(directory, "postgres-schema.restored.tsv", before);
  const afterManifest = await capture(directory, "postgres-schema.after.tsv", after);
  const differs = await readFile(beforeManifest, "utf8") !== await readFile(afterManifest, "utf8");
  const result = classify(beforeManifest, afterManifest);
  return { differs, result };
}

/* ---------- the delta the deploy is actually blocked on --------------------- */

test("the real 0004_listing.sql delta is accepted, and named", async (t) => {
  const { differs, result } = await verdict(t,
    { cosmos: cosmos({ token: "1f0aa2" }), keycloak: keycloak({ token: "1f0aa2" }) },
    { cosmos: cosmos({ token: "b73c91", memory: MEMORY_0004, indexes: INDEXES_0004 }), keycloak: keycloak({ token: "b73c91" }) });

  assert.ok(differs, "0004 must still be a real digest delta; the allowance runs only after equality fails");
  assert.equal(result.status, 0, result.stderr);
  // The allowance is worthless if it does not say what it allowed. Every object
  // 0004 creates has to appear by name.
  assert.match(result.stdout, /additive schema delta accepted/u);
  assert.match(result.stdout, /\+column public\.cosmos_memory\.thumbnail_count/u);
  assert.match(result.stdout, /\+index cosmos_event_recent on public\.cosmos_event/u);
  assert.match(result.stdout, /\+index cosmos_memory_recent on public\.cosmos_memory/u);
  assert.match(result.stdout, /\+index cosmos_note_recent on public\.cosmos_note/u);
});

test("a table this delta creates is additive; its decoration comes with it", async (t) => {
  // Everything pg_dump emits around a freshly created table: the sequence behind
  // its identity column, the column default that reads from it, its ownership, its
  // primary key, and an index on it. All of it is scoped to a table that did not
  // exist before, so none of it can touch a row that did.
  const created = table("cosmos_listing", ['"numeric_id" bigint NOT NULL', '"principal" "text" NOT NULL'])
    + 'CREATE SEQUENCE "public"."cosmos_listing_numeric_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;\n\n'
    + 'ALTER SEQUENCE "public"."cosmos_listing_numeric_id_seq" OWNER TO "cosmos";\n\n'
    + 'ALTER SEQUENCE "public"."cosmos_listing_numeric_id_seq" OWNED BY "public"."cosmos_listing"."numeric_id";\n\n'
    + 'ALTER TABLE ONLY "public"."cosmos_listing" ALTER COLUMN "numeric_id" SET DEFAULT "nextval"(\'"public"."cosmos_listing_numeric_id_seq"\'::"regclass");\n\n'
    + 'ALTER TABLE ONLY "public"."cosmos_listing"\n    ADD CONSTRAINT "cosmos_listing_pkey" PRIMARY KEY ("numeric_id");\n\n'
    + index("cosmos_listing_recent", "cosmos_listing", '"principal"');
  const { result } = await verdict(t,
    { cosmos: cosmos(), keycloak: keycloak() },
    { cosmos: cosmos({ token: "aa11", extra: created }), keycloak: keycloak({ token: "aa11" }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\+table public\.cosmos_listing/u);
  assert.match(result.stdout, /\+ownership on new table public\.cosmos_listing/u);
  assert.match(result.stdout, /\+constraint on new table public\.cosmos_listing/u);
  assert.match(result.stdout, /\+column default on new table public\.cosmos_listing/u);
  assert.match(result.stdout, /\+sequence public\.cosmos_listing_numeric_id_seq/u);
  assert.match(result.stdout, /\+index cosmos_listing_recent on public\.cosmos_listing/u);
});

test("a new table may be UNLOGGED; only a pre-existing table's heading is frozen", async (t) => {
  // The heading check must not overreach into tables this delta created. A table
  // that did not exist has no rows to lose, so how it is created is its own
  // business.
  const created = table("cosmos_scratch", ['"principal" "text" NOT NULL'])
    .replace('CREATE TABLE "public"."cosmos_scratch"', 'CREATE UNLOGGED TABLE "public"."cosmos_scratch"');
  const { result } = await verdict(t,
    { cosmos: cosmos(), keycloak: keycloak() },
    { cosmos: cosmos({ token: "cd34", extra: created }), keycloak: keycloak({ token: "cd34" }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\+table public\.cosmos_scratch/u);
});

test("the same decoration aimed at a pre-existing table is refused", async (t) => {
  // The mirror image of the test above, and the reason "new table" is defined as
  // "absent from the BEFORE dump" rather than "mentioned by an added statement".
  for (const [name, statement, expected] of [
    ["a primary key", 'ALTER TABLE ONLY "public"."cosmos_memory"\n    ADD CONSTRAINT "cosmos_memory_second" PRIMARY KEY ("principal");\n\n', /ALTER TABLE ONLY is not a provably additive change \(constraint cosmos_memory_second on table public\.cosmos_memory\)/u],
    ["a column default", 'ALTER TABLE ONLY "public"."cosmos_memory" ALTER COLUMN "created_seconds" SET DEFAULT 0;\n\n', /default of column public\.cosmos_memory\.created_seconds/u],
  ]) {
    const { result } = await verdict(t,
      { cosmos: cosmos(), keycloak: keycloak() },
      { cosmos: cosmos({ token: "bb22", extra: statement }), keycloak: keycloak({ token: "bb22" }) });
    assert.notEqual(result.status, 0, `${name} on a pre-existing table was accepted: ${result.stdout}`);
    assert.match(result.stderr, expected);
  }
});

/* ---------- everything the allowance must still refuse ---------------------- */

const refusals = [
  {
    name: "a dropped column",
    after: { cosmos: cosmos({ memory: MEMORY.filter((column) => !column.includes("thumbnails")) }) },
    expect: /table public\.cosmos_memory lost column\(s\) thumbnails/u,
  },
  {
    name: "a renamed column",
    // The trap case: pg_dump rewrites the CREATE TABLE block, so a rename looks
    // exactly like a removed line plus an added line.
    after: { cosmos: cosmos({ memory: MEMORY.map((column) => column.replace('"thumbnails"', '"thumbs"')) }) },
    expect: /column thumbnails was dropped or renamed; position 6 now holds thumbs/u,
  },
  {
    name: "a retyped column",
    after: { cosmos: cosmos({ memory: MEMORY.map((column) => (column.includes("numeric_id") ? column.replace("bigint", "integer") : column)) }) },
    expect: /changed the definition of pre-existing column numeric_id: before <"numeric_id" bigint NOT NULL> after <"numeric_id" integer NOT NULL>/u,
  },
  {
    name: "a column dropped while another is appended",
    // Same column COUNT before and after, so anything counting columns passes it.
    after: { cosmos: cosmos({ memory: [...MEMORY.slice(0, -1), '"thumbnail_count" integer'] }) },
    expect: /column thumbnails was dropped or renamed; position 6 now holds thumbnail_count/u,
  },
  {
    name: "a column inserted among the pre-existing ones",
    after: { cosmos: cosmos({ memory: [...MEMORY.slice(0, 2), '"inserted" "text"', ...MEMORY.slice(2)] }) },
    expect: /reordered its pre-existing columns; position 3 held created_seconds and now holds inserted/u,
  },
  {
    name: "a nullability change on a pre-existing column",
    after: { cosmos: cosmos({ memory: MEMORY.map((column) => (column === '"created_seconds" bigint' ? `${column} NOT NULL` : column)) }) },
    expect: /changed the definition of pre-existing column created_seconds/u,
  },
  {
    name: "a default change on a pre-existing column",
    before: { cosmos: cosmos({ extra: 'ALTER TABLE ONLY "public"."cosmos_memory" ALTER COLUMN "created_seconds" SET DEFAULT 0;\n\n' }) },
    after: { cosmos: cosmos({ extra: 'ALTER TABLE ONLY "public"."cosmos_memory" ALTER COLUMN "created_seconds" SET DEFAULT 1;\n\n' }) },
    expect: /default of column public\.cosmos_memory\.created_seconds was redefined/u,
  },
  {
    name: "a dropped index",
    before: { cosmos: cosmos({ indexes: INDEXES_0004 }) },
    after: { cosmos: cosmos({ indexes: INDEXES_0004.slice(0, 2) }) },
    expect: /CREATE INDEX disappeared from the schema \(index cosmos_note_recent\)/u,
  },
  {
    name: "a redefined index",
    before: { cosmos: cosmos({ indexes: INDEXES_0004 }) },
    after: { cosmos: cosmos({ indexes: [...INDEXES_0004.slice(0, 2), index("cosmos_note_recent", "cosmos_note", '"principal"')] }) },
    expect: /index cosmos_note_recent was redefined/u,
  },
  {
    name: "a dropped table",
    after: { cosmos: header("cc22") + table("cosmos_event", EVENT) + table("cosmos_memory", MEMORY) + PRIMARY_KEY + footer("cc22") },
    expect: /table public\.cosmos_note was dropped or renamed/u,
  },
  {
    name: "a dropped constraint",
    after: { cosmos: cosmos({ extra: "" }).replace(PRIMARY_KEY, "") },
    expect: /constraint cosmos_memory_pkey on table public\.cosmos_memory/u,
  },
  {
    name: "an ownership change",
    after: { cosmos: cosmos().replace('ALTER TABLE "public"."cosmos_note" OWNER TO "cosmos";', 'ALTER TABLE "public"."cosmos_note" OWNER TO "postgres";') },
    expect: /ownership of table public\.cosmos_note was redefined/u,
  },
  {
    name: "a new grant",
    after: { cosmos: cosmos({ extra: 'GRANT SELECT ON TABLE "public"."cosmos_memory" TO "readonly";\n\n' }) },
    expect: /GRANT SELECT ON TABLE is not a provably additive change/u,
  },
  {
    name: "a new trigger",
    after: { cosmos: cosmos({ extra: 'CREATE TRIGGER "audit" AFTER INSERT ON "public"."cosmos_memory" FOR EACH ROW EXECUTE FUNCTION "public"."audit"();\n\n' }) },
    expect: /CREATE TRIGGER is not a provably additive change/u,
  },
  {
    name: "a new function",
    after: { cosmos: cosmos({ extra: 'CREATE FUNCTION "public"."audit"() RETURNS "trigger" LANGUAGE "plpgsql" AS $$begin return new; end;$$;\n\n' }) },
    expect: /CREATE FUNCTION is not a provably additive change/u,
  },
  {
    name: "a UNIQUE index over rows that already exist",
    after: { cosmos: cosmos({ indexes: [index("cosmos_memory_unique", "cosmos_memory", '"principal"', true)] }) },
    expect: /adds a UNIQUE constraint to pre-existing table public\.cosmos_memory/u,
  },
  {
    name: "an inline CHECK constraint on an existing table",
    after: { cosmos: cosmos({ memory: [...MEMORY, 'CONSTRAINT "cosmos_memory_positive" CHECK (("numeric_id" > 0))'] }) },
    expect: /gained an inline table constraint, which can reject or reinterpret rows that already exist/u,
  },
  {
    // A CREATE TABLE block is more than its column list. `ALTER TABLE ... SET
    // UNLOGGED` rewrites only the block's HEADING, so a classifier that compared
    // column sets alone would find nothing to say about it and let it ride along
    // under the legitimate `+column` note beside it -- printing an acceptance line
    // byte-identical to the one the real 0004 delta prints. Unlogged means every
    // row that already exists is discarded on the next crash.
    name: "a pre-existing table quietly converted to UNLOGGED beneath an additive column",
    after: { cosmos: cosmos({ memory: MEMORY_0004, indexes: INDEXES_0004 })
      .replace('CREATE TABLE "public"."cosmos_memory"', 'CREATE UNLOGGED TABLE "public"."cosmos_memory"') },
    expect: /table public\.cosmos_memory changed its CREATE TABLE heading/u,
  },
  {
    // The same hole from the other side: nothing about the heading is permitted to
    // drift, whether or not this particular keyword is destructive on its own.
    name: "a rewritten CREATE TABLE heading on a pre-existing table",
    after: { cosmos: cosmos({ memory: MEMORY_0004 })
      .replace('CREATE TABLE "public"."cosmos_memory"', 'CREATE TABLE IF NOT EXISTS "public"."cosmos_memory"') },
    expect: /table public\.cosmos_memory changed its CREATE TABLE heading/u,
  },
  {
    // A shape the classifier deliberately does not model. It must fall through to
    // exact equality rather than being read as "no table changed" -- fail closed,
    // not fail open, is the whole posture.
    name: "a change to a table shape the classifier does not model",
    before: { cosmos: cosmos({ extra: 'CREATE TABLE "public"."cosmos_slice_2026" PARTITION OF "public"."cosmos_slice" FOR VALUES FROM (\'2026-01-01\') TO (\'2027-01-01\');\n\n' }) },
    after: { cosmos: cosmos({ extra: 'CREATE TABLE "public"."cosmos_slice_2026" PARTITION OF "public"."cosmos_slice" FOR VALUES FROM (\'2026-06-01\') TO (\'2027-01-01\');\n\n' }) },
    expect: /CREATE TABLE disappeared from the schema/u,
  },
  {
    name: "an additive column riding along with a dropped table",
    after: { cosmos: header("dd33") + table("cosmos_event", EVENT) + table("cosmos_memory", MEMORY_0004) + PRIMARY_KEY + footer("dd33") },
    expect: /table public\.cosmos_note was dropped or renamed/u,
  },
];

for (const { name, before, after, expect } of refusals) {
  test(`the allowance refuses ${name}, by name`, async (t) => {
    const { differs, result } = await verdict(t,
      { cosmos: cosmos(), keycloak: keycloak(), ...before },
      { cosmos: cosmos(), keycloak: keycloak(), ...after });
    assert.ok(differs, `${name} must be a real digest delta for the allowance to be reached`);
    assert.notEqual(result.status, 0, `${name} was accepted: ${result.stdout}`);
    assert.match(result.stderr, /schema delta refused/u);
    assert.match(result.stderr, expect);
    assert.equal(result.stdout.trim(), "", "a refused delta must not also print an acceptance");
  });
}

/* ---------- keycloak is out of scope entirely ------------------------------- */

test("no keycloak delta is additive, not even one that would pass in cosmos", async (t) => {
  // Byte-for-byte the change the allowance permits in cosmos: a column appended to
  // an existing table. The identity database is simply not in scope.
  const { result } = await verdict(t,
    { cosmos: cosmos(), keycloak: keycloak() },
    { cosmos: cosmos(), keycloak: keycloak({ token: "ee44", columns: [...KEYCLOAK_COLUMNS, '"nickname" "text"'] }) });
  assert.notEqual(result.status, 0, `keycloak delta was accepted: ${result.stdout}`);
  assert.match(result.stderr, /keycloak: only the cosmos database may contain a pending migration/u);
  assert.match(result.stderr, /\+column public\.user_entity\.nickname/u);
});

test("a keycloak delta refuses even when cosmos's delta is the accepted one", async (t) => {
  const { result } = await verdict(t,
    { cosmos: cosmos(), keycloak: keycloak() },
    {
      cosmos: cosmos({ token: "ff55", memory: MEMORY_0004, indexes: INDEXES_0004 }),
      keycloak: keycloak({ token: "ff55", columns: [...KEYCLOAK_COLUMNS, '"nickname" "text"'] }),
    });
  assert.notEqual(result.status, 0, `keycloak delta was accepted: ${result.stdout}`);
  assert.match(result.stderr, /keycloak/u);
});

/* ---------- the allowance cannot be handed text the gate did not hash -------- */

test("classification is refused unless the retained text reproduces the gate's digest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revival-schema-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const before = await capture(directory, "postgres-schema.restored.tsv",
    { cosmos: cosmos(), keycloak: keycloak() });
  const after = await capture(directory, "postgres-schema.after.tsv",
    { cosmos: cosmos({ token: "ab12", memory: MEMORY.filter((column) => !column.includes("thumbnails")) }), keycloak: keycloak({ token: "ab12" }) });

  // Substituting an innocent dump for the one that was actually hashed is the
  // obvious way to launder a destructive delta past a classifier.
  await writeFile(`${after}.cosmos.sql`, await readFile(`${before}.cosmos.sql`, "utf8"), { mode: 0o600 });
  let result = classify(before, after);
  assert.notEqual(result.status, 0, "laundered dump text was accepted");
  assert.match(result.stderr, /does not reproduce the digest the gate compared/u);

  // And a missing sidecar is a refusal, not a silent pass.
  await rm(`${after}.cosmos.sql`);
  result = classify(before, after);
  assert.notEqual(result.status, 0, "missing retained text was accepted");
  assert.match(result.stderr, /retained pg_dump text is missing beside the manifest/u);
});

test("a digest delta with no statement-level explanation is refused, not waved through", async (t) => {
  const { differs, result } = await verdict(t,
    { cosmos: cosmos(), keycloak: keycloak() },
    { cosmos: cosmos().replace("-- Name: cosmos_note; Type: TABLE", "-- Name: cosmos_note; Type: TABLE "), keycloak: keycloak() });
  assert.ok(differs, "a comment-only edit must still move the digest");
  assert.notEqual(result.status, 0, `an unexplained delta was accepted: ${result.stdout}`);
  assert.match(result.stderr, /no statement-level delta explains it/u);
});

/* ---------- the wiring, at the source level --------------------------------- */

test("the gate still compares digests first, and classifies only after equality fails", () => {
  // The allowance is an ADDITION to the equality check, never a replacement. If
  // this cmp ever stops guarding the classifier, the classifier becomes the gate
  // and its permitted set becomes the whole contract.
  assert.match(stagingSource,
    /^if ! cmp -s "\$projection_work\/postgres-schema\.restored\.tsv" "\$projection_work\/postgres-schema\.after\.tsv"; then$/mu);
  assert.match(stagingSource,
    /^  schema_allowance="\$\(classify_schema_delta \\$/mu);
  // The restore-fidelity half stays an unconditional exact comparison: a schema
  // difference that arrived with the RESTORE is never additive, it is a broken
  // backup, and no allowance applies to it.
  assert.match(stagingSource,
    /^cmp -s "\$backup_dir\/postgres-schema\.tsv" "\$projection_work\/postgres-schema\.restored\.tsv" \\$/mu);
  // A refusal must fail the deploy, and the accepted case must be logged.
  assert.match(stagingSource, /^    \|\| fail "candidate mutation: candidate startup changed PostgreSQL schema semantics in a way that is NOT provably additive/mu);
  assert.match(stagingSource, /^  log "candidate mutation: \$schema_allowance"$/mu);
});

test("capture_postgres_schema retains the text beside the digest it still emits", () => {
  assert.match(commonSource, /^print\(f"\{database\}\\t\{len\(canonical\)\}\\t\{len\(lines\)\}\\t\{hashlib\.sha256\(canonical\)\.hexdigest\(\)\}"\)$/mu);
  // Retention is opt-in — the backup producer must not grow sidecars its
  // versioned artifact manifest does not enumerate — but when asked for it must
  // still be the O_NOFOLLOW 0600 write it always was.
  assert.match(commonSource, /^if canonical_path:$/mu);
  assert.match(commonSource, /^    with os\.fdopen\(os\.open\(canonical_path,os\.O_WRONLY\|os\.O_CREAT\|os\.O_TRUNC\|os\.O_NOFOLLOW,0o600\),"wb"\) as retained:$/mu);
  assert.match(commonSource, /^\s*\[\[ -z "\$canonical_path" \]\] \|\| chmod 600 "\$canonical_path"$/mu);
  // And the staging smoke's two schema captures both ask for it: the classifier
  // and the preserved evidence read the sidecars of BOTH manifests.
  assert.equal(
    [...stagingSource.matchAll(/^  "\$projection_work\/postgres-schema\.(?:restored|after)\.tsv" retain-sql$/gmu)].length,
    2,
    "both staging schema captures must retain their pg_dump text for the classifier",
  );
  // The 32 MiB stream limit and the \restrict normalization both predate this and
  // must survive it.
  assert.match(commonSource, /^if len\(body\)>limit: raise SystemExit\("pg_dump schema stream exceeds limit"\)$/mu);
  assert.match(commonSource, /lines\[restrict\]=b"\\\\restrict <normalized>\\n"/u);
});

/* ---------- the class, not the instance ------------------------------------- */

/*
 * The classifier was written for ONE gate and there are THREE of the same shape:
 * every place a schema manifest captured BEFORE a candidate started is compared
 * against one captured AFTER. Deploy 13 died at the third of them. These pin the
 * two properties that keep the fix from decaying back into three instances: one
 * definition, and one call.
 */
const backupSource = await readFile(path.join(root, "platform/deploy/vps/remote/backup.sh"), "utf8");
const remoteSources = { commonSource, stagingSource, deploySource, rollbackSource, backupSource };

test("the classifier and its caller are defined exactly once, in common.sh", () => {
  for (const name of ["classify_schema_delta", "compare_schema_manifests"]) {
    const definition = new RegExp(String.raw`^${name}\(\) \{$`, "gmu");
    for (const [label, source] of Object.entries(remoteSources)) {
      assert.equal(
        [...source.matchAll(definition)].length,
        label === "commonSource" ? 1 : 0,
        `${name} must be defined once, in common.sh, and nowhere else (${label})`,
      );
    }
  }
  // And the equality check lives INSIDE compare_schema_manifests, so no caller can
  // reach the classifier without the byte comparison having failed first.
  assert.match(commonSource, /^compare_schema_manifests\(\) \{\n(?:.*\n)*?  if cmp -s "\$before" "\$after"; then return 0; fi$/mu);
});

test("every pre-vs-post schema comparison goes through the allowance, not a bare cmp", () => {
  // deploy.sh's two pre-commit sites are one function, called twice; neither may
  // reintroduce postgres-schema.tsv into a byte-exact loop. The two manifests
  // arrive as paths because the resume captures its own (see the cross-release
  // tests) — but they still reach exactly one comparison.
  assert.match(deploySource, /^compare_precommit_compatibility_state\(\) \{$/mu);
  assert.match(deploySource,
    /^  compare_schema_manifests "\$schema_before" "\$schema_after" "\$context"$/mu);
  assert.equal(
    [...deploySource.matchAll(/^\s*compare_precommit_compatibility_state "\$/gmu)].length,
    2,
    "the normal cutover and the precommit-resume path must both use the one comparison",
  );
  assert.doesNotMatch(deploySource, /^\s*for name in postgres-data\.tsv postgres-schema\.tsv/mu,
    "postgres-schema.tsv must not go back into a byte-exact pre-vs-post loop");
  assert.doesNotMatch(deploySource, /^\s*for name in .*postgres-schema\.tsv/mu,
    "postgres-schema.tsv must not go back into a byte-exact pre-vs-post loop");
  // The data half stays a BYTE comparison of the manifests — it is not classified
  // the way the schema half is. The only change is that both sides are first
  // stripped of Keycloak's two session relations, which any authentication
  // rewrites and which the deploy's own wearer canary therefore moves on every
  // run. Everything else, including every cosmos relation, is still compared byte
  // for byte and still fails by the same name.
  assert.match(deploySource,
    /^  zero_delta_volatile_filtered "\$before\/postgres-data\.tsv" "\$volatile_work\/before\.tsv"$/mu);
  assert.match(deploySource,
    /^  zero_delta_volatile_filtered "\$data_after" "\$volatile_work\/after\.tsv"$/mu);
  assert.match(deploySource,
    /^  if ! cmp -s "\$volatile_work\/before\.tsv" "\$volatile_work\/after\.tsv"; then$/mu);
  assert.match(deploySource, /^    fail "\$context: postgres-data\.tsv"$/mu);
  // The data manifest is never classified: an added COLUMN is invisible by
  // projection, but an added or changed ROW must always fail.
  assert.doesNotMatch(deploySource,
    /classify_schema_delta[^\n]*postgres-data/u,
    "the data half must stay a byte comparison, never a classified one");

  // rollback.sh's legacy-eligibility check is the same shape: the original
  // pre-cutover backup against a backup taken with the candidate's migrations
  // applied. Refusing it for a legitimately added column closes the recovery path.
  assert.match(rollbackSource,
    /^  compare_schema_manifests "\$original_backup\/postgres-schema\.tsv" "\$fresh_backup\/postgres-schema\.tsv" \\$/mu);
  const legacyList = rollbackSource.match(/^  immutable_legacy_state=\(\n(?:.*\n)*?  \)$/mu);
  assert.ok(legacyList, "the legacy byte-exact state list must still exist");
  assert.doesNotMatch(legacyList[0], /postgres-schema\.tsv/u,
    "postgres-schema.tsv must be classified, not byte-compared, in the legacy list");
  // postgres-security.json stays byte-exact on purpose and must not drift out.
  assert.match(legacyList[0], /^\s*postgres-security\.json$/mu);
});

test("the backup keeps the pg_dump text the classifier needs, and it is an allowed artifact", () => {
  // The PRE-candidate dump cannot be re-taken once the candidate has migrated, so
  // if the backup does not retain it there is nothing to classify against and the
  // gate can only refuse.
  assert.match(backupSource,
    /^capture_postgres_schema "\$postgres" cosmos "\$destination\/postgres-schema\.tsv" retain-sql$/mu);
  assert.match(commonSource, /^\s*postgres-schema\.tsv\.cosmos\.sql postgres-schema\.tsv\.keycloak\.sql$/mu);
});

test("the post-candidate backup is digested over the pre-candidate backup's columns", () => {
  // The relation-data half of the same class: `to_jsonb(t)` encodes the schema, so
  // an appended column moves every row's digest with no value moving. Fixed at
  // capture time so the comparison itself stays a plain byte comparison.
  assert.match(backupSource, /^    --data-columns-source\) \(\(\$# >= 2\)\) \|\| usage; data_columns_source="\$2"; shift 2 ;;$/mu);
  assert.match(backupSource,
    /^capture_postgres_data "\$postgres" cosmos "\$destination\/postgres-data\.tsv" "\$data_columns_source"$/mu);
  // Only another backup's own sidecar may narrow what a digest covers.
  assert.match(backupSource,
    /^  \[\[ "\$data_columns_source" == "\$\(readlink -f -- "\$BACKUP_ROOT"\)\/"\*\/postgres-data\.tsv\.columns \]\] \\$/mu);
  assert.match(backupSource, /^\[\[ -z "\$data_columns_source" \]\] \|\| validate_relation_column_sidecar "\$data_columns_source"$/mu);
  // The SAME-RELEASE cutover passes it, derived from the backup it will be
  // compared to. It is the only site that may: --data-columns-source is this
  // release's option, and the resume drives a possibly-older backup.sh.
  assert.match(deploySource, /^precommit_projection_args\(\) \{$/mu);
  assert.equal(
    [...deploySource.matchAll(/^\s*mapfile -t \w+ < <\(precommit_projection_args "\$\w+"\)$/gmu)].length,
    1,
    "the same-release post-candidate backup must be projected onto its baseline's columns",
  );
  assert.match(deploySource,
    /^bash "\$release_dir\/platform\/deploy\/vps\/remote\/backup\.sh" \\\n(?:.*\\\n)*.*"\$\{postcandidate_projection_args\[@\]\}"$/mu,
    "the projection may only be passed to this release's own backup.sh");
  // ...and the resume gets the same projection by capturing it ITSELF, with this
  // release's canonical producer, rather than asking an older backup.sh for it.
  assert.match(deploySource,
    /^  capture_postgres_data "\$postgres" cosmos "\$work\/candidate-data\.tsv" "\$columns_source"$/mu);
  assert.match(deploySource,
    /^  capture_postgres_schema "\$postgres" cosmos "\$work\/candidate-schema\.tsv" retain-sql$/mu);
  // The sidecar it projects onto is validated before it can narrow a digest, and
  // its absence degrades exactly as precommit_projection_args does: to the live
  // column list, which then FAILS an additive delta rather than passing it.
  assert.match(deploySource,
    /^    validate_relation_column_sidecar "\$baseline\/postgres-data\.tsv\.columns"$/mu);
  assert.match(deploySource,
    /^    columns_source="\$baseline\/postgres-data\.tsv\.columns"$/mu);
});

/*
 * ...and the narrowing must NOT leak into the checks that are not pre-vs-post.
 *
 * The projection answers exactly one question — "did a value move while the
 * candidate migrated?" — by excluding columns that did not exist at the
 * pre-candidate boundary. A SAME-CLUSTER FIDELITY check asks a different one:
 * did the clean snapshot, the physical restore, the blank-cluster logical restore
 * preserve this cluster? Both of its sides are the same schema at the same
 * instant, so there is nothing additive to project away — and projecting anyway
 * makes it blind to precisely the columns the projection excludes. Measured, not
 * theorised: against a real PostgreSQL 16 cluster with 0004 applied, corrupting
 * `cosmos_memory.thumbnail_count` between the authoritative capture and the
 * after-physical capture was compared EQUAL while the projection was in force.
 */

test("a projected backup keeps an unprojected manifest for its own fidelity checks", () => {
  assert.equal(
    [...commonSource.matchAll(/^backup_fidelity_data_manifest\(\) \{$/gmu)].length, 1,
    "backup_fidelity_data_manifest must be defined once, in common.sh");
  for (const [label, source] of Object.entries(remoteSources)) {
    if (label === "commonSource") continue;
    assert.doesNotMatch(source, /^backup_fidelity_data_manifest\(\) \{$/mu,
      `backup_fidelity_data_manifest must not be redefined in ${label}`);
  }
  // Written only when the authoritative manifest is projected, and enumerated as
  // an optional artifact so backups without it still verify.
  assert.match(backupSource,
    /^if \[\[ -n "\$data_columns_source" \]\]; then\n  capture_postgres_data "\$postgres" cosmos "\$destination\/postgres-data\.unprojected\.tsv"\nfi$/mu);
  assert.match(backupSource,
    /^fidelity_data_manifest="\$\(backup_fidelity_data_manifest "\$destination"\)"$/mu);
  assert.match(commonSource, /^\s*postgres-data\.unprojected\.tsv postgres-data\.unprojected\.tsv\.columns \\$/mu);
});

test("every same-cluster fidelity comparison resolves through the fidelity manifest", () => {
  // The three inside one backup: across the clean physical snapshot, against the
  // physical restore, against the blank-cluster logical restore. Each captures
  // over the FULL column list and compares against the FULL manifest.
  assert.equal(
    [...backupSource.matchAll(/"\$fidelity_data_manifest\.columns"$/gmu)].length,
    3,
    "all three intra-backup data fidelity captures must project onto the fidelity manifest's columns",
  );
  assert.equal(
    [...backupSource.matchAll(/^cmp -s "\$fidelity_data_manifest" "\$destination\/postgres-data\.(?:after-physical|physical-restored|restored)\.tsv" \\$/gmu)].length,
    3,
    "all three intra-backup data fidelity comparisons must compare against the fidelity manifest",
  );
  // None of them may drift back onto the possibly-projected authoritative manifest.
  assert.doesNotMatch(backupSource,
    /^cmp -s "\$destination\/postgres-data\.tsv" "\$destination\/postgres-data\./mu,
    "a fidelity check must never compare against the projected authoritative manifest");

  // And the staging smoke's restore-fidelity half, which is the same question
  // asked of a backup handed to it from outside.
  assert.match(stagingSource,
    /^restore_fidelity_manifest="\$\(backup_fidelity_data_manifest "\$backup_dir"\)"$/mu);
  assert.match(stagingSource,
    /^  "\$projection_work\/postgres-data\.restored\.tsv" "\$restore_fidelity_manifest\.columns"$/mu);
  assert.match(stagingSource,
    /^cmp -s "\$restore_fidelity_manifest" "\$projection_work\/postgres-data\.restored\.tsv" \\$/mu);
});
