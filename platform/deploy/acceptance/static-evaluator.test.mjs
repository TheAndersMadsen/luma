import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findUnapprovedMachinePath, validateSourceTreePolicy } from "../release.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function assertMachinePath(source, label) {
  assert.notEqual(findUnapprovedMachinePath(source), null, label);
}

function assertNoMachinePath(source, label) {
  assert.equal(findUnapprovedMachinePath(source), null, label);
}

async function policyFixture(t, relativePath, source) {
  const root = await mkdtemp(join(tmpdir(), "ai-pin-static-evaluator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "platform", "deploy"), { recursive: true });
  await writeFile(
    join(root, "platform", "deploy", "release.json"),
    await readFile(join(ROOT, "platform", "deploy", "release.json")),
  );
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
  return root;
}

test("static evaluator covers ordered JS and TS bindings and lexical shadows", () => {
  const badRoot = ["", "home"].join("/");
  const safeRoot = ["", "srv"].join("/");

  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; root = ${JSON.stringify(badRoot)}; path.join(root, "alice");`,
    "known reassignment must update the call-site binding",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(badRoot)}; path.join(root, "alice"); root = ${JSON.stringify(safeRoot)};`,
    "a later safe assignment must not erase an earlier bad call",
  );
  assertNoMachinePath(
    `let root = ${JSON.stringify(badRoot)}; root = ${JSON.stringify(safeRoot)}; path.join(root, "alice");`,
    "a stale first binding must not taint the only use after a safe reassignment",
  );
  assertNoMachinePath(
    `let root = ${JSON.stringify(badRoot)}; root = dynamicRoot(); path.join(root, "alice");`,
    "an unknown assignment must invalidate the old constant",
  );
  assertNoMachinePath(
    `let root = "/ho" + "me/alice/secret"; root = ${JSON.stringify(safeRoot)}; path.join(root, "x");`,
    "a known reassignment must retire a split stale initializer candidate",
  );
  assertNoMachinePath(
    `let root = "/ho" + "me/alice/secret"; root = dynamicRoot(); path.join(root, "x");`,
    "an unknown reassignment must retire a split stale initializer candidate",
  );
  assertNoMachinePath(
    `let root = ${JSON.stringify(badRoot)}; root++; path.join(root, "alice");`,
    "an unsupported mutating assignment must invalidate the old constant",
  );
  assertNoMachinePath(
    `path.join(root, "alice"); const root = ${JSON.stringify(badRoot)};`,
    "a later declaration must not resolve an earlier call",
  );
  assertMachinePath(
    `const root = ${JSON.stringify(safeRoot)}; { const root = ${JSON.stringify(badRoot)}; path.join(root, "alice"); }`,
    "an inner binding must shadow the outer binding at the inner call",
  );
  assertNoMachinePath(
    `const root = ${JSON.stringify(safeRoot)}; { const root = ${JSON.stringify(badRoot)}; } path.join(root, "alice");`,
    "an inner block binding must not leak",
  );
  assertNoMachinePath(
    `const root = ${JSON.stringify(badRoot)}; function render(root) { path.join(root, "alice"); }`,
    "a function parameter must shadow an outer constant",
  );
  assertMachinePath(
    `const root = ${JSON.stringify(badRoot)}, child = "alice"; path.join(root, child);`,
    "multiple declarators are evaluated from left to right",
  );
  assertMachinePath(
    `let root = "/ho"; root += "me"; path.join(root, "alice");`,
    "a known compound string assignment updates the binding",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; const assigned = (root = "/ho" + "me"); path.join(root, "alice");`,
    "a nested assignment expression updates its binding before the call",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; (root = "/ho" + "me", path.join(root, "alice"));`,
    "a comma expression preserves left-to-right assignment order",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; for (root = "/ho" + "me"; false;) {} path.join(root, "alice");`,
    "a for initializer assignment is evaluated before the loop",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; for (; dynamic(); root = "/ho" + "me/alice/secret") {} path.join(root, "x");`,
    "a possible for update is still inspected without treating it as definite afterward",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; [root] = [["", "home"].join("/")]; path.join(root, "alice");`,
    "array destructuring updates a statically selected binding",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; ({ source: root } = { source: "/ho" + "me" }); path.join(root, "alice");`,
    "object destructuring updates a renamed static property binding",
  );
  assertMachinePath(
    `const [root] = [["", "home"].join("/")]; path.join(root, "alice");`,
    "array destructuring declarations bind static members",
  );
  assertMachinePath(
    `const { source: root } = { source: "/ho" + "me" }; path.join(root, "alice");`,
    "object destructuring declarations bind renamed static properties",
  );
  assertMachinePath(
    `let root = ${JSON.stringify(safeRoot)}; if (dynamic()) { root = ${JSON.stringify(badRoot)}; path.join(root, "alice"); }`,
    "a static bad value used inside a possible branch is still inspected",
  );
  assertNoMachinePath(
    `let root = ${JSON.stringify(badRoot)}; if (dynamic()) { root = ${JSON.stringify(safeRoot)}; } path.join(root, "alice");`,
    "a conditional write makes the post-branch binding unknown",
  );
});

test("static evaluator resolves computed and optional constant calls", () => {
  const head = ["", "ho"].join("/");
  const tail = "me/alice";
  const root = ["", "home"].join("/");
  const cases = [
    `const value = ${JSON.stringify(head)}; value['concat'](${JSON.stringify(tail)});`,
    `const method = "concat"; const value = ${JSON.stringify(head)}; value[method](${JSON.stringify(tail)});`,
    `const values = ["", "home", "alice"]; const separator = "/"; values['join'](separator);`,
    `const value = ${JSON.stringify(head)}; value?.concat(${JSON.stringify(tail)});`,
    `const value = ${JSON.stringify(head)}; value.concat?.(${JSON.stringify(tail)});`,
    `const root = ${JSON.stringify(root)}; path['join'](root, "alice");`,
    `const root = ${JSON.stringify(root)}; path.posix['join'](root, "alice");`,
    `const pathAlias = path; const root = ${JSON.stringify(root)}; pathAlias?.join(root, "alice");`,
  ];
  for (const [index, source] of cases.entries()) assertMachinePath(source, `computed case ${index}`);

  assertNoMachinePath(
    `const value = ${JSON.stringify(head)}; const method = dynamicMethod(); value[method](${JSON.stringify(tail)});`,
    "a dynamic computed property is not a static call",
  );
  assertNoMachinePath(
    `const object = dynamicObject(); object['join'](${JSON.stringify(root)}, "alice");`,
    "an unrelated receiver named like a static operation is ignored",
  );
});

test("static evaluator covers Java, Kotlin, Rust, shell, and normalized joins", () => {
  const root = ["", "home"].join("/");
  const cases = [
    `String left = "/ho"; String right = "me/alice"; String result = left + right;`,
    `val left: String = "/ho"; var right = "me/alice"; val result = left + right;`,
    `String root = ${JSON.stringify(root)}; String child = "alice"; Paths.get(root, child);`,
    `String root = ${JSON.stringify(root)}; String child = "alice"; Path.of(root, child);`,
    `let left = "/ho"; let right = "me/alice"; let result = left + right;`,
    `let left = "/ho"; let result = left.to_owned() + "me/alice";`,
    `let left = String::from("/ho"); let result = left + "me/alice";`,
    `let result = concat!("/ho", "me/alice");`,
    `left='/ho'\nright='me/alice'\nresult="$left$right"`,
    `left='/ho'\nright='me/alice'\nresult="${"${left}${right}"}"`,
    `export left='/ho'\nexport right='me/alice'\nresult="$left$right"`,
    `path.join(${JSON.stringify(root)}, "temporary", "..", "alice");`,
  ];
  for (const [index, source] of cases.entries()) assertMachinePath(source, `language case ${index}`);
});

test("cycles and unsafe lookalikes stay unknown or public", () => {
  assertNoMachinePath(
    `let first = second; let second = first; path.join(first, "alice");`,
    "a cyclic binding graph is unknown",
  );
  assertNoMachinePath(
    `const root = "/homepage"; path.join(root, "alice");`,
    "a public lookalike is not a home directory",
  );
  assertNoMachinePath(
    `path.join("/home", "temporary", "..", "..", "srv", "alice");`,
    "normalization may remove the machine-home segment",
  );
});

test("static evaluator rejects bounded-resource exhaustion without source disclosure", () => {
  const bindingFlood = Array.from({ length: 1025 }, (_unused, index) =>
    `v${index}='';`).join("");
  assert.throws(
    () => findUnapprovedMachinePath(bindingFlood),
    (error) => /source static evaluator binding limit exceeded/u.test(error.message) &&
      !error.message.includes(bindingFlood.slice(0, 64)),
  );

  const tokenFlood = `const value = "";${"+!".repeat(8000)}`;
  assert.throws(
    () => findUnapprovedMachinePath(tokenFlood),
    /source static evaluator token limit exceeded/u,
  );

  const candidateFlood = Array.from({ length: 1025 }, (_unused, index) =>
    `value='${index.toString(36).padStart(3, "0")}';`).join("");
  assert.throws(
    () => findUnapprovedMachinePath(candidateFlood),
    /source static evaluator candidate limit exceeded/u,
  );

  const deep = `const value = ${"(".repeat(40)}"public"${")".repeat(40)};`;
  assert.throws(
    () => findUnapprovedMachinePath(deep),
    /source static evaluator expression depth limit exceeded/u,
  );

  const growth = ["let value = \"aa\";", ...Array.from({ length: 14 }, () =>
    "value = value + value;")].join("");
  assert.throws(
    () => findUnapprovedMachinePath(growth),
    /source static evaluator output byte limit exceeded/u,
  );
});

test("full source policy detects a split GitHub signature after mutation without echoing it", async (t) => {
  const prefixHead = String.fromCodePoint(103, 104);
  const prefixTail = String.fromCodePoint(112, 95);
  const body = "a".repeat(36);
  const token = `${prefixHead}${prefixTail}${body}`;
  const source = [
    `prefix = ${JSON.stringify(prefixHead)};`,
    `prefix = prefix.concat(${JSON.stringify(prefixTail)});`,
    `body = ${JSON.stringify(body)};`,
    "token = prefix.concat(body);",
  ].join("\n");
  const root = await policyFixture(t, "center/mutated-token.mjs", source);
  await assert.rejects(
    validateSourceTreePolicy({ root }),
    (error) => /GitHub access token detected in release source/u.test(error.message) &&
      !error.message.includes(token),
  );
});

test("full source policy path errors never echo the synthesized machine path", async (t) => {
  const rootPart = ["", "home"].join("/");
  const userPart = "private-user";
  const machinePath = [rootPart, userPart].join("/");
  const source = `const root = ${JSON.stringify(rootPart)}; path.join(root, ${JSON.stringify(userPart)});`;
  const root = await policyFixture(t, "center/mutated-path.mjs", source);
  await assert.rejects(
    validateSourceTreePolicy({ root }),
    (error) => /machine-local path found in release source/u.test(error.message) &&
      !error.message.includes(machinePath),
  );
});
