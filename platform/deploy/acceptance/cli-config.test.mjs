import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-config-"));
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
  };
  return { temporary, env };
}

function invoke(env, args, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, input, encoding: "utf8" });
}

test("config uses the contract, redacts secrets, and writes atomically at 0600", () => {
  const { temporary, env } = fixture();
  try {
    assert.equal(invoke(env, ["init"]).status, 0);
    const rejected = invoke(env, ["config", "set", "AUTH_SESSION_SECRET", "argv-secret"]);
    assert.equal(rejected.status, 64);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /argv-secret/);

    const changed = invoke(env, ["config", "set", "AUTH_SESSION_SECRET", "--stdin"], "stdin-secret-value");
    assert.equal(changed.status, 0, changed.stderr);
    assert.doesNotMatch(changed.stdout, /stdin-secret-value/);
    const secret = invoke(env, ["config", "get", "AUTH_SESSION_SECRET", "--json"]);
    assert.deepEqual(JSON.parse(secret.stdout), {
      name: "AUTH_SESSION_SECRET",
      sensitivity: "secret",
      state: "set",
    });

    const port = invoke(env, ["config", "set", "REVIVAL_CENTER_PORT", "4321"]);
    assert.equal(port.status, 0, port.stderr);
    assert.equal(fs.statSync(env.REVIVAL_ENV_FILE).mode & 0o777, 0o600);
    assert.match(invoke(env, ["config", "get", "REVIVAL_CENTER_PORT"]).stdout, /4321/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("config inventory prints metadata only and templates omit secret settings", () => {
  const { temporary, env } = fixture();
  try {
    const list = invoke(env, ["config", "list", "--group", "provider", "--json"]);
    assert.equal(list.status, 0, list.stderr);
    const settings = JSON.parse(list.stdout).settings;
    assert.ok(settings.some((setting) => setting.name === "AZURE_SPEECH_KEY"));
    assert.ok(settings.every((setting) => !Object.hasOwn(setting, "value")));

    const template = invoke(env, ["config", "template", "--group", "provider"]);
    assert.equal(template.status, 0, template.stderr);
    assert.match(template.stdout, /AZURE_SPEECH_REGION=/);
    assert.doesNotMatch(template.stdout, /^AZURE_SPEECH_KEY=/m);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
