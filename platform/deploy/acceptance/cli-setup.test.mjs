import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-setup-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
    REVIVAL_STATE_DIR: path.join(temporary, "state"),
  };
  return { temporary, env };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("setup persists only the selected track and reports the same ordered checklist", (t) => {
  const { env } = fixture(t);
  const selected = invoke(env, "setup", "local", "--json");
  assert.equal(selected.status, 0, selected.stderr);
  const report = JSON.parse(selected.stdout);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.selectedTrack, "local");
  assert.equal(Object.hasOwn(report, "next"), false);
  assert.deepEqual(
    report.steps.filter((step) => step.status === "required").map((step) => step.action),
    ["./revival init", "./revival doctor", "./revival stack up", "./revival stack status"],
  );

  const stateFile = path.join(env.REVIVAL_STATE_DIR, "setup-state.json");
  assert.equal(fs.statSync(env.REVIVAL_STATE_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), {
    schemaVersion: 1,
    selectedTrack: "local",
  });
  assert.deepEqual(fs.readdirSync(env.REVIVAL_STATE_DIR), ["setup-state.json"]);

  const resumed = invoke(env, "setup", "--resume", "--json");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), report);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "setup must not initialize product state");
});

test("setup recomputes safe file evidence without remembering command success", (t) => {
  const { env } = fixture(t);
  fs.mkdirSync(path.dirname(env.REVIVAL_ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(env.REVIVAL_ENV_FILE, "REVIVAL_CONFIG_VERSION=1\n", { mode: 0o600 });

  const configured = invoke(env, "setup", "local", "--json");
  assert.equal(configured.status, 0, configured.stderr);
  const configuredReport = JSON.parse(configured.stdout);
  assert.equal(configuredReport.steps.find((step) => step.id === "initialize").status, "complete");
  assert.deepEqual(
    configuredReport.steps.filter((step) => step.status === "required").map((step) => step.action),
    ["./revival doctor", "./revival stack up", "./revival stack status"],
  );

  fs.unlinkSync(env.REVIVAL_ENV_FILE);
  const changed = invoke(env, "setup", "status", "--json");
  assert.equal(changed.status, 0, changed.stderr);
  const changedReport = JSON.parse(changed.stdout);
  assert.equal(changedReport.steps.find((step) => step.id === "initialize").status, "required");
  assert.equal(
    changedReport.steps.find((step) => step.id === "check").evidence,
    "run the doctor directly; setup does not execute Docker",
  );
  assert.deepEqual(
    changedReport.steps.filter((step) => step.status === "required").map((step) => step.action),
    ["./revival init", "./revival doctor", "./revival stack up", "./revival stack status"],
  );
});

test("Pin setup retains no device identity and leaves live and physical checks required", (t) => {
  const { env } = fixture(t);
  env.REVIVAL_TEST_SECRET = "never-write-this-secret";
  const signingFile = path.join(env.REVIVAL_SECRETS_DIR, "pin", "signing.env");
  fs.mkdirSync(path.dirname(signingFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(signingFile, "PIN_SIGNING_STORE_FILE=/protected/store\n", { mode: 0o600 });

  const result = invoke(env, "setup", "pin", "--json");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.physicalAcceptanceRequired, true);
  assert.ok(report.steps.every((step) => step.status === "required"));
  assert.equal(report.steps[0].action, "./revival pin doctor");
  assert.equal(Object.hasOwn(report, "next"), false);

  const state = fs.readFileSync(path.join(env.REVIVAL_STATE_DIR, "setup-state.json"), "utf8");
  assert.doesNotMatch(state, /serial|secret|never-write-this-secret/i);
});

test("setup planning never probes Docker, a device, or the network", (t) => {
  const { temporary, env } = fixture(t);
  const bin = path.join(temporary, "bin");
  const marker = path.join(temporary, "executed-tools.txt");
  fs.mkdirSync(bin, { mode: 0o700 });
  for (const command of ["adb", "curl", "docker", "scp", "ssh"]) {
    fs.writeFileSync(
      path.join(bin, command),
      "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$REVIVAL_EXEC_MARKER\"\nexit 97\n",
      { mode: 0o700 },
    );
  }
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  env.REVIVAL_EXEC_MARKER = marker;

  for (const track of ["local", "contributor", "production", "pin"]) {
    const selected = invoke(env, "setup", track, "--json");
    assert.equal(selected.status, 0, `${track}: ${selected.stderr}`);
    assert.doesNotThrow(() => JSON.parse(selected.stdout));
    const resumed = invoke(env, "setup", "--resume", "--json");
    assert.equal(resumed.status, 0, `${track}: ${resumed.stderr}`);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("setup state refuses unsafe roots for both selection and status reads", (t) => {
  const { temporary, env } = fixture(t);

  for (const operation of ["local", "status"]) {
    const insideSource = invoke(
      { ...env, REVIVAL_STATE_DIR: path.join(root, ".setup-state-test") },
      "setup",
      operation,
    );
    assert.equal(insideSource.status, 1);
    assert.match(insideSource.stderr, /outside the source tree/u);
  }

  const realDirectory = path.join(temporary, "real-state");
  const linkedDirectory = path.join(temporary, "linked-state");
  fs.mkdirSync(realDirectory, { mode: 0o700 });
  fs.symlinkSync(realDirectory, linkedDirectory);
  for (const operation of ["local", "status"]) {
    const linked = invoke({ ...env, REVIVAL_STATE_DIR: linkedDirectory }, "setup", operation);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /must be a real directory/u);
  }

  const looseDirectory = path.join(temporary, "loose-state");
  fs.mkdirSync(looseDirectory, { mode: 0o700 });
  fs.chmodSync(looseDirectory, 0o755);
  for (const operation of ["local", "status"]) {
    const loose = invoke({ ...env, REVIVAL_STATE_DIR: looseDirectory }, "setup", operation);
    assert.equal(loose.status, 1);
    assert.match(loose.stderr, /mode 0700/u);
  }
});

test("setup state reads are bounded and reject malformed state", (t) => {
  const { env } = fixture(t);

  const selected = invoke(env, "setup", "local");
  assert.equal(selected.status, 0, selected.stderr);
  const stateFile = path.join(env.REVIVAL_STATE_DIR, "setup-state.json");
  fs.writeFileSync(stateFile, "{}\n", { mode: 0o600 });
  const malformed = invoke(env, "setup", "status");
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /unsupported shape/u);

  fs.writeFileSync(stateFile, " ".repeat(4097), { mode: 0o600 });
  const oversized = invoke(env, "setup", "status");
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /exceeds 4096 bytes/u);
});

test("hosted imports delegate immediately to the provider-verifying artifact tool", (t) => {
  const { env, temporary } = fixture(t);
  const result = invoke(
    env,
    "setup", "import", "vps-candidate",
    "--handoff-root", path.join(temporary, "missing"),
    "--json",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hosted candidate handoff is missing/u);
  assert.equal(fs.existsSync(env.REVIVAL_STATE_DIR), false, "artifact import must not create guide state");
});
