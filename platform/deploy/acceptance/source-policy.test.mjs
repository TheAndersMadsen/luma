import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const POLICY = join(ROOT, "platform", "deploy", "acceptance", "source-policy.sh");

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "ai-pin-source-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policyDirectory = join(root, "platform", "deploy", "acceptance");
  mkdirSync(policyDirectory, { recursive: true });
  copyFileSync(POLICY, join(policyDirectory, "source-policy.sh"));
  mkdirSync(join(root, "pin", "contracts", "fixtures"), { recursive: true });
  return root;
}

function writeJsonFixture(root, name, value) {
  writeFileSync(
    join(root, "pin", "contracts", "fixtures", name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function writeBaseline(root) {
  writeJsonFixture(root, "interface.json", {
    schema_version: 1,
    provenance: "clean-room-interface",
    evidence: "observed",
    actions: [{ name: "ExampleAction", kind: "device_action" }],
  });
}

function runPolicy(root) {
  return spawnSync("sh", [join(root, "platform", "deploy", "acceptance", "source-policy.sh")], {
    cwd: root,
    encoding: "utf8",
  });
}

test("accepts independently authored synthetic text fixtures", (t) => {
  const root = makeRoot(t);
  writeJsonFixture(root, "planner.synthetic.json", {
    schema_version: 1,
    provenance: "synthetic",
    evidence: "implemented",
    cases: [{ id: "synthetic-one", input: "An independently authored test input." }],
  });

  const result = runPolicy(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "source policy: ok\n");
});

test("accepts content-free clean-room interface manifests", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);

  const result = runPolicy(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "source policy: ok\n");
});

test("rejects text-bearing fields without synthetic provenance without echoing content", (t) => {
  const root = makeRoot(t);
  const sentinel = "SYNTHETIC_CONTENT_MUST_NOT_BE_ECHOED";
  writeJsonFixture(root, "bad.json", {
    schema_version: 1,
    provenance: "clean-room-interface",
    evidence: "observed",
    input: sentinel,
  });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /text-bearing fields without synthetic provenance/);
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
});

test("rejects fixtures with missing provenance", (t) => {
  const root = makeRoot(t);
  writeJsonFixture(root, "bad.json", {
    schema_version: 1,
    evidence: "implemented",
    input: "Synthetic fixture text.",
  });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported or missing provenance/);
});

test("rejects legacy provenance metadata", (t) => {
  const root = makeRoot(t);
  writeJsonFixture(root, "bad.json", {
    schema_version: 1,
    provenance: "clean-room-interface",
    evidence: "observed",
    _source: "external",
  });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden legacy provenance key _source/);
});

test("requires implemented evidence for synthetic fixtures", (t) => {
  const root = makeRoot(t);
  writeJsonFixture(root, "bad.json", {
    schema_version: 1,
    provenance: "synthetic",
    evidence: "derived",
    input: "Synthetic fixture text.",
  });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic fixtures must use implemented evidence/);
});

test("rejects the legacy transcript-fixture directory", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  mkdirSync(join(root, "pin", "contracts", "carry-golden"), { recursive: true });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pin\/contracts\/carry-golden is forbidden/);
});

test("rejects malformed JSON fixtures", (t) => {
  const root = makeRoot(t);
  writeFileSync(join(root, "pin", "contracts", "fixtures", "bad.json"), "{\n");

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not valid JSON/);
});

test("rejects symbolic links under the fixture root", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const target = join(root, "outside.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(root, "pin", "contracts", "fixtures", "linked.json"));

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symbolic link/);
});

test("rejects a returned NLU model-output fixture directory without echoing content", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const sentinel = "MODEL_OUTPUT_CONTENT_MUST_NOT_BE_ECHOED";
  const testdata = join(root, "pin", "runtime", "core", "src", "nlu", "testdata");
  mkdirSync(testdata, { recursive: true });
  writeFileSync(join(testdata, "returned.json"), `${sentinel}\n`);

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden NLU model-output fixture directory/);
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
});
