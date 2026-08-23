import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "revival");

function invoke(environment, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
  });
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function gitStatus() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "revival-fresh-install-"));
  const bin = join(temporary, "bin");
  const commandLog = join(temporary, "external-commands.log");
  mkdirSync(bin, { mode: 0o700 });

  for (const command of [
    "adb",
    "curl",
    "docker",
    "open",
    "rsync",
    "scp",
    "ssh",
    "wget",
    "xdg-open",
  ]) {
    const executable = join(bin, command);
    const body = command === "docker"
      ? `#!/bin/sh\nprintf '%s\\n' "docker $*" >> '${commandLog}'\n` +
        `if [ "$*" = "compose version --short" ]; then printf '%s\\n' '2.33.1'; exit 0; fi\nexit 97\n`
      : `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> '${commandLog}'\nexit 97\n`;
    writeFileSync(
      executable,
      body,
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
  }

  const xdgConfig = join(temporary, "xdg-config");
  const xdgData = join(temporary, "xdg-data");
  const xdgState = join(temporary, "xdg-state");
  const home = join(temporary, "home");
  const environment = { ...process.env };
  for (const variable of [
    "REVIVAL_BACKUP_DIR",
    "REVIVAL_BUILD_DIR",
    "REVIVAL_CONFIG_DIR",
    "REVIVAL_DATA_DIR",
    "REVIVAL_ENV_FILE",
    "REVIVAL_PRIVATE_DIR",
    "REVIVAL_SECRETS_DIR",
    "REVIVAL_STATE_DIR",
  ]) {
    delete environment[variable];
  }
  Object.assign(environment, {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  return { temporary, commandLog, environment, xdgConfig, xdgData, xdgState };
}

test("a clean isolated-XDG setup is safe, private, and idempotent", () => {
  const beforeSource = gitStatus();
  const fixtureState = fixture();
  const { temporary, commandLog, environment, xdgConfig, xdgData, xdgState } = fixtureState;

  try {
    for (const args of [
      ["--help"],
      ["setup", "--help"],
      ["setup", "local", "--help"],
      ["pin", "activate", "--help"],
    ]) {
      const help = invoke(environment, ...args);
      assert.equal(help.status, 0, `${args.join(" ")}: ${help.stderr}`);
      assert.match(help.stdout, /Usage:/);
    }
    assert.equal(existsSync(xdgConfig), false, "help must not initialize configuration");
    assert.equal(existsSync(xdgData), false, "help must not initialize data");
    assert.equal(existsSync(xdgState), false, "help must not initialize setup state");
    assert.equal(existsSync(commandLog), false, "help must not probe external tools");

    const setup = invoke(environment, "setup", "local", "--json");
    assert.equal(setup.status, 0, setup.stderr);
    const plan = JSON.parse(setup.stdout);
    assert.equal(plan.selectedTrack, "local");
    assert.equal(Object.hasOwn(plan, "next"), false);
    assert.equal(plan.steps.find((step) => step.id === "initialize").status, "required");
    assert.equal(plan.physicalAcceptanceRequired, false);
    const setupProbes = existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "";
    assert.ok(
      setupProbes === "" || setupProbes === "docker compose version --short\n",
      `setup may perform only the read-only Compose version probe; observed ${setupProbes}`,
    );

    const first = invoke(environment, "init");
    assert.equal(first.status, 0, first.stderr);
    const runtime = join(xdgConfig, "ai-pin-revival", "secrets", "runtime.env");
    const state = join(xdgState, "ai-pin-revival", "setup-state.json");
    const firstRuntime = readFileSync(runtime);
    const firstState = readFileSync(state);

    const second = invoke(environment, "init");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(runtime), firstRuntime, "init must preserve generated secrets");
    assert.deepEqual(readFileSync(state), firstState, "init must not rewrite setup selection");

    for (const directory of [
      join(xdgConfig, "ai-pin-revival"),
      join(xdgConfig, "ai-pin-revival", "secrets"),
      join(xdgData, "ai-pin-revival"),
      join(xdgState, "ai-pin-revival"),
      join(xdgState, "ai-pin-revival", "backups"),
    ]) {
      assert.equal(mode(directory), 0o700, `${directory} must be owner-only`);
    }
    assert.equal(mode(runtime), 0o600);
    assert.equal(mode(state), 0o600);

    assert.equal(
      existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "",
      setupProbes,
      "init must not run Docker, ADB, network, or remote tools",
    );
    assert.equal(gitStatus(), beforeSource, "fresh setup must leave no source-tree residue");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
