import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "contracts/ambiance-v2.json"), "utf8"));
const invariantIds = Array.from({ length: 12 }, (_, index) => `invariant-${String(index + 1).padStart(2, "0")}`);
const paperIds = ["surface-manifest", "origin-provenance", "cognition-authority", "inference-ability", "earned-authority", "concurrency", "recovery", "memory-lifecycle", "content-references", "performance-and-evaluation"];
const productIds = ["pin-realtime-media", "pin-physical-acceptance", "center-surface", "macos-surface", "android-surface", "pixel-default-digital-assistant", "linux-surface", "shield-playback-context", "movie-list-and-trailer-handoff", "document-explanation-desktop-continuation", "restaurant-pixel-navigation", "private-message-personal-continuation", "release-and-live-verification"];

function nonblank(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.trim().length > 0, "metadata text must not be blank");
}

// This validates research-inventory metadata, NOT runtime behavior or test runs.
// A source anchor proves only that a cited definition exists in this checkout.
function validate(value, readSource = (file) => {
  const resolved = fs.realpathSync(path.join(root, file));
  assert.ok(resolved.startsWith(`${root}${path.sep}`), "evidence must remain in the checkout");
  return fs.readFileSync(resolved, "utf8");
}) {
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.id, "cosmos-ambiance-v2");
  assert.equal(value.state, "work-in-progress");
  assert.equal(value.baselineRelease, "v0.1.108");
  assert.equal(value.source.url, "https://gist.githubusercontent.com/ericlewis/12e8f7d381a5d93926f4858ae2d725dc/raw/6bac46cd8251af39c40263331d7269c5e418fe8f/ambi_v2.md");
  assert.equal(value.source.sha256, "d9e3aa98f0646dd18ed58ec73790be468754baea763551ee2d7c7576f579e04e");
  assert.equal(value.source.bytes, 153937);
  assert.equal(value.source.logicalLines, 872);
  assert.equal(value.source.referenceImplementation, "unavailable");
  nonblank(value.source.limitation);
  nonblank(value.scope);
  nonblank(value.verificationPolicy);
  assert.match(value.scope, /not a passing conformance report/u);
  assert.match(value.scope, /self-hosted LiveKit substrate/u);
  assert.match(value.scope, /native clients, media and full acceptance remain unfinished/u);
  assert.match(value.verificationPolicy, /never establish that behavior passed/u);

  assert.ok(Array.isArray(value.evidence));
  const evidence = new Map();
  for (const item of value.evidence) {
    nonblank(item.id);
    assert.ok(!evidence.has(item.id), "duplicate evidence ID");
    assert.ok(["implementation", "test-definition"].includes(item.kind));
    nonblank(item.path);
    assert.match(item.path, /^(cosmos|center|pin|platform|contracts)\/[A-Za-z0-9_./\[\]-]+$/u);
    assert.ok(!item.path.split("/").some((part) => part === ".." || part === "." || part === ""));
    assert.notEqual(item.path, "contracts/ambiance-v2.json", "inventory is not implementation evidence");
    assert.notEqual(item.path, "platform/deploy/acceptance/ambiance-v2.test.mjs", "metadata tests are not implementation evidence");
    for (const field of ["anchor", "scope", "limitation"]) nonblank(item[field]);
    assert.ok(readSource(item.path).includes(item.anchor), `missing evidence anchor: ${item.id}`);
    evidence.set(item.id, item);
  }

  assert.ok(Array.isArray(value.requirements));
  const requirements = new Map();
  const usedEvidence = new Set();
  for (const item of value.requirements) {
    nonblank(item.id);
    assert.ok(!requirements.has(item.id), "duplicate requirement ID");
    assert.ok(["paper", "cosmos-product"].includes(item.basis));
    assert.ok(["pending", "partial"].includes(item.status), "inventory cannot certify runtime conformance");
    assert.ok(Array.isArray(item.sourceSections) && item.sourceSections.length > 0);
    for (const section of item.sourceSections) assert.match(section, /^\d+(?:\.\d+)*$/u);
    nonblank(item.requirement);
    nonblank(item.acceptance);
    assert.ok(Array.isArray(item.evidence));
    assert.equal(new Set(item.evidence).size, item.evidence.length);
    assert.equal(item.status === "pending", item.evidence.length === 0, "partial needs evidence; pending has none");
    for (const id of item.evidence) {
      assert.ok(evidence.has(id), `unknown evidence: ${id}`);
      usedEvidence.add(id);
    }
    requirements.set(item.id, item);
  }
  assert.deepEqual([...requirements.keys()].filter((id) => id.startsWith("invariant-")).sort(), invariantIds);
  for (const id of invariantIds) assert.equal(requirements.get(id).basis, "paper");
  for (const id of productIds) assert.equal(requirements.get(id)?.basis, "cosmos-product");
  for (const id of paperIds) assert.equal(requirements.get(id)?.basis, "paper");
  assert.equal(usedEvidence.size, evidence.size, "orphan evidence must be attached to its scoped requirement");

  const interpretations = new Map(value.interpretations.map((item) => [item.id, item]));
  assert.equal(interpretations.size, value.interpretations.length);
  for (const id of ["occupied-room-private-channel", "shared-origin-private-memory", "unrestricted-outcome-prose"]) {
    const item = interpretations.get(id);
    assert.ok(item, `missing interpretation: ${id}`);
    assert.ok(["unresolved", "conservative-interpretation"].includes(item.status));
    nonblank(item.decision);
    assert.ok(Array.isArray(item.sourceSections) && item.sourceSections.length > 0);
  }
}

test("Ambiance research inventory metadata is internally consistent; this is not conformance acceptance", () => {
  validate(inventory);
});

test("metadata rejects changed source pins, missing or duplicated invariants and product scope conflation", () => {
  for (const mutate of [
    (value) => { value.source.sha256 = "0".repeat(64); },
    (value) => { value.source.url = "https://example.invalid/latest"; },
    (value) => { value.requirements.shift(); },
    (value) => { value.requirements.push(value.requirements[0]); },
    (value) => { value.requirements.find((item) => item.id === "macos-surface").basis = "paper"; },
    (value) => { value.requirements = value.requirements.filter((item) => item.id !== "inference-ability"); },
    (value) => { value.requirements[0].status = "passed"; },
    (value) => { value.requirements[0].status = "partial"; value.requirements[0].evidence = []; },
    (value) => { value.requirements[0].evidence = ["missing"]; },
  ]) {
    const copy = structuredClone(inventory);
    mutate(copy);
    assert.throws(() => validate(copy));
  }
});

test("partial coverage requires a bounded existing definition, not a claimed successful run", () => {
  const copy = structuredClone(inventory);
  copy.evidence.push({ id: "fixture-definition", kind: "test-definition", path: "cosmos/fixture.rs", anchor: "fn fixture()", scope: "Synthetic metadata fixture only.", limitation: "Does not execute code or prove any behavior." });
  copy.requirements[0].status = "partial";
  copy.requirements[0].evidence = ["fixture-definition"];
  const readFixture = (file) => file === "cosmos/fixture.rs" ? "fn fixture() {}" : fs.readFileSync(path.join(root, file), "utf8");
  validate(copy, readFixture);
  assert.throws(() => validate(copy, (file) => file === "cosmos/fixture.rs" ? "fn renamed() {}" : readFixture(file)));
  for (const mutate of [
    (value) => { value.evidence.at(-1).path = "cosmos/../../outside"; },
    (value) => { value.evidence.at(-1).kind = "passed"; },
    (value) => { value.evidence.at(-1).limitation = ""; },
    (value) => { value.requirements[0].status = "pending"; },
  ]) {
    const invalid = structuredClone(copy);
    mutate(invalid);
    assert.throws(() => validate(invalid, readFixture));
  }
});

test("metadata permits Next.js dynamic route evidence without permitting traversal", () => {
  const copy = structuredClone(inventory);
  const route = "center/src/app/api/surfaces/[surfaceId]/[...action]/route.ts";
  copy.evidence.push({ id: "dynamic-route-fixture", kind: "implementation", path: route, anchor: "function fixtureRoute()", scope: "Synthetic dynamic-route metadata fixture only.", limitation: "No runtime behavior or file existence claimed by this fixture." });
  copy.requirements[0].status = "partial";
  copy.requirements[0].evidence = ["dynamic-route-fixture"];
  const readFixture = (file) => file === route ? "function fixtureRoute() {}" : fs.readFileSync(path.join(root, file), "utf8");
  validate(copy, readFixture);
  copy.evidence.at(-1).path = "center/src/app/[surfaceId]/../outside.ts";
  assert.throws(() => validate(copy, readFixture));
});
