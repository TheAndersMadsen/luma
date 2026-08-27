import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const {
  changedCheckComponents,
  changedPaths,
  checksForPath,
  dependencyFingerprint,
  focusedRustTestArguments,
  listedRustTests,
  normalizedNpmInstallEnvironment,
  parseChangedArguments,
  parsePlatformArguments,
  prepareNpmDependencies,
  pruneCargoIncremental,
  requiresFullPlatformCheck,
  runCenterCheck,
  runPlatformCheck,
  runSelectedComponents,
} = require("../../cli/checks.js");
const {
  BUILD_DIR,
  cosmosTestEnvironment,
  testProcessEnvironment,
} = require("../../cli/context.js");
const {
  pinContributorCheck,
  policyTestArguments,
  policyTestInventory,
  policyTestMode,
  policyTestPlan,
} = require("../../cli/gates.js");
const { formatDuration, timedStage } = require("../../cli/timing.js");
const { sameVersion } = require("../../cli/toolchain.js");
const { resolveTool, trustedPath } = require("../../cli/authority.js");

test("the validated active Node owns child checks and trusted PATH", () => {
  assert.equal(resolveTool("node"), process.execPath);
  assert.equal(trustedPath().split(path.delimiter)[0], path.dirname(process.execPath));
});

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-changed-"));
  runGit(directory, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(directory, "README.md"), "initial\n");
  fs.writeFileSync(path.join(directory, "deleted.txt"), "delete me\n");
  fs.writeFileSync(path.join(directory, "rename-source.txt"), "rename me\n");
  runGit(directory, "add", ".");
  runGit(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "initial");
  return directory;
}

test("the operational Rust toolchain match is exact", () => {
  assert.equal(sameVersion([1, 91, 1], [1, 91, 1]), true);
  assert.equal(sameVersion([1, 91, 0], [1, 91, 1]), false);
  assert.equal(sameVersion([1, 91], [1, 91, 1]), false);
});

test("Cosmos test environment drops credentials and points its target outside the repository", () => {
  const environment = cosmosTestEnvironment({
    ...process.env,
    DATABASE_URL: "postgres://production",
    AWS_SECRET_ACCESS_KEY: "secret",
    NODE_OPTIONS: "--require=/tmp/inject.cjs",
    CARGO_TARGET_DIR: "/tmp/poison-target",
    NPM_CONFIG_CACHE: "/tmp/poison-cache",
  });
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.notEqual(environment.CARGO_TARGET_DIR, "/tmp/poison-target");
  assert.notEqual(environment.NPM_CONFIG_CACHE, "/tmp/poison-cache");
  assert.equal(path.isAbsolute(environment.CARGO_TARGET_DIR), true);
  assert.equal(environment.CARGO_TARGET_DIR.startsWith(`${root}${path.sep}`), false);
});

test("Cosmos checks bound superseded incremental states without touching active variants", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "revival-cargo-target-"));
  const incremental = path.join(target, "debug", "incremental");
  fs.mkdirSync(incremental, { recursive: true });
  const now = Date.now();
  try {
    for (const [index, age] of [50_000, 40_000, 30_000, 20_000, 100].entries()) {
      const directory = path.join(incremental, `cosmos-hash${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "artifact"), "compiled");
      const modified = new Date(now - age);
      fs.utimesSync(directory, modified, modified);
    }
    const foreign = path.join(incremental, "not-a-cargo-entry");
    fs.mkdirSync(foreign);

    assert.equal(pruneCargoIncremental(target, { now, keep: 2, activeMs: 1_000 }), 3);
    assert.deepEqual(
      fs.readdirSync(incremental).sort(),
      ["cosmos-hash3", "cosmos-hash4", "not-a-cargo-entry"],
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("npm normalization ignores inherited behavior changes and uses the external cache", () => {
  const normalized = normalizedNpmInstallEnvironment({
    PATH: "/fixture/bin",
    npm_config_registry: "https://attacker.invalid",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NODE_OPTIONS: "--require=/tmp/inject.cjs",
  }, { cacheDirectory: "/fixture/cache" });
  assert.equal(normalized.PATH, "/fixture/bin");
  assert.equal(normalized.npm_config_registry, undefined);
  assert.equal(normalized.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
  assert.equal(normalized.NODE_OPTIONS, undefined);
  assert.equal(normalized.NPM_CONFIG_CACHE, "/fixture/cache");
  assert.equal(normalized.NPM_CONFIG_INCLUDE, "dev");
});

test("dependency reuse keys only the package manifests and exact runtime platform", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-dependencies-"));
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "package-lock.json"), '{"lockfileVersion":3}\n');
    const runtime = {
      npmVersion: "11.4.2",
      nodeVersion: "22.14.0",
      platform: process.platform,
      arch: process.arch,
    };
    const baseline = dependencyFingerprint(temporary, runtime);
    assert.equal(
      dependencyFingerprint(temporary, { npmVersion: runtime.npmVersion, nodeVersion: runtime.nodeVersion }),
      baseline,
      "the host platform and architecture are the defaults",
    );
    fs.writeFileSync(path.join(temporary, "source.mjs"), "export default 1;\n");
    assert.equal(
      dependencyFingerprint(temporary, runtime),
      baseline,
      "ordinary source edits must not invalidate dependencies",
    );
    assert.notEqual(
      dependencyFingerprint(temporary, { npmVersion: "11.4.3", nodeVersion: "22.14.0" }),
      baseline,
    );
    const otherPlatform = process.platform === "darwin" ? "linux" : "darwin";
    const otherArchitecture = process.arch === "arm64" ? "x64" : "arm64";
    assert.notEqual(dependencyFingerprint(temporary, { ...runtime, platform: otherPlatform }), baseline);
    assert.notEqual(dependencyFingerprint(temporary, { ...runtime, arch: otherArchitecture }), baseline);
    fs.writeFileSync(path.join(temporary, ".npmrc"), "install-links=true\n");
    const withNpmrc = dependencyFingerprint(temporary, runtime);
    assert.notEqual(withNpmrc, baseline, "adding project npm policy must invalidate dependencies");
    fs.appendFileSync(path.join(temporary, ".npmrc"), "strict-peer-deps=true\n");
    assert.notEqual(
      dependencyFingerprint(temporary, runtime),
      withNpmrc,
      "changing project npm policy must invalidate dependencies",
    );
    fs.appendFileSync(path.join(temporary, "package-lock.json"), " ");
    assert.notEqual(
      dependencyFingerprint(temporary, runtime),
      baseline,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed partial npm install cannot leave an old reusable stamp", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-npm-retry-"));
  const namespace = `fixture-retry-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  const packageLock = path.join(temporary, "package-lock.json");
  let calls = 0;
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(packageLock, '{"lockfileVersion":3}\n');
    const runner = () => {
      calls += 1;
      fs.mkdirSync(path.join(temporary, "node_modules"), { recursive: true });
      if (calls === 2) fs.writeFileSync(path.join(temporary, "node_modules", "partial"), "partial\n");
      return { status: calls === 2 ? 1 : 0, signal: null, stdout: "", stderr: "failed" };
    };

    prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner);
    fs.writeFileSync(packageLock, '{"lockfileVersion":3,"changed":true}\n');
    fs.writeFileSync(lock, "held\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner), (error) => {
      assert.match(error.message, /install is already running/u);
      assert.equal(error.message.includes(lock), true, "contention must identify the exact stale lock path");
      return true;
    });
    assert.equal(calls, 1, "contention must fail before npm ci");
    assert.equal(fs.existsSync(lock), true, "a contender must not release another invocation's lock");
    fs.unlinkSync(lock);

    assert.throws(() => prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner));
    assert.equal(fs.existsSync(stamp), false, "a failed npm ci must leave no reusable stamp");
    assert.equal(fs.existsSync(lock), false, "a failed npm ci must release its install lock");

    fs.writeFileSync(packageLock, '{"lockfileVersion":3}\n');
    assert.equal(
      prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      false,
      "retry must run npm ci instead of trusting the partial node_modules tree",
    );
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(lock, { force: true });
    fs.rmSync(stamp, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("an atomic lock owner leaves a foreign replacement intact", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-npm-lock-owner-"));
  const namespace = `fixture-owner-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "package-lock.json"), '{"lockfileVersion":3}\n');
    prepareNpmDependencies(temporary, namespace, "11.4.2", {}, () => {
      fs.mkdirSync(path.join(temporary, "node_modules"));
      fs.writeFileSync(lock, "foreign replacement\n");
      return { status: 0, signal: null, stdout: "", stderr: "" };
    });
    assert.equal(fs.readFileSync(lock, "utf8"), "foreign replacement\n");
  } finally {
    fs.rmSync(lock, { force: true });
    fs.rmSync(stamp, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm dependency preparation installs once and reuses the working-tree modules", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-npm-"));
  const namespace = `fixture-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  const calls = [];
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "package-lock.json"), '{"lockfileVersion":3}\n');
    const runner = (...arguments_) => {
      calls.push(arguments_);
      fs.mkdirSync(path.join(temporary, "node_modules"));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    assert.equal(
      prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      false,
    );
    assert.equal(
      prepareNpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      true,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), [
      `${namespace} dependencies`, "npm", ["ci", "--include=dev"],
    ]);
  } finally {
    fs.rmSync(lock, { force: true });
    fs.rmSync(stamp, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Center checks execute directly in the source tree with external incremental output", () => {
  const commands = [];
  const prepared = [];
  runCenterCheck({
    environment: testProcessEnvironment(),
    npmVersion: "11.4.2",
    prepareDependencies(project, namespace) { prepared.push([project, namespace]); },
    runner(label, command, args, options) {
      commands.push({ label, command, args, options });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(prepared.map((entry) => entry[1]), ["center-npm", "spotify-adapter-npm"]);
  assert.equal(prepared[0][0], path.join(root, "center"));
  assert.deepEqual(commands.map((entry) => entry.label), [
    "center typecheck", "center server tests", "center UI tests", "Spotify adapter tests",
  ]);
  assert.equal(commands[0].options.cwd, path.join(root, "center"));
  assert.equal(commands[0].args.includes("--tsBuildInfoFile"), true);
  const buildInfo = commands[0].args.at(-1);
  assert.equal(buildInfo.startsWith(`${BUILD_DIR}${path.sep}`), true);
  assert.equal(buildInfo.startsWith(`${root}${path.sep}`), false);
  assert.equal(path.basename(buildInfo), "tsconfig.tsbuildinfo");
  const typecheckLock = path.join(BUILD_DIR, "center", "typecheck.lock");
  assert.equal(fs.existsSync(typecheckLock), false);
  fs.writeFileSync(typecheckLock, "held\n", { flag: "wx", mode: 0o600 });
  try {
    assert.throws(() => runCenterCheck({
      environment: testProcessEnvironment(),
      npmVersion: "11.4.2",
      prepareDependencies() {},
      runner() { throw new Error("typecheck runner must not start during contention"); },
    }), /Center typecheck is already running/u);
    assert.equal(fs.existsSync(typecheckLock), true, "a contender must not release the active typecheck lock");
  } finally {
    fs.unlinkSync(typecheckLock);
  }
});

test("platform checks keep the fast contributor inventory distinct from the dynamic full inventory", () => {
  const observed = [];
  runPlatformCheck({
    environment: testProcessEnvironment(),
    policyRunner(environment, options) { observed.push({ environment, options }); },
  });
  runPlatformCheck({
    full: true,
    environment: testProcessEnvironment(),
    policyRunner(environment, options) { observed.push({ environment, options }); },
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].options.contributor, true);
  assert.equal(observed[1].options.contributor, false);
  assert.deepEqual(policyTestMode(), { contributor: false });
  assert.deepEqual(parsePlatformArguments([]), { full: false });
  assert.deepEqual(parsePlatformArguments(["--full"]), { full: true });
});

test("Pin check runs direct contributor checks", () => {
  const ordering = [];
  pinContributorCheck({
    sessionRunner(label, command, args) {
      ordering.push([label, command, args.slice()]);
    },
  });
  const [coreRust, bridgeRust, pinGradle, injectorGradle] = ordering;
  assert.deepEqual(coreRust, [
    "Pin contributor check: cargo test --locked",
    "cargo",
    ["test", "--locked"],
  ]);
  assert.deepEqual(bridgeRust, [
    "Pin contributor check: cargo test --locked",
    "cargo",
    ["test", "--locked"],
  ]);
  assert.match(
    pinGradle[0],
    new RegExp(`^Pin contributor check: bash ${path.join(root, "pin", "gradlew")} --no-daemon --project-cache-dir `),
  );
  assert.equal(pinGradle[1], "bash");
  assert.equal(pinGradle[2][0], path.join(root, "pin", "gradlew"));
  assert.equal(pinGradle[2][1], "--no-daemon");
  assert.equal(pinGradle[2].includes(":hook:payload:testDebugUnitTest"), true);
  assert.match(
    injectorGradle[0],
    new RegExp(`^Pin contributor check: bash ${path.join(root, "pin", "injector", "gradlew")} --no-daemon --project-cache-dir `),
  );
  assert.equal(injectorGradle[1], "bash");
  assert.equal(injectorGradle[2][0], path.join(root, "pin", "injector/gradlew"));
  assert.equal(injectorGradle[2][1], "--no-daemon");
});

test("changed paths select precise component checks and unfamiliar paths fail closed", () => {
  assert.deepEqual([...checksForPath("center/src/app/page.tsx")], ["center"]);
  assert.deepEqual([...checksForPath("cosmos/crates/cosmos/src/lib.rs")], ["cosmos"]);
  assert.deepEqual([...checksForPath("pin/runtime/core/src/lib.rs")], ["pin"]);
  assert.deepEqual([...checksForPath("README.md")], ["platform"]);
  assert.equal(requiresFullPlatformCheck("README.md"), false);
  assert.equal(requiresFullPlatformCheck("center/src/app/page.tsx"), false);
  assert.equal(requiresFullPlatformCheck("platform/deploy/acceptance/new-check.test.mjs"), true);
  assert.equal(requiresFullPlatformCheck("unknown-root/file"), true);
  assert.deepEqual([...checksForPath("contracts/wire/humane/aibus.proto")], [
    "platform", "center", "cosmos", "pin",
  ]);
  assert.deepEqual([...checksForPath("unknown-root/file")], [
    "platform", "center", "cosmos", "pin",
  ]);
  assert.deepEqual(changedCheckComponents([
    "center/src/app/page.tsx", "cosmos/crates/cosmos/src/lib.rs",
  ]), ["center", "cosmos"]);
  const calls = [];
  runSelectedComponents(["platform", "center"],
    (component, options) => calls.push([component, options.fullPlatform]),
    { fullPlatform: true });
  assert.deepEqual(calls, [["platform", true], ["center", true]]);
});

test("changed paths include committed, staged, unstaged, deleted, and untracked files", () => {
  const repository = gitFixture();
  try {
    const base = runGit(repository, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repository, "committed.txt"), "committed\n");
    runGit(repository, "add", "committed.txt");
    runGit(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "-m", "committed");
    fs.writeFileSync(path.join(repository, "staged.txt"), "staged\n");
    runGit(repository, "add", "staged.txt");
    fs.rmSync(path.join(repository, "deleted.txt"));
    runGit(repository, "mv", "rename-source.txt", "rename-destination.txt");
    fs.appendFileSync(path.join(repository, "README.md"), "unstaged\n");
    fs.writeFileSync(path.join(repository, "untracked.txt"), "untracked\n");
    const changed = changedPaths(base, { cwd: repository, environment: testProcessEnvironment() });
    assert.deepEqual(changed.files, [
      "README.md", "committed.txt", "deleted.txt", "rename-destination.txt",
      "rename-source.txt", "staged.txt", "untracked.txt",
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("automatic changed selection uses the full tracked tree when no remote base exists", () => {
  const repository = gitFixture();
  try {
    const changed = changedPaths(null, { cwd: repository, environment: testProcessEnvironment() });
    assert.equal(changed.base, null);
    assert.deepEqual(changed.files, ["README.md", "deleted.txt", "rename-source.txt"]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("a no-change selection does no component work", () => {
  const repository = gitFixture();
  try {
    const changed = changedPaths("HEAD", { cwd: repository, environment: testProcessEnvironment() });
    assert.deepEqual(changed.files, []);
    assert.deepEqual(changedCheckComponents(changed.files), []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("changed-check arguments retain an explicit comparison base", () => {
  assert.deepEqual(parseChangedArguments([]), { base: null });
  assert.deepEqual(parseChangedArguments(["--base", "origin/main"]), { base: "origin/main" });
});

test("Cargo test discovery distinguishes matching tests from an empty filter", () => {
  assert.deepEqual(listedRustTests("alpha: test\nbeta: test\n"), ["alpha: test", "beta: test"]);
  assert.deepEqual(listedRustTests("0 tests, 0 benchmarks\n"), []);
  assert.deepEqual(focusedRustTestArguments("alpha"), [
    "test", "--workspace", "--locked", "alpha", "--", "--include-ignored",
  ]);
});

test("platform policy files share one bounded-concurrency runner", () => {
  assert.deepEqual(policyTestArguments(["a.test.mjs"], 2), [
    "--no-warnings", "--experimental-strip-types", "--test", "--test-concurrency=2", "a.test.mjs",
  ]);
  assert.deepEqual(policyTestPlan([
    "z-safe.test.mjs", "fresh-install.test.mjs", "a-safe.test.mjs",
  ]), {
    parallel: ["a-safe.test.mjs", "z-safe.test.mjs"],
    serial: ["fresh-install.test.mjs"],
  });
  const acceptance = path.join(root, "platform", "deploy", "acceptance");
  const fullInventory = policyTestInventory(acceptance);
  assert.equal(fullInventory.includes(path.join("pin", "pinbox.test.mjs")), true);
  assert.equal(
    policyTestInventory(acceptance, { contributor: true }).some(
      (entry) => entry.startsWith(`pin${path.sep}`),
    ),
    false,
  );
  const entrypoint = fs.readFileSync(
    path.join(root, "platform", "containers", "pin-builder", "entrypoint.sh"),
    "utf8",
  );
  assert.match(entrypoint, /:hook:payload:testDebugUnitTest/u);
});

test("stage timings are concise and preserve the action result", () => {
  const reports = [];
  const ticks = [10_000_000n, 1_244_000_000n];
  const result = timedStage("fixture", () => 42, {
    now: () => ticks.shift(),
    report: (message) => reports.push(message),
  });
  assert.equal(result, 42);
  assert.deepEqual(reports, ["[timing] fixture: 1.23s"]);
  assert.equal(formatDuration(999), "999ms");
});

test("bad direct-loop usage fails before doing component work", () => {
  for (const args of [
    ["check", "cosmos", ""],
    ["check", "center", "extra"],
    ["check", "platform", "--fast"],
    ["check", "pin"],
    ["check", "changed", "--base"],
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, "revival"), ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
  }
});
