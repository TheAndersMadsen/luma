'use strict';

const child = require('node:child_process');
const crypto = require('node:crypto');
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
const RELEASE_RSA_COMPATIBILITY_TEST =
  'tests::production_wrapping_key_is_4096_bit_and_accepts_explicit_sha1_oaep';
const PIN_BUILDER_DEBUG_STORE = path.join(
  ROOT,
  'platform',
  'containers',
  'pin-builder',
  'debug-store.py',
);
const PIN_TRUSTED_EXECUTABLES = Object.freeze({
  sh: Object.freeze(['/bin/sh', '/usr/bin/sh']),
  node: Object.freeze(['/usr/bin/node', '/bin/node']),
  python3: Object.freeze(['/usr/bin/python3', '/bin/python3']),
  docker: Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']),
});
const PIN_BROKER_BOOTSTRAP = String.raw`
import fcntl
import hashlib
import os
import stat
import sys

SOURCE_DESCRIPTOR = 4
MAXIMUM_BROKER_BYTES = 8 * 1024 * 1024
EXPECTED_SHA256 = sys.argv[1]
BROKER_ARGUMENTS = sys.argv[2:]

def stable(metadata):
    return (
        metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
        metadata.st_gid, metadata.st_nlink, metadata.st_size,
        metadata.st_mtime_ns, metadata.st_ctime_ns,
    )

before = os.fstat(SOURCE_DESCRIPTOR)
if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAXIMUM_BROKER_BYTES:
    raise SystemExit("Pin lane broker is not one bounded regular file")
os.lseek(SOURCE_DESCRIPTOR, 0, os.SEEK_SET)
contents = bytearray()
while len(contents) <= MAXIMUM_BROKER_BYTES:
    block = os.read(SOURCE_DESCRIPTOR, min(1024 * 1024, MAXIMUM_BROKER_BYTES + 1 - len(contents)))
    if not block:
        break
    contents.extend(block)
after = os.fstat(SOURCE_DESCRIPTOR)
if (
    len(contents) > MAXIMUM_BROKER_BYTES or stable(before) != stable(after) or
    hashlib.sha256(contents).hexdigest() != EXPECTED_SHA256
):
    raise SystemExit("Pin lane broker changed before its sealed execution")

sealed = os.memfd_create(
    "revival-pin-lane-broker",
    getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002),
)
view = memoryview(contents)
while view:
    written = os.write(sealed, view)
    view = view[written:]
os.fsync(sealed)
required_seals = (
    getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
    getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
    getattr(fcntl, "F_SEAL_GROW", 0x0004) |
    getattr(fcntl, "F_SEAL_WRITE", 0x0008)
)
fcntl.fcntl(sealed, getattr(fcntl, "F_ADD_SEALS", 1033), required_seals)
if fcntl.fcntl(sealed, getattr(fcntl, "F_GET_SEALS", 1034)) & required_seals != required_seals:
    raise SystemExit("Pin lane broker memfd did not retain every required seal")
if stable(os.fstat(SOURCE_DESCRIPTOR)) != stable(before):
    raise SystemExit("Pin lane broker changed while its memfd was sealed")

filename = f"/proc/self/fd/{sealed}"
code = compile(bytes(contents), filename, "exec", dont_inherit=True)
sys.argv = [filename, *BROKER_ARGUMENTS]
namespace = {
    "__name__": "__main__",
    "__file__": filename,
    "__package__": None,
    "__cached__": None,
}
exec(code, namespace, namespace)
`;

function sameStableFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.isFile() && right.isFile();
}

function resolveTrustedPinExecutable(name, candidates = PIN_TRUSTED_EXECUTABLES[name]) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`no fixed executable candidates exist for Pin ${name}`);
  }
  const failures = [];
  for (const requested of candidates) {
    try {
      if (!path.isAbsolute(requested)) throw new Error('candidate is not absolute');
      const executable = fs.realpathSync(requested);
      let cursor = path.parse(executable).root;
      for (const component of executable.slice(cursor.length).split(path.sep).slice(0, -1)) {
        cursor = path.join(cursor, component);
        const ancestor = fs.lstatSync(cursor);
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 ||
            (ancestor.mode & 0o022) !== 0) {
          throw new Error(`untrusted executable ancestor ${cursor}`);
        }
      }
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      const descriptor = fs.openSync(
        executable,
        fs.constants.O_RDONLY | noFollow | (fs.constants.O_CLOEXEC || 0),
      );
      try {
        const before = fs.lstatSync(executable);
        const opened = fs.fstatSync(descriptor);
        const after = fs.lstatSync(executable);
        if (!sameStableFile(before, opened) || !sameStableFile(opened, after) ||
            before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1 ||
            (before.mode & 0o022) !== 0 || (before.mode & 0o111) === 0) {
          throw new Error('executable is not one stable root-owned non-writable file');
        }
      } finally {
        fs.closeSync(descriptor);
      }
      return executable;
    } catch (error) {
      failures.push(`${requested}: ${error.message}`);
    }
  }
  throw new Error(`trusted Pin ${name} executable is unavailable (${failures.join('; ')})`);
}

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

function openStablePinProgram(file, label, { executable = false, snapshot = false } = {}) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const before = fs.lstatSync(file);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | noFollow | (fs.constants.O_CLOEXEC || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const after = fs.lstatSync(file);
    if (!sameStableFile(before, opened) || !sameStableFile(opened, after) ||
        before.isSymbolicLink() || before.nlink !== 1 ||
        (executable && (before.mode & 0o111) === 0)) {
      throw new Error(`${label} is not one stable nofollow regular file`);
    }
    let sha256;
    if (snapshot) {
      if (opened.size < 0 || opened.size > 8 * 1024 * 1024) {
        throw new Error(`${label} exceeds the sealed-program size bound`);
      }
      const contents = fs.readFileSync(descriptor);
      const reread = fs.fstatSync(descriptor);
      if (!sameStableFile(opened, reread) || contents.length !== opened.size) {
        throw new Error(`${label} changed while its bytes were captured`);
      }
      sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    }
    return Object.freeze({ descriptor, metadata: opened, file, label, sha256 });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function revalidateStablePinProgram(program) {
  const opened = fs.fstatSync(program.descriptor);
  const named = fs.lstatSync(program.file);
  if (!sameStableFile(program.metadata, opened) ||
      !sameStableFile(program.metadata, named) || named.isSymbolicLink()) {
    throw new Error(`${program.label} changed while the lane broker was active`);
  }
}

function executePinLaneSession(lane, selection = {}, dependencies = {}) {
  const pythonPath = resolveTrustedPinExecutable('python3');
  const python = openStablePinProgram(pythonPath, 'trusted Pin Python', { executable: true });
  const broker = openStablePinProgram(PIN_BUILDER_DEBUG_STORE, 'Pin lane broker', {
    snapshot: true,
  });
  const spawn = dependencies.spawnSync ?? child.spawnSync;
  let result;
  try {
    result = spawn('/proc/self/fd/3', [
      '-I', '-S', '-B', '-c', PIN_BROKER_BOOTSTRAP, broker.sha256,
      ...pinLaneSessionArguments(lane, selection),
    ], {
      cwd: ROOT,
      env: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'inherit', 'inherit', python.descriptor, broker.descriptor],
    });
    revalidateStablePinProgram(python);
    revalidateStablePinProgram(broker);
  } finally {
    fs.closeSync(broker.descriptor);
    fs.closeSync(python.descriptor);
  }
  if (result.error) throw result.error;
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

function policyTests(environment = testProcessEnvironment()) {
  timedStage('platform version fixtures', testVersionParser);
  info('[implemented] Docker Compose minimum-version parser fixtures passed.');
  const acceptance = path.join(ROOT, 'platform', 'deploy', 'acceptance');
  const scripts = fs.readdirSync(acceptance).sort();
  const pinPath = path.join(ROOT, 'pin');
  const hasPinSource = fs.existsSync(pinPath);
  if (hasPinSource && !fs.lstatSync(pinPath).isDirectory()) {
    fail(`${pinPath} exists but is not a source directory`);
  }
  timedStage('platform shell policies', () => {
    for (const name of scripts.filter((entry) => entry.endsWith('.sh'))) {
      if (!hasPinSource && name === 'layout.sh') {
        info('[implemented] skipped the complete-source layout check in the Pin-free VPS profile.');
        continue;
      }
      timedRun(`platform ${name}`, 'sh', [path.join(acceptance, name)], { env: environment });
    }
  });
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

  // Load lazily to avoid the checks -> gates module cycle during startup. A
  // complete leased snapshot makes package-manager output disposable and
  // prevents this release gate from ever cleaning or mutating source paths.
  const {
    exactNpmVersion,
    isolatedSnapshotGitEnvironment,
    normalizedNpmInstallEnvironment,
    prepareCenterWorkspace,
    prepareNpmDependencies,
  } = require('./checks');
  const prepared = timedStage('release Center source snapshot', prepareCenterWorkspace);
  try {
    const isolatedEnvironment = isolatedSnapshotGitEnvironment(prepared.root, testEnvironment);
    const npmEnvironment = normalizedNpmInstallEnvironment(isolatedEnvironment);
    const npmVersion = exactNpmVersion(npmEnvironment);
    prepareNpmDependencies(prepared.center, 'center-npm', npmVersion, npmEnvironment);
    prepareNpmDependencies(prepared.spotify, 'spotify-adapter-npm', npmVersion, npmEnvironment);
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
  PIN_BROKER_BOOTSTRAP,
  RELEASE_RSA_COMPATIBILITY_TEST,
  assertExactlyOneListedRustTest,
  policyTestArguments,
  policyTestConcurrency,
  policyTestPlan,
  policyTests,
  runCenterUiTests,
  vpsReleaseCheck,
  resolveTrustedPinExecutable,
  pinLaneSessionArguments,
  executePinLaneSession,
  assertPinAmd64ConsumerHost,
  pinContributorCheck,
  pinSourceCheck,
  releaseCheck,
};
