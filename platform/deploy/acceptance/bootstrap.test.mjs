import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function runSourcedBootstrap(command, args = []) {
  return spawnSync("bash", ["-c", `source "$1"; shift; ${command}`, "bootstrap-test", bootstrap, ...args], {
    encoding: "utf8",
  });
}

test("bootstrap can be sourced for compatibility checks without starting setup", () => {
  const result = runSourcedBootstrap("printf ready");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready");
});

test("bootstrap explains missing and unsupported host release information", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldUbuntu = path.join(temporary, "os-release");
  const currentUbuntu = path.join(temporary, "current-os-release");
  fs.writeFileSync(oldUbuntu, 'ID=ubuntu\nVERSION_ID="22.04"\n');
  fs.writeFileSync(currentUbuntu, 'ID=ubuntu\nVERSION_ID="24.04"\n');

  for (const [file, architecture, failure] of [
    [path.join(temporary, "missing"), "x86_64", /release information is missing/u],
    [oldUbuntu, "x86_64", /requires 64-bit Ubuntu 24\.04/u],
    [currentUbuntu, "riscv64", /supports only amd64\/x86_64 and arm64\/aarch64/u],
  ]) {
    const result = runSourcedBootstrap(
      'CURRENT_STAGE="Host compatibility"; CHANGE_STATE="Nothing was changed."; validate_supported_host "$1" "$2"',
      [file, architecture],
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Setup stopped · Host compatibility/u);
    assert.match(result.stderr, failure);
    assert.match(result.stderr, /Nothing was changed/u);
    assert.match(result.stderr, /Safe retry: bash <\(curl -fsSL https:\/\/center\.andersmadsen\.dk\/install\.sh\)/u);
  }
});

test("bootstrap has bounded capacity, privilege, Docker, and GitHub recovery checks", () => {
  const source = fs.readFileSync(bootstrap, "utf8");
  assert.match(source, /MINIMUM_AVAILABLE_KIB/u);
  assert.match(source, /sudo -v/u);
  assert.match(source, /incompatible Docker package/u);
  assert.match(source, /repository read access/u);
  assert.match(source, /package read access/u);
  assert.match(source, /CURRENT_STAGE/u);
  assert.match(source, /CHANGE_STATE/u);
  assert.match(source, /Safe retry/u);
});
