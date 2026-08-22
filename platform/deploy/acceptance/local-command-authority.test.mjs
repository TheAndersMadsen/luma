import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidateGitEnvironment } from "../release-candidate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "revival");
const require = createRequire(import.meta.url);
const {
  localProductionEnvironment,
  operatorEnvironment,
  resolveTool,
} = require("../../cli/context.js");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-local-authority-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fakeBin = path.join(temporary, "fake-bin");
  const evidence = path.join(temporary, "evidence");
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const fakeTools = [
    "bash", "node", "python3", "git", "docker", "ssh", "rsync",
    "sha256sum", "shasum", "awk", "tar", "mktemp", "chmod", "mkdir",
    "mv", "rm", "stat", "date", "find", "cat", "install", "cmp",
    "sort", "head", "od", "tr", "basename", "dirname",
  ];
  for (const name of fakeTools) {
    const marker = path.join(evidence, `tool-${name}`);
    fs.writeFileSync(
      path.join(fakeBin, name),
      `#!/bin/sh\nprintf executed >${JSON.stringify(marker)}\nexit 97\n`,
      { mode: 0o700 },
    );
  }
  const nodeMarker = path.join(evidence, "node-options");
  const nodePreload = path.join(temporary, "preload.cjs");
  fs.writeFileSync(nodePreload, `require("node:fs").writeFileSync(${JSON.stringify(nodeMarker)}, "executed")\n`);
  const shellMarker = path.join(evidence, "shell-startup");
  const shellStartup = path.join(temporary, "shell-startup.sh");
  fs.writeFileSync(shellStartup, `#!/bin/sh\nprintf executed >${JSON.stringify(shellMarker)}\n`, { mode: 0o700 });
  const functionMarker = path.join(evidence, "bash-function");
  const gitMarker = path.join(evidence, "git-config");
  const gitHelper = path.join(temporary, "git-helper.sh");
  fs.writeFileSync(gitHelper, `#!/bin/sh\nprintf executed >${JSON.stringify(gitMarker)}\nexit 97\n`, { mode: 0o700 });
  const sshMarker = path.join(evidence, "ssh-config");
  const sshHome = path.join(temporary, ".ssh");
  fs.mkdirSync(sshHome, { mode: 0o700 });
  fs.writeFileSync(path.join(sshHome, "config"), [
    "Host *",
    `  ProxyCommand /bin/sh -c 'printf executed >${sshMarker}'`,
    "  StrictHostKeyChecking no",
    "",
  ].join("\n"), { mode: 0o600 });
  const environment = {
    ...process.env,
    HOME: temporary,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_PRIVATE_DIR: path.join(temporary, "secrets"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
    REVIVAL_DEPLOY_REMOTE: "authority-test.invalid",
    BASH_ENV: shellStartup,
    ENV: shellStartup,
    NODE_OPTIONS: `--require=${nodePreload}`,
    NODE_PATH: path.join(temporary, "node-path"),
    PYTHONHOME: path.join(temporary, "python-home"),
    PYTHONPATH: path.join(temporary, "python-path"),
    PYTHONSTARTUP: shellStartup,
    DOCKER_HOST: "tcp://authority-test.invalid:2375",
    DOCKER_CONTEXT: "hostile-context",
    DOCKER_CONFIG: path.join(temporary, "docker-config"),
    GIT_CONFIG_GLOBAL: path.join(temporary, "hostile.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(temporary, "hostile.gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: gitHelper,
    GIT_CONFIG_PARAMETERS: `'credential.helper=${gitHelper}'`,
    GIT_SSH_COMMAND: gitHelper,
    SSH_AUTH_SOCK: path.join(temporary, "hostile-agent.sock"),
    RSYNC_RSH: gitHelper,
    LD_PRELOAD: "",
    LD_LIBRARY_PATH: path.join(temporary, "loader"),
    DYLD_INSERT_LIBRARIES: path.join(temporary, "loader.dylib"),
    "BASH_FUNC_exec%%": `() { /bin/sh -c 'printf executed >${functionMarker}'; builtin exec "$@"; }`,
  };
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, `[credential]\n\thelper = ${gitHelper}\n`);
  return { temporary, fakeBin, evidence, environment };
}

function invoke(environment, args, timeout = 20_000) {
  return spawnSync(CLI, args, {
    cwd: ROOT,
    env: environment,
    encoding: "utf8",
    timeout,
  });
}

function assertNoEvidence(evidence) {
  assert.deepEqual(fs.readdirSync(evidence), [], "hostile startup or executable authority ran");
}

function trackedFixtureGit(sourceRoot, args) {
  const result = spawnSync("/usr/bin/git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "submodule.recurse=false",
    ...args,
  ], {
    cwd: sourceRoot,
    env: {
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: "/nonexistent",
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}

function isolatedLauncherFixture(t, label, { gateDuringCommand = true } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `revival-launcher-${label}-`));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "source");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.cpSync(path.join(ROOT, "platform"), path.join(sourceRoot, "platform"), { recursive: true });
  fs.cpSync(path.join(ROOT, "contracts"), path.join(sourceRoot, "contracts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, ".gitignore"), path.join(sourceRoot, ".gitignore"));
  fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(sourceRoot, ".env.example"));
  const launcher = path.join(sourceRoot, "revival");
  fs.copyFileSync(CLI, launcher);
  fs.chmodSync(launcher, fs.statSync(CLI).mode & 0o777);

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
  const gate = path.join(external, "config-check-gate");
  const config = path.join(sourceRoot, "platform", "cli", "config.js");
  const originalConfig = fs.readFileSync(config, "utf8");
  const needle = "  else if (operation === 'check') {\n    const report = configCheck(args);";
  assert.equal(originalConfig.split(needle).length, 2, "config-check gate insertion point drifted");
  if (gateDuringCommand) {
    const gatedConfig = originalConfig.replace(needle, [
      "  else if (operation === 'check') {",
      `    fs.writeFileSync(${JSON.stringify(`${gate}.started`)}, 'started\\n', { mode: 0o600 });`,
      "    const waitState = new Int32Array(new SharedArrayBuffer(4));",
      "    const waitDeadline = Date.now() + 20_000;",
      `    while (!fs.existsSync(${JSON.stringify(`${gate}.release`)})) {`,
      "      if (Date.now() >= waitDeadline) throw new Error('launcher receipt race gate timed out');",
      "      Atomics.wait(waitState, 0, 0, 10);",
      "    }",
      "    const report = configCheck(args);",
    ].join("\n"));
    fs.writeFileSync(config, gatedConfig, { mode: fs.statSync(config).mode & 0o777 });
  }
  trackedFixtureGit(sourceRoot, ["init", "--quiet", "--initial-branch=fixture"]);
  trackedFixtureGit(sourceRoot, ["add", "--all", "--"]);
  return { temporary, sourceRoot, launcher, environment, gate };
}

function invokeAsync(sourceRoot, launcher, environment, args, timeout = 20_000) {
  const child = spawn(launcher, args, {
    cwd: sourceRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeout);
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

async function waitForPath(selected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(selected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${selected}`);
}

function installHostedVpsImportStub(selected, { marker } = {}) {
  const hostedTool = path.join(selected.sourceRoot, "platform", "deploy", "hosted-vps-candidate.mjs");
  const resultRecord = {
    candidateId: "1".repeat(64),
    candidateRoot: path.join(selected.temporary, "candidate"),
    evidenceRoot: path.join(selected.temporary, "evidence"),
    ok: true,
    releaseId: "2".repeat(64),
    runnerInvocationUri: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/123/attempts/1",
    sourceDigest: "3".repeat(40),
  };
  fs.writeFileSync(hostedTool, [
    ...(marker === undefined ? [] : [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(marker)}, "executed\\n", { mode: 0o600 });`,
    ]),
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(resultRecord)}\n`)})`,
    "",
  ].join("\n"), { mode: fs.statSync(hostedTool).mode & 0o777 });
  return resultRecord;
}

function mutatePinReleaseDependencyInPlace(selected, marker) {
  const dependency = path.join(selected.sourceRoot, "platform", "deploy", "pin", "release.mjs");
  const before = fs.statSync(dependency, { bigint: true });
  const source = fs.readFileSync(dependency, "utf8");
  const importNeedle = 'import { constants as fsConstants, createReadStream } from "node:fs";';
  const selfNeedle = 'const SELF_PATH = fileURLToPath(import.meta.url);';
  assert.equal(source.split(importNeedle).length, 2, "Pin release marker import point drifted");
  assert.equal(source.split(selfNeedle).length, 2, "Pin release marker execution point drifted");
  const changed = source
    .replace(
      importNeedle,
      'import { constants as fsConstants, createReadStream, writeFileSync as receiptAttackWrite } from "node:fs";',
    )
    .replace(selfNeedle, `${selfNeedle}\nreceiptAttackWrite(${JSON.stringify(marker)}, "executed\\n", { mode: 0o600 });`);
  const descriptor = fs.openSync(dependency, "r+");
  try {
    fs.writeFileSync(descriptor, changed);
    fs.ftruncateSync(descriptor, Buffer.byteLength(changed));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.statSync(dependency, { bigint: true });
  assert.equal(after.ino, before.ino, "reviewer dependency mutation exchanged its inode");
  assert.notEqual(after.ctimeNs, before.ctimeNs, "reviewer dependency mutation retained ctime");
  return dependency;
}

test("the public launcher clears hostile startup and tool authority before Node", (t) => {
  const { evidence, environment } = fixture(t);
  const result = invoke(environment, ["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Ai Pin Revival /u);
  assertNoEvidence(evidence);
});

test("every production, release, PKI, and Pin alias ignores hostile local executables", (t) => {
  const { temporary, evidence, environment } = fixture(t);
  const missingCandidate = path.join(temporary, "missing-candidate");
  const cases = [
    ["doctor", "production", "--definitely-invalid"],
    ["deploy", "production", "--candidate", missingCandidate, "--dry-run"],
    ["backup", "--definitely-invalid"],
    ["canary", "--definitely-invalid"],
    ["drift", "--definitely-invalid"],
    ["adopt-config", "--definitely-invalid"],
    ["prune-state", "--definitely-invalid"],
    ["rollback", "--deployment", "authority-test", "--definitely-invalid"],
    ["release", "build", "--help"],
    ["release", "verify", "--help"],
    ["release", "candidate", "inspect", "--candidate", missingCandidate],
    ["pki", "--help"],
    ["pin", "doctor", "--help"],
    ["pin", "release", "help"],
    ["pin", "install", "--help"],
    ["pin", "activate"],
    ["pin", "network"],
    ["pin", "build-debug", "--help"],
  ];
  for (const args of cases) {
    const result = invoke(environment, args);
    assert.equal(result.signal, null, `${args.join(" ")} was killed: ${result.stderr}`);
    assert.notEqual(result.status, null, `${args.join(" ")} timed out`);
    assertNoEvidence(evidence);
  }
});

test("public VPS shell drivers self-sanitize before parsing arguments", (t) => {
  const { evidence, environment } = fixture(t);
  for (const [label, driverEnvironment] of [
    ["ordinary hostile environment", environment],
    ["forged authority marker", { ...environment, REVIVAL_LOCAL_AUTHORITY: "v1" }],
  ]) {
    for (const name of [
      "deploy.sh", "backup.sh", "canary.sh", "drift.sh", "adopt-config.sh",
      "prune-state.sh", "rollback.sh", "preflight.sh",
    ]) {
      const result = spawnSync("/bin/bash", ["-p", path.join(ROOT, "platform/deploy/vps", name), "--definitely-invalid"], {
        cwd: ROOT,
        env: driverEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.signal, null, `${name} (${label}) was killed: ${result.stderr}`);
      assert.notEqual(result.status, null, `${name} (${label}) failed to launch: ${result.error?.message ?? "unknown error"}`);
      assertNoEvidence(evidence);
    }
  }
});

test("positive operator environments omit ambient loader, language, Docker, Git, and SSH controls", (t) => {
  const { fakeBin, environment } = fixture(t);
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const ordinary = operatorEnvironment({ NODE_OPTIONS: "hostile", REVIVAL_RELEASE_ID: "local" });
  const production = localProductionEnvironment();
  const forbidden = [
    "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND",
    "SSH_AUTH_SOCK", "RSYNC_RSH",
  ];
  for (const name of forbidden) {
    assert.equal(ordinary[name], undefined, `${name} crossed the ordinary operator boundary`);
    assert.equal(production[name], undefined, `${name} crossed the production boundary`);
  }
  assert.equal(ordinary.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(ordinary.DOCKER_CONTEXT, "default");
  assert.equal(ordinary.DOCKER_CONFIG, "/nonexistent/ai-pin-revival-docker-config");
  assert.equal(ordinary.PATH.includes(fakeBin), false);
  assert.equal(ordinary.OPENSSL, resolveTool("openssl"));
  const npm = resolveTool("npm", { required: false });
  if (npm) {
    const npmResult = spawnSync(npm, ["--version"], { env: ordinary, encoding: "utf8" });
    assert.equal(npmResult.status, 0, npmResult.stderr);
  }
  for (const name of ["REVIVAL_LOCAL_BASH", "REVIVAL_LOCAL_NODE", "REVIVAL_LOCAL_PYTHON", "REVIVAL_LOCAL_GIT", "REVIVAL_LOCAL_SSH", "REVIVAL_LOCAL_RSYNC"]) {
    assert.equal(path.isAbsolute(production[name]), true, name);
    assert.equal(production[name].startsWith(fakeBin), false, name);
  }
  assert.equal(resolveTool("node").startsWith(fakeBin), false);
});

test("candidate preparation ignores a fake PATH Git and build tool set", (t) => {
  const { temporary, fakeBin, evidence, environment } = fixture(t);
  const gitEnvironment = candidateGitEnvironment(path.join(temporary, "candidate-home"), fakeBin);
  assert.equal(gitEnvironment.PATH.includes(fakeBin), false);
  const result = invoke(environment, [
    "release", "candidate", "prepare", "--commit", "HEAD",
    "--data-dir", path.join(temporary, "candidate-data"), "--json",
  ], 30_000);
  assert.notEqual(result.status, null, result.stderr);
  assert.notEqual(result.status, 0, "the current Cosmos-renamed HEAD must remain nonpromotable");
  assert.match(result.stderr, /Carry contract|production authority|candidate source|native linux\/amd64/u);
  assertNoEvidence(evidence);
});

test("VPS SSH and rsync authority is explicit and cannot read user configuration", () => {
  const local = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/lib/local.sh"), "utf8");
  for (const contract of [
    "-F /dev/null",
    "GlobalKnownHostsFile=/dev/null",
    "UserKnownHostsFile=$REVIVAL_SSH_KNOWN_HOSTS_FILE",
    "StrictHostKeyChecking=yes",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "IdentityFile=$REVIVAL_SSH_IDENTITY_FILE",
  ]) assert.equal(local.includes(contract), true, contract);
  assert.match(local, /run_local_rsync --rsh "\$remote_shell"/u);
  assert.doesNotMatch(local, /(?:^|\s)ssh\s+\\/mu);
});

test("the launcher records only command-owned structured completion, never generic zero exit", () => {
  const launcher = fs.readFileSync(CLI, "utf8");
  const bootstrapCapture = launcher.indexOf("bootstrapInvocation = captureBootstrapInvocation(rawArgs)");
  const firstRepositoryRequire = launcher.indexOf("require('./platform/");
  assert.notEqual(bootstrapCapture, -1);
  assert.notEqual(firstRepositoryRequire, -1);
  assert.equal(bootstrapCapture < firstRepositoryRequire, true, "a repository module loads before bootstrap capture");
  const preRepositorySource = launcher.slice(launcher.indexOf("'use strict';"), firstRepositoryRequire);
  for (const match of preRepositorySource.matchAll(/require\(([^)]+)\)/gu)) {
    assert.match(match[1], /^'node:/u, `non-built-in bootstrap dependency: ${match[1]}`);
  }
  assert.match(
    launcher,
    /const loadedSetupInvocation = captureSetupInvocation\(rawArgs, \{\s*trackedSourceCapture: bootstrapInvocation\.trackedSource,\s*\}\);[\s\S]*?bootstrapInvocation\.invocationBinding/u,
  );
  assert.match(
    launcher,
    /sourceUnchanged && setupInvocationBinding !== null[\s\S]*?recordSetupInvocationSuccess\(rawArgs, completion, receiptOptions\)/u,
  );
  assert.match(launcher, /Receipt progress is operator convenience, never deployment or publication\s*\/\/ authority/u);
  assert.match(launcher, /BOOTSTRAP_TRACKED_GIT_EXECUTABLE = '\/usr\/bin\/git'/u);
  assert.match(launcher, /'ls-files', '--cached', '--stage', '--full-name', '-z', '--'/u);
  assert.match(launcher, /'ls-files', '--others', '-z', '--'/u);
  assert.match(launcher, /allowedWorkspaceInstructions: Object\.freeze\(\['AGENTS\.md', 'CLAUDE\.md'\]\)/u);
  assert.match(launcher, /enumeration: 'git-ls-files-others-unfiltered'/u);
  assert.match(launcher, /usesRepositoryGitignore: false/u);
  assert.match(launcher, /usesGitInfoExclude: false/u);
  assert.doesNotMatch(launcher, /--exclude-standard|--exclude-per-directory/u);
  assert.match(launcher, /'-c', 'core\.hooksPath=\/dev\/null'/u);
  assert.match(launcher, /'-c', 'core\.fsmonitor=false'/u);
  assert.match(launcher, /'-c', 'submodule\.recurse=false'/u);
  assert.match(launcher, /GIT_CONFIG_NOSYSTEM: '1'/u);
  assert.match(launcher, /GIT_CONFIG_GLOBAL: '\/dev\/null'/u);
  const trackedGitEnvironment = /function bootstrapTrackedGitEnvironment\(\) \{([\s\S]*?)\n\}/u.exec(launcher)?.[1];
  assert.ok(trackedGitEnvironment);
  assert.doesNotMatch(trackedGitEnvironment, /process\.env|\.\.\./u);
  assert.match(launcher, /bootstrapCaptureTrackedSource\(\)/u);
  assert.match(launcher, /postTrackedSourceCapture: postBootstrapInvocation\.trackedSource/u);
  assert.match(launcher, /setupCommand\(args, \{ invocationBinding: setupInvocationBinding \}\)/u);
  assert.doesNotMatch(launcher, /bootstrapImplementationFiles|bootstrapImplementationTree|implementationFiles|perGroup/u);
  assert.doesNotMatch(launcher, /recordSetupActionSuccess|commandIdForInvocation|successful-authoritative-exit/u);
  assert.doesNotMatch(launcher, /process\.exitCode[^\n]*recordSetup/u);

  const setup = fs.readFileSync(path.join(ROOT, "platform/cli/setup.js"), "utf8");
  assert.doesNotMatch(setup, /captureSetupInvocation|recordSetupInvocationSuccess/u);
  assert.match(setup, /completion: artifactCompletion\('setup\.import\.vps-candidate'/u);
  assert.match(setup, /completion: artifactCompletion\('setup\.import\.pin-release'/u);
  assert.match(setup, /validateSetupInvocationBinding\(invocationBinding, \{ actionId: 'setup\.import\.vps-candidate' \}\)/u);
  assert.match(setup, /validateSetupInvocationBinding\(invocationBinding, \{ actionId: 'setup\.import\.pin-release' \}\)/u);

  const production = fs.readFileSync(path.join(ROOT, "platform/cli/production.js"), "utf8");
  assert.match(production, /authoritativeCompletion\('deploy\.production', 'production-deployment-applied'/u);
  assert.match(production, /authoritativeCompletion\('backup', 'production-backup-created'/u);
  assert.match(production, /authoritativeCompletion\('canary', 'production-canary-passed'/u);
  assert.match(production, /--dry-run cannot be combined with --confirm/u);
  assert.match(production, /changes production and requires one literal --confirm/u);
  for (const name of ["deploy.sh", "backup.sh", "canary.sh", "rollback.sh"]) {
    const source = fs.readFileSync(path.join(ROOT, "platform/deploy/vps", name), "utf8");
    assert.match(source, /--confirm/u, `${name} has no direct-invocation confirmation gate`);
  }
});

test("the real launcher withholds a receipt when old implementation bytes were loaded before pathname replacement", async (t) => {
  const selected = isolatedLauncherFixture(t, "loaded-old-before-capture", { gateDuringCommand: false });
  const initialized = spawnSync(selected.launcher, ["init"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const config = path.join(selected.sourceRoot, "platform", "cli", "config.js");
  const original = fs.readFileSync(config, "utf8");
  const importNeedle = "const { operatorContract } = require('./command-spec');\n";
  assert.equal(original.split(importNeedle).length, 2, "config import gate insertion point drifted");
  const oldMarker = `${selected.gate}.old-implementation`;
  const oldCheckNeedle = "  else if (operation === 'check') {\n    const report = configCheck(args);";
  assert.equal(original.split(oldCheckNeedle).length, 2, "old config execution marker insertion point drifted");
  const gatedOld = original
    .replace(importNeedle, [
      importNeedle.trimEnd(),
      `fs.writeFileSync(${JSON.stringify(`${selected.gate}.loaded`)}, 'loaded\\n', { mode: 0o600 });`,
      "const loadWaitState = new Int32Array(new SharedArrayBuffer(4));",
      "const loadWaitDeadline = Date.now() + 20_000;",
      `while (!fs.existsSync(${JSON.stringify(`${selected.gate}.load-release`)})) {`,
      "  if (Date.now() >= loadWaitDeadline) throw new Error('loaded-old launcher gate timed out');",
      "  Atomics.wait(loadWaitState, 0, 0, 10);",
      "}",
      "",
    ].join("\n"))
    .replace(oldCheckNeedle, [
      "  else if (operation === 'check') {",
      `    fs.writeFileSync(${JSON.stringify(oldMarker)}, 'old bytes executed\\n', { mode: 0o600 });`,
      "    const report = configCheck(args);",
    ].join("\n"));
  fs.writeFileSync(config, gatedOld, { mode: fs.statSync(config).mode & 0o777 });

  const replacementNeedle = "  else if (operation === 'check') {\n    const report = configCheck(args);";
  const replacement = original.replace(replacementNeedle, [
    "  else if (operation === 'check') {",
    "    throw new Error('replacement config implementation must not execute');",
  ].join("\n"));
  assert.notEqual(replacement, original);

  const running = invokeAsync(
    selected.sourceRoot,
    selected.launcher,
    selected.environment,
    ["config", "check", "--json"],
  );
  try {
    await waitForPath(`${selected.gate}.loaded`);
    const replacementPath = `${config}.replacement`;
    fs.writeFileSync(replacementPath, replacement, { mode: fs.statSync(config).mode & 0o777 });
    fs.renameSync(replacementPath, config);
  } finally {
    fs.writeFileSync(`${selected.gate}.load-release`, "release\n", { mode: 0o600 });
  }

  const result = await running;
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
  assert.equal(fs.existsSync(oldMarker), true, "old loaded config implementation did not execute");
  const receipt = path.join(selected.environment.REVIVAL_STATE_DIR, "setup-receipts", "config.check.json");
  assert.equal(fs.existsSync(receipt), false, "loaded old implementation produced a replacement-bound receipt");
});

test("hosted imports return verified evidence to the root launcher for the only receipt write", (t) => {
  const selected = isolatedLauncherFixture(t, "root-owned-import-receipt", { gateDuringCommand: false });
  const resultRecord = installHostedVpsImportStub(selected);

  const result = spawnSync(selected.launcher, [
    "setup", "import", "vps-candidate",
    "--handoff-root", path.join(selected.temporary, "handoff"),
    "--json",
  ], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), resultRecord);
  const receiptPath = path.join(
    selected.environment.REVIVAL_STATE_DIR,
    "setup-receipts",
    "setup.import.vps-candidate.json",
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 5);
  assert.equal(receipt.actionId, "setup.import.vps-candidate");
  assert.equal(receipt.evidenceKind, "hosted-vps-provider-verified-import");
  assert.match(receipt.untrackedPolicySha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.untrackedEnumerationSha256, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.evidenceSha256.length, 64);
});

test("an unexpected untracked source aborts before dispatch and becomes bound only after staging", (t) => {
  const selected = isolatedLauncherFixture(t, "untracked-staged-transition", { gateDuringCommand: false });
  const initialized = spawnSync(selected.launcher, ["init"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const emptyDirectory = path.join(selected.sourceRoot, "platform", "empty-untracked-runtime");
  fs.mkdirSync(emptyDirectory, { mode: 0o700 });
  const emptyUntracked = spawnSync(selected.launcher, ["config", "check", "--json"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(emptyUntracked.status, 1, emptyUntracked.stderr);
  assert.match(
    emptyUntracked.stderr,
    /unexpected untracked directory refuses launcher receipt capture: platform\/empty-untracked-runtime/u,
  );
  fs.rmdirSync(emptyDirectory);

  const relative = "platform/staged-new-source.mjs";
  fs.writeFileSync(path.join(selected.sourceRoot, relative), "export const stagedSource = true;\n", { mode: 0o600 });
  const untracked = spawnSync(selected.launcher, ["config", "check", "--json"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(untracked.status, 1, untracked.stderr);
  assert.match(untracked.stderr, /unexpected untracked source refuses launcher receipt capture: platform\/staged-new-source\.mjs/u);
  const receipt = path.join(selected.environment.REVIVAL_STATE_DIR, "setup-receipts", "config.check.json");
  assert.equal(fs.existsSync(receipt), false, "untracked source reached command dispatch or receipt write");

  trackedFixtureGit(selected.sourceRoot, ["add", "--", relative]);
  const capture = spawnSync(process.execPath, ["-e", [
    `const state = require(${JSON.stringify(path.join(selected.sourceRoot, "platform", "cli", "setup-state.js"))});`,
    `const selected = state.captureTrackedSource().membership.some((entry) => entry.path === ${JSON.stringify(relative)});`,
    "process.stdout.write(JSON.stringify({ selected }));",
  ].join("\n")], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(capture.status, 0, capture.stderr);
  assert.deepEqual(JSON.parse(capture.stdout), { selected: true });

  const staged = spawnSync(selected.launcher, ["config", "check", "--json"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(JSON.parse(staged.stdout).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).actionId, "config.check");
});

test("ignore files cannot conceal an untracked executed dependency from pre-module capture", (t) => {
  for (const concealment of ["git-info-exclude", "tracked-gitignore"]) {
    const selected = isolatedLauncherFixture(t, concealment, { gateDuringCommand: false });
    const relative = "platform/deploy/pin/release.mjs";
    trackedFixtureGit(selected.sourceRoot, ["rm", "--cached", "--", relative]);
    if (concealment === "git-info-exclude") {
      fs.appendFileSync(path.join(selected.sourceRoot, ".git", "info", "exclude"), `\n/${relative}\n`);
    } else {
      fs.appendFileSync(path.join(selected.sourceRoot, ".gitignore"), `\n/${relative}\n`);
    }
    const conventionallyVisible = trackedFixtureGit(selected.sourceRoot, [
      "ls-files", "--others", "--exclude-standard", "-z", "--",
    ]).stdout.split("\0").filter(Boolean);
    assert.equal(
      conventionallyVisible.includes(relative),
      false,
      `${concealment} did not conventionally hide the reviewer dependency`,
    );

    const authorityMarker = path.join(selected.temporary, `${concealment}-authority-loaded`);
    const authority = path.join(selected.sourceRoot, "platform", "cli", "authority.js");
    const authoritySource = fs.readFileSync(authority, "utf8");
    const authorityNeedle = "'use strict';\n";
    assert.equal(authoritySource.split(authorityNeedle).length, 2, "authority import marker point drifted");
    fs.writeFileSync(authority, authoritySource.replace(
      authorityNeedle,
      `${authorityNeedle}require('node:fs').writeFileSync(${JSON.stringify(authorityMarker)}, 'executed\\n', { mode: 0o600 });\n`,
    ));

    const dependencyMarker = path.join(selected.temporary, `${concealment}-pin-release-executed`);
    mutatePinReleaseDependencyInPlace(selected, dependencyMarker);
    const result = spawnSync(selected.launcher, [
      "setup", "import", "pin-release",
      "--release-root", path.join(selected.temporary, "missing-release"),
      "--json",
    ], {
      cwd: selected.sourceRoot,
      env: selected.environment,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 1, `${concealment}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /unexpected untracked source refuses launcher receipt capture: platform\/deploy\/pin\/release\.mjs/u,
      concealment,
    );
    assert.equal(fs.existsSync(authorityMarker), false, `${concealment} loaded the first repository module`);
    assert.equal(fs.existsSync(dependencyMarker), false, `${concealment} executed the hidden dependency`);
    const receipt = path.join(
      selected.environment.REVIVAL_STATE_DIR,
      "setup-receipts",
      "setup.import.pin-release.json",
    );
    assert.equal(fs.existsSync(receipt), false, `${concealment} produced a receipt`);
  }
});

test("failed and confirmation-missing real launcher actions never create receipts", (t) => {
  const selected = isolatedLauncherFixture(t, "failed-and-unconfirmed", { gateDuringCommand: false });
  const failed = spawnSync(selected.launcher, ["config", "check", "--json"], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).ok, false);

  const unconfirmed = spawnSync(selected.launcher, [
    "deploy", "production", "--candidate-id", "1".repeat(64),
  ], {
    cwd: selected.sourceRoot,
    env: selected.environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(unconfirmed.status, 64, unconfirmed.stderr);
  assert.match(unconfirmed.stderr, /requires one literal --confirm/u);
  const receiptRoot = path.join(selected.environment.REVIVAL_STATE_DIR, "setup-receipts");
  assert.equal(fs.existsSync(receiptRoot), false, "failed or unconfirmed action created receipt state");
});

test("the real launcher refuses receipts after concurrent implementation mutation", async (t) => {
  for (const attack of [
    "control",
    "same-inode-same-size",
    "inode-exchange",
    "release-source",
    "environment-example",
    "trusted-root",
    "same-byte-restore",
    "new-tracked-membership",
    "untracked-appears",
    "untracked-appears-disappears",
    "untracked-tree-appears-disappears",
    "index-exchange",
    "gitdir-ephemeral-index-lock",
  ]) {
    await t.test(attack, async (t) => {
      const fixture = isolatedLauncherFixture(t, attack);
      const initialized = spawnSync(fixture.launcher, ["init"], {
        cwd: fixture.sourceRoot,
        env: fixture.environment,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(initialized.status, 0, initialized.stderr);

      const running = invokeAsync(
        fixture.sourceRoot,
        fixture.launcher,
        fixture.environment,
        ["config", "check", "--json"],
      );
      try {
        await waitForPath(`${fixture.gate}.started`);
        const original = fs.readFileSync(fixture.launcher);
        const before = fs.statSync(fixture.launcher);
        if (attack === "same-inode-same-size") {
          const source = original.toString("utf8");
          const changed = source.replace("stable operator", "steble operator");
          assert.notEqual(changed, source);
          assert.equal(Buffer.byteLength(changed), original.length);
          const descriptor = fs.openSync(fixture.launcher, "r+");
          try {
            fs.writeSync(descriptor, Buffer.from(changed), 0, original.length, 0);
            fs.ftruncateSync(descriptor, original.length);
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
          const after = fs.statSync(fixture.launcher);
          assert.equal(after.ino, before.ino, "same-inode attack replaced rather than rewrote the launcher");
          assert.equal(after.size, before.size);
        } else if (attack === "inode-exchange") {
          const replacement = `${fixture.launcher}.replacement`;
          fs.writeFileSync(replacement, original, { mode: before.mode & 0o777 });
          fs.renameSync(replacement, fixture.launcher);
          const after = fs.statSync(fixture.launcher);
          assert.notEqual(after.ino, before.ino, "inode-exchange attack retained the launcher inode");
          assert.deepEqual(fs.readFileSync(fixture.launcher), original);
        } else if (["release-source", "environment-example", "trusted-root"].includes(attack)) {
          const relative = {
            "release-source": "platform/deploy/release.mjs",
            "environment-example": ".env.example",
            "trusted-root": "platform/deploy/pin/github-private-trusted-root.jsonl",
          }[attack];
          const selected = path.join(fixture.sourceRoot, relative);
          assert.equal(fs.existsSync(selected), true, `${relative} is absent from the tracked fixture`);
          fs.appendFileSync(selected, `\n# ${attack} concurrent mutation\n`);
        } else if (attack === "same-byte-restore") {
          const selected = path.join(fixture.sourceRoot, "platform/deploy/release.mjs");
          const selectedBytes = fs.readFileSync(selected);
          const selectedBefore = fs.statSync(selected, { bigint: true });
          fs.writeFileSync(selected, Buffer.concat([selectedBytes, Buffer.from("\n# transient\n")]));
          fs.writeFileSync(selected, selectedBytes);
          const selectedAfter = fs.statSync(selected, { bigint: true });
          assert.deepEqual(fs.readFileSync(selected), selectedBytes);
          assert.notEqual(selectedAfter.ctimeNs, selectedBefore.ctimeNs, "same-byte restore retained ctime");
        } else if (attack === "new-tracked-membership") {
          const added = path.join(fixture.sourceRoot, "platform", "tracked-during-command.txt");
          fs.writeFileSync(added, "new tracked source\n", { mode: 0o600 });
          trackedFixtureGit(fixture.sourceRoot, ["add", "--", "platform/tracked-during-command.txt"]);
        } else if (attack === "untracked-appears") {
          const added = path.join(fixture.sourceRoot, "platform", "untracked-during-command.txt");
          fs.writeFileSync(added, "unexpected untracked source\n", { mode: 0o600 });
        } else if (attack === "untracked-appears-disappears") {
          const transient = path.join(fixture.sourceRoot, "platform", "transient-untracked-source.txt");
          fs.writeFileSync(transient, "transient untracked source\n", { mode: 0o600 });
          fs.unlinkSync(transient);
        } else if (attack === "untracked-tree-appears-disappears") {
          const transientDirectory = path.join(fixture.sourceRoot, "platform", "transient-untracked-tree");
          fs.mkdirSync(transientDirectory, { mode: 0o700 });
          fs.writeFileSync(path.join(transientDirectory, "runtime.mjs"), "export default true;\n", { mode: 0o600 });
          fs.rmSync(transientDirectory, { recursive: true, force: true });
        } else if (attack === "index-exchange") {
          const index = path.join(fixture.sourceRoot, ".git", "index");
          const indexBefore = fs.statSync(index);
          const replacement = `${index}.replacement`;
          fs.copyFileSync(index, replacement);
          fs.chmodSync(replacement, indexBefore.mode & 0o777);
          fs.renameSync(replacement, index);
          const indexAfter = fs.statSync(index);
          assert.notEqual(indexAfter.ino, indexBefore.ino, "index exchange retained its inode");
        } else if (attack === "gitdir-ephemeral-index-lock") {
          const ephemeral = path.join(fixture.sourceRoot, ".git", "index.lock");
          fs.writeFileSync(ephemeral, "transient\n", { mode: 0o600 });
          fs.unlinkSync(ephemeral);
        }
      } finally {
        fs.writeFileSync(`${fixture.gate}.release`, "release\n", { mode: 0o600 });
      }

      const result = await running;
      assert.equal(result.timedOut, false, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
      const receipt = path.join(fixture.environment.REVIVAL_STATE_DIR, "setup-receipts", "config.check.json");
      if (["control", "gitdir-ephemeral-index-lock"].includes(attack)) {
        assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).actionId, "config.check");
      } else {
        assert.equal(fs.existsSync(receipt), false, `${attack} created a setup receipt`);
      }
    });
  }
});

test("production mutations refuse missing, duplicate, and dry-run confirmation before external tools", (t) => {
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
    assert.equal(result.status, 64, `${args.join(" ")} did not fail as usage`);
    assert.match(result.stderr, refusal);
    assertNoEvidence(evidence);
  }
});
