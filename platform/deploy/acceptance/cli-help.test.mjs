import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");
const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts/operator-setup.json"), "utf8"));
const descriptor = JSON.parse(fs.readFileSync(path.join(root, "platform/distribution/version.json"), "utf8"));

function isolatedEnvironment() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-help-"));
  return {
    temporary,
    env: {
      ...process.env,
      REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
      REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
      REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
      REVIVAL_DATA_DIR: path.join(temporary, "data"),
      REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
      REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
    },
  };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

test("every current command, alias, and group resolves help before effects", () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    const paths = [];
    const groups = new Map();
    for (const command of contract.commands.filter((entry) => entry.lifecycle === "current")) {
      for (const tokens of [command.tokens, ...command.aliases]) {
        paths.push(tokens);
        for (let length = 1; length < tokens.length; length += 1) {
          groups.set(tokens.slice(0, length).join("\0"), tokens.slice(0, length));
        }
      }
    }
    for (const tokens of [...paths, ...groups.values()]) {
      const result = invoke(env, ...tokens, "--help");
      assert.equal(result.status, 0, `${tokens.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/, tokens.join(" "));
    }
    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "help must not initialize configuration");
    assert.equal(fs.existsSync(env.REVIVAL_DATA_DIR), false, "help must not initialize data");
    assert.equal(fs.existsSync(path.join(temporary, "setup-state.json")), false, "help must not select a setup track");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("version is stamped and doctor JSON is one actionable document", () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    const version = invoke(env, "version", "--json");
    assert.equal(version.status, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), {
      product: "Ai Pin Revival",
      version: descriptor.version,
      contractVersion: contract.contractVersion,
    });

    const doctor = invoke(env, "doctor", "--json");
    assert.notEqual(doctor.status, 0);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.status === "FAIL" && check.fix));
    assert.equal(typeof report.next, "string");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
