'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Validation gates: source policy, layout, the VPS release gate, and the Pin source gate.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  ROOT,
  DATA_DIR,
  BUILD_DIR,
  fail,
  info,
  exists,
  testProcessEnvironment,
  cosmosTestEnvironment,
} = require('./context');
const { throwLikeChild, timedRun, timedStage } = require('./timing');
const {
  probePinAmd64Runtime,
  testVersionParser,
  validateHostToolchains,
} = require('./toolchain');

const SERIAL_POLICY_TESTS = Object.freeze([
  'fresh-install.test.mjs',
  'release.test.mjs',
]);
const CONTRIBUTOR_POLICY_TESTS = Object.freeze([
  'cli-config.test.mjs',
  'cli-help.test.mjs',
  'cli-setup.test.mjs',
  'connectivity.test.mjs',
  'distribution.test.mjs',
  'fast-workflow.test.mjs',
  'fresh-install.test.mjs',
  'local-command-authority.test.mjs',
  'operator-setup-contract.test.mjs',
  'revival.test.mjs',
  'setup-projection.test.mjs',
  'wire-divergence.test.mjs',
  'wire-equivalence.test.mjs',
]);
const RELEASE_RSA_COMPATIBILITY_TEST =
  'tests::production_wrapping_key_is_4096_bit_and_accepts_explicit_sha1_oaep';
const PIN_BUILDER_DEBUG_STORE = path.join(
  ROOT,
  'platform',
  'containers',
  'pin-builder',
  'debug-store.py',
);
function pinLaneSessionArguments(lane, selection = {}) {
  if (!['check', 'debug'].includes(lane)) {
    throw new Error(`unknown Pin builder lane: ${lane}`);
  }
  const roles = selection.roles ?? [];
  const changed = selection.changed === true;
  const base = selection.base;
  if (!Array.isArray(roles) || roles.some((role) =>
    !['installer', 'bootstrap', 'hook', 'server', 'hook-injector'].includes(role))) {
    throw new Error('Pin lane roles must use the fixed five-role vocabulary');
  }
  if (lane === 'check' && (roles.length > 0 || changed || base !== undefined)) {
    throw new Error('the Pin check lane accepts no debug selection');
  }
  if (lane === 'debug' && changed === (roles.length > 0)) {
    throw new Error('the Pin debug lane requires exactly one explicit or changed selection');
  }
  const arguments_ = [
    'lane-session', DATA_DIR, BUILD_DIR, ROOT, lane,
  ];
  if (changed) {
    arguments_.push('--changed');
    if (base !== undefined) arguments_.push('--base', base);
  } else {
    for (const role of roles) arguments_.push('--role', role);
  }
  return Object.freeze(arguments_);
}

function executePinLaneSession(lane, selection = {}, dependencies = {}) {
  const environment = dependencies.environment ?? testProcessEnvironment();
  const runner = dependencies.runner ?? timedRun;
  const result = runner('Pin contributor lane', 'python3', [
    '-B', PIN_BUILDER_DEBUG_STORE, ...pinLaneSessionArguments(lane, selection),
  ], { cwd: ROOT, env: environment, allowFailure: true });
  if (result.signal || result.status !== 0) throwLikeChild(result);
  return result;
}

function assertExactlyOneListedRustTest(output, expected) {
  const listed = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(': test'))
    .map((line) => line.slice(0, -': test'.length));
  if (listed.length !== 1 || listed[0] !== expected) {
    throw new Error(
      `release RSA compatibility discovery must list exactly ${expected}; observed ${listed.length}: ${listed.length === 0 ? '<none>' : listed.join(', ')}`,
    );
  }
  return listed[0];
}

function policyTestConcurrency() {
  const available = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(4, available || 1));
}

function policyTestArguments(tests, concurrency = policyTestConcurrency()) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error(`platform test concurrency must be an integer from 1 through 4: ${concurrency}`);
  }
  return [
    '--no-warnings',
    '--experimental-strip-types',
    '--test',
    `--test-concurrency=${concurrency}`,
    ...tests,
  ];
}

function policyTestPlan(testNames, { hasPinSource = true } = {}) {
  const available = new Set(testNames);
  if (!hasPinSource) available.delete('release.test.mjs');
  const serial = SERIAL_POLICY_TESTS.filter((name) => available.delete(name));
  return {
    parallel: [...available].sort(),
    serial,
  };
}

function policyTestMode({ contributor = false, shellPolicies = true } = {}) {
  return Object.freeze({ contributor, shellPolicies });
}

function policyTests(environment = testProcessEnvironment(), options = {}) {
  const { contributor, shellPolicies } = policyTestMode(options);
  timedStage('platform version fixtures', testVersionParser);
  info('[implemented] Docker Compose minimum-version parser fixtures passed.');
  const acceptance = path.join(ROOT, 'platform', 'deploy', 'acceptance');
  let scripts = fs.readdirSync(acceptance).sort();
  const pinPath = path.join(ROOT, 'pin');
  const hasPinSource = fs.existsSync(pinPath);
  if (hasPinSource && !fs.lstatSync(pinPath).isDirectory()) {
    fail(`${pinPath} exists but is not a source directory`);
  }
  if (contributor) {
    const available = new Set(scripts);
    for (const name of CONTRIBUTOR_POLICY_TESTS) {
      if (!available.has(name)) throw new Error(`contributor platform test is missing: ${name}`);
    }
    scripts = [...CONTRIBUTOR_POLICY_TESTS];
  } else if (shellPolicies) {
    timedStage('platform shell policies', () => {
      for (const name of scripts.filter((entry) => entry.endsWith('.sh'))) {
        if (!hasPinSource && name === 'layout.sh') {
          info('[implemented] skipped the complete-source layout check in the Pin-free VPS profile.');
          continue;
        }
        timedRun(`platform ${name}`, 'sh', [path.join(acceptance, name)], { env: environment });
      }
    });
  }
  if (!hasPinSource && scripts.includes('release.test.mjs')) {
    info('[implemented] skipped the complete-source package fixture in the Pin-free VPS profile.');
  }
  const plan = policyTestPlan(
    scripts.filter((entry) => entry.endsWith('.test.mjs')),
    { hasPinSource },
  );
  const parallelTests = plan.parallel.map((name) => path.join(acceptance, name));
  if (parallelTests.length > 0) {
    const concurrency = policyTestConcurrency();
    info(`[implemented] running ${parallelTests.length} isolated-safe platform test files in one Node runner (concurrency ${concurrency}).`);
    timedRun('platform Node acceptance', 'node', policyTestArguments(parallelTests, concurrency), {
      env: environment,
    });
  }
  // fresh-install observes repository cleanliness and release exercises the
  // packaging boundary. Never overlap either with a process that can create or
  // inspect root state; release stays last so no later check can observe its
  // transient build fixture.
  for (const name of plan.serial) {
    timedRun(`platform isolated ${name}`, 'node', policyTestArguments([
      path.join(acceptance, name),
    ], 1), { env: environment });
  }
}

function runCenterUiTests(center, environment, runner = timedRun) {
  const result = runner('release Center UI tests', 'npm', ['run', 'test:ui'], {
    cwd: center,
    env: environment,
    allowFailure: true,
  });
  if (result.signal || result.status !== 0) throwLikeChild(result);
  return result;
}

function vpsReleaseCheck() {
  const testEnvironment = testProcessEnvironment();
  for (const command of ['node', 'npm', 'rustc', 'cargo']) {
    if (!exists(command, testEnvironment)) fail(`release check requires ${command}`);
  }

  try {
    validateHostToolchains({ env: testEnvironment });
  } catch (error) {
    fail(error.message);
  }

  const cosmos = path.join(ROOT, 'cosmos');
  const cosmosEnvironment = cosmosTestEnvironment(testEnvironment);
  policyTests(testEnvironment);

  // Load lazily to avoid the checks -> gates module cycle during startup.
  const {
    createCenterBuildWorkspace,
    exactNpmVersion,
    normalizedNpmInstallEnvironment,
    prepareNpmDependencies,
  } = require('./checks');
  // Next's build directory is project-relative, so the complete release gate
  // uses an external short-lived source copy. Immutable candidate provenance
  // is enforced later by candidate/release commands, not contributor checks.
  const prepared = timedStage('release Center build workspace', createCenterBuildWorkspace);
  try {
    const npmEnvironment = normalizedNpmInstallEnvironment(testEnvironment);
    const npmVersion = exactNpmVersion(npmEnvironment);
    prepareNpmDependencies(prepared.center, 'center-release-npm', npmVersion, npmEnvironment);
    prepareNpmDependencies(prepared.spotify, 'spotify-release-npm', npmVersion, npmEnvironment);
    timedRun('release Center tests', 'npm', ['test'], { cwd: prepared.center, env: npmEnvironment });
    runCenterUiTests(prepared.center, npmEnvironment);
    timedRun('release Center build', 'npm', ['run', 'build'], {
      cwd: prepared.center,
      env: { ...npmEnvironment, REVIVAL_RELEASE_ID: 'source-check' },
    });
    timedRun('release Spotify tests', 'npm', ['test'], {
      cwd: prepared.spotify,
      env: npmEnvironment,
    });
  } finally {
    prepared.finish();
  }

  timedRun('release Cosmos format', 'cargo', ['fmt', '--all', '--check'], { cwd: cosmos, env: cosmosEnvironment });
  timedRun('release Cosmos clippy', 'cargo', [
    'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings',
  ], { cwd: cosmos, env: cosmosEnvironment });
  timedRun('release Cosmos tests', 'cargo', [
    'test', '--workspace', '--locked',
  ], { cwd: cosmos, env: cosmosEnvironment });
  const rsaDiscovery = timedRun('release Cosmos 4096-bit RSA test discovery', 'cargo', [
    'test', '-p', 'cosmos-crypto', '--locked',
    RELEASE_RSA_COMPATIBILITY_TEST,
    '--', '--ignored', '--exact', '--list',
  ], { cwd: cosmos, env: cosmosEnvironment, capture: true, allowFailure: true });
  if (rsaDiscovery.signal || rsaDiscovery.status !== 0) {
    if (rsaDiscovery.stdout) process.stdout.write(rsaDiscovery.stdout);
    if (rsaDiscovery.stderr) process.stderr.write(rsaDiscovery.stderr);
    throwLikeChild(rsaDiscovery);
  }
  assertExactlyOneListedRustTest(rsaDiscovery.stdout, RELEASE_RSA_COMPATIBILITY_TEST);
  timedRun('release Cosmos 4096-bit RSA compatibility test', 'cargo', [
    'test', '-p', 'cosmos-crypto', '--locked',
    RELEASE_RSA_COMPATIBILITY_TEST,
    '--', '--ignored', '--exact', '--test-threads=1',
  ], { cwd: cosmos, env: cosmosEnvironment });

  info('[implemented] root policy/package, Center, Cosmos, and Spotify adapter VPS release checks passed.');
}

function assertPinAmd64ConsumerHost(pinEnvironment) {
  // The probe itself uses a fixed two-variable locale environment. It never
  // forwards even this already-sanitized contributor environment.
  void pinEnvironment;
  const diagnosis = probePinAmd64Runtime();
  if (diagnosis.safe !== true) {
    throw new Error(`unsafe linux/amd64 Pin consumer host: ${diagnosis.detail}. ${diagnosis.guidance}`);
  }
  return diagnosis;
}

function pinContributorCheck(dependencies = {}) {
  // Native-only refusal is the first operational action. In particular, an
  // ARM/macOS host cannot create synthetic homes, npm configs, cache roots, or
  // Docker state merely by asking for a Pin check.
  const preflight = dependencies.preflight ?? assertPinAmd64ConsumerHost;
  preflight(Object.freeze({ LANG: 'C', LC_ALL: 'C' }));
  // One helper remains alive from its first watch-before-target traversal
  // through source policy, policy tests, Docker build/run, and final
  // revalidation. JavaScript never prepares or reauthorizes a lane pathname.
  (dependencies.sessionRunner ?? executePinLaneSession)(
    'check',
    {},
    dependencies,
  );
  info('[implemented] Pin policy, Cargo, and canonical Android contract/common checks passed in one held lane session.');
  info('[implemented] contributor Pin checks require no signing keys or private release assets.');
  info('[unknown] this host gate does not build a signed device bundle or verify a physical Pin.');
}

function pinSourceCheck() {
  assertPinAmd64ConsumerHost(Object.freeze({ LANG: 'C', LC_ALL: 'C' }));
  executePinLaneSession('check');
}

function releaseCheck({ source = false } = {}) {
  vpsReleaseCheck();
  if (source) pinSourceCheck();
}

module.exports = {
  RELEASE_RSA_COMPATIBILITY_TEST,
  assertExactlyOneListedRustTest,
  policyTestArguments,
  policyTestConcurrency,
  policyTestMode,
  policyTestPlan,
  policyTests,
  runCenterUiTests,
  vpsReleaseCheck,
  pinLaneSessionArguments,
  executePinLaneSession,
  assertPinAmd64ConsumerHost,
  pinContributorCheck,
  pinSourceCheck,
  releaseCheck,
};
