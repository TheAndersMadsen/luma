import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const bootstrap = path.join(root, "bootstrap");

test("newcomer bootstrap is a valid standalone interactive Bash program", () => {
  const syntax = spawnSync("bash", ["-n", bootstrap], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [bootstrap, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /installs supported host tools/u);
  const mode = fs.statSync(bootstrap).mode & 0o777;
  assert.equal(mode, 0o755);
});

test("bootstrap keeps secrets transient and authenticates before executing a release", () => {
  const source = fs.readFileSync(bootstrap, "utf8");
  assert.match(source, /ask_secret GH_TOKEN/u);
  assert.match(source, /cosign.*verify-blob/su);
  assert.match(source, /operator archive did not match the authenticated descriptor/u);
  assert.match(source, /docker login ghcr\.io.*--password-stdin/u);
  assert.match(source, /\.\/revival onboard production/u);
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/u);
  assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/u);
});
