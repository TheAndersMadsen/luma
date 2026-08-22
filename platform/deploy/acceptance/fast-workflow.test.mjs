import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const {
  changedCheckComponents,
  changedPolicyScripts,
  changedPaths,
  checksForPath,
  cloneCachedDirectory,
  CACHE_MARKER,
  acquireFastCheckLease,
  assertNoForbiddenRealTreeRoots,
  completeCache,
  dependencyFingerprint,
  focusedRustTestArguments,
  isolatedSnapshotGitEnvironment,
  listedRustTests,
  normalizedNpmInstallEnvironment,
  parseChangedArguments,
  pruneFastCheckState,
  runSelectedComponents,
  snapshotRepository,
} = require("../../cli/checks.js");
const {
  BUILD_DIR,
  DATA_DIR,
  cosmosTestEnvironment,
  operatorEnvironment,
  realPostgresTestEnvironment,
  resolveTrustedRustupHome,
  secureDirectory,
  testProcessEnvironment,
  trustedRustupDirectoryRole,
  validateDisposablePostgresTestUrl,
} = require("../../cli/context.js");
const {
  diagnosePinAmd64Runtime,
  parseQemuX86VersionBanner,
  probePinAmd64Runtime,
  sameVersion,
} = require("../../cli/toolchain.js");
const {
  PIN_BROKER_BOOTSTRAP,
  RELEASE_RSA_COMPATIBILITY_TEST,
  assertExactlyOneListedRustTest,
  executePinLaneSession,
  pinContributorCheck,
  pinLaneSessionArguments,
  policyTestArguments,
  policyTestConcurrency,
  policyTestPlan,
  runCenterUiTests,
  resolveTrustedPinExecutable,
} = require("../../cli/gates.js");
const { composeArgs } = require("../../cli/stack.js");
const { formatDuration, timedStage } = require("../../cli/timing.js");
const {
  ROOTED_SOURCE_HELPER_SHA256,
  readStableRootedEntries,
  resolveTrustedPython3,
} = require("../../cli/rooted-source.js");

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runGitWithEnvironment(cwd, environment, ...args) {
  const result = spawnSync("git", args, { cwd, env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function externalEnvironment(temporary) {
  return {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "config", "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "config", "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
  };
}

function spawnNode(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, ...args], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function composeServiceBlock(source, serviceName) {
  const services = source.indexOf("services:\n");
  assert.notEqual(services, -1, "Compose source must define services");
  const marker = `  ${serviceName}:\n`;
  const start = source.indexOf(marker, services);
  assert.notEqual(start, -1, `Compose source must define ${serviceName}`);
  const bodyStart = start + marker.length;
  const nextService = /^  [A-Za-z0-9_-]+:\s*$/mu.exec(source.slice(bodyStart));
  const end = nextService ? bodyStart + nextService.index : source.length;
  return source.slice(start, end);
}

test("the operational Rust toolchain match is exact", () => {
  assert.equal(sameVersion([1, 91, 1], [1, 91, 1]), true);
  assert.equal(sameVersion([1, 91, 0], [1, 91, 1]), false);
  assert.equal(sameVersion([1, 97, 1], [1, 91, 1]), false);
});

test("Cosmos test subprocesses cannot inherit production state routing", () => {
  const sanitized = cosmosTestEnvironment({
    PATH: "/fixture/bin",
    COSMOS_STATE_DIR: "/mounted/production-state",
    COSMOS_WORKLOAD: "ai-bus",
    COSMOS_DATABASE_URL: "postgresql://production.invalid/cosmos",
    DATABASE_URL: "postgresql://production.invalid/default",
    COSMOS_PRINCIPAL: "production-principal",
    COSMOS_TEST_DATABASE_URL: "postgresql://test:test@postgres.test/cosmos_test",
  });
  assert.equal(sanitized.PATH, "/fixture/bin");
  assert.equal("COSMOS_STATE_DIR" in sanitized, false);
  assert.equal("COSMOS_WORKLOAD" in sanitized, false);
  assert.equal("COSMOS_DATABASE_URL" in sanitized, false);
  assert.equal("DATABASE_URL" in sanitized, false);
  assert.equal("COSMOS_PRINCIPAL" in sanitized, false);
  assert.equal("COSMOS_TEST_DATABASE_URL" in sanitized, false);
  assert.equal("COSMOS_TEST_DATABASE_URL" in operatorEnvironment({
    COSMOS_TEST_DATABASE_URL: "postgresql://production.invalid/cosmos",
  }), false);

  const disposable = "postgresql://workflow_test:fixture-only@127.0.0.1:55432/workflow_test";
  assert.equal(validateDisposablePostgresTestUrl(disposable), disposable);
  assert.equal(
    realPostgresTestEnvironment({
      PATH: "/fixture/bin",
      COSMOS_TEST_DATABASE_URL: "postgresql://production.invalid/cosmos",
    }, disposable).COSMOS_TEST_DATABASE_URL,
    disposable,
  );
  for (const refused of [
    "postgresql://workflow_test:fixture-only@localhost:55432/workflow_test",
    "postgresql://workflow_test:fixture-only@192.0.2.1:55432/workflow_test",
    "postgresql://workflow_test:fixture-only@2130706433:55432/workflow_test",
    "postgresql://workflow_test:fixture-only@0177.0.0.1:55432/workflow_test",
    "postgresql://workflow:fixture-only@127.0.0.1:55432/workflow_test",
    "postgresql://workflow_test:fixture-only@127.0.0.1:55432/production",
    "postgresql://workflow_test:fixture-only@127.0.0.1/workflow_test",
    "postgresql://workflow_test:fixture-only@127.0.0.1:55432/workflow_test?sslmode=disable",
  ]) {
    assert.throws(() => validateDisposablePostgresTestUrl(refused), /restricted to/u, refused);
  }
});

test("the fixed Cosmos Cargo target rejects a symlink substitution", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-cosmos-target-link-"));
  const contextModule = path.join(root, "platform/cli/context.js");
  try {
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const context = require(process.argv[1]);",
      "const first = context.cosmosTestEnvironment({ PATH: process.env.PATH });",
      "const target = first.CARGO_TARGET_DIR;",
      "fs.rmdirSync(target);",
      "fs.symlinkSync(path.dirname(target), target);",
      "try { context.cosmosTestEnvironment({ PATH: process.env.PATH }); process.exitCode = 91; }",
      "catch (error) { process.stdout.write(error.message); }",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script, contextModule], {
      cwd: root,
      env: externalEnvironment(temporary),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Cosmos test Cargo target must be an owner-owned real directory/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("kid scoping is explicit on ai-bus and production cannot render without a protected mode", () => {
  const composePaths = {
    root: "compose.yaml",
    development: "platform/compose/development.yaml",
    production: "platform/compose/production.yaml",
  };
  const sources = Object.fromEntries(Object.entries(composePaths).map(([name, relativePath]) => [
    name,
    fs.readFileSync(path.join(root, relativePath), "utf8"),
  ]));
  for (const [name, source] of Object.entries(sources)) {
    assert.equal(
      [...source.matchAll(/^\s+COSMOS_KID_SCOPE:/gmu)].length,
      1,
      `${name} must place kid scope on exactly one workload`,
    );
    assert.match(composeServiceBlock(source, "ai-bus"), /COSMOS_KID_SCOPE:/u);
  }
  assert.match(
    composeServiceBlock(sources.root, "ai-bus"),
    /^      COSMOS_KID_SCOPE: \$\{COSMOS_KID_SCOPE:-audit\}$/mu,
  );
  assert.match(
    composeServiceBlock(sources.development, "ai-bus"),
    /^      COSMOS_KID_SCOPE: \$\{COSMOS_KID_SCOPE:-audit\}$/mu,
  );
  assert.match(
    composeServiceBlock(sources.production, "ai-bus"),
    /^      COSMOS_KID_SCOPE: \$\{COSMOS_KID_SCOPE:\?set COSMOS_KID_SCOPE to audit or enforce in the protected production env\}$/mu,
  );

  const environment = testProcessEnvironment();
  for (const match of sources.production.matchAll(/\$\{([A-Z0-9_]+):\?/gu)) {
    environment[match[1]] = "fixture";
  }
  Object.assign(environment, {
    REVIVAL_RELEASE_ID: "0".repeat(64),
    COSMOS_DATABASE_URL: "postgresql://fixture:fixture@postgres/cosmos",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://upload.invalid",
    COSMOS_ONBOARDING_ENDPOINT: "https://onboarding.invalid",
    COSMOS_OPAQUE_SEED: Buffer.alloc(32, 1).toString("base64"),
    COSMOS_ENROLLMENT_PINCODE: "1234",
    REVIVAL_PIN_BRIDGE_DEVICE_ID: "fixture-device",
    REVIVAL_PIN_BRIDGE_OWNER_SUB: "fixture-owner",
  });
  delete environment.COSMOS_KID_SCOPE;
  const arguments_ = [
    "compose",
    "-f",
    "compose.yaml",
    "-f",
    "platform/compose/production.yaml",
    "config",
    "--quiet",
  ];
  const missing = spawnSync("docker", arguments_, { cwd: root, env: environment, encoding: "utf8" });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(
    missing.stderr,
    /services\.ai-bus\.environment\.COSMOS_KID_SCOPE: required variable COSMOS_KID_SCOPE is missing a value/u,
  );
  for (const scope of ["audit", "enforce"]) {
    const rendered = spawnSync("docker", arguments_, {
      cwd: root,
      env: { ...environment, COSMOS_KID_SCOPE: scope },
      encoding: "utf8",
    });
    assert.equal(rendered.status, 0, rendered.stderr);
  }

  const privacy = fs.readFileSync(
    path.join(root, "cosmos/crates/cosmos/src/services/public_privacy.rs"),
    "utf8",
  );
  const runtime = fs.readFileSync(path.join(root, "cosmos/crates/cosmos/src/lib.rs"), "utf8");
  assert.match(
    privacy,
    /fn parse_kid_scope\(raw: Option<&str>\) -> Result<KidScope, KidScopeConfigurationError>[\s\S]*?Some\("audit"\) => Ok\(KidScope::Audit\),[\s\S]*?Some\("enforce"\) => Ok\(KidScope::Enforce\),[\s\S]*?_ => Err\(KidScopeConfigurationError\),/u,
  );
  const kidScopeValidation = runtime.indexOf(
    "startup_kid_scope(config.identity.workload(), config.kid_scope.as_deref())?",
  );
  const firstListenerBind = runtime.indexOf(
    "let grpc_listener = tokio::net::TcpListener::bind(config.grpc_bind).await?",
  );
  assert.notEqual(kidScopeValidation, -1, "ai-bus startup must validate kid scope");
  assert.notEqual(firstListenerBind, -1, "server startup must bind its listener");
  assert.ok(
    kidScopeValidation < firstListenerBind,
    "invalid kid scope must fail before either listener binds",
  );
  assert.match(
    runtime,
    /fn ai_bus_startup_rejects_missing_or_invalid_kid_scope_before_binding\(\)[\s\S]*?Some\("Audit"\)[\s\S]*?Some\("enforce "\)[\s\S]*?Some\("warn"\)[\s\S]*?Err\(ServerError::KidScopeConfiguration\(_\)\)/u,
  );
});

test("all source-test subprocesses drop credentials and Node/npm injection", () => {
  const poisoned = {
    PATH: "/fixture/bin",
    REVIVAL_BUILD_DIR: "/fixture/build",
    REVIVAL_RELEASE_ID: "production-release",
    AUTH_SESSION_SECRET: "poison-secret",
    GITHUB_TOKEN: "poison-token",
    AWS_SECRET_ACCESS_KEY: "poison-aws",
    AZURE_STORAGE_ACCOUNT_KEY: "poison-azure",
    SSH_AUTH_SOCK: "/production/agent.sock",
    NODE_OPTIONS: "--require=/production/preload.cjs",
    NODE_PATH: "/production/node_modules",
    NODE_ENV: "production",
    NPM_CONFIG_USERCONFIG: "/production/.npmrc",
    npm_config_registry: "https://credential.invalid/",
    npm_lifecycle_script: "curl credential.invalid",
    INIT_CWD: "/production/source",
    COSMOS_TEST_DATABASE_URL: "postgresql://production.invalid/cosmos",
    RUSTC: "/production/rustc",
    RUSTC_WRAPPER: "/production/wrapper",
    RUSTC_WORKSPACE_WRAPPER: "/production/workspace-wrapper",
    RUSTUP_DIST_SERVER: "https://credential.invalid/rustup",
    RUSTUP_UPDATE_ROOT: "https://credential.invalid/rustup-update",
    RUSTUP_TOOLCHAIN: "production-injection",
    RUSTFLAGS: "--cfg production_injection",
    CARGO_ENCODED_RUSTFLAGS: "--cfg\u001fproduction_injection",
    CARGO_HOME: "/production/cargo",
    CARGO_TARGET_DIR: "/production/target",
    CARGO_BUILD_RUSTC_WRAPPER: "/production/wrapper",
    LD_PRELOAD: "/production/loader.so",
    LD_LIBRARY_PATH: "/production/lib",
    DYLD_INSERT_LIBRARIES: "/production/loader.dylib",
    CC: "/production/cc",
    CXX: "/production/cxx",
    CPPFLAGS: "-include /production/inject.h",
    CFLAGS: "-include /production/inject.h",
    LDFLAGS: "-L/production/lib",
    BASH_ENV: "/production/bash-env",
    ENV: "/production/shell-env",
    SHELL: "/production/shell",
    ZDOTDIR: "/production/zsh",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "/production/helper",
    GIT_CONFIG_PARAMETERS: "'credential.helper=/production/helper'",
    GIT_DIR: "/production/git-dir",
    GIT_WORK_TREE: "/production/work-tree",
    PYTHONPATH: "/production/python",
    PYTHONSTARTUP: "/production/python-startup",
    RUBYOPT: "-r/production/ruby",
    PERL5OPT: "-I/production/perl",
    JAVA_TOOL_OPTIONS: "-javaagent:/production/agent.jar",
    GRADLE_OPTS: "-I/production/init.gradle",
  };
  const sanitized = testProcessEnvironment(poisoned);
  assert.equal(sanitized.PATH, "/fixture/bin");
  assert.equal(sanitized.REVIVAL_DATA_DIR, DATA_DIR);
  assert.equal(sanitized.REVIVAL_BUILD_DIR, BUILD_DIR);
  assert.equal(sanitized.CARGO_TARGET_DIR, path.join(BUILD_DIR, "test-process", "cargo-target"));
  assert.notEqual(sanitized.CARGO_TARGET_DIR, cosmosTestEnvironment(poisoned).CARGO_TARGET_DIR);
  const managedPoisonNames = new Set([
    "REVIVAL_BUILD_DIR",
    "NPM_CONFIG_USERCONFIG",
    "CARGO_HOME",
    "CARGO_TARGET_DIR",
    "GRADLE_USER_HOME",
  ]);
  for (const name of Object.keys(poisoned).filter((name) => name !== "PATH")) {
    if (managedPoisonNames.has(name)) continue;
    assert.equal(name in sanitized, false, `${name} survived the test boundary`);
  }
  for (const directoryName of [
    "HOME",
    "CARGO_HOME",
    "GRADLE_USER_HOME",
    "ANDROID_USER_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const directory = sanitized[directoryName];
    const stat = fs.lstatSync(directory);
    assert.equal(path.isAbsolute(directory), true, directoryName);
    assert.equal(directory.startsWith(`${root}${path.sep}`), false, directoryName);
    assert.equal(stat.isSymbolicLink(), false, directoryName);
    assert.equal(stat.isDirectory(), true, directoryName);
    assert.equal(stat.mode & 0o777, 0o700, directoryName);
  }
  assert.notEqual(sanitized.NPM_CONFIG_USERCONFIG, sanitized.NPM_CONFIG_GLOBALCONFIG);
  for (const config of [sanitized.NPM_CONFIG_USERCONFIG, sanitized.NPM_CONFIG_GLOBALCONFIG]) {
    assert.equal(path.isAbsolute(config), true);
    assert.equal(config.startsWith(`${root}${path.sep}`), false);
    const stat = fs.lstatSync(config);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(config, "utf8"), "");
  }
  const nested = testProcessEnvironment(sanitized);
  assert.equal(nested.NPM_CONFIG_USERCONFIG, sanitized.NPM_CONFIG_USERCONFIG);
  assert.equal(nested.NPM_CONFIG_GLOBALCONFIG, sanitized.NPM_CONFIG_GLOBALCONFIG);
  const npmProbe = spawnSync("npm", ["--version"], {
    cwd: root,
    env: testProcessEnvironment(process.env),
    encoding: "utf8",
  });
  assert.equal(npmProbe.status, 0, npmProbe.stderr);
  assert.doesNotMatch(npmProbe.stderr, /double-loading config/u);

  const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revival-child-env-sentinel-"));
  try {
    const preloadEvidence = path.join(sentinelRoot, "node-preload-ran");
    const preload = path.join(sentinelRoot, "preload.cjs");
    const shellEvidence = path.join(sentinelRoot, "shell-startup-ran");
    const shellStartup = path.join(sentinelRoot, "shell-startup.sh");
    const wrapperEvidence = path.join(sentinelRoot, "rust-wrapper-ran");
    const wrapper = path.join(sentinelRoot, "rust-wrapper.sh");
    fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloadEvidence)}, 'ran')\n`);
    fs.writeFileSync(shellStartup, `printf ran >${JSON.stringify(shellEvidence)}\n`, { mode: 0o700 });
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf ran >${JSON.stringify(wrapperEvidence)}\nexec "$@"\n`, { mode: 0o700 });
    const childEnvironment = testProcessEnvironment({
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      BASH_ENV: shellStartup,
      ENV: shellStartup,
      RUSTC_WRAPPER: wrapper,
      GITHUB_TOKEN: "ordinary-credential-must-not-cross",
    });
    const sentinelNames = [
      "NODE_OPTIONS", "BASH_ENV", "ENV", "RUSTC_WRAPPER", "GITHUB_TOKEN",
      "COSMOS_TEST_DATABASE_URL", "LD_PRELOAD", "CC", "RUSTFLAGS", "PYTHONPATH",
    ];
    const child = spawnSync(process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(sentinelNames)}.map((name) => [name, process.env[name]]))))`,
    ], { env: childEnvironment, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
    assert.equal(fs.existsSync(preloadEvidence), false, "NODE_OPTIONS preload executed");

    // A disposable snapshot reloads context.js after replacing XDG homes. The
    // trusted outer data/build pair must survive that reload as one boundary.
    const contextModule = path.join(root, "platform/cli/context.js");
    const nestedReload = spawnSync(process.execPath, [
      "-e",
      "const context = require(process.argv[1]); const value = context.testProcessEnvironment(); process.stdout.write(value.REVIVAL_BUILD_DIR);",
      contextModule,
    ], {
      env: { ...childEnvironment, XDG_DATA_HOME: path.join(sentinelRoot, "nested-xdg-data") },
      encoding: "utf8",
    });
    assert.equal(nestedReload.status, 0, nestedReload.stderr);
    assert.equal(nestedReload.stdout, BUILD_DIR);

    const shell = spawnSync("bash", ["-c", "exit 0"], { env: childEnvironment, encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(fs.existsSync(shellEvidence), false, "shell startup injection executed");

    const cargoFixture = path.join(sentinelRoot, "cargo-fixture");
    fs.mkdirSync(path.join(cargoFixture, "src"), { recursive: true });
    fs.writeFileSync(path.join(cargoFixture, "Cargo.toml"), "[package]\nname='env_sentinel'\nversion='0.0.0'\nedition='2021'\n");
    fs.writeFileSync(path.join(cargoFixture, "src/lib.rs"), "pub fn sentinel() -> bool { true }\n");
    const cargo = spawnSync("cargo", ["check", "--offline", "--quiet"], {
      cwd: cargoFixture,
      env: childEnvironment,
      encoding: "utf8",
    });
    assert.equal(cargo.status, 0, cargo.stderr);
    assert.equal(fs.existsSync(wrapperEvidence), false, "RUSTC_WRAPPER executed");
  } finally {
    fs.rmSync(sentinelRoot, { recursive: true, force: true });
  }

  const checksSource = fs.readFileSync(path.join(root, "platform/cli/checks.js"), "utf8");
  const gatesSource = fs.readFileSync(path.join(root, "platform/cli/gates.js"), "utf8");
  assert.match(
    checksSource,
    /testProcessEnvironment\(process\.env, \{\s*NEXT_TELEMETRY_DISABLED/u,
  );
  assert.match(checksSource, /const testEnvironment = testProcessEnvironment\(\)/u);
  assert.match(gatesSource, /const testEnvironment = testProcessEnvironment\(\)/u);
  assert.match(gatesSource, /policyTests\(testEnvironment\)/u);
  assert.match(gatesSource, /release Center tests[^\n]+env: npmEnvironment/u);
  assert.match(gatesSource, /release Spotify tests[\s\S]*?env: npmEnvironment/u);
  assert.match(gatesSource, /release Center source snapshot[^\n]+prepareCenterWorkspace/u);
  assert.doesNotMatch(gatesSource, /generatedCleanupGuard|release Center dependencies/u);
});

test("a validated custom root-owned RUSTUP_HOME survives synthetic HOME and nested reload offline", () => {
  const rootOwnedRustup = ["/usr/local", "/usr"].find((candidate) => {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    return stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 &&
      (stat.mode & 0o022) === 0;
  });
  assert.ok(rootOwnedRustup, "the host must expose a canonical root-owned installation directory");
  assert.equal(resolveTrustedRustupHome({ RUSTUP_HOME: rootOwnedRustup }), rootOwnedRustup);
  const environment = testProcessEnvironment({
    PATH: process.env.PATH,
    RUSTUP_HOME: rootOwnedRustup,
  });
  assert.equal(environment.RUSTUP_HOME, rootOwnedRustup);
  assert.notEqual(environment.HOME, os.userInfo().homedir);
  assert.equal(testProcessEnvironment(environment).RUSTUP_HOME, rootOwnedRustup);

  const contextModule = path.join(root, "platform/cli/context.js");
  const nested = spawnSync(process.execPath, [
    "-e",
    [
      "const context = require(process.argv[1]);",
      "const environment = context.testProcessEnvironment();",
      "if (environment.RUSTUP_HOME !== process.argv[2]) process.exit(71);",
      "process.stdout.write(environment.RUSTUP_HOME);",
    ].join("\n"),
    contextModule,
    rootOwnedRustup,
  ], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, rootOwnedRustup);
});

test("the Dev Container pins its supply chain and separates cache from private authority", () => {
  const configuration = JSON.parse(fs.readFileSync(
    path.join(root, ".devcontainer/devcontainer.json"),
    "utf8",
  ));
  const serialized = JSON.stringify(configuration);
  assert.match(configuration.image, /@sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(serialized, /\blatest\b/u);
  assert.deepEqual(Object.keys(configuration.features), [
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1.10.0",
    "ghcr.io/devcontainers/features/node:2.1.0",
    "ghcr.io/devcontainers/features/rust:1.5.1",
  ]);
  const dockerFeature = configuration.features["ghcr.io/devcontainers/features/docker-outside-of-docker:1.10.0"];
  assert.equal(dockerFeature.version, "28.5.2");
  assert.equal(dockerFeature.dockerDashComposeVersion, "none");
  assert.equal(dockerFeature.installDockerBuildx, false);
  assert.equal(dockerFeature.installDockerComposeSwitch, false);
  const nodeFeature = configuration.features["ghcr.io/devcontainers/features/node:2.1.0"];
  assert.deepEqual(nodeFeature, {
    version: "22.14.0",
    npmVersion: "none",
    pnpmVersion: "none",
    nvmVersion: "0.40.3",
  });
  const rustFeature = configuration.features["ghcr.io/devcontainers/features/rust:1.5.1"];
  assert.equal(rustFeature.version, "1.91.1");
  assert.deepEqual(
    new Set(String(rustFeature.components).split(",")),
    new Set(["rustfmt", "clippy"]),
  );
  assert.equal(configuration.containerEnv.RUSTUP_HOME, "/usr/local/rustup");
  assert.equal(configuration.containerEnv.CARGO_HOME, "/workspace-private/cargo");
  assert.equal(configuration.containerEnv.CARGO_TARGET_DIR, "/workspace-cache/cargo-target");
  assert.notEqual(configuration.containerEnv.CARGO_HOME, "/usr/local/cargo");
  assert.ok(configuration.mounts.every((mount) => mount.includes("${devcontainerId}")));
  assert.ok(configuration.mounts.some((mount) => mount.includes("target=/workspace-cache")));
  assert.ok(configuration.mounts.some((mount) => mount.includes("target=/workspace-private")));
  for (const variable of [
    "REVIVAL_CONFIG_DIR",
    "REVIVAL_SECRETS_DIR",
    "REVIVAL_DATA_DIR",
    "REVIVAL_BACKUP_DIR",
    "NPM_CONFIG_USERCONFIG",
  ]) {
    assert.match(configuration.containerEnv[variable], /^\/workspace-private\//u, variable);
    assert.doesNotMatch(configuration.containerEnv[variable], /^\/workspace-cache\//u, variable);
  }
  for (const variable of ["CARGO_TARGET_DIR", "NPM_CONFIG_CACHE"]) {
    assert.match(configuration.containerEnv[variable], /^\/workspace-cache\//u, variable);
  }
  const commands = configuration.postCreateCommand.split(" && ");
  assert.deepEqual(commands.slice(0, 2), [
    "sudo chown -R root:root /usr/local/rustup /usr/local/cargo",
    "sudo chmod -R go-w /usr/local/rustup /usr/local/cargo",
  ]);
  assert.equal(commands[2], "sudo chown -R vscode:vscode /workspace-cache /workspace-private");
  assert.ok(commands.includes("sudo chmod 0700 /workspace-private"));

  const lock = JSON.parse(fs.readFileSync(
    path.join(root, ".devcontainer/devcontainer-lock.json"),
    "utf8",
  ));
  assert.deepEqual(Object.keys(lock.features), Object.keys(configuration.features));
  for (const [feature, record] of Object.entries(lock.features)) {
    assert.match(feature, /:[0-9]+\.[0-9]+\.[0-9]+$/u);
    assert.match(record.version, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
    assert.match(record.resolved, /@sha256:[0-9a-f]{64}$/u);
    assert.equal(record.integrity, record.resolved.slice(record.resolved.indexOf("sha256:")));
  }

  const callerUid = 4242;
  const callerGid = 4242;
  const supplementaryRustlangGid = 4343;
  const directory = ({ uid, gid, mode }) => ({
    uid,
    gid,
    mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  assert.equal(
    trustedRustupDirectoryRole(directory({
      uid: callerUid,
      gid: supplementaryRustlangGid,
      mode: 0o2775,
    }), callerUid, callerGid),
    null,
    "the upstream rustlang-group 2775 layout must be rejected before hardening",
  );
  assert.equal(
    trustedRustupDirectoryRole(directory({ uid: 0, gid: 0, mode: 0o755 }), callerUid, callerGid),
    "root",
    "the recursively root-owned, non-writable postCreate layout must be accepted",
  );
  assert.equal(
    trustedRustupDirectoryRole(
      directory({ uid: 0, gid: 0, mode: 0o1777 }),
      callerUid,
      callerGid,
      { allowRootOwnedStickyAncestor: true },
    ),
    "root-sticky-ancestor",
    "a /tmp-style root-owned sticky directory is safe only as a held ancestor",
  );
  assert.equal(
    trustedRustupDirectoryRole(directory({ uid: callerUid, gid: callerGid, mode: 0o700 }), callerUid, callerGid),
    "caller",
    "a private caller-owned leaf below the sticky ancestor must remain trusted",
  );
  assert.equal(
    trustedRustupDirectoryRole(directory({ uid: 0, gid: 0, mode: 0o1777 }), callerUid, callerGid),
    null,
    "a root-owned sticky directory must never be accepted as the RUSTUP_HOME leaf",
  );
  assert.equal(
    trustedRustupDirectoryRole(
      directory({ uid: 0, gid: 0, mode: 0o777 }),
      callerUid,
      callerGid,
      { allowRootOwnedStickyAncestor: true },
    ),
    null,
    "a non-sticky world-writable root-owned ancestor must remain rejected",
  );
});

test("an official root-owned Rust installation passes a nested sanitized offline smoke when present", (t) => {
  const rustupHome = "/usr/local/rustup";
  const cargoBin = "/usr/local/cargo/bin";
  const required = [rustupHome, "/usr/local/cargo", path.join(cargoBin, "cargo"), path.join(cargoBin, "rustup")];
  if (!required.every((candidate) => fs.existsSync(candidate))) {
    t.skip("official Dev Container Rust roots are not installed on this host");
    return;
  }
  for (const directory of [rustupHome, "/usr/local/cargo"]) {
    const stat = fs.lstatSync(directory);
    assert.equal(stat.uid, 0, directory);
    assert.equal(stat.mode & 0o022, 0, directory);
  }

  secureDirectory(BUILD_DIR);
  const temporary = fs.mkdtempSync(path.join(BUILD_DIR, "root-rust-offline-"));
  try {
    const crate = path.join(temporary, "crate");
    fs.mkdirSync(path.join(crate, "src"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(crate, "Cargo.toml"),
      "[package]\nname='root_rust_offline'\nversion='0.0.0'\nedition='2021'\n",
    );
    fs.writeFileSync(path.join(crate, "src/lib.rs"), "pub fn offline() -> bool { true }\n");
    const contextModule = path.join(root, "platform/cli/context.js");
    const outer = testProcessEnvironment({
      ...process.env,
      PATH: `${cargoBin}:${process.env.PATH}`,
      RUSTUP_HOME: rustupHome,
    });
    const nested = spawnSync(process.execPath, [
      "-e",
      [
        "const { spawnSync } = require('node:child_process');",
        "const context = require(process.argv[1]);",
        "const environment = context.testProcessEnvironment(process.env);",
        "const rustup = spawnSync('rustup', ['toolchain', 'list'], { env: environment, encoding: 'utf8' });",
        "if (rustup.status !== 0) { process.stderr.write(rustup.stderr); process.exit(81); }",
        "const cargo = spawnSync('cargo', ['+1.91.1', 'check', '--offline', '--quiet'], { cwd: process.argv[2], env: environment, encoding: 'utf8' });",
        "if (cargo.status !== 0) { process.stderr.write(cargo.stderr); process.exit(82); }",
        "process.stdout.write(environment.RUSTUP_HOME);",
      ].join("\n"),
      contextModule,
      crate,
    ], { cwd: root, env: outer, encoding: "utf8" });
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(nested.stdout, rustupHome);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("RUSTUP_HOME rejects noncanonical, linked, writable, source, and ambient injection paths", () => {
  assert.throws(
    () => resolveTrustedRustupHome({ RUSTUP_HOME: "/tmp" }),
    /RUSTUP_HOME/u,
    "the global sticky temporary directory must not itself be a Rustup installation",
  );
  secureDirectory(BUILD_DIR);
  const temporary = fs.mkdtempSync(path.join(BUILD_DIR, "rustup-validation-"));
  try {
    fs.chmodSync(temporary, 0o700);
    const safe = path.join(temporary, "safe-rustup");
    fs.mkdirSync(safe, { mode: 0o700 });
    assert.equal(testProcessEnvironment({ PATH: process.env.PATH, RUSTUP_HOME: safe }).RUSTUP_HOME, safe);

    const linked = path.join(temporary, "linked-rustup");
    fs.symlinkSync(safe, linked);
    assert.throws(
      () => testProcessEnvironment({ PATH: process.env.PATH, RUSTUP_HOME: linked }),
      /RUSTUP_HOME.*(?:canonical non-link|real directories|symbolic links)/u,
    );
    assert.equal(
      testProcessEnvironment({ PATH: process.env.PATH, RUSTUP_HOME: safe }).RUSTUP_HOME,
      safe,
      "a hostile sibling link must not redirect the descriptor-held safe leaf",
    );

    const writable = path.join(temporary, "writable-rustup");
    fs.mkdirSync(writable, { mode: 0o700 });
    fs.chmodSync(writable, 0o707);
    assert.throws(
      () => testProcessEnvironment({ PATH: process.env.PATH, RUSTUP_HOME: writable }),
      /RUSTUP_HOME has a writable or foreign-owned ancestor/u,
    );

    const writableParent = path.join(temporary, "writable-parent");
    const childBelowWritableParent = path.join(writableParent, "rustup");
    fs.mkdirSync(childBelowWritableParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(writableParent, 0o707);
    assert.throws(
      () => testProcessEnvironment({
        PATH: process.env.PATH,
        RUSTUP_HOME: childBelowWritableParent,
      }),
      /RUSTUP_HOME has a writable or foreign-owned ancestor/u,
      "a non-sticky world-writable ancestor must not authorize a private leaf",
    );

    const realParent = path.join(temporary, "real-parent");
    fs.mkdirSync(path.join(realParent, "rustup"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(realParent, path.join(temporary, "linked-parent"));
    assert.throws(
      () => testProcessEnvironment({
        PATH: process.env.PATH,
        RUSTUP_HOME: path.join(temporary, "linked-parent", "rustup"),
      }),
      /RUSTUP_HOME.*(?:real directories|symbolic links|canonical non-link)/u,
    );

    for (const refused of [
      ".rustup",
      `${safe}/../safe-rustup`,
      `${safe}\ninjected`,
      root,
      path.join(temporary, "missing"),
    ]) {
      assert.throws(
        () => testProcessEnvironment({ PATH: process.env.PATH, RUSTUP_HOME: refused }),
        /RUSTUP_HOME/u,
        refused,
      );
    }

    const sanitized = testProcessEnvironment({
      PATH: process.env.PATH,
      RUSTUP_HOME: safe,
      RUSTUP_DIST_SERVER: "https://injection.invalid/dist",
      RUSTUP_UPDATE_ROOT: "https://injection.invalid/update",
      RUSTUP_TOOLCHAIN: "injected",
    });
    assert.equal(sanitized.RUSTUP_HOME, safe);
    assert.equal("RUSTUP_DIST_SERVER" in sanitized, false);
    assert.equal("RUSTUP_UPDATE_ROOT" in sanitized, false);
    assert.equal("RUSTUP_TOOLCHAIN" in sanitized, false);

    const contextModule = path.join(root, "platform/cli/context.js");
    const outer = testProcessEnvironment({ ...process.env });
    const nestedNegative = spawnSync(process.execPath, [
      "-e",
      [
        "const context = require(process.argv[1]);",
        "try {",
        "  context.testProcessEnvironment({ ...process.env, RUSTUP_HOME: process.argv[2] });",
        "  process.exit(91);",
        "} catch (error) { process.stdout.write(error.message); }",
      ].join("\n"),
      contextModule,
      writable,
    ], { cwd: root, env: outer, encoding: "utf8" });
    assert.equal(nestedNegative.status, 0, nestedNegative.stderr);
    assert.match(nestedNegative.stdout, /RUSTUP_HOME has a writable or foreign-owned ancestor/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm control files fail closed on permissive modes, hardlinks, and symlinks", () => {
  const contextModule = path.join(root, "platform/cli/context.js");
  for (const mutation of ["permissive", "hardlink", "symlink"]) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `revival-npm-control-${mutation}-`));
    try {
      const script = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const context = require(process.argv[1]);",
        "const environment = context.testProcessEnvironment({ PATH: process.env.PATH });",
        "const file = environment.NPM_CONFIG_USERCONFIG;",
        "if (process.argv[2] === 'permissive') fs.chmodSync(file, 0o644);",
        "if (process.argv[2] === 'hardlink') fs.linkSync(file, file + '.alias');",
        "if (process.argv[2] === 'symlink') { const target = file + '.target'; fs.writeFileSync(target, ''); fs.chmodSync(target, 0o600); fs.unlinkSync(file); fs.symlinkSync(target, file); }",
        "try { context.testProcessEnvironment({ PATH: process.env.PATH }); process.exitCode = 91; }",
        "catch (error) { process.stdout.write(error.message); }",
      ].join("\n");
      const result = spawnSync(process.execPath, ["-e", script, contextModule, mutation], {
        cwd: root,
        env: externalEnvironment(temporary),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${mutation}: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /npm test configuration|symbolic link|ELOOP/u, mutation);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("the release gate discovers exactly one 4096-bit RSA compatibility test before running it", () => {
  const gates = fs.readFileSync(path.join(root, "platform/cli/gates.js"), "utf8");
  assert.equal(
    assertExactlyOneListedRustTest(
      `${RELEASE_RSA_COMPATIBILITY_TEST}: test\n`,
      RELEASE_RSA_COMPATIBILITY_TEST,
    ),
    RELEASE_RSA_COMPATIBILITY_TEST,
  );
  assert.throws(
    () => assertExactlyOneListedRustTest("0 tests, 0 benchmarks\n", RELEASE_RSA_COMPATIBILITY_TEST),
    /observed 0: <none>/u,
  );
  assert.throws(
    () => assertExactlyOneListedRustTest(
      `${RELEASE_RSA_COMPATIBILITY_TEST}: test\n${RELEASE_RSA_COMPATIBILITY_TEST}: test\n`,
      RELEASE_RSA_COMPATIBILITY_TEST,
    ),
    /observed 2/u,
  );
  assert.throws(
    () => assertExactlyOneListedRustTest(
      "tests::renamed_4096_compatibility_test: test\n",
      RELEASE_RSA_COMPATIBILITY_TEST,
    ),
    /renamed_4096_compatibility_test/u,
  );
  assert.match(gates, /release Cosmos 4096-bit RSA test discovery/u);
  assert.match(gates, /'--ignored', '--exact', '--list'/u);
  assert.match(gates, /release Cosmos 4096-bit RSA compatibility test/u);
  assert.match(gates, /'--ignored', '--exact', '--test-threads=1'/u);
  assert.ok(
    gates.indexOf("release Cosmos 4096-bit RSA test discovery") <
      gates.indexOf("release Cosmos 4096-bit RSA compatibility test"),
  );
});

test("platform policy files share one bounded-concurrency Node runner", () => {
  assert.deepEqual(policyTestArguments(["one.test.mjs", "two.test.mjs"], 3), [
    "--no-warnings",
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=3",
    "one.test.mjs",
    "two.test.mjs",
  ]);
  assert.ok(policyTestConcurrency() >= 1);
  assert.ok(policyTestConcurrency() <= 4);
  assert.throws(() => policyTestArguments([], 0), /integer from 1 through 4/u);
  assert.throws(() => policyTestArguments([], 5), /integer from 1 through 4/u);
  assert.deepEqual(policyTestPlan([
    "z-safe.test.mjs",
    "release.test.mjs",
    "fresh-install.test.mjs",
    "a-safe.test.mjs",
  ]), {
    parallel: ["a-safe.test.mjs", "z-safe.test.mjs"],
    serial: ["fresh-install.test.mjs", "release.test.mjs"],
  });
  assert.deepEqual(policyTestPlan(["release.test.mjs", "safe.test.mjs"], {
    hasPinSource: false,
  }), {
    parallel: ["safe.test.mjs"],
    serial: [],
  });
});

test("Center UI tests are a mandatory release subprocess", () => {
  const calls = [];
  const successful = runCenterUiTests("/fixture/center", { PATH: "/fixture/bin" },
    (...arguments_) => {
      calls.push(arguments_);
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
  assert.equal(successful.status, 0);
  assert.deepEqual(calls[0].slice(0, 3), [
    "release Center UI tests",
    "npm",
    ["run", "test:ui"],
  ]);
  assert.equal(calls[0][3].allowFailure, true);
  assert.throws(
    () => runCenterUiTests("/fixture/center", {}, () => ({
      status: 37,
      signal: null,
      stdout: "",
      stderr: "mutated UI failure",
    })),
    (error) => error.name === "TimedSubprocessFailure" && error.result.status === 37,
  );
});

test("the Pin command enters one descriptor-stable broker with a positive environment", () => {
  assert.deepEqual(pinLaneSessionArguments("check"), [
    "lane-session", DATA_DIR, BUILD_DIR, root, "check",
  ]);
  assert.deepEqual(pinLaneSessionArguments("debug", {
    roles: ["hook", "server"],
  }).slice(-4), ["--role", "hook", "--role", "server"]);
  let observed;
  executePinLaneSession("check", {}, {
    spawnSync(command, arguments_, options) {
      observed = { command, arguments_, options };
      return { status: 0, signal: null, error: null };
    },
  });
  assert.equal(observed.command, "/proc/self/fd/3");
  assert.deepEqual(observed.arguments_.slice(0, 5), [
    "-I", "-S", "-B", "-c", PIN_BROKER_BOOTSTRAP,
  ]);
  assert.match(observed.arguments_[5], /^[0-9a-f]{64}$/u);
  assert.equal(observed.arguments_[6], "lane-session");
  assert.deepEqual(observed.options.env, {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  assert.equal(observed.options.stdio.length, 5);
  assert.equal(Number.isInteger(observed.options.stdio[3]), true);
  assert.equal(Number.isInteger(observed.options.stdio[4]), true);
  assert.equal(JSON.stringify(observed).includes("DOCKER_CONTEXT"), false);
  const ordering = [];
  pinContributorCheck({
    preflight() { ordering.push("preflight"); },
    sessionRunner(lane, selection) { ordering.push([lane, selection]); },
  });
  assert.deepEqual(ordering, ["preflight", ["check", {}]]);
});

test("the Pin broker bootstrap seals verified bytes before executing them", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pin-broker-seal-"));
  const broker = path.join(temporary, "broker.py");
  const marker = path.join(temporary, "executed");
  const original = Buffer.from(
    "import pathlib, sys\npathlib.Path(sys.argv[1]).write_text('original', encoding='utf-8')\n",
  );
  try {
    fs.writeFileSync(broker, original, { mode: 0o600 });
    const expected = crypto.createHash("sha256").update(original).digest("hex");
    let descriptor = fs.openSync(broker, "r");
    let result = spawnSync("/usr/bin/python3", [
      "-I", "-S", "-B", "-c", PIN_BROKER_BOOTSTRAP, expected, marker,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", "ignore", descriptor],
    });
    fs.closeSync(descriptor);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "original");

    fs.rmSync(marker);
    descriptor = fs.openSync(broker, "r");
    // Preserve the inode, mode, and byte length; only the contents and ctime
    // move after the expected digest was captured.
    const changed = Buffer.from(original.toString("utf8").replace("original", "mutated!"));
    assert.equal(changed.length, original.length);
    fs.writeFileSync(broker, changed);
    result = spawnSync("/usr/bin/python3", [
      "-I", "-S", "-B", "-c", PIN_BROKER_BOOTSTRAP, expected, marker,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", "ignore", descriptor],
    });
    fs.closeSync(descriptor);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.match(result.stderr, /changed before its sealed execution/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("every ARM, emulated, and non-Linux Pin host is refused before the broker", () => {
  assert.deepEqual(
    parseQemuX86VersionBanner("qemu-x86_64 version 8.2.2 (fixture)"),
    [8, 2, 2],
  );
  assert.equal(diagnosePinAmd64Runtime({
    architecture: "x64", platform: "linux", cpuInfo: "vendor_id : GenuineIntel",
  }).safe, true);
  for (const input of [
    { architecture: "x64", platform: "linux", binfmtRegistered: true,
      cpuInfo: "vendor_id : GenuineIntel" },
    { architecture: "x64", platform: "linux", cpuInfo: "vendor_id : GenuineIntel",
      emulationEvidence: "QEMU Virtual CPU version 9.2" },
    { architecture: "x64", platform: "linux", cpuInfo: "CPU implementer : 0x41" },
    { architecture: "x64", platform: "linux", cpuInfo: "vendor_id : AuthenticAMD",
      emulationEvidence: "tcg translated process" },
  ]) assert.equal(diagnosePinAmd64Runtime(input).safe, false);
  for (const input of [
    { architecture: "arm64", platform: "linux", binfmtRegistered: false },
    { architecture: "arm64", platform: "linux", binfmtRegistered: true,
      qemuVersionBanner: "qemu-x86_64 version 8.2.2" },
    { architecture: "arm64", platform: "linux", binfmtRegistered: true,
      qemuVersionBanner: "qemu-x86_64 version 9.2.0" },
    { architecture: "arm64", platform: "darwin", binfmtRegistered: false },
    { architecture: "x64", platform: "darwin", binfmtRegistered: false },
  ]) {
    const diagnosis = diagnosePinAmd64Runtime(input);
    assert.equal(diagnosis.safe, false);
    assert.match(diagnosis.guidance, /native hosted linux\/amd64/u);
  }
  const probed = probePinAmd64Runtime({
    architecture: "arm64",
    platform: "linux",
    readRegistration: () => "enabled\ninterpreter /fixture/qemu-x86_64\nflags: POF\n",
    resolveInterpreter: (value) => value,
    spawn: () => assert.fail("ARM preflight must not execute QEMU"),
  });
  assert.equal(probed.safe, false);
  const translatedX64 = probePinAmd64Runtime({
    architecture: "x64",
    platform: "linux",
    readBinfmtRegistrations: () => "qemu-x86_64\nenabled\n",
    readCpuInfo: () => "vendor_id : GenuineIntel\n",
    readEvidence: () => "",
  });
  assert.equal(translatedX64.safe, false);
  const nativeX64 = probePinAmd64Runtime({
    architecture: "x64",
    platform: "linux",
    readBinfmtRegistrations: () => "",
    readCpuInfo: () => "vendor_id : AuthenticAMD\nmodel name : native fixture\n",
    readEvidence: () => "",
  });
  assert.equal(nativeX64.safe, true);
  let sessions = 0;
  assert.throws(() => pinContributorCheck({
    preflight() { throw new Error("native preflight refused"); },
    sessionRunner() { sessions += 1; },
  }), /native preflight refused/u);
  assert.equal(sessions, 0);
});

test("changed paths select precise component checks and unknown paths fail closed", () => {
  assert.deepEqual([...checksForPath("center/src/app/page.tsx")], ["center"]);
  assert.deepEqual([...checksForPath("center/adapters/spotify/src/server.mjs")], ["center"]);
  for (const developmentBoundary of [
    "center/.dockerignore",
    "center/Dockerfile",
    "center/next.config.mjs",
    "center/package-lock.json",
    "center/package.json",
  ]) {
    assert.deepEqual([...checksForPath(developmentBoundary)], ["platform", "center"]);
  }
  assert.deepEqual([...checksForPath("cosmos/crates/cosmos/src/lib.rs")], ["cosmos"]);
  for (const cosmosBoundary of [
    "cosmos/Cargo.lock",
    "cosmos/Cargo.toml",
    "cosmos/Dockerfile",
  ]) {
    assert.deepEqual([...checksForPath(cosmosBoundary)], ["platform", "cosmos"]);
  }
  assert.deepEqual(
    [...checksForPath("rust-toolchain.toml")],
    ["platform", "cosmos", "pin"],
  );
  assert.deepEqual([...checksForPath("pin/runtime/core/src/lib.rs")], ["pin"]);
  assert.deepEqual([...checksForPath("docs/architecture.md")], ["platform"]);
  for (const sharedCli of [
    "platform/cli/pin.js",
    "platform/cli/gates.js",
    "platform/cli/context.js",
    "platform/cli/checks.js",
  ]) {
    assert.deepEqual([...checksForPath(sharedCli)], ["platform", "center", "cosmos", "pin"]);
  }
  assert.deepEqual([...checksForPath("revival")], ["platform", "center", "cosmos", "pin"]);
  assert.deepEqual([...checksForPath("platform/deploy/pin/build.mjs")], ["platform", "pin"]);
  assert.deepEqual([...checksForPath("platform/compose/development.yaml")], [
    "platform", "center", "cosmos", "pin",
  ]);
  assert.deepEqual([...checksForPath(".github/workflows/release-cli.yml")], ["platform"]);
  assert.deepEqual(changedCheckComponents([
    "center/src/app/page.tsx",
    "cosmos/crates/cosmos/src/lib.rs",
  ]), ["center", "cosmos"]);
  for (const shared of [
    "contracts/wire/humane/account.proto",
    ".github/workflows/ci.yml",
    "platform/new-unowned-area/file.txt",
    "unfamiliar-root-file.txt",
  ]) {
    assert.deepEqual(changedCheckComponents([shared]), ["platform", "center", "cosmos", "pin"]);
  }

  const observed = [];
  const routed = changedCheckComponents(["platform/cli/context.js", "revival"]);
  runSelectedComponents(routed, (component) => observed.push(component));
  assert.deepEqual(observed, ["platform", "center", "cosmos", "pin"]);
});

test("changed checks always run cheap whole-tree source policies without widening ordinary Rust edits", () => {
  assert.deepEqual(
    changedPolicyScripts(root).map((script) => path.basename(script)),
    ["source-policy.sh", "layout.sh"],
  );
  assert.deepEqual([...checksForPath("cosmos/crates/cosmos/src/lib.rs")], ["cosmos"]);
  const checks = fs.readFileSync(path.join(root, "platform/cli/checks.js"), "utf8");
  const changedBranch = checks.indexOf("if (component === 'changed')");
  const policyCall = checks.indexOf("runChangedSourcePolicies();", changedBranch);
  const selection = checks.indexOf("changedCheckComponents(changeSet.files)", changedBranch);
  assert.ok(changedBranch >= 0 && policyCall > changedBranch && policyCall < selection);
  assert.match(
    checks,
    /timedRun\(`changed \$\{path\.basename\(sourcePolicy\)\}`[^]*createDisposableWorkspace\('changed-layout-policy'\)/u,
    "secret policy must inspect the real tree before layout checks its disposable snapshot",
  );
  const platformCheck = checks.indexOf("function runPlatformCheck()");
  const realPolicy = checks.indexOf("platform real-tree source policy", platformCheck);
  const platformSnapshot = checks.indexOf("platform source snapshot", platformCheck);
  assert.ok(platformCheck >= 0 && realPolicy > platformCheck && realPolicy < platformSnapshot);
});

test("snapshots reject ignored top-level private and state roots in the real source tree", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "revival-real-tree-boundary-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "revival-real-tree-outside-"));
  try {
    fs.mkdirSync(path.join(source, "private"));
    assert.throws(
      () => assertNoForbiddenRealTreeRoots(source),
      /forbidden top-level private\/state boundary.*private/u,
    );
    fs.rmdirSync(path.join(source, "private"));
    fs.symlinkSync(outside, path.join(source, "state"));
    assert.throws(
      () => assertNoForbiddenRealTreeRoots(source),
      /forbidden top-level private\/state boundary.*state/u,
    );
    const checks = fs.readFileSync(path.join(root, "platform/cli/checks.js"), "utf8");
    assert.ok(
      checks.indexOf("assertNoForbiddenRealTreeRoots(sourceRoot);") <
        checks.indexOf("git(\n    [", checks.indexOf("function snapshotRepository")),
      "the real-tree boundary must run before Git selects non-ignored files",
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Darwin uses one sanitized openat helper and trusted Python resolution", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rooted-python-"));
  try {
    const makeStat = (kind, mode = kind === "file" ? 0o100755n : 0o040755n) => ({
      dev: 1n,
      ino: kind === "file" ? 2n : 1n,
      mode,
      nlink: 1n,
      uid: 0n,
      gid: 0n,
      size: 0n,
      mtimeNs: 0n,
      ctimeNs: 0n,
      isSymbolicLink: () => false,
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
    });
    for (const [candidate, canonical] of [
      ["/opt/homebrew/bin/python3", "/opt/homebrew/Cellar/python@3.13/3.13.5/bin/python3.13"],
      ["/Library/Developer/CommandLineTools/usr/bin/python3", "/Library/Developer/CommandLineTools/usr/bin/python3"],
    ]) {
      assert.equal(resolveTrustedPython3({
        candidates: [candidate],
        realpathSync: () => canonical,
        lstatSync: (entry) => makeStat(entry === canonical ? "file" : "directory"),
        accessSync: () => {},
      }).path, canonical);
    }
    assert.throws(
      () => resolveTrustedPython3({
        candidates: ["/opt/homebrew/bin/python3"],
        realpathSync: () => "/opt/homebrew/Cellar/python@3.13/3.13.5/bin/python3.13",
        lstatSync: (entry) => makeStat(
          entry.endsWith("python3.13") ? "file" : "directory",
          entry === "/opt/homebrew" ? 0o040775n : undefined,
        ),
        accessSync: () => {},
      }),
      /no secure Python 3/u,
    );

    const poisonedBin = path.join(temporary, "caller-path-bin");
    fs.mkdirSync(poisonedBin);
    fs.writeFileSync(path.join(poisonedBin, "python3"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    let invocation;
    let result;
    const actualSpawn = spawnSync;
    try {
      process.env.PATH = poisonedBin;
      result = readStableRootedEntries(
        root,
        ["platform/cli/rooted-source.js"],
        "Darwin fixture",
        {
          platform: "darwin",
          spawnSync: (command, args, options) => {
            invocation = { command, args, options };
            return actualSpawn(command, args, options);
          },
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(result.entries.length, 1);
    assert.equal(invocation.command, "/dev/fd/3");
    assert.deepEqual(invocation.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.equal(
      crypto.createHash("sha256").update(invocation.args[3]).digest("hex"),
      ROOTED_SOURCE_HELPER_SHA256,
    );
    assert.match(invocation.args[3], /class RootedReader:/u);
    assert.doesNotMatch(invocation.args[3], /rooted-source-helper\.py/u);
    assert.equal(Number.isInteger(invocation.options.stdio[3]), true);
    assert.doesNotMatch(invocation.args.join("\n"), /\/dev\/fd/u);
    assert.deepEqual(Object.keys(invocation.options.env).sort(), [
      "LANG",
      "LC_ALL",
      "PYTHONDONTWRITEBYTECODE",
      "PYTHONNOUSERSITE",
    ]);
    for (const sentinel of ["AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "LD_PRELOAD", "NPM_TOKEN"]) {
      assert.equal(sentinel in invocation.options.env, false);
    }

    const realParent = path.join(temporary, "real-parent");
    fs.mkdirSync(realParent);
    const realSource = path.join(realParent, "real-source");
    fs.mkdirSync(realSource);
    fs.writeFileSync(path.join(realSource, "file.txt"), "inside\n");
    const linkedParent = path.join(temporary, "linked-parent");
    fs.symlinkSync(realParent, linkedParent);
    const linkedSource = path.join(linkedParent, "real-source");
    for (const platform of ["linux", "darwin"]) {
      assert.throws(
        () => readStableRootedEntries(linkedSource, ["file.txt"], `${platform} root`, { platform }),
        /source root ancestors must not be symbolic links/u,
        platform,
      );
    }

    for (const platform of ["linux", "darwin"]) {
      const parent = path.join(temporary, `swap-parent-${platform}`);
      const source = path.join(parent, "source");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "file.txt"), "inside\n");
      const opened = readStableRootedEntries(source, ["file.txt"], `${platform} initial root`, {
        platform,
      });
      fs.renameSync(parent, `${parent}.displaced`);
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "file.txt"), "outside replacement\n");
      assert.throws(
        () => readStableRootedEntries(source, ["file.txt"], `${platform} replaced root`, {
          platform,
          expectedRoot: opened.rootReceipt,
        }),
        /root changed|source root changed/u,
        `${platform} root-ancestor swap`,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("snapshots reject every link shape, hardlinks, and concurrent source swaps", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-snapshot-link-policy-"));
  const outside = path.join(temporary, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  try {
    for (const [label, target] of [
      ["relative", "target.txt"],
      ["absolute", outside],
      ["dangling", "missing.txt"],
    ]) {
      const source = path.join(temporary, `source-${label}`);
      fs.mkdirSync(source);
      runGit(source, "init", "--quiet", "--initial-branch=main");
      fs.writeFileSync(path.join(source, "target.txt"), "target\n");
      fs.symlinkSync(target, path.join(source, "linked.txt"));
      fs.mkdirSync(BUILD_DIR, { recursive: true, mode: 0o700 });
      const destination = fs.mkdtempSync(path.join(BUILD_DIR, `snapshot-${label}-`));
      try {
        assert.throws(
          () => snapshotRepository(destination, { sourceRoot: source, initializeGit: false }),
          /symbolic links are forbidden in check snapshots/u,
          label,
        );
      } finally {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    }

    const hardlinkSource = path.join(temporary, "source-hardlink");
    fs.mkdirSync(hardlinkSource);
    runGit(hardlinkSource, "init", "--quiet", "--initial-branch=main");
    fs.linkSync(outside, path.join(hardlinkSource, "linked.txt"));
    runGit(hardlinkSource, "add", "--all");
    const hardlinkDestination = fs.mkdtempSync(path.join(BUILD_DIR, "snapshot-hardlink-"));
    try {
      assert.throws(
        () => snapshotRepository(hardlinkDestination, {
          sourceRoot: hardlinkSource,
          initializeGit: false,
        }),
        /hard-linked files are forbidden in check snapshots/u,
      );
      assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
    } finally {
      fs.rmSync(hardlinkDestination, { recursive: true, force: true });
    }

    for (const mutation of ["symlink", "content", "root"]) {
      const source = path.join(temporary, `source-swap-${mutation}`);
      fs.mkdirSync(source);
      runGit(source, "init", "--quiet", "--initial-branch=main");
      const mutable = path.join(source, "mutable.txt");
      fs.writeFileSync(mutable, "before\n");
      runGit(source, "add", "--all");
      const destination = fs.mkdtempSync(path.join(BUILD_DIR, `snapshot-swap-${mutation}-`));
      try {
        assert.throws(
          () => snapshotRepository(destination, {
            sourceRoot: source,
            initializeGit: false,
            beforeStabilityCheck: () => {
              if (mutation === "symlink") {
                fs.rmSync(mutable);
                fs.symlinkSync(outside, mutable);
              } else if (mutation === "content") {
                fs.writeFileSync(mutable, "after!\n");
              } else {
                const displaced = `${source}.before-root-swap`;
                fs.renameSync(source, displaced);
                fs.cpSync(displaced, source, { recursive: true, preserveTimestamps: true });
              }
            },
          }),
          mutation === "root"
            ? /check snapshots root changed during descriptor traversal: mutable\.txt/u
            : /symbolic links are forbidden|source content manifest changed|check snapshots root changed during descriptor traversal/u,
          mutation,
        );
      } finally {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    }

    const externalDirectory = path.join(temporary, "external-directory");
    fs.mkdirSync(externalDirectory);
    fs.writeFileSync(path.join(externalDirectory, "tracked.txt"), "external\n");

    const staticAncestor = path.join(temporary, "source-static-ancestor");
    fs.mkdirSync(staticAncestor);
    runGit(staticAncestor, "init", "--quiet", "--initial-branch=main");
    fs.writeFileSync(path.join(staticAncestor, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(staticAncestor, "ignored"));
    fs.writeFileSync(path.join(staticAncestor, "ignored", "tracked.txt"), "inside\n");
    runGit(staticAncestor, "add", "--force", ".gitignore", "ignored/tracked.txt");
    fs.rmSync(path.join(staticAncestor, "ignored"), { recursive: true });
    fs.symlinkSync(externalDirectory, path.join(staticAncestor, "ignored"));
    const staticDestination = fs.mkdtempSync(path.join(BUILD_DIR, "snapshot-static-ancestor-"));
    try {
      assert.throws(
        () => snapshotRepository(staticDestination, {
          sourceRoot: staticAncestor,
          initializeGit: false,
        }),
        /symbolic links are forbidden in check snapshots.*ignored/u,
      );
      assert.equal(fs.existsSync(path.join(staticDestination, "ignored", "tracked.txt")), false);
    } finally {
      fs.rmSync(staticDestination, { recursive: true, force: true });
    }

    const swappedAncestor = path.join(temporary, "source-swapped-ancestor");
    fs.mkdirSync(swappedAncestor);
    runGit(swappedAncestor, "init", "--quiet", "--initial-branch=main");
    fs.mkdirSync(path.join(swappedAncestor, "ancestor"));
    fs.writeFileSync(path.join(swappedAncestor, "ancestor", "tracked.txt"), "inside\n");
    runGit(swappedAncestor, "add", "--all");
    const swappedDestination = fs.mkdtempSync(path.join(BUILD_DIR, "snapshot-swapped-ancestor-"));
    try {
      assert.throws(
        () => snapshotRepository(swappedDestination, {
          sourceRoot: swappedAncestor,
          initializeGit: false,
          beforeStabilityCheck: () => {
            fs.rmSync(path.join(swappedAncestor, "ancestor"), { recursive: true });
            fs.symlinkSync(externalDirectory, path.join(swappedAncestor, "ancestor"));
          },
        }),
        /symbolic links are forbidden in check snapshots|source (?:path|content) manifest changed/u,
      );
    } finally {
      fs.rmSync(swappedDestination, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("changed-check arguments retain an explicit comparison base", () => {
  assert.deepEqual(parseChangedArguments([]), { base: null });
  assert.deepEqual(parseChangedArguments(["--base", "origin/main"]), { base: "origin/main" });
});

test("changed paths prefer origin/HEAD and retain rename, deletion, staged, and untracked sides", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-changed-paths-"));
  try {
    runGit(temporary, "init", "--quiet", "--initial-branch=main");
    runGit(temporary, "config", "user.name", "Workflow Test");
    runGit(temporary, "config", "user.email", "workflow@example.invalid");
    runGit(temporary, "config", "commit.gpgsign", "false");
    fs.mkdirSync(path.join(temporary, "center"));
    fs.writeFileSync(path.join(temporary, "center", "old.ts"), "old\n");
    fs.writeFileSync(path.join(temporary, "center", "deleted.ts"), "delete me\n");
    runGit(temporary, "add", "--all");
    runGit(temporary, "commit", "--quiet", "-m", "remote default base");
    const remoteDefault = runGit(temporary, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(temporary, "center", "main-only.ts"), "main\n");
    runGit(temporary, "add", "--all");
    runGit(temporary, "commit", "--quiet", "-m", "origin main advance");
    const originMain = runGit(temporary, "rev-parse", "HEAD");
    runGit(temporary, "update-ref", "refs/remotes/origin/trunk", remoteDefault);
    runGit(temporary, "update-ref", "refs/remotes/origin/main", originMain);
    runGit(temporary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    runGit(temporary, "switch", "--quiet", "-c", "feature");
    fs.mkdirSync(path.join(temporary, "cosmos"));
    runGit(temporary, "mv", "center/old.ts", "cosmos/renamed.rs");
    runGit(temporary, "commit", "--quiet", "-m", "rename across components");
    const featureHead = runGit(temporary, "rev-parse", "HEAD");
    runGit(temporary, "update-ref", "refs/remotes/origin/feature", featureHead);
    runGit(temporary, "config", "remote.origin.url", ".");
    runGit(temporary, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    runGit(temporary, "config", "branch.feature.remote", "origin");
    runGit(temporary, "config", "branch.feature.merge", "refs/heads/feature");
    assert.equal(runGit(temporary, "rev-parse", "@{upstream}"), featureHead);

    fs.rmSync(path.join(temporary, "center", "deleted.ts"));
    fs.mkdirSync(path.join(temporary, "docs"));
    fs.writeFileSync(path.join(temporary, "docs", "staged.md"), "staged\n");
    runGit(temporary, "add", "docs/staged.md");
    fs.mkdirSync(path.join(temporary, "pin"));
    fs.writeFileSync(path.join(temporary, "pin", "untracked.rs"), "untracked\n");

    const changes = changedPaths(null, { cwd: temporary });
    assert.equal(changes.base, remoteDefault, "origin/HEAD must beat origin/main and feature upstream");
    for (const expected of [
      "center/deleted.ts",
      "center/main-only.ts",
      "center/old.ts",
      "cosmos/renamed.rs",
      "docs/staged.md",
      "pin/untracked.rs",
    ]) {
      assert.ok(changes.files.includes(expected), `${expected} missing from ${changes.files.join(", ")}`);
    }

    const explicit = changedPaths("origin/main", { cwd: temporary });
    assert.equal(explicit.base, originMain);
    assert.ok(explicit.files.includes("center/old.ts"));
    assert.ok(explicit.files.includes("cosmos/renamed.rs"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a remote-less non-default branch checks its full tracked tree instead of HEAD parent", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-changed-no-default-"));
  try {
    runGit(temporary, "init", "--quiet", "--initial-branch=feature");
    runGit(temporary, "config", "user.name", "Workflow Test");
    runGit(temporary, "config", "user.email", "workflow@example.invalid");
    for (const [directory, name] of [
      ["center", "first.ts"],
      ["cosmos", "second.rs"],
      ["pin", "third.rs"],
    ]) {
      fs.mkdirSync(path.join(temporary, directory), { recursive: true });
      fs.writeFileSync(path.join(temporary, directory, name), `${name}\n`);
      runGit(temporary, "add", "--all");
      runGit(temporary, "commit", "--quiet", "-m", name);
    }
    const changes = changedPaths(null, { cwd: temporary });
    assert.equal(changes.base, null);
    assert.deepEqual(changes.files, [
      "center/first.ts",
      "cosmos/second.rs",
      "pin/third.rs",
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("source snapshots are clean disposable Git repositories", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-snapshot-"));
  const source = path.join(temporary, "source");
  const environment = externalEnvironment(temporary);
  const destination = path.join(environment.REVIVAL_BUILD_DIR, "snapshot");
  const hookEvidence = path.join(temporary, "hook-ran");
  const filterEvidence = path.join(temporary, "clean-filter-ran");
  const fsmonitorEvidence = path.join(temporary, "fsmonitor-ran");
  try {
    fs.mkdirSync(source, { recursive: true });
    runGit(source, "init", "--quiet", "--initial-branch=main");
    runGit(source, "config", "user.name", "Snapshot Test");
    runGit(source, "config", "user.email", "snapshot@example.invalid");
    fs.writeFileSync(path.join(source, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(
      path.join(source, ".gitattributes"),
      "filter-target.txt filter=revival-malicious\n",
    );
    fs.writeFileSync(path.join(source, "filter-target.txt"), "unfiltered source bytes\n");
    fs.writeFileSync(path.join(source, "tracked.txt"), "tracked\n");
    fs.writeFileSync(path.join(source, "deleted.txt"), "deleted\n");
    runGit(source, "add", "--all");
    runGit(source, "commit", "--quiet", "-m", "fixture");
    fs.rmSync(path.join(source, "deleted.txt"));
    fs.writeFileSync(path.join(source, "untracked.txt"), "untracked\n");
    fs.writeFileSync(path.join(source, "ignored.txt"), "ignored\n");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

    const template = path.join(temporary, "git-template");
    const globalHooks = path.join(temporary, "global-hooks");
    fs.mkdirSync(path.join(template, "hooks"), { recursive: true });
    fs.mkdirSync(globalHooks);
    fs.writeFileSync(path.join(template, "template-marker"), "must not copy\n");
    for (const hook of [
      path.join(template, "hooks", "post-commit"),
      path.join(globalHooks, "post-commit"),
    ]) {
      fs.writeFileSync(hook, `#!/bin/sh\nprintf hook >'${hookEvidence}'\nexit 99\n`, { mode: 0o700 });
    }
    const globalConfig = path.join(temporary, "global.gitconfig");
    const cleanFilter = path.join(temporary, "malicious-clean-filter");
    fs.writeFileSync(
      cleanFilter,
      `#!/bin/sh\nprintf filter >'${filterEvidence}'\ncat\n`,
      { mode: 0o700 },
    );
    const fsmonitor = path.join(temporary, "malicious-fsmonitor");
    fs.writeFileSync(
      fsmonitor,
      `#!/bin/sh\nprintf fsmonitor >'${fsmonitorEvidence}'\nexit 97\n`,
      { mode: 0o700 },
    );
    runGit(source, "config", "--local", "core.fsmonitor", fsmonitor);
    runGit(source, "config", "--file", globalConfig, "init.templateDir", template);
    runGit(source, "config", "--file", globalConfig, "core.hooksPath", globalHooks);
    runGit(
      source,
      "config",
      "--file",
      globalConfig,
      "filter.revival-malicious.clean",
      cleanFilter,
    );
    runGit(
      source,
      "config",
      "--file",
      globalConfig,
      "filter.revival-malicious.required",
      "true",
    );
    environment.GIT_CONFIG_GLOBAL = globalConfig;
    environment.GIT_CONFIG_SYSTEM = path.join(temporary, "missing-system-config");
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "filter.revival-malicious.clean";
    environment.GIT_CONFIG_VALUE_0 = cleanFilter;
    environment.GIT_CONFIG_PARAMETERS = "malformed-host-injection";
    environment.GIT_DIR = path.join(temporary, "host-routed-git-dir");
    environment.GIT_EXTERNAL_DIFF = cleanFilter;
    environment.GIT_INDEX_FILE = path.join(temporary, "host-index");
    environment.GIT_OBJECT_DIRECTORY = path.join(temporary, "host-objects");
    environment.GIT_PAGER = cleanFilter;
    environment.GIT_TRACE = path.join(temporary, "host-git-trace");
    environment.GIT_WORK_TREE = path.join(temporary, "host-work-tree");

    const script = [
      "const { snapshotRepository } = require(process.argv[1]);",
      "snapshotRepository(process.argv[3], { sourceRoot: process.argv[2] });",
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "-e", script, path.join(root, "platform/cli/checks.js"), source, destination,
    ], { cwd: root, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(destination, ".git")), true);
    assert.equal(fs.readFileSync(path.join(destination, "tracked.txt"), "utf8"), "tracked\n");
    assert.equal(fs.readFileSync(path.join(destination, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(fs.existsSync(path.join(destination, "deleted.txt")), false);
    assert.equal(fs.existsSync(path.join(destination, "ignored.txt")), false);
    assert.equal(fs.existsSync(path.join(destination, ".git", "template-marker")), false);
    assert.equal(fs.existsSync(hookEvidence), false, "global/template Git hooks must never execute");
    assert.equal(fs.existsSync(filterEvidence), false, "global Git clean filters must never execute");
    assert.equal(fs.existsSync(fsmonitorEvidence), false, "source-local fsmonitor must never execute");
    assert.equal(
      runGit(source, "config", "--local", "--get", "core.fsmonitor"),
      fsmonitor,
      "snapshot enumeration must not rewrite source-local configuration",
    );
    const postInitEnvironment = isolatedSnapshotGitEnvironment(destination, environment);
    assert.deepEqual(
      Object.keys(postInitEnvironment)
        .filter((name) => name.toUpperCase().startsWith("GIT_"))
        .sort(),
      [
        "GIT_ATTR_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_SYSTEM",
      ],
    );
    assert.equal(postInitEnvironment.HOME, path.join(destination, ".git", "revival-isolated-home"));
    assert.equal(
      postInitEnvironment.XDG_CONFIG_HOME,
      path.join(destination, ".git", "revival-isolated-xdg"),
    );
    assert.equal(
      runGitWithEnvironment(
        destination,
        postInitEnvironment,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
      "",
    );
    assert.equal(fs.existsSync(filterEvidence), false, "post-init Git must not reload host filters");
    assert.equal(
      runGitWithEnvironment(destination, postInitEnvironment, "show", "HEAD:filter-target.txt"),
      "unfiltered source bytes",
    );
    assert.equal(
      runGitWithEnvironment(
        destination,
        postInitEnvironment,
        "config",
        "--local",
        "--get",
        "core.hooksPath",
      ),
      path.join(destination, ".git", "revival-empty-hooks"),
    );
    assert.equal(
      runGitWithEnvironment(destination, postInitEnvironment, "rev-list", "--count", "HEAD"),
      "1",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm dependency fingerprints include every compatibility dimension", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-fingerprint-"));
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(temporary, "package-lock.json"), '{"lockfileVersion":3}\n');
    const options = {
      platform: "fixture-os",
      arch: "fixture-arch",
      nodeVersion: "22.1.0",
      npmVersion: "10.2.0",
      installMode: "npm-ci--include=dev",
    };
    const baseline = dependencyFingerprint(temporary, options);
    for (const [name, value] of [
      ["platform", "other-os"],
      ["arch", "other-arch"],
      ["nodeVersion", "22.2.0"],
      ["npmVersion", "10.3.0"],
      ["installMode", "npm-ci-production-only"],
      ["installPolicy", "changed-policy"],
    ]) {
      assert.notEqual(
        dependencyFingerprint(temporary, { ...options, [name]: value }),
        baseline,
        name,
      );
    }
    fs.writeFileSync(path.join(temporary, "package-lock.json"), '{"lockfileVersion":2}\n');
    assert.notEqual(dependencyFingerprint(temporary, options), baseline, "lockfile content");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm install environment ignores inherited behavior-changing configuration", () => {
  const normalized = normalizedNpmInstallEnvironment({
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    NODE_ENV: "production",
    NODE_OPTIONS: "--require=/untrusted/hook.cjs",
    npm_config_omit: "dev",
    NPM_CONFIG_PRODUCTION: "true",
    npm_config_registry: "https://untrusted.invalid",
    npm_package_config_mode: "inherited",
    npm_lifecycle_event: "postinstall",
    INIT_CWD: "/untrusted/cwd",
  }, {
    userConfigFile: "/fixture/empty-user.npmrc",
    globalConfigFile: "/fixture/empty-global.npmrc",
    cacheDirectory: "/fixture/cache",
  });
  assert.equal(normalized.PATH, "/fixture/bin");
  assert.equal(normalized.HOME, "/fixture/home");
  assert.equal(normalized.NODE_ENV, "development");
  assert.equal(normalized.NODE_OPTIONS, undefined);
  assert.equal(normalized.npm_config_omit, undefined);
  assert.equal(normalized.npm_config_registry, undefined);
  assert.equal(normalized.npm_package_config_mode, undefined);
  assert.equal(normalized.npm_lifecycle_event, undefined);
  assert.equal(normalized.INIT_CWD, undefined);
  assert.equal(normalized.NPM_CONFIG_INCLUDE, "dev");
  assert.equal(normalized.NPM_CONFIG_OMIT, "");
  assert.equal(normalized.NPM_CONFIG_PRODUCTION, "false");
  assert.equal(normalized.NPM_CONFIG_USERCONFIG, "/fixture/empty-user.npmrc");
  assert.equal(normalized.NPM_CONFIG_GLOBALCONFIG, "/fixture/empty-global.npmrc");
  assert.equal(normalized.NPM_CONFIG_CACHE, "/fixture/cache");
});

test("concurrent checks use distinct workspaces and atomically reuse one cache", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-cache-race-"));
  const source = path.join(temporary, "source");
  const environment = externalEnvironment(temporary);
  const checks = path.join(root, "platform/cli/checks.js");
  const key = crypto.createHash("sha256").update("shared cache").digest("hex");
  const otherKey = crypto.createHash("sha256").update("invalidated cache").digest("hex");
  try {
    fs.mkdirSync(source);
    runGit(source, "init", "--quiet", "--initial-branch=main");
    runGit(source, "config", "user.name", "Cache Test");
    runGit(source, "config", "user.email", "cache@example.invalid");
    fs.writeFileSync(path.join(source, "fixture.txt"), "fixture\n");
    runGit(source, "add", "--all");
    runGit(source, "commit", "--quiet", "-m", "fixture");

    const worker = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { createDisposableWorkspace, ensureContentAddressedDirectory } = require(process.argv[1]);",
      "const workspace = createDisposableWorkspace('concurrency', { sourceRoot: process.argv[3] });",
      "const cache = ensureContentAddressedDirectory('concurrency-cache', process.argv[2], (artifact) => {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);",
      "  fs.writeFileSync(path.join(artifact, 'payload.txt'), String(process.pid));",
      "});",
      "const result = { workspace: workspace.root, git: fs.existsSync(path.join(workspace.root, '.git')), cache };",
      "workspace.finish();",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    const options = { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] };
    const concurrent = await Promise.all([
      spawnNode(worker, [checks, key, source], options),
      spawnNode(worker, [checks, key, source], options),
    ]);
    for (const result of concurrent) assert.equal(result.status, 0, result.stderr);
    const parsed = concurrent.map((result) => JSON.parse(result.stdout));
    assert.notEqual(parsed[0].workspace, parsed[1].workspace);
    assert.ok(parsed.every((result) => result.git));
    assert.equal(parsed.filter((result) => result.cache.reused === false).length, 1);
    assert.equal(parsed[0].cache.path, parsed[1].cache.path);
    assert.equal(fs.existsSync(path.join(parsed[0].cache.path, "payload.txt")), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(parsed[0].cache.path, CACHE_MARKER), "utf8"));
    assert.equal(manifest.schema, 2);
    assert.ok(manifest.entries.some((entry) => entry.path === "payload.txt" && entry.sha256));
    assert.equal(completeCache(parsed[0].cache.path, "concurrency-cache", key), true);

    const reused = spawnSync(process.execPath, ["-e", worker, checks, key, source], {
      cwd: root, env: environment, encoding: "utf8",
    });
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).cache.reused, true);

    fs.writeFileSync(path.join(parsed[0].cache.path, "payload.txt"), "corrupt-after-publish");
    assert.equal(completeCache(parsed[0].cache.path, "concurrency-cache", key), false);
    const repairedCorruption = spawnSync(process.execPath, ["-e", worker, checks, key, source], {
      cwd: root, env: environment, encoding: "utf8",
    });
    assert.equal(repairedCorruption.status, 0, repairedCorruption.stderr);
    assert.equal(JSON.parse(repairedCorruption.stdout).cache.reused, false);
    assert.notEqual(
      fs.readFileSync(path.join(parsed[0].cache.path, "payload.txt"), "utf8"),
      "corrupt-after-publish",
    );

    const outside = path.join(temporary, "outside-cache-target.txt");
    fs.writeFileSync(outside, "outside-must-survive\n");
    fs.rmSync(path.join(parsed[0].cache.path, "payload.txt"));
    fs.symlinkSync(outside, path.join(parsed[0].cache.path, "payload.txt"));
    assert.equal(completeCache(parsed[0].cache.path, "concurrency-cache", key), false);
    const repairedSymlink = spawnSync(process.execPath, ["-e", worker, checks, key, source], {
      cwd: root, env: environment, encoding: "utf8",
    });
    assert.equal(repairedSymlink.status, 0, repairedSymlink.stderr);
    assert.equal(JSON.parse(repairedSymlink.stdout).cache.reused, false);
    assert.equal(fs.lstatSync(path.join(parsed[0].cache.path, "payload.txt")).isFile(), true);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside-must-survive\n");

    const invalidated = spawnSync(process.execPath, ["-e", worker, checks, otherKey, source], {
      cwd: root, env: environment, encoding: "utf8",
    });
    assert.equal(invalidated.status, 0, invalidated.stderr);
    assert.equal(JSON.parse(invalidated.stdout).cache.reused, false);

    const cacheDirectory = path.join(environment.REVIVAL_BUILD_DIR, "fast-check-cache", "concurrency-cache");
    assert.deepEqual(
      fs.readdirSync(cacheDirectory).filter((entry) => !entry.startsWith(".")).sort(),
      [key, otherKey].sort(),
    );
    assert.deepEqual(
      fs.readdirSync(cacheDirectory).filter((entry) => entry.startsWith(".publish-")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("stale fast-check state is age-gated, atomically claimed, and retention-bounded", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-prune-state-"));
  const buildDirectory = path.join(temporary, "build");
  const workspaceNamespace = path.join(buildDirectory, "fast-check-workspaces", "fixture");
  const cacheNamespace = path.join(buildDirectory, "fast-check-cache", "fixture");
  const now = Date.now();
  const old = new Date(now - 10_000);
  const fresh = new Date(now);
  try {
    fs.mkdirSync(workspaceNamespace, { recursive: true });
    fs.mkdirSync(cacheNamespace, { recursive: true });
    for (const [name, timestamp] of [
      ["run-old", old],
      ["run-active", fresh],
      ["ordinary-source", old],
      [".prune-crashed", old],
    ]) {
      const candidate = path.join(workspaceNamespace, name);
      fs.mkdirSync(candidate);
      fs.utimesSync(candidate, timestamp, timestamp);
    }
    for (const [name, timestamp] of [
      [".publish-old", old],
      [".publish-active", fresh],
      [".prune-crashed", old],
    ]) {
      const candidate = path.join(cacheNamespace, name);
      fs.mkdirSync(candidate);
      fs.utimesSync(candidate, timestamp, timestamp);
    }
    const cacheKeys = Array.from({ length: 5 }, (_, index) =>
      crypto.createHash("sha256").update(`retention-${index}`).digest("hex"));
    for (let index = 0; index < cacheKeys.length; index += 1) {
      const candidate = path.join(cacheNamespace, cacheKeys[index]);
      fs.mkdirSync(candidate);
      const timestamp = new Date(now - 20_000 + (index * 1_000));
      fs.utimesSync(candidate, timestamp, timestamp);
    }

    const removed = pruneFastCheckState({
      buildDirectory,
      now,
      staleAgeMs: 1_000,
      cacheRetention: 2,
    });
    assert.deepEqual(removed, { workspaces: 1, publications: 1, caches: 3, claims: 2 });
    assert.equal(fs.existsSync(path.join(workspaceNamespace, "run-old")), false);
    assert.equal(fs.existsSync(path.join(workspaceNamespace, "run-active")), true);
    assert.equal(fs.existsSync(path.join(workspaceNamespace, "ordinary-source")), true);
    assert.equal(fs.existsSync(path.join(cacheNamespace, ".publish-old")), false);
    assert.equal(fs.existsSync(path.join(cacheNamespace, ".publish-active")), true);
    assert.deepEqual(
      fs.readdirSync(cacheNamespace).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort(),
      cacheKeys.slice(-2).sort(),
    );
    assert.equal(
      fs.readdirSync(workspaceNamespace).some((name) => name.startsWith(".prune-")),
      false,
      "atomic claims must not be left behind after successful removal",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fast-check leases serialize pruning against long-lived workspaces and cache clones", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-prune-lease-"));
  const buildDirectory = path.join(temporary, "build");
  const workspaceNamespace = path.join(buildDirectory, "fast-check-workspaces", "fixture");
  const cacheNamespace = path.join(buildDirectory, "fast-check-cache", "fixture");
  const now = Date.now();
  const old = new Date(now - 60_000);
  try {
    fs.mkdirSync(workspaceNamespace, { recursive: true, mode: 0o700 });
    const workspace = path.join(workspaceNamespace, "run-long-lived");
    fs.mkdirSync(workspace);
    fs.utimesSync(workspace, old, old);
    const workspaceLease = acquireFastCheckLease("workspace-regression", { buildDirectory });
    try {
      assert.deepEqual(
        pruneFastCheckState({ buildDirectory, now, staleAgeMs: 1, cacheRetention: 1 }),
        { workspaces: 0, publications: 0, caches: 0, claims: 0 },
      );
      assert.equal(fs.existsSync(workspace), true, "pruner crossed a live workspace lease");
    } finally {
      workspaceLease.release();
    }
    assert.equal(
      pruneFastCheckState({ buildDirectory, now, staleAgeMs: 1, cacheRetention: 1 }).workspaces,
      1,
    );
    assert.equal(fs.existsSync(workspace), false);

    fs.mkdirSync(cacheNamespace, { recursive: true, mode: 0o700 });
    const oldKey = "1".repeat(64);
    const newKey = "2".repeat(64);
    const oldCache = path.join(cacheNamespace, oldKey);
    const newCache = path.join(cacheNamespace, newKey);
    fs.mkdirSync(oldCache);
    fs.writeFileSync(path.join(oldCache, "payload.txt"), "clone-safe\n");
    fs.mkdirSync(newCache);
    fs.writeFileSync(path.join(newCache, "payload.txt"), "retained\n");
    fs.utimesSync(oldCache, old, old);
    const destination = path.join(temporary, "clone");
    let attemptedPrune;
    cloneCachedDirectory(oldCache, destination, {
      buildDirectory,
      beforeCopy: () => {
        attemptedPrune = pruneFastCheckState({
          buildDirectory,
          now,
          staleAgeMs: 1,
          cacheRetention: 1,
        });
      },
    });
    assert.deepEqual(attemptedPrune, { workspaces: 0, publications: 0, caches: 0, claims: 0 });
    assert.equal(fs.readFileSync(path.join(destination, "payload.txt"), "utf8"), "clone-safe\n");
    assert.equal(fs.existsSync(oldCache), true, "pruner crossed a live cache-clone lease");
    assert.equal(
      pruneFastCheckState({ buildDirectory, now, staleAgeMs: 1, cacheRetention: 1 }).caches,
      1,
    );
    assert.equal(fs.existsSync(oldCache), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("stage timings are concise and preserve the action result", () => {
  const reports = [];
  const ticks = [0n, 1_250_000_000n];
  const result = timedStage("fixture", () => 42, {
    now: () => ticks.shift(),
    report: (line) => reports.push(line),
  });
  assert.equal(result, 42);
  assert.deepEqual(reports, ["[timing] fixture: 1.25s"]);
  assert.equal(formatDuration(12.4), "12ms");
  assert.equal(formatDuration(2250), "2.25s");
});

test("a failing subprocess still reports its stage time and exit status", () => {
  const script = [
    "const { runTimedBoundary, timedRun } = require('./platform/cli/timing');",
    "runTimedBoundary(() => timedRun('failing fixture', process.execPath, ['-e', 'process.exit(7)']));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /^\[timing\] failing fixture: \d+(?:ms|\.\d{2}s)$/mu);
});

test("a signaled subprocess preserves its signal after reporting stage time", () => {
  const script = [
    "const { runTimedBoundary, timedRun } = require('./platform/cli/timing');",
    "runTimedBoundary(() => timedRun('signal fixture', process.execPath, ['-e', \"process.kill(process.pid, 'SIGTERM')\"]));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, null, result.stderr);
  assert.equal(result.signal, "SIGTERM");
  assert.match(result.stdout, /^\[timing\] signal fixture: \d+(?:ms|\.\d{2}s)$/mu);
});

test("signal propagation unwinds cleanup before re-raising the child signal", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-signal-cleanup-"));
  const source = path.join(temporary, "source");
  const evidence = path.join(temporary, "cleanup-evidence.txt");
  const environment = externalEnvironment(temporary);
  const before = runGit(root, "status", "--porcelain=v1", "--untracked-files=all");
  try {
    fs.mkdirSync(source);
    runGit(source, "init", "--quiet", "--initial-branch=main");
    runGit(source, "config", "user.name", "Signal Test");
    runGit(source, "config", "user.email", "signal@example.invalid");
    fs.writeFileSync(path.join(source, "fixture.txt"), "fixture\n");
    runGit(source, "add", "--all");
    runGit(source, "commit", "--quiet", "-m", "fixture");
    const script = [
      "const fs = require('node:fs');",
      "const { createDisposableWorkspace } = require(process.argv[1]);",
      "const { runTimedBoundary, timedRun } = require(process.argv[2]);",
      "runTimedBoundary(() => {",
      "  const workspace = createDisposableWorkspace('signal-cleanup', { sourceRoot: process.argv[3] });",
      "  fs.writeFileSync(process.argv[4], workspace.root + '\\n');",
      "  try {",
      "    timedRun('cleanup signal fixture', process.execPath, ['-e', \"process.kill(process.pid, 'SIGTERM')\"]);",
      "  } finally {",
      "    workspace.finish();",
      "    fs.appendFileSync(process.argv[4], 'cleaned=' + String(!fs.existsSync(workspace.root)) + '\\n');",
      "  }",
      "});",
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "-e",
      script,
      path.join(root, "platform/cli/checks.js"),
      path.join(root, "platform/cli/timing.js"),
      source,
      evidence,
    ], { cwd: root, env: environment, encoding: "utf8" });
    assert.equal(result.status, null, result.stderr);
    assert.equal(result.signal, "SIGTERM");
    const [workspace, cleaned] = fs.readFileSync(evidence, "utf8").trim().split("\n");
    assert.equal(cleaned, "cleaned=true");
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(runGit(root, "status", "--porcelain=v1", "--untracked-files=all"), before);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Cargo list output distinguishes matching tests from empty filters", () => {
  assert.deepEqual(listedRustTests([
    "service::one: test",
    "service::two: test",
    "",
    "2 tests, 0 benchmarks",
  ].join("\n")), ["service::one: test", "service::two: test"]);
  assert.deepEqual(listedRustTests("0 tests, 0 benchmarks\n"), []);
  assert.deepEqual(
    focusedRustTestArguments("production_wrapping_key_is_4096_bit"),
    [
      "test", "--workspace", "--locked", "production_wrapping_key_is_4096_bit",
      "--", "--include-ignored",
    ],
    "a discovered ignored match must execute rather than report a zero-test success",
  );
});

test("Center development keeps dependencies and Next output outside source", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "center/package.json"), "utf8"));
  const dockerfile = fs.readFileSync(path.join(root, "center/Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(root, "platform/compose/development.yaml"), "utf8");
  const checks = fs.readFileSync(path.join(root, "platform/cli/checks.js"), "utf8");

  assert.match(manifest.scripts.dev, /^next dev --turbopack -H 0\.0\.0\.0 -p 4000$/u);
  assert.match(dockerfile, /^FROM base AS development$/mu);
  assert.match(dockerfile, /COPY --from=dependencies --chown=node:node \/app\/node_modules \.\/node_modules/u);
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(compose, /^\s+image: ai-pin-revival\/center-development:\$\{REVIVAL_RELEASE_ID:/mu);
  assert.match(compose, /^\s+target: development$/mu);
  assert.match(compose, /^\s+- center-development-next:\/app\/\.next$/mu);
  assert.match(compose, /^\s+develop:\n\s+watch:$/mu);
  assert.match(compose, /action: sync\n\s+path: \.\/center\n\s+target: \/app/u);
  assert.match(compose, /action: rebuild\n\s+path: \.\/center\/package-lock\.json/u);
  assert.match(compose, /action: sync\+restart\n\s+path: \.\/contracts\/wire\n\s+target: \/app\/contracts/u);
  assert.match(compose, /^\s+- node_modules\/$/mu);
  assert.match(compose, /^\s+- \.next\/$/mu);
  assert.match(checks, /\['ci', '--include=dev'\]/u);
  assert.match(checks, /timedRun\('Spotify adapter tests'/u);
  assert.deepEqual(
    composeArgs({ REVIVAL_IDENTITY_ENABLED: "false" }, ["watch", "center"], {
      project: "ai-pin-revival-dev",
    }).slice(0, 4),
    ["compose", "--project-name", "ai-pin-revival-dev", "--env-file"],
  );
});

test("bad fast-workflow usage fails before runtime initialization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-fast-workflow-"));
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
  };
  try {
    const badCheck = spawnSync(process.execPath, [
      path.join(root, "revival"), "check", "cosmos", "one", "two",
    ], { cwd: root, env, encoding: "utf8" });
    assert.equal(badCheck.status, 64, badCheck.stderr);
    assert.match(badCheck.stderr, /usage: \.\/revival check cosmos/u);

    const emptyFilter = spawnSync(process.execPath, [
      path.join(root, "revival"), "check", "cosmos", "",
    ], { cwd: root, env, encoding: "utf8" });
    assert.equal(emptyFilter.status, 64, emptyFilter.stderr);
    assert.match(emptyFilter.stderr, /usage: \.\/revival check cosmos/u);

    const badDev = spawnSync(process.execPath, [
      path.join(root, "revival"), "dev", "unknown",
    ], { cwd: root, env, encoding: "utf8" });
    assert.equal(badDev.status, 64, badDev.stderr);
    assert.match(badDev.stderr, /usage: \.\/revival dev center \| down/u);
    assert.equal(fs.existsSync(env.REVIVAL_DATA_DIR), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
