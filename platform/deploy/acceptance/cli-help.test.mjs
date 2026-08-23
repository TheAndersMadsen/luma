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
    const commandsByPath = new Map();
    for (const command of contract.commands.filter((entry) => entry.lifecycle === "current")) {
      for (const tokens of [command.tokens, ...command.aliases]) {
        paths.push(tokens);
        commandsByPath.set(tokens.join("\0"), command);
        for (let length = 1; length < tokens.length; length += 1) {
          groups.set(tokens.slice(0, length).join("\0"), tokens.slice(0, length));
        }
      }
    }
    for (const tokens of [...paths, ...groups.values()]) {
      const result = invoke(env, ...tokens, "--help");
      assert.equal(result.status, 0, `${tokens.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/, tokens.join(" "));
      assert.match(result.stdout, /Safety:/, `${tokens.join(" ")} omits its safety boundary`);
      const command = commandsByPath.get(tokens.join("\0"));
      if (command?.effect === "read-only") assert.match(result.stdout, /Safety: read-only/u, command.id);
      if (command?.effect === "local-mutation") {
        assert.match(result.stdout, /Safety: (?:local mutation only|the local mutation)/u, command.id);
      }
      if (command?.effect === "remote-mutation") {
        assert.match(result.stdout, /Safety: (?:this remote mutation|remote mutation)/u, command.id);
      }
      if (command?.effect === "device-mutation") assert.match(result.stdout, /Safety: device mutation/u, command.id);
    }
    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "help must not initialize configuration");
    assert.equal(fs.existsSync(env.REVIVAL_DATA_DIR), false, "help must not initialize data");
    assert.equal(fs.existsSync(path.join(temporary, "setup-state.json")), false, "help must not select a setup track");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("root and command help state the effect boundary without running effects", () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    for (const args of [[], ["help"], ["--help"], ["unknown-command", "--help"]]) {
      const result = invoke(env, ...args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Safety: help is read-only and side-effect-free/u);
    }

    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false);
    assert.equal(fs.existsSync(env.REVIVAL_DATA_DIR), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("help flags short-circuit unknown trailing arguments at every position", () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    for (const args of [
      ["--help", "deploy", "production", "--poison"],
      ["deploy", "--help", "production", "--poison"],
      ["deploy", "production", "--poison", "--help"],
      ["help", "deploy", "production", "--poison"],
    ]) {
      const result = invoke(env, ...args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/u);
      assert.match(result.stdout, /Safety:/u);
    }
    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false);
    assert.equal(fs.existsSync(env.REVIVAL_DATA_DIR), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("deprecated predecessor spelling resolves canonical help without being advertised", () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    const canonical = invoke(env, "deploy", "legacy-predecessor", "--help");
    const compatibility = invoke(env, "deploy", "carry-baseline", "--help");
    const group = invoke(env, "deploy", "--help");
    assert.equal(canonical.status, 0, canonical.stderr);
    assert.equal(compatibility.status, 0, compatibility.stderr);
    assert.equal(group.status, 0, group.stderr);
    assert.equal(compatibility.stdout, canonical.stdout);
    assert.match(canonical.stdout, /Usage: revival deploy legacy-predecessor\b/u);
    assert.doesNotMatch(canonical.stdout, /carry-baseline/u);
    assert.match(group.stdout, /^  legacy-predecessor\s+/mu);
    assert.doesNotMatch(group.stdout, /carry-baseline/u);
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
