import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  normalizedPnpmInstallEnvironment,
  parseChangedArguments,
  parsePlatformArguments,
  preparePnpmDependencies,
  productionPostgresImage,
  pruneCargoIncremental,
  requiresFullPlatformCheck,
  runCenterCheck,
  runPlatformCheck,
  runSelectedComponents,
  withAtomicLock,
  withTestPostgres,
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
  assert.equal(resolveTool("bun"), process.execPath);
  assert.equal(trustedPath().split(path.delimiter)[0], path.dirname(process.execPath));
});

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-changed-"));
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
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "luma-cargo-target-"));
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

// A concurrent cargo removes superseded state too, so a prune can lose the
// race between the directory listing and each entry step. Race both windows
// the way cargo would: vanish an entry before its stat, and before its removal.
test("pruning tolerates the entries a concurrent cargo removes mid-scan", () => {
  const staleEntries = (target, ages) => {
    const incremental = path.join(target, "debug", "incremental");
    fs.mkdirSync(incremental, { recursive: true });
    for (const [index, age] of ages.entries()) {
      const directory = path.join(incremental, `cosmos-hash${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "artifact"), "compiled");
      const modified = new Date(Date.now() - age);
      fs.utimesSync(directory, modified, modified);
    }
    return incremental;
  };
  const raceStat = (removeFirst) => {
    const realLstat = fs.lstatSync;
    let raced = 0;
    fs.lstatSync = (entry, ...rest) => {
      if (removeFirst.includes(entry)) {
        raced += 1;
        fs.rmSync(entry, { recursive: true, force: true });
      }
      return realLstat(entry, ...rest);
    };
    return () => {
      fs.lstatSync = realLstat;
      return raced;
    };
  };
  const raceRemoval = (removeFirst) => {
    const realRm = fs.rmSync;
    let raced = 0;
    fs.rmSync = (entry, options, ...rest) => {
      if (options?.recursive === true && options.force === false && removeFirst.includes(entry)) {
        raced += 1;
        realRm(entry, { recursive: true, force: true });
      }
      return realRm(entry, options, ...rest);
    };
    return () => {
      fs.rmSync = realRm;
      return raced;
    };
  };
  const now = Date.now();

  // The vanished entry is skipped where it stood. The other stale one is
  // still removed and the kept one survives.
  const statTarget = fs.mkdtempSync(path.join(os.tmpdir(), "luma-cargo-race-stat-"));
  try {
    const statIncremental = staleEntries(statTarget, [50_000, 40_000, 30_000]);
    const restore = raceStat([path.join(statIncremental, "cosmos-hash0")]);
    // hash2 (newest) is kept. Hash1 is removed. Hash0 loses the stat race.
    assert.equal(pruneCargoIncremental(statTarget, { now, keep: 1, activeMs: 1_000 }), 1);
    assert.equal(restore(), 1);
    assert.deepEqual(fs.readdirSync(statIncremental).sort(), ["cosmos-hash2"]);
  } finally {
    fs.rmSync(statTarget, { recursive: true, force: true });
  }

  // A removal that loses the race is skipped. The survivor of keep is kept.
  const rmTarget = fs.mkdtempSync(path.join(os.tmpdir(), "luma-cargo-race-rm-"));
  try {
    const rmIncremental = staleEntries(rmTarget, [50_000, 40_000]);
    const restore = raceRemoval([path.join(rmIncremental, "cosmos-hash0")]);
    assert.equal(pruneCargoIncremental(rmTarget, { now, keep: 1, activeMs: 1_000 }), 0);
    assert.equal(restore(), 1);
    assert.deepEqual(fs.readdirSync(rmIncremental).sort(), ["cosmos-hash1"]);
  } finally {
    fs.rmSync(rmTarget, { recursive: true, force: true });
  }
});

test("a failing prune never flips a passed Cosmos check", () => {
  const { result } = runRecordedCosmosCheck({ breakPrune: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: skipped Cargo incremental pruning: fixture prune failure/u);
});

function fakePostgresDocker({ daemon = true, runStatus = 0, readyAfter = 1, rmStatus = 0, stale = "" } = {}) {
  const calls = [];
  let probes = 0;
  const docker = (args, env) => {
    calls.push({ args, env });
    if (args[0] === "version") {
      return daemon
        ? { status: 0, stdout: "29.6.2\n", stderr: "" }
        : { status: null, signal: "SIGKILL", stdout: "", stderr: "docker version did not answer within 30s" };
    }
    if (args[0] === "ps") return { status: 0, stdout: stale, stderr: "" };
    if (args[0] === "run") return { status: runStatus, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    if (args[0] === "rm") return { status: rmStatus, stdout: "", stderr: "" };
    if (args[0] === "exec") {
      probes += 1;
      return { status: probes > readyAfter ? 0 : 2, stdout: "", stderr: "" };
    }
    if (args[0] === "port") return { status: 0, stdout: "127.0.0.1:54321\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, docker };
}

test("the Postgres-backed tests get a throwaway production Postgres that is always removed", () => {
  const productionCompose = fs.readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
  const image = productionPostgresImage();
  assert.match(image, /^postgres:[^@\s]+@sha256:[0-9a-f]{64}$/u);
  assert.equal(productionCompose.includes(`image: ${image}\n`), true);
  const environment = { PATH: "/fixture/bin" };
  const reapers = [];
  const startReaper = (name, env) => {
    const reaper = { name, env, stopped: false };
    reapers.push(reaper);
    return { stop: () => { reaper.stopped = true; } };
  };
  const options = (docker) => ({ docker, startReaper, sleep: () => {}, now: () => 0 });

  const { calls, docker } = fakePostgresDocker({ readyAfter: 2 });
  let received = null;
  assert.equal(withTestPostgres(environment, (url) => { received = url; return "tests ran"; }, options(docker)),
    "tests ran");
  const [probe, sweep, started, ...rest] = calls;
  assert.deepEqual(probe.args, ["version", "--format", "{{.Server.Version}}"]);
  const label = "dk.andersmadsen.luma.environment=cosmos-test";
  assert.deepEqual(sweep.args, [
    "ps", "--all", "--quiet", "--filter", `label=${label}`, "--filter", "status=exited",
    "--filter", "status=dead",
  ], "only stopped throwaway containers are swept; a concurrent check's running one stays");
  assert.equal(sweep.args.some((argument) => argument.startsWith("name=")), false,
    "Docker's name filter matches substrings, so it could select an unrelated container");
  const name = started.args[started.args.indexOf("--name") + 1];
  assert.match(name, /^luma-cosmos-test-[0-9a-f]{16}$/u);
  assert.equal(started.args[started.args.indexOf("--label") + 1], label, "the sweep's label marks every throwaway");
  assert.equal(started.args.at(-1), image);
  assert.equal(started.args[started.args.indexOf("--publish") + 1], "127.0.0.1::5432");
  const password = started.env.POSTGRES_PASSWORD;
  assert.match(password, /^[0-9a-f]{48}$/u);
  assert.equal(started.args.includes("POSTGRES_PASSWORD"), true);
  assert.equal(started.args.some((argument) => argument.includes(password)), false, "no password in argv");
  assert.equal(environment.POSTGRES_PASSWORD, undefined, "the caller's environment is not modified");
  assert.equal(received, `postgresql://cosmos_test:${password}@127.0.0.1:54321/cosmos_test`);
  assert.deepEqual(rest.map((call) => call.args[0]), ["exec", "exec", "exec", "port", "rm"]);
  assert.deepEqual(rest.at(-1).args, ["rm", "--force", "--volumes", name]);
  assert.deepEqual(reapers.map((reaper) => [reaper.name, reaper.env, reaper.stopped]), [[name, environment, true]]);

  const failing = fakePostgresDocker();
  assert.throws(() => withTestPostgres(environment, () => {
    throw new Error("a Postgres-backed test failed");
  }, options(failing.docker)), /a Postgres-backed test failed/u);
  assert.deepEqual(failing.calls.at(-1).args.slice(0, 3), ["rm", "--force", "--volumes"]);

  const noDaemon = fakePostgresDocker({ runStatus: 1 });
  let ran = false;
  assert.throws(() => withTestPostgres(environment, () => { ran = true; }, options(noDaemon.docker)),
    /needs Docker\. Install and start Docker Desktop or Docker Engine, then rerun\. docker run failed: Cannot connect/u);
  assert.equal(ran, false);
  assert.deepEqual(noDaemon.calls.map((call) => call.args[0]), ["version", "ps", "run", "rm"]);

  const hung = fakePostgresDocker({ daemon: false });
  assert.throws(() => withTestPostgres(environment, () => { ran = true; }, options(hung.docker)),
    /needs Docker\. .*Docker is not answering: docker version did not answer within 30s/u);
  assert.equal(ran, false);
  assert.deepEqual(hung.calls.map((call) => call.args[0]), ["version", "rm"]);

  const neverReady = fakePostgresDocker({ readyAfter: Infinity });
  let clock = 0;
  assert.throws(() => withTestPostgres(environment, () => { ran = true; }, {
    ...options(neverReady.docker), readyWithinMs: 1_000, now: () => (clock += 400),
  }), /was not ready within 1s/u);
  assert.equal(ran, false);
  assert.equal(neverReady.calls.at(-1).args[0], "rm");
  assert.equal(reapers.every((reaper) => reaper.stopped), true);

  const leftovers = fakePostgresDocker({ stale: "0123abcd\n4567ef01\n" });
  withTestPostgres(environment, () => {}, options(leftovers.docker));
  assert.deepEqual(leftovers.calls[2].args, ["rm", "--volumes", "0123abcd", "4567ef01"]);
  assert.equal(leftovers.calls[3].args[0], "run");

  const stuck = fakePostgresDocker({ rmStatus: 1 });
  withTestPostgres(environment, () => {}, options(stuck.docker));
  assert.equal(reapers.at(-1).stopped, false, "the reaper retries a removal that failed");
});

test("production Postgres image discovery refuses an ambiguous or unpinned compose file", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-postgres-image-"));
  try {
    const file = path.join(temporary, "production.yaml");
    const pinned = `    image: postgres:16-alpine@sha256:${"a".repeat(64)}\n`;
    for (const contents of ["services: {}\n", "    image: postgres:16-alpine\n", pinned + pinned]) {
      fs.writeFileSync(file, contents);
      assert.throws(() => productionPostgresImage(file), /must pin exactly one digest-addressed postgres image/u);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function runRecordedCosmosCheck({
  filter = null, missing = null, failStage = null, discoveryError = null, ignoredListing = "",
  breakPrune = false,
} = {}) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "luma-cosmos-check-"));
  const script = `
const context = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
const toolchain = require(${JSON.stringify(path.join(root, "platform/cli/toolchain.js"))});
const { runTimedBoundary, throwLikeChild } = require(${JSON.stringify(path.join(root, "platform/cli/timing.js"))});
context.exists = (command) => command !== ${JSON.stringify(missing)};
toolchain.validateHostToolchains = () => {};
${breakPrune ? `
// Housekeeping after a passed check races a concurrent cargo. Make every
// incremental-directory listing fail like a lost race or a full disk would.
const nodeFs = require("node:fs");
const realReaddirSync = nodeFs.readdirSync;
nodeFs.readdirSync = (entry, ...rest) => {
  if (String(entry).endsWith(${JSON.stringify(path.join("debug", "incremental"))})) {
    const error = new Error("fixture prune failure");
    error.code = "EACCES";
    throw error;
  }
  return realReaddirSync(entry, ...rest);
};
` : ""}
const { runCosmosCheck } = require(${JSON.stringify(path.join(root, "platform/cli/checks.js"))});
const stages = [];
process.on("exit", () => process.stderr.write("STAGES " + JSON.stringify(stages) + "\\n"));
const runner = (label, command, args, options) => {
  stages.push({ label, url: options.env.COSMOS_TEST_DATABASE_URL ?? null,
    ...(label === "cosmos focused tests" ? { args } : {}) });
  if (label === ${JSON.stringify(failStage)}) throwLikeChild({ status: 101, signal: null });
  if (label === "cosmos test discovery" && ${JSON.stringify(discoveryError)} !== null) {
    return { status: 101, signal: null, stdout: "", stderr: ${JSON.stringify(discoveryError)} };
  }
  if (label === "cosmos ignored test discovery") {
    return { status: 0, signal: null, stdout: ${JSON.stringify(ignoredListing)}, stderr: "" };
  }
  return { status: 0, signal: null, stdout: "store::tests::fixture: test\\n", stderr: "" };
};
const database = (environment, action) => {
  stages.push({ label: "database started" });
  try { return action("postgresql://fixture@127.0.0.1:5/cosmos_test"); } finally { stages.push({ label: "database removed" }); }
};
runTimedBoundary(() => runCosmosCheck(${JSON.stringify(filter)}, {
  environment: { CARGO_TARGET_DIR: ${JSON.stringify(target)} }, runner, database,
}));
`;
  try {
    const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", timeout: 30_000 });
    const stages = JSON.parse(/^STAGES (.*)$/mu.exec(result.stderr)?.[1] ?? "null");
    return { result, stages };
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

test("the Cosmos check hands the throwaway database only to its test stages", () => {
  const url = "postgresql://fixture@127.0.0.1:5/cosmos_test";
  const full = runRecordedCosmosCheck();
  assert.equal(full.result.status, 0, full.result.stderr);
  assert.deepEqual(full.stages, [
    { label: "cosmos format", url: null },
    { label: "cosmos clippy", url: null },
    { label: "cosmos python tests", url: null },
    { label: "cosmos hygiene", url: null },
    { label: "database started" },
    { label: "cosmos tests", url },
    { label: "database removed" },
  ]);

  const focused = runRecordedCosmosCheck({ filter: "store_postgres" });
  assert.equal(focused.result.status, 0, focused.result.stderr);
  assert.deepEqual(focused.stages, [
    { label: "cosmos format", url: null },
    { label: "cosmos test discovery", url: null },
    { label: "cosmos ignored test discovery", url: null },
    { label: "database started" },
    { label: "cosmos focused tests", url, args: ["test", "--workspace", "--locked", "store_postgres"] },
    { label: "database removed" },
  ]);
  assert.match(focused.result.stdout, /Cosmos test filter matched 1 test\.$/mu);

  // Named alone, an ignored live-service test runs.
  const ignored = runRecordedCosmosCheck({ filter: "store::tests::fixture", ignoredListing: "store::tests::fixture: test\n" });
  assert.equal(ignored.result.status, 0, ignored.result.stderr);
  assert.deepEqual(ignored.stages.find((stage) => stage.label === "cosmos focused tests").args,
    ["test", "--workspace", "--locked", "store::tests::fixture", "--", "--ignored"]);

  const failed = runRecordedCosmosCheck({ failStage: "cosmos tests" });
  assert.equal(failed.result.status, 101, "a failing test run keeps its exit status");
  assert.equal(failed.stages.at(-1).label, "database removed");
});

test("a module filter skips its ignored live-service tests and says so", () => {
  const script = `
const context = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
const toolchain = require(${JSON.stringify(path.join(root, "platform/cli/toolchain.js"))});
const { runTimedBoundary } = require(${JSON.stringify(path.join(root, "platform/cli/timing.js"))});
context.exists = () => true;
toolchain.validateHostToolchains = () => {};
const { runCosmosCheck } = require(${JSON.stringify(path.join(root, "platform/cli/checks.js"))});
const listing = "enrollment::tests::a: test\\nenrollment::tests::b: test\\nenrollment::tests::live_keycloak: test\\n";
runTimedBoundary(() => runCosmosCheck("enrollment::tests", {
  environment: { CARGO_TARGET_DIR: ${JSON.stringify(os.tmpdir())} },
  runner: (label, command, args) => {
    if (label === "cosmos focused tests") process.stderr.write("ARGS " + JSON.stringify(args) + "\\n");
    const stdout = label === "cosmos ignored test discovery" ? "enrollment::tests::live_keycloak: test\\n" : listing;
    return { status: 0, signal: null, stdout, stderr: "" };
  },
  database: (environment, action) => action("postgresql://fixture@127.0.0.1:5/cosmos_test"),
}));
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout,
    /Cosmos test filter matched 3 tests; its 1 ignored live-service test is skipped \(name one alone to run it\)\./u);
  assert.deepEqual(JSON.parse(/^ARGS (.*)$/mu.exec(result.stderr)[1]), ["test", "--workspace", "--locked", "enrollment::tests"]);
});

test("a focused Cosmos check that does not compile shows cargo's errors", () => {
  const compileError = "error[E0425]: cannot find value `missing` in this scope\n" +
    "  --> crates/cosmos/src/backends/os3.rs:10:5\n";
  const { result, stages } = runRecordedCosmosCheck({ filter: "os3", discoveryError: compileError });
  assert.equal(result.status, 101, "the check keeps cargo's exit status");
  assert.ok(result.stderr.includes(compileError), result.stderr);
  assert.deepEqual(stages.map((stage) => stage.label), ["cosmos format", "cosmos test discovery"],
    "nothing runs after a build that failed");
});

test("CI covers documentation and can run manually or gate a release at the same commit", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /^  pull_request:/mu);
  assert.match(ci, /^  workflow_dispatch:/mu);
  assert.match(ci, /^  workflow_call:/mu);
  assert.doesNotMatch(ci, /paths-ignore:/u);
  assert.match(ci, /group: ci-\$\{\{ github\.workflow \}\}-/u);
  const jobs = [...ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gmu)]
    .filter(([, , body]) => body.includes("runs-on:"));
  assert.equal(jobs.length, 6);
  for (const [, name, body] of jobs) {
    assert.match(body, /timeout-minutes: [1-9][0-9]*/u, name);
  }
  const pin = jobs.find(([ , name]) => name === "pin-runtime")?.[2];
  assert.ok(pin?.includes("./luma pin check"), "all contributor Pin checks use the pinned builder");
  assert.doesNotMatch(ci, /\.\/gradlew|\.\/device-installer\/gradlew/u);
});

test("the final CI gate rejects every failed, cancelled, or skipped component", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  complete:\n"));
  assert.match(job, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(job, /needs: \[platform, center, cosmos, pin-runtime, pin-builder-linux-amd64\]/u);
  assert.match(job, /CHECK_RESULTS: \$\{\{ toJSON\(needs\) \}\}/u);
  const script = /        run: \|\n((?:          .*\n)+)/u.exec(job)?.[1].replace(/^          /gmu, "");
  assert.ok(script, "the final gate is executable");
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const run = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, CHECK_RESULTS: JSON.stringify({ first: { result: "success" }, last: { result } }) },
    });
    assert.equal(run.status, result === "success" ? 0 : 1, `${result}: ${run.stderr}`);
  }
});

test("CI runs every Postgres-backed Cosmos test against its production-pinned service", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const start = ci.indexOf("\n  cosmos:\n");
  assert.notEqual(start, -1, "CI has a cosmos job");
  const next = ci.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  const job = next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  assert.equal(job.includes(`image: ${productionPostgresImage()}\n`), true, "the service is production's Postgres");
  const step = /- name: focused component checks\n((?: {8}.*\n)+)/u.exec(job);
  assert.ok(step, "the cosmos job runs the workspace tests");
  assert.match(step[1], /cargo test --workspace --locked --manifest-path cosmos\/Cargo\.toml\n/u);
  // Without the URL every Postgres-backed test prints SKIPPED and passes.
  assert.match(
    step[1],
    /COSMOS_TEST_DATABASE_URL: postgresql:\/\/cosmos_test:cosmos_test_ci_only@127\.0\.0\.1:5432\/cosmos_test\n/u,
  );
  assert.equal(job.includes("-- --exact"), false,
    "no hand-picked Postgres test list that can silently match nothing");
});

test("without Docker the Cosmos check fails loudly with the fix instead of skipping", () => {
  const { result, stages } = runRecordedCosmosCheck({ missing: "docker" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: Cosmos check runs the Postgres-backed tests against a throwaway PostgreSQL container, so it needs Docker\. Install and start Docker Desktop or Docker Engine, then rerun/u);
  assert.deepEqual(stages, [], "nothing runs, so no Postgres-backed test can skip");
});

test("pnpm normalization ignores inherited behavior changes and uses the external cache", () => {
  const normalized = normalizedPnpmInstallEnvironment({
    PATH: "/fixture/bin",
    npm_config_registry: "https://attacker.invalid",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NODE_OPTIONS: "--require=/tmp/inject.cjs",
  }, { cacheDirectory: "/fixture/cache" });
  assert.equal(normalized.PATH, "/fixture/bin");
  assert.equal(normalized.npm_config_registry, undefined);
  assert.equal(normalized.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
  assert.equal(normalized.NODE_OPTIONS, undefined);
  assert.equal(normalized.NPM_CONFIG_STORE_DIR, "/fixture/cache");
  assert.equal(normalized.NPM_CONFIG_INCLUDE, "dev");
});

test("dependency reuse keys only the package manifests and exact runtime platform", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-dependencies-"));
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "pnpm-lock.yaml"), '{"lockfileVersion":3}\n');
    const runtime = {
      pnpmVersion: "11.4.2",
      bunVersion: "22.14.0",
      platform: process.platform,
      arch: process.arch,
    };
    const baseline = dependencyFingerprint(temporary, runtime);
    assert.equal(
      dependencyFingerprint(temporary, { pnpmVersion: runtime.pnpmVersion, bunVersion: runtime.bunVersion }),
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
      dependencyFingerprint(temporary, { pnpmVersion: "11.4.3", bunVersion: "22.14.0" }),
      baseline,
    );
    const otherPlatform = process.platform === "darwin" ? "linux" : "darwin";
    const otherArchitecture = process.arch === "arm64" ? "x64" : "arm64";
    assert.notEqual(dependencyFingerprint(temporary, { ...runtime, platform: otherPlatform }), baseline);
    assert.notEqual(dependencyFingerprint(temporary, { ...runtime, arch: otherArchitecture }), baseline);
    fs.writeFileSync(path.join(temporary, ".npmrc"), "install-links=true\n");
    const withNpmrc = dependencyFingerprint(temporary, runtime);
    assert.notEqual(withNpmrc, baseline, "adding project pnpm policy must invalidate dependencies");
    fs.appendFileSync(path.join(temporary, ".npmrc"), "strict-peer-deps=true\n");
    assert.notEqual(
      dependencyFingerprint(temporary, runtime),
      withNpmrc,
      "changing project pnpm policy must invalidate dependencies",
    );
    fs.appendFileSync(path.join(temporary, "pnpm-lock.yaml"), " ");
    assert.notEqual(
      dependencyFingerprint(temporary, runtime),
      baseline,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed partial pnpm install cannot leave an old reusable stamp", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-npm-retry-"));
  const namespace = `fixture-retry-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  const packageLock = path.join(temporary, "pnpm-lock.yaml");
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

    preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner);
    fs.writeFileSync(packageLock, '{"lockfileVersion":3,"changed":true}\n');
    fs.writeFileSync(lock, "held\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner), (error) => {
      assert.match(error.message, /install is already running/u);
      assert.equal(error.message.includes(lock), true, "contention must identify the exact stale lock path");
      return true;
    });
    assert.equal(calls, 1, "contention must fail before pnpm install");
    assert.equal(fs.existsSync(lock), true, "a contender must not release another invocation's lock");
    fs.unlinkSync(lock);

    assert.throws(() => preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner));
    assert.equal(fs.existsSync(stamp), false, "a failed pnpm install must leave no reusable stamp");
    assert.equal(fs.existsSync(lock), false, "a failed pnpm install must release its install lock");

    fs.writeFileSync(packageLock, '{"lockfileVersion":3}\n');
    assert.equal(
      preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      false,
      "retry must run pnpm install instead of trusting the partial node_modules tree",
    );
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(lock, { force: true });
    fs.rmSync(stamp, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("an atomic lock owner leaves a foreign replacement intact", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-npm-lock-owner-"));
  const namespace = `fixture-owner-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "pnpm-lock.yaml"), '{"lockfileVersion":3}\n');
    preparePnpmDependencies(temporary, namespace, "11.4.2", {}, () => {
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

// A pid no process has: that of a child that already exited.
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

test("a lock whose owner died is taken over and released", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-lock-steal-"));
  const lock = path.join(temporary, "fixture.lock");
  try {
    fs.writeFileSync(lock, `${deadPid()}:${"d".repeat(64)}`, { mode: 0o600 });
    const seen = withAtomicLock(lock, "fixture contention", () => fs.readFileSync(lock, "utf8"));
    assert.match(seen, new RegExp(`^${process.pid}:[0-9a-f]{64}$`, "u"));
    assert.deepEqual(fs.readdirSync(temporary), [], "the lock and its takeover sentinel are gone");
    fs.writeFileSync(lock, `${process.pid}:${"e".repeat(64)}`, { mode: 0o600 });
    assert.throws(() => withAtomicLock(lock, "fixture contention", () => assert.fail("must not run")),
      new RegExp(`fixture contention; the lock ${lock.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")} is held by live process ${process.pid}`, "u"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("two contenders for a dead owner's lock never both hold it", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-lock-race-"));
  const lock = path.join(temporary, "fixture.lock");
  const program = `
    const { withAtomicLock } = require(${JSON.stringify(path.join(root, "platform/cli/checks.js"))});
    const start = Number(process.argv[1]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, start - Date.now()));
    try {
      withAtomicLock(${JSON.stringify(lock)}, "fixture contention", () => {
        process.stdout.write("entered\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      });
    } catch (error) {
      if (!error.message.startsWith("fixture contention")) throw error;
      process.stdout.write("refused\\n");
    }
  `;
  try {
    for (let round = 0; round < 4; round += 1) {
      fs.writeFileSync(lock, `${deadPid()}:${"d".repeat(64)}`, { mode: 0o600 });
      const start = String(Date.now() + 500);
      const outcomes = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", program, start], { stdio: ["ignore", "pipe", "inherit"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.on("error", reject);
        child.on("close", (status) => (status === 0 ? resolve(output.trim()) : reject(new Error(`exit ${status}`))));
      })));
      assert.deepEqual(outcomes.sort(), ["entered", "refused"], `round ${round}`);
      assert.deepEqual(fs.readdirSync(temporary), [], `round ${round} leaves no lock behind`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("pnpm dependency preparation installs once and reuses the working-tree modules", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-npm-"));
  const namespace = `fixture-${process.pid}-${Date.now()}`;
  const stamp = path.join(BUILD_DIR, "check-state", `${namespace}.dependencies`);
  const lock = path.join(BUILD_DIR, "check-state", `${namespace}.install.lock`);
  const calls = [];
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), '{"dependencies":{"fixture":"1.0.0"}}\n');
    fs.writeFileSync(path.join(temporary, "pnpm-lock.yaml"), '{"lockfileVersion":3}\n');
    const runner = (...arguments_) => {
      calls.push(arguments_);
      fs.mkdirSync(path.join(temporary, "node_modules"));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    assert.equal(
      preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      false,
    );
    assert.equal(
      preparePnpmDependencies(temporary, namespace, "11.4.2", {}, runner).reused,
      true,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), [
      `${namespace} dependencies`, "pnpm", ["install", "--frozen-lockfile", "--prod=false"],
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
    pnpmVersion: "11.4.2",
    prepareDependencies(project, namespace) { prepared.push([project, namespace]); },
    runner(label, command, args, options) {
      commands.push({ label, command, args, options });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(prepared.map((entry) => entry[1]), ["workspace-pnpm"]);
  assert.equal(prepared[0][0], root);
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
      pnpmVersion: "11.4.2",
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

const PIN_ANDROID_STAGE = "Pin Android unit tests (pinned builder)";

// Runs the Pin lane with every subprocess recorded, in throwaway builder
// directories, so nothing touches Docker or the real builder state.
function recordedPinCheck({
  docker = { status: 0, signal: null, stdout: "27.0.0\n", stderr: "" },
  stockReference = false,
  before = () => {},
} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-pin-check-"));
  const directories = {
    state: path.join(temporary, "state"),
    cache: path.join(temporary, "cache"),
    imageStamp: path.join(temporary, "cache", "image.sha256"),
  };
  const data = path.join(temporary, "data");
  if (stockReference) fs.mkdirSync(path.join(data, "stock-reference"), { recursive: true });
  before(directories);
  const steps = [];
  let error = null;
  try {
    pinContributorCheck({
      environment: { LUMA_DATA_DIR: data },
      directories,
      image: "fixture:image",
      ensureImage(options) {
        steps.push({ label: "ensure image", image: options.image, directories: options.directories });
      },
      sessionRunner(label, command, args, options) {
        steps.push({ label, command, args: args.slice(), options });
        return label === "Pin builder Docker" ? docker : { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { temporary, directories, data, steps, error };
}

function bindMounts(args) {
  return args.flatMap((value, index) => (args[index - 1] === "--mount" ? [value] : [])).map((mount) => {
    const fields = Object.fromEntries(mount.split(",").map((field) => field.split("=")));
    return { source: fields.src, target: fields.dst, readOnly: mount.split(",").includes("readonly") };
  });
}

function insideCheckout(directory) {
  return directory === root || directory.startsWith(`${root}${path.sep}`);
}

test("Pin check runs its suites and Cargo on the host and its Android unit tests in the pinned builder", () => {
  const { temporary, directories, steps, error } = recordedPinCheck();
  try {
    assert.equal(error, null, error?.stack);
    // Docker is asked first, so a stopped daemon fails before minutes of Cargo.
    assert.deepEqual([steps[0].label, steps[0].command, steps[0].args],
      ["Pin builder Docker", "docker", ["version", "--format", "{{.Server.Version}}"]]);
    assert.equal(steps[1].command, "bun");
    assert.deepEqual(steps[1].args.slice(0, 3), ["test", "--isolate", "--parallel=4"]);
    // The builder suites guard pin/ sources (the Tier-A literal guard), so a
    // Pin-only change runs them.
    for (const suite of ["tier-a-literals.test.mjs", "doctor.test.mjs"]) {
      assert.ok(steps[1].args.includes(path.join(root, "platform", "containers", "pin-builder", suite)), suite);
    }
    const core = path.join(root, "pin", "runtime", "core");
    const bridge = path.join(root, "pin", "bridge");
    assert.deepEqual(steps.slice(2, 7).map((step) => [step.command, step.args, step.options.cwd]), [
      ["cargo", ["fmt", "--check"], core],
      // The release APK's `iroh` feature is tested, not only built.
      ["cargo", ["test", "--locked", "--features", "iroh"], core],
      ["cargo", ["fmt", "--check"], bridge],
      ["cargo", ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"], bridge],
      ["cargo", ["test", "--locked"], bridge],
    ]);
    // The image is current before the one container run that holds every
    // Gradle task. No Gradle runs on the host.
    assert.deepEqual(steps[7], { label: "ensure image", image: "fixture:image", directories });
    assert.equal(steps.length, 9);
    const android = steps[8];
    assert.equal(android.label, PIN_ANDROID_STAGE);
    assert.equal(android.command, "docker");
    assert.deepEqual(android.args.slice(0, 3), ["run", "--rm", "--init"]);
    assert.deepEqual(android.args.slice(-2), ["fixture:image", "check-unit"]);
    for (const step of steps.filter((entry) => entry.args)) {
      assert.equal(step.args.some((value) => /gradlew/u.test(value)), false, step.label);
      assert.notEqual(step.command, "bash", step.label);
    }
    assert.equal(fs.existsSync(path.join(directories.state, "check.lock")), false, "the lane releases its lock");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the Pin check keeps Gradle and Cargo output out of the checkout", () => {
  const { temporary, directories, steps, error } = recordedPinCheck();
  try {
    assert.equal(error, null, error?.stack);
    const android = steps.find((step) => step.label === PIN_ANDROID_STAGE);
    assert.ok(android.args.includes("--read-only"));
    const mounts = bindMounts(android.args);
    assert.deepEqual(mounts.find((mount) => mount.target === "/workspace"),
      { source: root, target: "/workspace", readOnly: true });
    // The only writable mounts are the external builder state and caches.
    assert.deepEqual(mounts.filter((mount) => !mount.readOnly), [
      { source: directories.state, target: "/state", readOnly: false },
      { source: directories.cache, target: "/cache", readOnly: false },
    ]);
    for (const mount of mounts) {
      if (insideCheckout(mount.source)) assert.equal(mount.readOnly, true, mount.target);
    }
    for (const step of steps.filter((entry) => entry.command === "cargo")) {
      assert.equal(insideCheckout(step.options.env.CARGO_TARGET_DIR), false, step.options.cwd);
    }
    const builderState = require("../../cli/pin-debug.js").checkDirectories();
    for (const directory of [builderState.state, builderState.cache]) {
      assert.equal(insideCheckout(directory), false, directory);
      assert.equal(directory.startsWith(`${BUILD_DIR}${path.sep}`), true, directory);
    }
    // Inside the builder, Gradle runs in the external worktree with its
    // project caches in external state, never in the read-only source.
    const entrypoint = fs.readFileSync(
      path.join(root, "platform", "containers", "pin-builder", "entrypoint.sh"), "utf8");
    const checkUnit = /^check_unit\(\) \{\n([\s\S]*?)\n\}\n/mu.exec(entrypoint)[1];
    const code = checkUnit.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.match(code, /\bprepare_workspace\b/u);
    assert.match(code, /cd "\$\{WORK_ROOT\}"\n/u);
    assert.doesNotMatch(code, /SOURCE_ROOT/u);
    assert.doesNotMatch(code, /\bcargo\b/u, "the host runs the Pin's Cargo tests");
    const gradle = code.match(/\.\/(?:device-installer\/)?gradlew\b(?:[^\n\\]|\\\n)*/gu);
    assert.equal(gradle.length, 2);
    for (const invocation of gradle) {
      assert.match(invocation, /--project-cache-dir "\$\{STATE_ROOT\}\//u);
    }
    for (const task of [
      ":contracts:stock-aibus:testDebugUnitTest", ":contracts:penumbra-ipc:testDebugUnitTest",
      ":hook:module:testDebugUnitTest", ":hook:loader:testDebugUnitTest", ":runtime:android:testDebugUnitTest",
      ":common:testDebugUnitTest", ":installer:testDebugUnitTest", ":bootstrap:testDebugUnitTest",
    ]) {
      assert.match(code, new RegExp(`${task}\\b`, "u"), task);
    }
    // Device Services' tests run without the Rust server build. The installer
    // stays compile-only debug.
    assert.match(gradle[0], /-x :runtime:android:buildRustServerAndroid/u);
    assert.match(gradle[1], /-PlumaCompileOnlyDebug=true/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the Pin check mounts the stock reference read-only only when one exists", () => {
  const withReference = recordedPinCheck({ stockReference: true });
  const without = recordedPinCheck();
  try {
    assert.equal(withReference.error, null, withReference.error?.stack);
    assert.equal(without.error, null, without.error?.stack);
    const referenceMounts = (run) => bindMounts(run.steps.find((step) => step.label === PIN_ANDROID_STAGE).args)
      .filter((mount) => mount.target === "/luma-data/stock-reference");
    assert.deepEqual(referenceMounts(withReference), [{
      source: path.join(withReference.data, "stock-reference"),
      target: "/luma-data/stock-reference",
      readOnly: true,
    }]);
    assert.deepEqual(referenceMounts(without), []);
  } finally {
    fs.rmSync(withReference.temporary, { recursive: true, force: true });
    fs.rmSync(without.temporary, { recursive: true, force: true });
  }
});

test("the Pin check says Docker must be running before it runs anything", () => {
  const { temporary, steps, error } = recordedPinCheck({
    docker: {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    },
  });
  try {
    assert.match(error?.message ?? "", /^the Pin check runs its Android unit tests in the pinned builder container, so Docker must be running\. Docker is not answering: Cannot connect to the Docker daemon/u);
    assert.deepEqual(steps.map((step) => step.label), ["Pin builder Docker"]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a second Pin check refuses while one is running", () => {
  const { temporary, directories, steps, error } = recordedPinCheck({
    before(directories) {
      fs.mkdirSync(directories.state, { recursive: true });
      fs.writeFileSync(path.join(directories.state, "check.lock"), `${process.pid}:${"a".repeat(64)}`, { mode: 0o600 });
    },
  });
  try {
    assert.match(error?.message ?? "", /^the Pin check is already running; wait for it to finish and run it again; the lock .+ is held by live process \d+$/u);
    assert.deepEqual(steps, []);
    assert.equal(fs.existsSync(path.join(directories.state, "check.lock")), true, "a contender keeps the holder's lock");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("changed paths select precise component checks and unfamiliar paths fail closed", () => {
  assert.deepEqual([...checksForPath("center/src/app/page.tsx")], ["center"]);
  assert.deepEqual([...checksForPath("cosmos/crates/cosmos/src/lib.rs")], ["cosmos"]);
  assert.deepEqual([...checksForPath("pin/runtime/core/src/lib.rs")], ["pin"]);
  // README sentences are pinned by full-inventory platform suites and by
  // Center's verify tests.
  assert.deepEqual([...checksForPath("README.md")], ["platform", "center"]);
  assert.equal(requiresFullPlatformCheck("README.md"), true);
  assert.deepEqual([...checksForPath("docs/notes.md")], ["platform"]);
  assert.equal(requiresFullPlatformCheck("docs/notes.md"), false);
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
  // A filter that matches ordinary tests leaves the ignored live-service ones
  // out. One that matches only ignored tests runs them.
  assert.deepEqual(focusedRustTestArguments("alpha"), ["test", "--workspace", "--locked", "alpha"]);
  assert.deepEqual(focusedRustTestArguments("alpha", { ignoredOnly: true }), [
    "test", "--workspace", "--locked", "alpha", "--", "--ignored",
  ]);
});

test("platform policy files have bounded runner arguments and a complete inventory", () => {
  assert.deepEqual(policyTestArguments(["a.test.mjs"], 2), [
    "test", "--isolate", "--parallel=2", "--timeout=120000", "a.test.mjs",
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
  for (const suite of ["tier-a-literals.test.mjs", "doctor.test.mjs"]) {
    assert.equal(
      fullInventory.includes(path.join("..", "..", "containers", "pin-builder", suite)), true, suite,
    );
  }
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
  assert.match(entrypoint, /:hook:module:testDebugUnitTest/u);
  assert.match(entrypoint, /:hook:loader:testDebugUnitTest/u);
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
    const result = spawnSync(process.execPath, [path.join(root, "luma"), ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
  }
});
