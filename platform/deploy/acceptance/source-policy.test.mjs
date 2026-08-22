import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateSourceTreePolicy } from "../release.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const POLICY = join(ROOT, "platform", "deploy", "acceptance", "source-policy.sh");
const RELEASE_POLICY = join(ROOT, "platform", "deploy", "release.mjs");
const RELEASE_CONFIG = join(ROOT, "platform", "deploy", "release.json");
const ROOTED_SOURCE = join(ROOT, "platform", "cli", "rooted-source.js");

function runtimeJoin(parts, separator) {
  return parts.join(separator);
}

function populateRoot(root) {
  const policyDirectory = join(root, "platform", "deploy", "acceptance");
  mkdirSync(policyDirectory, { recursive: true });
  copyFileSync(POLICY, join(policyDirectory, "source-policy.sh"));
  copyFileSync(RELEASE_POLICY, join(root, "platform", "deploy", "release.mjs"));
  copyFileSync(RELEASE_CONFIG, join(root, "platform", "deploy", "release.json"));
  mkdirSync(join(root, "platform", "cli"), { recursive: true });
  copyFileSync(ROOTED_SOURCE, join(root, "platform", "cli", "rooted-source.js"));
  mkdirSync(join(root, "pin", "contracts", "fixtures"), { recursive: true });
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "ai-pin-source-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  populateRoot(root);
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

function runPolicy(root, { cwd = root, env = process.env } = {}) {
  return spawnSync("/usr/bin/sh", [join(root, "platform", "deploy", "acceptance", "source-policy.sh")], {
    cwd,
    encoding: "utf8",
    env,
  });
}

test("hostile PATH node and dirname shims cannot replace either real policy scan", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const hostile = mkdtempSync(join(tmpdir(), "ai-pin-source-policy-path-"));
  t.after(() => rmSync(hostile, { recursive: true, force: true }));
  const marker = join(hostile, "called");
  for (const name of ["node", "dirname"]) {
    const executable = join(hostile, name);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' ${name} >> '${marker}'\nexit 0\n`);
    chmodSync(executable, 0o700);
  }
  const result = runPolicy(root, { env: { ...process.env, PATH: hostile } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "source policy: ok\n");
  assert.equal(existsSync(marker), false);
});

test("source policy resolves its source root independently of the caller cwd", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const result = runPolicy(root, { cwd: tmpdir() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "source policy: ok\n");
});

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
  mkdirSync(join(root, "pin", "contracts", "cosmos-golden"), { recursive: true });

  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pin\/contracts\/cosmos-golden is forbidden/);
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
  assert.match(result.stderr, /symbolic links are forbidden|must not be a symbolic link/);
});

test("cheap source policy rejects every release secret signature", (t) => {
  const signatures = [
    ["AWS", String.fromCodePoint(65, 75, 73, 65) + "ABCDEFGHIJKLMNOP"],
    ["GitHub", String.fromCodePoint(103, 104, 112, 95) + "a".repeat(36)],
    ["Google", String.fromCodePoint(65, 73, 122, 97) + "a".repeat(35)],
    ["OpenAI", String.fromCodePoint(115, 107, 45, 112, 114, 111, 106, 45) + "a".repeat(48)],
    ["Slack", String.fromCodePoint(120, 111, 120, 98, 45) + "a".repeat(24)],
    ["Azure", String.fromCodePoint(65, 99, 99, 111, 117, 110, 116, 75, 101, 121, 61) + "A".repeat(44)],
  ];
  for (const [label, signature] of signatures) {
    const root = makeRoot(t);
    writeBaseline(root);
    writeFileSync(join(root, `${label.toLowerCase()}.txt`), `${signature}\n`);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${label} signature passed`);
    assert.match(result.stderr, /detected in release source/u, label);
    assert.doesNotMatch(result.stderr, new RegExp(signature), `${label} value leaked`);
  }
});

test("cheap source policy scans instruction files, diagrams, and hidden source trees", (t) => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  const cases = [
    ["AGENTS.md", Buffer.from(privateKey).toString("base64"), /encoded private key material/u],
    [join("diagrams", "architecture.md"), String.fromCodePoint(103, 104, 112, 95) + "a".repeat(36), /GitHub access token/u],
    [join(".claude", "instructions.md"), String.fromCodePoint(120, 111, 120, 98, 45) + "a".repeat(24), /Slack access token/u],
    [join(".gstack", "notes.md"), String.fromCodePoint(65, 73, 122, 97) + "a".repeat(35), /Google API key/u],
  ];
  for (const [relativePath, secret, expected] of cases) {
    const root = makeRoot(t);
    writeBaseline(root);
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), `${secret}\n`);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${relativePath} was skipped`);
    assert.match(result.stderr, expected, relativePath);
    assert.equal(result.stderr.includes(secret), false, `${relativePath} value leaked`);
  }
});

test("a Git worktree pointer file is the only non-directory structural exclusion", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const sentinel = String.fromCodePoint(103, 104, 112, 95) + "a".repeat(36);
  writeFileSync(join(root, ".git"), `gitdir: ${sentinel}\n`);
  const result = runPolicy(root);
  assert.equal(result.status, 0, result.stderr);
});

test("instruction-file review redacts only the exact historical path literals", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const reviewedPaths = [
    runtimeJoin(["", "Users", "andersmadsen", "Desktop", "Ai Pin Revival"], "/"),
    runtimeJoin(["", "home", "anders", "carry-cent*"], "/"),
  ];
  writeFileSync(join(root, "AGENTS.md"), `${reviewedPaths.join("\n")}\n`);
  assert.equal(runPolicy(root).status, 0, "exact reviewed literals should remain usable");

  const injected = runtimeJoin(["", "Users", "different-user", "secret"], "/");
  writeFileSync(join(root, "AGENTS.md"), `${reviewedPaths.join("\n")}\n${injected}\n`);
  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /machine-local path found.*AGENTS\.md/u);
});

test("cheap source policy rejects nested private and generated hiding places", (t) => {
  for (const directory of [
    "secrets",
    ".secrets",
    "Secrets",
    "...SECRETS...",
    "private-keys",
    "release-assets",
    "dist-center",
    "test-runs",
  ]) {
    const root = makeRoot(t);
    writeBaseline(root);
    const hidden = join(root, "center", "nested", directory);
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "ordinary.txt"), "synthetic\n");
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${directory} passed`);
    assert.match(result.stderr, /private directory|generated directory/u, directory);
  }
});

test("cheap source policy folds static calls and templates at its package boundary", (t) => {
  const slash = String.fromCodePoint(47);
  const homeHead = `${slash}ho`;
  const homeChild = `${slash}${["alice", "secret"].join(slash)}`;
  const homeTail = ["me", "alice", "secret"].join(slash);
  const templateReference = ["$", "{root}"].join("");
  const githubPrefix = String.fromCodePoint(103, 104, 112, 95);
  const sources = [
    ["concat.mjs", ["const p = ", JSON.stringify(homeHead), ".concat(\"me\", ", JSON.stringify(homeChild), ");\n"].join(""), /machine-local path/u],
    ["join.mjs", ["const p = [", JSON.stringify(homeHead), ", \"me\", ", JSON.stringify(homeChild), "].join(\"\");\n"].join(""), /machine-local path/u],
    ["template.mjs", ["const root = ", JSON.stringify(homeHead), "; const p = `", templateReference, homeTail, "`;\n"].join(""), /machine-local path/u],
    ["bound-join.mjs", ["const sep = \"\"; const p = [", JSON.stringify(homeHead), ", \"me/alice/secret\"].join(sep);\n"].join(""), /machine-local path/u],
    ["bound-concat.mjs", ["const a = ", JSON.stringify(homeHead), "; const b = \"me/alice/secret\"; const p = a.concat(b);\n"].join(""), /machine-local path/u],
    ["bound-path-join.mjs", ["const root = ", JSON.stringify(`${slash}home`), "; const child = \"alice/secret\"; const p = path.join(root, child);\n"].join(""), /machine-local path/u],
    ["bound-secret.mjs", ["const prefix = ", JSON.stringify(githubPrefix), "; const body = ", JSON.stringify("a".repeat(36)), "; const token = prefix.concat(body);\n"].join(""), /GitHub access token/u],
  ];
  for (const [name, source, expected] of sources) {
    const root = makeRoot(t);
    writeBaseline(root);
    mkdirSync(join(root, "center"), { recursive: true });
    writeFileSync(join(root, "center", name), source);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${name} passed`);
    assert.match(result.stderr, expected, name);
  }
});

test("cheap source policy scans ASCII credentials and paths across binary bytes", (t) => {
  const slash = String.fromCodePoint(47);
  const githubPrefix = String.fromCodePoint(103, 104, 112, 95);
  const cases = [
    ["path.dat", Buffer.concat([
      Buffer.from([0, 255, 0]),
      Buffer.from([slash, "Users", "binary-user", "secret"].join(slash), "ascii"),
    ]), /machine-local path/u],
    ["secret.dat", Buffer.concat([
      Buffer.from([0, 255, 0]),
      Buffer.from(`${githubPrefix}${"a".repeat(36)}`, "ascii"),
    ]), /GitHub access token/u],
  ];
  for (const [name, value, expected] of cases) {
    const root = makeRoot(t);
    writeBaseline(root);
    mkdirSync(join(root, "center"), { recursive: true });
    writeFileSync(join(root, "center", name), value);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${name} passed`);
    assert.match(result.stderr, expected, name);
  }
});

test("cheap source policy forbids live key snapshot names without reading them aloud", (t) => {
  for (const name of [
    "channel-key.json",
    "channel.keys.json",
    "channel_store.json",
    "wearer-channel.json",
    "key.material.json",
    ".cosmos-channel-key.json.123.tmp",
    "ai-bus-keymaterial.json.swap",
  ]) {
    const root = makeRoot(t);
    writeBaseline(root);
    const sentinel = `LIVE_SNAPSHOT_${name.length}_MUST_NOT_BE_ECHOED`;
    writeFileSync(join(root, name), `${sentinel}\n`);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${name} passed`);
    assert.match(result.stderr, /live channel\/key-material snapshot filename/u);
    assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  }
});

test("cheap source policy rejects embedded private DER and live-store schemas under harmless names", (t) => {
  const channelKey = Buffer.alloc(16, 7).toString("base64");
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  const cases = [
    ["fixture.dat", Buffer.concat([Buffer.from([0, 255, 0]), privateKey, Buffer.from([0, 42, 0])]), /encoded private key material/u],
    ["center-store.json", JSON.stringify({
      kid: "U:reviewer/center/ephemeral",
      key: channelKey,
      keys: { "U:reviewer/center/ephemeral": channelKey },
    }), /live channel\/key-material snapshot content/u],
    ["cosmos-store.json", JSON.stringify({
      wrapping_private_key: null,
      channel_keys: { "reviewer-kid": channelKey },
    }), /live channel\/key-material snapshot content/u],
  ];
  for (const [name, value, expected] of cases) {
    const root = makeRoot(t);
    writeBaseline(root);
    mkdirSync(join(root, "center"), { recursive: true });
    writeFileSync(join(root, "center", name), value);
    const result = runPolicy(root);
    assert.notEqual(result.status, 0, `${name} passed`);
    assert.match(result.stderr, expected, name);
    assert.doesNotMatch(result.stderr, /reviewer-kid|BwcHBw/u);
  }
});

test("cheap source policy rejects links outside fixture-specific directories", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  mkdirSync(join(root, "center"), { recursive: true });
  writeFileSync(join(root, "outside.txt"), "synthetic\n");
  symlinkSync(join(root, "outside.txt"), join(root, "center", "linked.txt"));
  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic links are forbidden.*center\/linked\.txt/u);
});

test("cheap source policy rejects external hard-linked inodes", (t) => {
  const root = makeRoot(t);
  const external = mkdtempSync(join(tmpdir(), "ai-pin-policy-hardlink-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeBaseline(root);
  mkdirSync(join(root, "center"), { recursive: true });
  writeFileSync(join(external, "outside.txt"), "outside inode\n");
  linkSync(join(external, "outside.txt"), join(root, "center", "linked.txt"));
  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hard-linked files are forbidden.*center\/linked\.txt/u);
});

test("source policy rejects static and concurrent source-ancestor substitution", async (t) => {
  const outer = mkdtempSync(join(tmpdir(), "ai-pin-policy-root-ancestor-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const realParent = join(outer, "real-parent");
  const root = join(realParent, "source");
  mkdirSync(root, { recursive: true });
  populateRoot(root);
  writeBaseline(root);

  const aliasParent = join(outer, "alias-parent");
  symlinkSync(realParent, aliasParent);
  await assert.rejects(
    validateSourceTreePolicy({ root: join(aliasParent, "source") }),
    /source root ancestors must not be symbolic links/u,
  );

  const displaced = join(outer, "real-parent-before-swap");
  await assert.rejects(
    validateSourceTreePolicy({
      root,
      beforeSourceStabilityCheck: async () => {
        renameSync(realParent, displaced);
        cpSync(displaced, realParent, { recursive: true, preserveTimestamps: true });
      },
    }),
    /root changed|source root changed|source manifest changed/u,
  );
});

test("source policy rejects a concurrent included-directory ancestor swap", async (t) => {
  const root = makeRoot(t);
  const external = mkdtempSync(join(tmpdir(), "ai-pin-policy-external-ancestor-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeBaseline(root);
  mkdirSync(join(root, "center", "ancestor"), { recursive: true });
  writeFileSync(join(root, "center", "ancestor", "inside.txt"), "inside\n");
  writeFileSync(join(external, "inside.txt"), "outside\n");
  await assert.rejects(
    validateSourceTreePolicy({
      root,
      beforeSourceStabilityCheck: async () => {
        rmSync(join(root, "center", "ancestor"), { recursive: true });
        symlinkSync(external, join(root, "center", "ancestor"));
      },
    }),
    /symbolic links are forbidden|source manifest changed/u,
  );
  assert.equal(readFileSync(join(external, "inside.txt"), "utf8"), "outside\n");
});

test("cheap source policy uses the structural encrypted-PKCS#8 detector", (t) => {
  const root = makeRoot(t);
  writeBaseline(root);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const encryptedDer = privateKey.export({
    format: "der",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: "source-policy-test-only",
  });
  mkdirSync(join(root, "center"), { recursive: true });
  writeFileSync(join(root, "center", "opaque.dat"), encryptedDer);
  const result = runPolicy(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /encoded private key material detected.*center\/opaque\.dat/u);
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
