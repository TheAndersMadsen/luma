import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-setup-"));
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

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

test("setup stores only the selected track and recomputes an actionable plan", () => {
  const { temporary, env } = fixture();
  try {
    const selected = invoke(env, "setup", "local", "--json");
    assert.equal(selected.status, 0, selected.stderr);
    const report = JSON.parse(selected.stdout);
    assert.equal(report.selectedTrack, "local");
    assert.equal(report.next.action, "./revival init");

    const stateFile = path.join(temporary, "setup-state.json");
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), {
      schemaVersion: 1,
      selectedTrack: "local",
    });

    const resumed = invoke(env, "setup", "--resume", "--json");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), report);
    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "setup must not initialize product state");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Pin setup retains no serial or secret and preserves physical acceptance", () => {
  const { temporary, env } = fixture();
  try {
    env.REVIVAL_TEST_SECRET = "never-write-this-secret";
    const signingFile = path.join(env.REVIVAL_SECRETS_DIR, "pin", "signing.env");
    const releaseDirectory = path.join(env.REVIVAL_DATA_DIR, "releases", "unverified");
    fs.mkdirSync(path.dirname(signingFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(signingFile, "PIN_SIGNING_STORE_FILE=/protected/store\n", { mode: 0o600 });
    fs.mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(releaseDirectory, "manifest.json"), "{}\n", { mode: 0o600 });

    const result = invoke(env, "setup", "pin", "--json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.physicalAcceptanceRequired, true);
    assert.equal(report.next.action, "./revival pin doctor");
    assert.equal(report.steps[0].status, "pending");
    assert.ok(
      report.steps.slice(1).every((step) => step.status === "blocked"),
      "prerequisite file presence must not become fake command completion",
    );
    const state = fs.readFileSync(path.join(temporary, "setup-state.json"), "utf8");
    assert.doesNotMatch(state, /serial|secret|never-write-this-secret/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("all setup surfaces inspect evidence without executing external tools", () => {
  const { temporary, env } = fixture();
  try {
    const bin = path.join(temporary, "bin");
    const marker = path.join(temporary, "executed-tools.txt");
    fs.mkdirSync(bin, { mode: 0o700 });
    for (const command of ["adb", "curl", "docker", "scp", "ssh"]) {
      const stub = path.join(bin, command);
      fs.writeFileSync(
        stub,
        "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$REVIVAL_EXEC_MARKER\"\nexit 97\n",
        { mode: 0o700 },
      );
    }
    fs.mkdirSync(env.REVIVAL_SECRETS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(env.REVIVAL_ENV_FILE, "REVIVAL_CONFIG_VERSION=1\n", { mode: 0o600 });
    env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    env.REVIVAL_EXEC_MARKER = marker;

    for (const track of ["local", "contributor", "production", "pin"]) {
      const selected = invoke(env, "setup", track, "--json");
      assert.equal(selected.status, 0, `${track}: ${selected.stderr}`);
      assert.doesNotThrow(() => JSON.parse(selected.stdout));

      const status = invoke(env, "setup", "status", "--json");
      assert.equal(status.status, 0, `${track} status: ${status.stderr}`);
      const resumed = invoke(env, "setup", "--resume", "--json");
      assert.equal(resumed.status, 0, `${track} resume: ${resumed.stderr}`);
    }
    assert.equal(fs.existsSync(marker), false, "setup must never execute Docker, ADB, network, or remote tools");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
