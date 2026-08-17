'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Validation gates: source policy, layout, the VPS release gate, and the Pin source gate.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  ROOT, BUILD_DIR, isInsideSource, fail, info, exists, run, operatorEnvironment, pinBuildEnvironment,
} = require('./context');
const { testVersionParser, validateHostToolchains } = require('./toolchain');

function policyTests() {
  testVersionParser();
  info('[implemented] Docker Compose minimum-version parser fixtures passed.');
  const acceptance = path.join(ROOT, 'platform', 'deploy', 'acceptance');
  const scripts = fs.readdirSync(acceptance).sort();
  const pinPath = path.join(ROOT, 'pin');
  const hasPinSource = fs.existsSync(pinPath);
  if (hasPinSource && !fs.lstatSync(pinPath).isDirectory()) {
    fail(`${pinPath} exists but is not a source directory`);
  }
  for (const name of scripts.filter((entry) => entry.endsWith('.sh'))) {
    if (!hasPinSource && name === 'layout.sh') {
      info('[implemented] skipped the complete-source layout check in the Pin-free VPS profile.');
      continue;
    }
    run('sh', [path.join(acceptance, name)]);
  }
  for (const name of scripts.filter((entry) => entry.endsWith('.test.mjs'))) {
    if (!hasPinSource && name === 'release.test.mjs') {
      info('[implemented] skipped the complete-source package fixture in the Pin-free VPS profile.');
      continue;
    }
    run('node', ['--test', path.join(acceptance, name)]);
  }
}

// What `clean` is allowed to delete, by exact directory name. Deliberately an
// allowlist: anything not named here is refused rather than removed, so a typo
// in a caller cannot take source with it.
//
// `.vite`, `dist-install`, `dist-static`, and `dist-setup` were the outputs of
// the retired pin/setup Vite SPA and are dropped with it — nothing in the tree
// can produce them now, and keeping a name here only widens what clean may
// delete.
const GENERATED_DIRECTORY_NAMES = new Set([
  '.gradle',
  '.kotlin',
  '.next',
  'build',
  'coverage',
  'dist',
  'dist-center',
  'node_modules',
  'target'
]);

function removeGeneratedPath(target) {
  if (!isInsideSource(target)) {
    throw new Error(`refusing to clean generated output outside the source tree: ${target}`);
  }
  const name = path.basename(target);
  const allowedDirectory = GENERATED_DIRECTORY_NAMES.has(name);
  const allowedFile = name.endsWith('.tsbuildinfo');
  if (!allowedDirectory && !allowedFile) {
    throw new Error(`refusing to clean unrecognized generated output: ${target}`);
  }
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (stat.isDirectory()) {
    if (!allowedDirectory) {
      throw new Error(`generated file path is unexpectedly a directory: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: false, maxRetries: 3 });
    return;
  }
  if (!stat.isFile() || !allowedFile) {
    throw new Error(`generated output path has an unexpected type: ${target}`);
  }
  fs.unlinkSync(target);
}

function generatedCleanupGuard(paths) {
  let active = true;
  const cleanup = () => {
    if (!active) return;
    for (const target of paths) removeGeneratedPath(target);
  };
  cleanup();
  process.once('exit', cleanup);
  return () => {
    if (!active) return;
    cleanup();
    active = false;
    process.removeListener('exit', cleanup);
  };
}

function vpsReleaseCheck() {
  for (const command of ['node', 'npm', 'rustc', 'cargo']) {
    if (!exists(command)) fail(`release check requires ${command}`);
  }

  try {
    validateHostToolchains();
  } catch (error) {
    fail(error.message);
  }

  const center = path.join(ROOT, 'center');
  const cosmos = path.join(ROOT, 'cosmos');
  const spotifyAdapter = path.join(ROOT, 'center', 'adapters', 'spotify');
  const injector = path.join(ROOT, 'pin', 'injector');
  const finishCleanup = generatedCleanupGuard([
    path.join(center, 'node_modules'),
    path.join(center, '.next'),
    path.join(center, 'tsconfig.tsbuildinfo'),
    path.join(cosmos, 'target'),
    path.join(spotifyAdapter, 'node_modules'),
    path.join(spotifyAdapter, 'coverage'),
    path.join(injector, '.gradle'),
    path.join(injector, '.kotlin'),
    path.join(injector, 'common', 'build')
  ]);

  try {
    policyTests();
    run('npm', ['ci'], { cwd: center });
    run('npm', ['test'], { cwd: center });
    run('npm', ['run', 'build'], {
      cwd: center,
      env: operatorEnvironment({ REVIVAL_RELEASE_ID: 'source-check' })
    });

    run('cargo', ['fmt', '--all', '--check'], { cwd: cosmos });
    run('cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'], { cwd: cosmos });
    run('cargo', ['test', '--workspace', '--locked'], { cwd: cosmos });

    run('npm', ['ci'], { cwd: spotifyAdapter });
    run('npm', ['test'], { cwd: spotifyAdapter });
  } finally {
    finishCleanup();
  }

  info('[implemented] root policy/package, Center, Cosmos, and Spotify adapter VPS release checks passed.');
}

function pinSourceCheck() {
  for (const command of ['node', 'npm', 'cargo', 'java']) {
    if (!exists(command)) fail(`Pin source check requires ${command}`);
  }

  try {
    validateHostToolchains({ includeJava: true, report: false });
  } catch (error) {
    fail(error.message);
  }

  const pin = path.join(ROOT, 'pin');
  let pinEnvironment;
  try {
    pinEnvironment = pinBuildEnvironment();
  } catch (error) {
    fail(error.message);
  }
  const finishCleanup = generatedCleanupGuard([
    path.join(pin, '.gradle'),
    path.join(pin, 'injector', '.gradle'),
    path.join(pin, 'injector', '.kotlin'),
    path.join(pin, 'injector', 'common', 'build'),
    path.join(pin, 'runtime', 'core', 'target'),
    path.join(pin, 'bridge', 'target')
  ]);

  try {
    for (const directory of [
      path.join(ROOT, 'platform', 'containers', 'pin-builder'),
      path.join(ROOT, 'platform', 'deploy', 'acceptance', 'pin')
    ]) {
      const tests = fs.readdirSync(directory)
        .filter((entry) => entry.endsWith('.test.mjs'))
        .sort()
        .map((entry) => path.join(directory, entry));
      if (tests.length > 0) run('node', ['--test', ...tests]);
    }

    // No browser build here. The installer console used to be a separate Vite
    // SPA under pin/setup with its own npm install, lint, and test run; it is
    // part of Center now, so vpsReleaseCheck() covers it with the rest of
    // Center and this gate stays about device toolchains.

    for (const directory of [
      path.join(pin, 'runtime', 'core'),
      path.join(pin, 'bridge')
    ]) {
      run('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
        cwd: directory,
        capture: true
      });
    }
    run(path.join(pin, 'gradlew'), [
      '--no-daemon',
      '--project-cache-dir', path.join(BUILD_DIR, 'gradle-pin-cache'),
      'projects'
    ], {
      cwd: pin,
      env: pinEnvironment
    });
    run(path.join(pin, 'injector', 'gradlew'), [
      '--no-daemon',
      '--project-cache-dir', path.join(BUILD_DIR, 'gradle-injector-cache'),
      'projects'
    ], {
      cwd: path.join(pin, 'injector'),
      env: pinEnvironment
    });
  } finally {
    finishCleanup();
  }
  info('[implemented] Pin toolchain/QA, metadata, and Gradle project-graph source checks passed.');
  info('[unknown] this host gate does not build a signed device bundle or verify a physical Pin.');
}

function releaseCheck({ source = false } = {}) {
  if (source) {
    try {
      validateHostToolchains({ includeJava: true, report: false });
    } catch (error) {
      fail(error.message);
    }
  }
  vpsReleaseCheck();
  if (source) pinSourceCheck();
}

module.exports = { policyTests, removeGeneratedPath, generatedCleanupGuard, vpsReleaseCheck, pinSourceCheck, releaseCheck };
