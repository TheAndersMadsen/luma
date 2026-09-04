'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Validation gates shared by contributor checks.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  ROOT,
  fail,
  info,
  testProcessEnvironment,
} = require('./context');
const { timedRun, timedStage } = require('./timing');
const { testVersionParser } = require('./toolchain');
const SERIAL_POLICY_TESTS = Object.freeze([
  'fresh-install.test.mjs',
]);
const CONTRIBUTOR_POLICY_TESTS = Object.freeze([
  'ambiance-v2.test.mjs',
  'cli-config.test.mjs',
  'cli-setup.test.mjs',
  'fast-workflow.test.mjs',
  'fresh-install.test.mjs',
  'revival.test.mjs',
  'setup-projection.test.mjs',
  'wire-divergence.test.mjs',
  'wire-equivalence.test.mjs',
]);
function runContributorCheckUnit(runner, command, args, {
  environment,
  cwd,
  ...options
} = {}) {
  return runner(`Pin contributor check: ${command} ${args.join(' ')}`, command, args, {
    cwd,
    env: environment,
    allowFailure: false,
    ...options,
  });
}

function runPinContributorChecks(runner, environment) {
  const rootEnvironment = Object.freeze({
    ...environment,
    LANG: 'C',
    LC_ALL: 'C',
  });
  const coreTarget = path.join(environment.CARGO_TARGET_DIR, 'runtime-core');
  const bridgeTarget = path.join(environment.CARGO_TARGET_DIR, 'bridge');
  const gradleProjectCache = path.join(environment.GRADLE_USER_HOME, 'pin-contributor');
  const gradleInjectorCache = path.join(environment.GRADLE_USER_HOME, 'pin-contributor-injector');
  fs.mkdirSync(coreTarget, { recursive: true });
  fs.mkdirSync(bridgeTarget, { recursive: true });
  fs.mkdirSync(gradleProjectCache, { recursive: true });
  fs.mkdirSync(gradleInjectorCache, { recursive: true });
  runContributorCheckUnit(runner, 'cargo', ['test', '--locked'], {
    cwd: path.join(ROOT, 'pin', 'runtime', 'core'),
    environment: Object.freeze({ ...rootEnvironment, CARGO_TARGET_DIR: coreTarget }),
  });
  runContributorCheckUnit(runner, 'cargo', ['test', '--locked'], {
    cwd: path.join(ROOT, 'pin', 'bridge'),
    environment: Object.freeze({ ...rootEnvironment, CARGO_TARGET_DIR: bridgeTarget }),
  });
  runContributorCheckUnit(runner, 'bash', [path.join(ROOT, 'pin', 'gradlew'), '--no-daemon',
    '--project-cache-dir', gradleProjectCache,
    ':contracts:stock-aibus:testDebugUnitTest',
    ':contracts:penumbra-ipc:testDebugUnitTest',
    ':hook:payload:testDebugUnitTest',
    ':hook:loader:testDebugUnitTest'], {
    cwd: path.join(ROOT, 'pin'),
    environment: Object.freeze({ ...rootEnvironment, GRADLE_USER_HOME: environment.GRADLE_USER_HOME }),
  });
  runContributorCheckUnit(runner, 'bash', [path.join(ROOT, 'pin', 'injector/gradlew'), '--no-daemon',
    '--project-cache-dir', gradleInjectorCache,
    '-p', 'injector',
    ':common:testDebugUnitTest'], {
    cwd: path.join(ROOT, 'pin'),
    environment: Object.freeze({ ...rootEnvironment, GRADLE_USER_HOME: environment.GRADLE_USER_HOME }),
  });
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

function policyTestMode({ contributor = false } = {}) {
  return Object.freeze({ contributor });
}

function policyTestInventory(acceptance, { contributor = false } = {}) {
  const scripts = fs.readdirSync(acceptance).sort();
  if (contributor) return scripts;
  const pinAcceptance = path.join(acceptance, 'pin');
  return [
    ...scripts,
    ...fs.readdirSync(pinAcceptance).sort().map((entry) => path.join('pin', entry)),
  ];
}

function policyTests(environment = testProcessEnvironment(), options = {}) {
  const { contributor } = policyTestMode(options);
  timedStage('platform version fixtures', testVersionParser);
  info('[implemented] Docker Compose minimum-version parser fixtures passed.');
  const acceptance = path.join(ROOT, 'platform', 'deploy', 'acceptance');
  let scripts = policyTestInventory(acceptance, { contributor });
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
  // fresh-install observes repository cleanliness, so keep it out of the
  // parallel runner.
  for (const name of plan.serial) {
    timedRun(`platform isolated ${name}`, 'node', policyTestArguments([
      path.join(acceptance, name),
    ], 1), { env: environment });
  }
}

function pinContributorCheck(dependencies = {}) {
  const environment = Object.freeze({
    ...testProcessEnvironment(),
    ...(dependencies.environment || {}),
  });
  const sessionRunner = dependencies.sessionRunner ?? timedRun;
  runPinContributorChecks(sessionRunner, environment);
  info('[implemented] Pin policy, Cargo, and canonical Android contract/common checks passed in direct contributor checks.');
  info('[implemented] contributor Pin checks require no signing keys or private release assets.');
  info('[unknown] contributor checks do not build a signed device bundle or verify a physical Pin.');
}

function pinSourceCheck() {
  pinContributorCheck();
}

function repositoryCheck({ source = false } = {}) {
  // Load lazily to avoid the checks -> gates module cycle during startup.
  const { runCenterCheck, runCosmosCheck, runPlatformCheck } = require('./checks');
  runPlatformCheck({ full: true });
  runCenterCheck();
  runCosmosCheck();
  if (source) pinSourceCheck();
  info('[implemented] repository checks passed.');
}

module.exports = {
  policyTestArguments,
  policyTestConcurrency,
  policyTestInventory,
  policyTestMode,
  policyTestPlan,
  policyTests,
  pinContributorCheck,
  pinSourceCheck,
  repositoryCheck,
};
