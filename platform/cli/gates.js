'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Validation gates shared by contributor checks.
// Split out of the root `luma` entry point. Behavior, messages, and exit
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
  'backup-restore.test.mjs',
  'cli-config.test.mjs',
  'cli-setup.test.mjs',
  'fast-workflow.test.mjs',
  'fresh-install.test.mjs',
  'identity-realm.test.mjs',
  'luma.test.mjs',
  'production-runtime.test.mjs',
  'release-publish.test.mjs',
  'setup-projection.test.mjs',
  'stock-reference.test.mjs',
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

// The Pin's Tier-A and capability guards read pin/ sources, so the Pin lane
// runs them too. The full platform check runs them with every other suite.
const PIN_BUILDER_TESTS = path.join(ROOT, 'platform', 'containers', 'pin-builder');

function pinBuilderTestFiles() {
  return fs.readdirSync(PIN_BUILDER_TESTS).filter((entry) => entry.endsWith('.test.mjs')).sort()
    .map((entry) => path.join(PIN_BUILDER_TESTS, entry));
}

const PIN_CHECK_NEEDS_DOCKER = 'the Pin check runs its Android unit tests in the pinned builder container, ' +
  'so Docker must be running';

// The builder's own suites and the Cargo tests run on the host. The Android
// unit tests run in the pinned builder container, on the image's JDK and
// Android SDK rather than whatever JVM the host has, with the checkout mounted
// read-only: Gradle compiles a copy in the external build directory, so no
// Gradle output reaches pin/.
function runPinContributorChecks(runner, environment, builder) {
  const rootEnvironment = Object.freeze({
    ...environment,
    LANG: 'C',
    LC_ALL: 'C',
  });
  const docker = runner('Pin builder Docker', 'docker', ['version', '--format', '{{.Server.Version}}'], {
    cwd: ROOT,
    env: rootEnvironment,
    allowFailure: true,
    capture: true,
  });
  if (docker.signal || docker.status !== 0) {
    const detail = `${docker.stderr || ''}`.trim().split('\n').at(-1) ||
      `docker version exited with ${docker.signal || `status ${docker.status}`}`;
    throw new Error(`${PIN_CHECK_NEEDS_DOCKER}. Docker is not answering: ${detail}`);
  }
  const coreTarget = path.join(environment.CARGO_TARGET_DIR, 'runtime-core');
  const bridgeTarget = path.join(environment.CARGO_TARGET_DIR, 'bridge');
  fs.mkdirSync(coreTarget, { recursive: true });
  fs.mkdirSync(bridgeTarget, { recursive: true });
  runContributorCheckUnit(runner, 'bun', [
    'test', '--isolate', '--parallel=4', '--timeout=120000', ...pinBuilderTestFiles(),
  ], {
    cwd: ROOT,
    environment: rootEnvironment,
  });
  const core = {
    cwd: path.join(ROOT, 'pin', 'runtime', 'core'),
    environment: Object.freeze({ ...rootEnvironment, CARGO_TARGET_DIR: coreTarget }),
  };
  const bridge = {
    cwd: path.join(ROOT, 'pin', 'bridge'),
    environment: Object.freeze({ ...rootEnvironment, CARGO_TARGET_DIR: bridgeTarget }),
  };
  runContributorCheckUnit(runner, 'cargo', ['fmt', '--check'], core);
  // The release APK builds with `iroh` (pin/runtime/android
  // build.gradle.kts), so its code is tested here.
  runContributorCheckUnit(runner, 'cargo', ['test', '--locked', '--features', 'iroh'], core);
  runContributorCheckUnit(runner, 'cargo', ['fmt', '--check'], bridge);
  runContributorCheckUnit(runner, 'cargo', ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'], bridge);
  runContributorCheckUnit(runner, 'cargo', ['test', '--locked'], bridge);
  // The builder's check-unit lane: the JVM unit tests of the contracts, hook,
  // Device Services, and Device Installer, with no signing input.
  builder.ensureImage({
    directories: builder.directories,
    environment: rootEnvironment,
    runner,
    image: builder.image,
  });
  runner('Pin Android unit tests (pinned builder)', builder.invocation.command, builder.invocation.args, {
    cwd: ROOT,
    env: rootEnvironment,
    allowFailure: false,
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
    'test',
    '--isolate',
    `--parallel=${concurrency}`,
    '--timeout=120000',
    ...tests,
  ];
}

function policyTestPlan(testNames) {
  const available = new Set(testNames);
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
    // The Pin builder's own suites (Tier-A registry, capability manifest,
    // doctor, signing setup) live beside the builder.
    ...pinBuilderTestFiles().map((file) => path.relative(acceptance, file)),
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
  );
  const parallelTests = plan.parallel.map((name) => path.join(acceptance, name));
  if (parallelTests.length > 0) {
    // A fresh process avoids Bun's cumulative isolated-global worker hang
    // (oven-sh/bun#32251). A whole-process deadline also bounds synchronous code.
    info(`[implemented] running ${parallelTests.length} platform test files in separate Bun processes.`);
    for (const file of parallelTests) {
      timedRun(`platform ${path.basename(file)}`, 'bun', policyTestArguments([file], 1), {
        env: environment, timeout: 180000, killSignal: 'SIGKILL',
      });
    }
  }
  // fresh-install observes repository cleanliness, so keep it out of the
  // parallel runner.
  for (const name of plan.serial) {
    timedRun(`platform isolated ${name}`, 'bun', policyTestArguments([
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
  // Loaded here: pin-debug requires checks, which requires this module.
  const pinBuilder = require('./pin-debug');
  const { withAtomicLock } = require('./checks');
  const directories = dependencies.directories ?? pinBuilder.checkDirectories();
  const image = dependencies.image ?? pinBuilder.BUILDER_IMAGE;
  pinBuilder.prepareDebugDirectories(directories);
  const reference = path.join(environment.LUMA_DATA_DIR, 'stock-reference');
  const stockReference = fs.statSync(reference, { throwIfNoEntry: false })?.isDirectory() ? reference : null;
  withAtomicLock(
    path.join(directories.state, 'check.lock'),
    'the Pin check is already running; wait for it to finish and run it again',
    () => runPinContributorChecks(sessionRunner, environment, {
      ensureImage: dependencies.ensureImage ?? pinBuilder.ensurePinBuilderImage,
      directories,
      image,
      invocation: pinBuilder.pinBuilderCheckInvocation(directories, stockReference, image),
    }),
  );
  info('[implemented] Pin builder policy suites and the Cargo tests of the runtime core and bridge passed on the host; ' +
    'the Android unit tests of the contracts, hook, Device Services, and Device Installer (common, installer, bootstrap) ' +
    `passed in the pinned builder container (${image}).`);
  info(stockReference
    ? `[observed] the stock reference ${stockReference} was mounted read-only for the evidence-bound Kotlin tests.`
    : `[unknown] no stock reference at ${reference}; the evidence-bound Kotlin tests skipped.`);
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
