import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "revival");
const require = createRequire(import.meta.url);
const { localProductionEnvironment, operatorEnvironment } = require("../../cli/context.js");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-command-boundary-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fakeBin = path.join(temporary, "fake-bin");
  const evidence = path.join(temporary, "evidence");
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  for (const name of ["docker", "ssh", "rsync", "git", "bash", "node", "python3"]) {
    fs.writeFileSync(
      path.join(fakeBin, name),
      `#!/bin/sh\nprintf executed >${JSON.stringify(path.join(evidence, name))}\nexit 97\n`,
      { mode: 0o700 },
    );
  }
  const external = path.join(temporary, "operator");
  const environment = {
    ...process.env,
    HOME: temporary,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    REVIVAL_CONFIG_DIR: path.join(external, "config"),
    REVIVAL_SECRETS_DIR: path.join(external, "secrets"),
    REVIVAL_ENV_FILE: path.join(external, "secrets", "runtime.env"),
    REVIVAL_PRIVATE_DIR: path.join(external, "secrets"),
    REVIVAL_DATA_DIR: path.join(external, "data"),
    REVIVAL_BUILD_DIR: path.join(external, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(external, "backups"),
    REVIVAL_STATE_DIR: path.join(external, "state"),
    REVIVAL_DEPLOY_REMOTE: "authority-test.invalid",
    DOCKER_HOST: "tcp://authority-test.invalid:2375",
    DOCKER_CONTEXT: "hostile-context",
    DOCKER_CONFIG: path.join(temporary, "docker-config"),
    GIT_CONFIG_GLOBAL: path.join(temporary, "hostile.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(temporary, "hostile.gitconfig"),
    GIT_SSH_COMMAND: path.join(fakeBin, "ssh"),
    SSH_AUTH_SOCK: path.join(temporary, "hostile-agent.sock"),
    RSYNC_RSH: path.join(fakeBin, "ssh"),
  };
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, "[credential]\n\thelper = false\n");
  return { temporary, fakeBin, evidence, environment };
}

function invoke(environment, args, { cwd = ROOT, cli = CLI, timeout = 20_000 } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
  });
}

function assertNoExternalTool(evidence) {
  assert.deepEqual(fs.readdirSync(evidence), [], "an external tool ran before command validation");
}

function isolatedSource(t, label) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `revival-launcher-${label}-`));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "source");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.cpSync(path.join(ROOT, "platform"), path.join(sourceRoot, "platform"), { recursive: true });
  fs.cpSync(path.join(ROOT, "contracts"), path.join(sourceRoot, "contracts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(sourceRoot, ".env.example"));
  const launcher = path.join(sourceRoot, "revival");
  fs.copyFileSync(CLI, launcher);
  fs.chmodSync(launcher, 0o755);
  const external = path.join(temporary, "operator");
  const environment = {
    ...process.env,
    HOME: temporary,
    REVIVAL_CONFIG_DIR: path.join(external, "config"),
    REVIVAL_SECRETS_DIR: path.join(external, "secrets"),
    REVIVAL_ENV_FILE: path.join(external, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(external, "data"),
    REVIVAL_BUILD_DIR: path.join(external, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(external, "backups"),
    REVIVAL_STATE_DIR: path.join(external, "state"),
  };
  return { temporary, sourceRoot, launcher, environment };
}

function installHostedVpsStub(selected, record, { canonical = true } = {}) {
  const tool = path.join(selected.sourceRoot, "platform", "deploy", "hosted-vps-candidate.mjs");
  const stdout = canonical
    ? `${JSON.stringify(record)}\n`
    : `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(tool, `process.stdout.write(${JSON.stringify(stdout)});\n`, { mode: 0o600 });
}

test("help and version do not load effectful command modules", (t) => {
  const selected = isolatedSource(t, "early-help");
  const marker = path.join(selected.temporary, "production-loaded");
  const production = path.join(selected.sourceRoot, "platform", "cli", "production.js");
  fs.writeFileSync(
    production,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded\\n');\n${fs.readFileSync(production, "utf8")}`,
  );

  for (const args of [["--version"], ["--help"], ["setup", "--help"]]) {
    const result = invoke(selected.environment, args, {
      cwd: selected.sourceRoot,
      cli: selected.launcher,
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(fs.existsSync(marker), false, `${args.join(" ")} loaded production commands`);
  }

  const executable = spawnSync(selected.launcher, ["--version"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(executable.status, 0, executable.stderr);
  assert.match(executable.stdout, /^Ai Pin Revival /u);
  assert.equal(fs.existsSync(marker), false);

  const dispatched = invoke(selected.environment, ["setup", "local", "--json"], {
    cwd: selected.sourceRoot,
    cli: selected.launcher,
  });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(fs.existsSync(marker), true, "the marker fixture never became reachable");
});

test("ordinary local commands run from a checkout without Git or whole-tree capture", (t) => {
  const selected = isolatedSource(t, "ordinary-checkout");
  fs.writeFileSync(path.join(selected.sourceRoot, "untracked-development-note.txt"), "work in progress\n");

  const initialized = invoke(selected.environment, ["init"], {
    cwd: selected.sourceRoot,
    cli: selected.launcher,
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const checked = invoke(selected.environment, ["config", "check", "--json"], {
    cwd: selected.sourceRoot,
    cli: selected.launcher,
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).ok, true);
  assert.equal(fs.existsSync(selected.environment.REVIVAL_STATE_DIR), false);
});

test("hosted imports return only provider-verifier output and write no guide state", (t) => {
  const selected = isolatedSource(t, "hosted-import");
  const record = {
    candidateId: "1".repeat(64),
    candidateRoot: path.join(selected.temporary, "candidate"),
    evidenceRoot: path.join(selected.temporary, "evidence"),
    ok: true,
    releaseId: "2".repeat(64),
    runnerInvocationUri: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/123/attempts/1",
    sourceDigest: "3".repeat(40),
  };
  installHostedVpsStub(selected, record);

  const imported = invoke(selected.environment, [
    "setup", "import", "vps-candidate",
    "--handoff-root", path.join(selected.temporary, "handoff"),
    "--json",
  ], { cwd: selected.sourceRoot, cli: selected.launcher });
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(JSON.parse(imported.stdout), record);
  assert.equal(fs.existsSync(selected.environment.REVIVAL_STATE_DIR), false);

  installHostedVpsStub(selected, { ...record, unexpected: true });
  const unsupported = invoke(selected.environment, [
    "setup", "import", "vps-candidate",
    "--handoff-root", path.join(selected.temporary, "handoff"),
    "--json",
  ], { cwd: selected.sourceRoot, cli: selected.launcher });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /unsupported success record/u);

  installHostedVpsStub(selected, record, { canonical: false });
  const ambiguous = invoke(selected.environment, [
    "setup", "import", "vps-candidate",
    "--handoff-root", path.join(selected.temporary, "handoff"),
    "--json",
  ], { cwd: selected.sourceRoot, cli: selected.launcher });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous non-canonical evidence/u);
});

test("production subprocess environments omit ambient executable and connection controls", (t) => {
  const { fakeBin, environment } = fixture(t);
  const previous = new Map();
  const hostile = {
    ...environment,
    BASH_ENV: "/hostile/bash-env",
    ENV: "/hostile/env",
    NODE_OPTIONS: "--require=/hostile/preload.cjs",
    NODE_PATH: "/hostile/node-path",
    PYTHONHOME: "/hostile/python-home",
    PYTHONPATH: "/hostile/python-path",
    PYTHONSTARTUP: "/hostile/python-startup",
    LD_PRELOAD: "/hostile/preload.so",
    LD_LIBRARY_PATH: "/hostile/loader",
    DYLD_INSERT_LIBRARIES: "/hostile/loader.dylib",
  };
  for (const [name, value] of Object.entries(hostile)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const ordinary = operatorEnvironment({ REVIVAL_RELEASE_ID: "local" });
  const production = localProductionEnvironment();
  for (const name of [
    "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_PARAMETERS",
    "GIT_SSH_COMMAND", "SSH_AUTH_SOCK", "RSYNC_RSH",
  ]) {
    assert.equal(ordinary[name], undefined, name);
    assert.equal(production[name], undefined, name);
  }
  assert.equal(ordinary.PATH.includes(fakeBin), false);
  assert.equal(ordinary.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(ordinary.DOCKER_CONTEXT, "default");
  assert.equal(ordinary.DOCKER_CONFIG, "/nonexistent/ai-pin-revival-docker-config");
});

test("production mutations require exact confirmation before any external tool", (t) => {
  const { temporary, evidence, environment } = fixture(t);
  const candidate = path.join(temporary, "0".repeat(64));
  const cases = [
    [["deploy", "production", "--candidate", candidate], /requires one literal --confirm/u],
    [["deploy", "production", "--candidate", candidate, "--confirm", "--confirm"], /exactly one literal --confirm/u],
    [["deploy", "production", "--candidate", candidate, "--dry-run", "--confirm"], /cannot be combined/u],
    [["backup"], /requires one literal --confirm/u],
    [["canary"], /requires one literal --confirm/u],
    [["rollback", "--deployment", "authority-test"], /requires one literal --confirm/u],
  ];
  for (const [args, refusal] of cases) {
    const result = invoke(environment, args);
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, refusal);
    assertNoExternalTool(evidence);
  }
});

test("deprecated predecessor spelling shares the canonical plan and confirmation gates", (t) => {
  const selected = isolatedSource(t, "predecessor-alias");
  const script = path.join(
    selected.sourceRoot,
    "platform", "deploy", "vps", "register-legacy-predecessor.sh",
  );
  fs.writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  const candidate = path.join(selected.temporary, "candidate");

  for (const { tail, status } of [
    { tail: ["--candidate", candidate], status: 64 },
    { tail: ["--candidate", candidate, "--dry-run"], status: 0 },
    { tail: ["--candidate", candidate, "--confirm"], status: 0 },
    { tail: ["--candidate", candidate, "--confirm", "--confirm"], status: 64 },
    { tail: ["--candidate", candidate, "--dry-run", "--confirm"], status: 64 },
  ]) {
    const canonical = invoke(selected.environment, ["deploy", "legacy-predecessor", ...tail], {
      cwd: selected.sourceRoot,
      cli: selected.launcher,
    });
    const compatibility = invoke(selected.environment, ["deploy", "carry-baseline", ...tail], {
      cwd: selected.sourceRoot,
      cli: selected.launcher,
    });
    assert.equal(canonical.status, status, canonical.stderr);
    assert.equal(compatibility.status, status, compatibility.stderr);
    assert.equal(compatibility.stdout, canonical.stdout);
    assert.equal(compatibility.stderr, canonical.stderr);
  }

  for (const target of ["carry", "legacy-baseline", "carry-baseline-extra"]) {
    const result = invoke(
      selected.environment,
      ["deploy", target, "--candidate", candidate, "--dry-run"],
      { cwd: selected.sourceRoot, cli: selected.launcher },
    );
    assert.notEqual(result.status, 0, target);
    assert.match(result.stderr, /deploy production\|legacy-predecessor/u);
    assert.doesNotMatch(result.stderr, /carry-baseline/u);
    assert.equal(result.stdout, "");
  }
});
