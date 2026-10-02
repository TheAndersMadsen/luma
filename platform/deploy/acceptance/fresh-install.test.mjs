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
const CLI = join(ROOT, "luma");

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
  const temporary = mkdtempSync(join(tmpdir(), "luma-fresh-install-"));
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
        `if [ "$*" = "compose version --short" ]; then printf '%s\\n' '2.34.0'; exit 0; fi\nexit 97\n`
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
    "LUMA_BUILD_DIR",
    "LUMA_CONFIG_DIR",
    "LUMA_DATA_DIR",
    "LUMA_ENV_FILE",
    "LUMA_SECRETS_DIR",
    "LUMA_STATE_DIR",
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

    const setup = invoke(environment, "setup", "local");
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /NEXT \.\/luma doctor/u);
    const setupProbes = existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "";
    assert.equal(setupProbes, "", "setup must not probe Docker, ADB, or the network");

    const runtime = join(xdgConfig, "luma", "secrets", "runtime.env");
    const firstRuntime = readFileSync(runtime);
    const runtimeText = firstRuntime.toString("utf8");
    assert.match(runtimeText, /^SEARXNG_SECRET=[0-9a-f]{64}$/m);
    const databasePassword = /^COSMOS_PG_PASSWORD=([0-9a-f]{64})$/m.exec(runtimeText)?.[1];
    assert.ok(databasePassword, "setup must create the database password");
    assert.match(runtimeText, /^GRAFANA_ADMIN_PASSWORD=[0-9a-f]{64}$/m);
    assert.match(
      runtimeText,
      new RegExp(`^COSMOS_DATABASE_URL=postgresql://cosmos:${databasePassword}@postgres:5432/cosmos$`, "m"),
    );
    assert.match(
      runtimeText,
      /^COSMOS_ONBOARDING_ENDPOINT=https:\/\/onboarding\.cosmos\.humane\.cloud$/m,
    );
    assert.match(runtimeText, /^COSMOS_CAPTURE_UPLOAD_BASE_URL=$/m);

    const second = invoke(environment, "setup", "local");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(runtime), firstRuntime, "setup must preserve generated secrets");

    for (const directory of [
      join(xdgConfig, "luma"),
      join(xdgConfig, "luma", "secrets"),
      join(xdgData, "luma"),
    ]) {
      assert.equal(mode(directory), 0o700, `${directory} must be owner-only`);
    }
    assert.equal(mode(runtime), 0o600);

    assert.equal(
      existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "",
      setupProbes,
      "setup must not run Docker, ADB, network, or remote tools",
    );
    assert.equal(gitStatus(), beforeSource, "fresh setup must leave no source-tree residue");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
