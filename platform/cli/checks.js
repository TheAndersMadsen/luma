'use strict';

const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT, BUILD_DIR, exists, fail, info, secureDirectory,
  testProcessEnvironment, cosmosTestEnvironment, resolveTool, run,
} = require('./context');
const { pinContributorCheck, policyTests } = require('./gates');
const { TimedSubprocessFailure, throwLikeChild, timedRun, timedStage } = require('./timing');
const { validateHostToolchains } = require('./toolchain');

const CHECK_ORDER = Object.freeze(['platform', 'center', 'cosmos', 'pin']);
const ALL_CHECKS = Object.freeze([...CHECK_ORDER]);
const CENTER_DEVELOPMENT_BOUNDARY = new Set([
  'center/Dockerfile', 'center/next.config.mjs',
  'center/package.json',
]);
const COSMOS_PLATFORM_BOUNDARY = new Set([
  'cosmos/Cargo.lock', 'cosmos/Cargo.toml', 'cosmos/Dockerfile',
]);
const FULL_PLATFORM_ROOT_PATHS = new Set([
  '.dockerignore', '.env.example', '.gitignore', 'compose.yaml', 'luma', 'rust-toolchain.toml',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bunfig.toml',
]);
const CARGO_INCREMENTAL_VARIANTS_PER_CRATE = 8;
const CARGO_INCREMENTAL_ACTIVE_MS = 10 * 60 * 1000;
const TEST_POSTGRES_READY_MS = 60 * 1000;
const TEST_POSTGRES_LABEL = 'dk.andersmadsen.luma.environment=cosmos-test';
// A stuck Docker must fail the check, not hang it. `run` may pull the image.
const DOCKER_TIMEOUT_MS = 30 * 1000;
const DOCKER_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const COSMOS_NEEDS_DOCKER = 'Cosmos check runs the Postgres-backed tests against a throwaway PostgreSQL ' +
  'container, so it needs Docker. Install and start Docker Desktop or Docker Engine, then rerun';
// Removes the container if the check dies before its own cleanup runs
// (Ctrl-C, SIGKILL, process.exit). Arguments: owner pid, docker, container.
const TEST_POSTGRES_REAPER = `
const [owner, docker, name] = process.argv.slice(1);
const timer = setInterval(() => {
  try { process.kill(Number(owner), 0); return; } catch (error) { if (error.code === 'EPERM') return; }
  clearInterval(timer);
  require('node:child_process').spawnSync(docker, ['rm', '--force', '--volumes', name], {
    stdio: 'ignore', timeout: ${DOCKER_TIMEOUT_MS}, killSignal: 'SIGKILL',
  });
}, 1000);
`;

/**
 * Keep the useful recent rustc states without letting test/clippy profile hashes
 * grow forever. Cargo's stable GC covers downloads, not target artifacts.
 */
function pruneCargoIncremental(targetDirectory, {
  now = Date.now(),
  keep = CARGO_INCREMENTAL_VARIANTS_PER_CRATE,
  activeMs = CARGO_INCREMENTAL_ACTIVE_MS,
} = {}) {
  if (!Number.isInteger(keep) || keep < 1 || !Number.isFinite(activeMs) || activeMs < 0) {
    throw new Error('invalid Cargo incremental retention policy');
  }
  let removed = 0;
  for (const profile of ['debug', 'release']) {
    const root = path.join(targetDirectory, profile, 'incremental');
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const groups = new Map();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = /^(.*)-[a-z0-9]+$/u.exec(entry.name);
      if (!match) continue;
      const fullPath = path.join(root, entry.name);
      // A concurrent cargo build removes superseded state too, so every entry
      // step can lose the race. Skipping a vanished or busy entry is correct.
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (error) {
        if (['ENOENT', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const rows = groups.get(match[1]) ?? [];
      rows.push({ fullPath, modified: stat.mtimeMs });
      groups.set(match[1], rows);
    }
    for (const rows of groups.values()) {
      rows.sort((left, right) => right.modified - left.modified);
      for (const row of rows.slice(keep)) {
        if (now - row.modified < activeMs) continue;
        try {
          fs.rmSync(row.fullPath, { recursive: true, force: false, maxRetries: 2 });
        } catch (error) {
          if (['ENOENT', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) continue;
          throw error;
        }
        removed += 1;
      }
    }
  }
  return removed;
}

function requiredCommands(commands, label) {
  for (const command of commands) if (!exists(command)) fail(`${label} requires ${command}`);
}

function git(args, { allowFailure = false, cwd = ROOT, env = testProcessEnvironment() } = {}) {
  const result = run('git', args, { cwd, capture: true, allowFailure: true, env });
  if ((result.signal || result.status !== 0) && !allowFailure) {
    fail((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result;
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean);
}

function safeNamespace(namespace) {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(namespace);
}

function exactPnpmVersion(environment) {
  const result = run('pnpm', ['--version'], { capture: true, allowFailure: true, env: environment });
  if (result.signal || result.status !== 0) throwLikeChild(result);
  const version = result.stdout.trim();
  if (!version || /\s/u.test(version)) fail(`pnpm returned an invalid version: ${version || '<empty>'}`);
  const expected = require('./toolchain').loadToolchainContract().pnpm.raw;
  if (version !== expected) throw new Error(`pnpm ${expected} is required; observed ${version}`);
  return version;
}

function normalizedPnpmInstallEnvironment(environment, {
  cacheDirectory = path.join(BUILD_DIR, 'pnpm-cache'),
} = {}) {
  const userConfig = environment.NPM_CONFIG_USERCONFIG;
  const globalConfig = environment.NPM_CONFIG_GLOBALCONFIG;
  const normalized = {};
  for (const [name, value] of Object.entries(environment)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('npm_config_') || lower.startsWith('npm_package_') ||
        lower.startsWith('npm_lifecycle_') || ['node_env', 'node_options', 'bun_options', 'init_cwd'].includes(lower)) continue;
    normalized[name] = value;
  }
  return {
    ...normalized,
    NODE_ENV: 'development',
    NPM_CONFIG_STORE_DIR: cacheDirectory,
    ...(userConfig ? { NPM_CONFIG_USERCONFIG: userConfig } : {}),
    ...(globalConfig ? { NPM_CONFIG_GLOBALCONFIG: globalConfig } : {}),
    NPM_CONFIG_INCLUDE: 'dev',
    NPM_CONFIG_OMIT: '',
    NPM_CONFIG_PRODUCTION: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

function dependencyFingerprint(project, {
  pnpmVersion,
  bunVersion = process.versions.bun,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (typeof pnpmVersion !== 'string' || pnpmVersion.length === 0) {
    throw new Error('dependency fingerprint requires the exact pnpm version');
  }
  const hash = crypto.createHash('sha256');
  hash.update(`bun=${bunVersion}\0pnpm=${pnpmVersion}\0platform=${platform}\0arch=${arch}\0`);
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const file = path.join(project, name);
    if (!fs.existsSync(file)) throw new Error(`pnpm dependency input is missing: ${file}`);
    hash.update(`${name}\0`);
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  const workspace = path.join(project, 'pnpm-workspace.yaml');
  if (fs.existsSync(workspace)) {
    hash.update(fs.readFileSync(workspace));
    // These are the three workspace members. Root lockfile covers their resolutions.
    for (const member of ['center', 'center/adapters/spotify', 'pin/device-installer/cli']) {
      hash.update(fs.readFileSync(path.join(project, member, 'package.json')));
    }
  }
  const npmrc = path.join(project, '.npmrc');
  const hasNpmrc = fs.existsSync(npmrc);
  hash.update(`.npmrc=${hasNpmrc ? 'present' : 'absent'}\0`);
  if (hasNpmrc) hash.update(fs.readFileSync(npmrc));
  return hash.digest('hex');
}

function projectHasDependencies(project) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  return ['dependencies', 'devDependencies', 'optionalDependencies']
    .some((name) => Object.keys(packageJson[name] || {}).length > 0);
}

function writeDependencyStamp(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function reusableDependencies(stamp, key, modules) {
  const current = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
  return current === key && modules.every((directory) =>
    fs.existsSync(directory) && fs.lstatSync(directory).isDirectory());
}

// Same probe as the Postgres reaper above: signal 0 answers the question
// "could this pid exist at all", and only its error code matters.
function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockHolder(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { pid: null, contents: null, missing: true };
    throw error;
  }
  const pid = /^(\d+):/u.exec(contents)?.[1];
  return { pid: pid === undefined ? null : Number(pid), contents, missing: false };
}

// Takes over `file` from its dead owner, whose exact lock contents were
// `stale`. Contenders serialize through `${file}.steal`, created exclusively,
// and the one holding it replaces the lock only if it still holds `stale`: two
// contenders that both saw the dead owner cannot both win, and neither can
// replace a lock a live process took in the meantime. Returns false to retry.
function stealStaleLock(file, stale, contents, contentionMessage) {
  const sentinel = `${file}.steal`;
  try {
    fs.writeFileSync(sentinel, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stealer = lockHolder(sentinel);
    if (stealer.missing || (stealer.pid !== null && processIsLive(stealer.pid))) return false;
    throw new Error(`${contentionMessage}; if no matching check is running, remove stale locks ${file} and ${sentinel}`);
  }
  try {
    if (lockHolder(file).contents !== stale) return false;
    const stolen = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(stolen, contents, { mode: 0o600 });
      fs.renameSync(stolen, file);
    } finally {
      fs.rmSync(stolen, { force: true });
    }
    return true;
  } finally {
    fs.rmSync(sentinel, { force: true });
  }
}

/**
 * Runs `action()` holding `file`, whose content names its owner as
 * `${pid}:${token}`. A SIGKILL'd owner's lock is taken over by exactly one
 * contender (stealStaleLock). Pid reuse can fool the probe, but only into
 * waiting out a dev-loop lock, never into destroying live state.
 */
function withAtomicLock(file, contentionMessage, action) {
  const token = crypto.randomBytes(32).toString('hex');
  const contents = `${process.pid}:${token}`;
  for (;;) {
    let owned = false;
    try {
      fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
      owned = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (owned) break;
    const holder = lockHolder(file);
    if (holder.missing) continue; // released between our claim and the read
    if (holder.pid !== null && processIsLive(holder.pid)) {
      throw new Error(`${contentionMessage}; the lock ${file} is held by live process ${holder.pid}`);
    }
    if (holder.pid === null) {
      throw new Error(`${contentionMessage}; if no matching check is running, remove stale lock ${file}`);
    }
    if (stealStaleLock(file, holder.contents, contents, contentionMessage)) break;
  }
  try {
    return action();
  } finally {
    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === contents) fs.unlinkSync(file);
  }
}

function preparePnpmDependencies(project, namespace, pnpmVersion, environment, runner = timedRun) {
  if (!safeNamespace(namespace)) throw new Error(`invalid pnpm dependency namespace: ${namespace}`);
  if (!fs.existsSync(path.join(project, 'pnpm-workspace.yaml')) && !projectHasDependencies(project)) return { key: null, reused: true };
  const key = dependencyFingerprint(project, { pnpmVersion });
  secureDirectory(BUILD_DIR);
  const state = path.join(BUILD_DIR, 'check-state');
  secureDirectory(state);
  const stamp = path.join(state, `${namespace}.dependencies`);
  const lock = path.join(state, `${namespace}.install.lock`);
  const modules = [path.join(project, 'node_modules')];
  if (fs.existsSync(path.join(project, 'pnpm-workspace.yaml'))) {
    modules.push(path.join(project, 'center', 'node_modules'),
      path.join(project, 'pin', 'device-installer', 'cli', 'node_modules'));
  }
  if (reusableDependencies(stamp, key, modules)) {
    info(`[cached] ${namespace} dependencies.`);
    return { key, reused: true };
  }
  return withAtomicLock(lock, `pnpm dependency install is already running for ${namespace}`, () => {
    if (reusableDependencies(stamp, key, modules)) {
      info(`[cached] ${namespace} dependencies.`);
      return { key, reused: true };
    }
    try {
      fs.unlinkSync(stamp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = runner(`${namespace} dependencies`, 'pnpm', ['install', '--frozen-lockfile', '--prod=false'], {
      cwd: project, env: environment, allowFailure: true,
    });
    if (result.signal || result.status !== 0) throwLikeChild(result);
    writeDependencyStamp(stamp, key);
    return { key, reused: false };
  });
}

function runCenterCheck(dependencies = {}) {
  const environment = dependencies.environment ?? testProcessEnvironment(process.env, {
    NEXT_TELEMETRY_DISABLED: '1',
  });
  const runner = dependencies.runner ?? timedRun;
  const prepare = dependencies.prepareDependencies ?? preparePnpmDependencies;
  requiredCommands(['bun', 'pnpm'], 'Center check');
  try { validateHostToolchains({ includeRust: false, env: environment }); } catch (error) { fail(error.message); }
  const pnpmEnvironment = normalizedPnpmInstallEnvironment(environment);
  const pnpmVersion = dependencies.pnpmVersion ?? exactPnpmVersion(pnpmEnvironment);
  const center = path.join(ROOT, 'center');
  const spotify = path.join(center, 'adapters', 'spotify');
  prepare(ROOT, 'workspace-pnpm', pnpmVersion, pnpmEnvironment, runner);
  secureDirectory(BUILD_DIR);
  const centerBuild = path.join(BUILD_DIR, 'center');
  secureDirectory(centerBuild);
  withAtomicLock(
    path.join(centerBuild, 'typecheck.lock'),
    'Center typecheck is already running',
    () => runner('center typecheck', 'pnpm', [
      'run', 'typecheck', '--tsBuildInfoFile', path.join(centerBuild, 'tsconfig.tsbuildinfo'),
    ], { cwd: center, env: pnpmEnvironment }),
  );
  runner('center server tests', 'pnpm', ['test'], { cwd: center, env: pnpmEnvironment });
  runner('center UI tests', 'pnpm', ['run', 'test:ui'], { cwd: center, env: pnpmEnvironment });
  runner('Spotify adapter tests', 'pnpm', ['test'], { cwd: spotify, env: pnpmEnvironment });
  info('[implemented] Center checks passed from the working tree.');
}

function listedRustTests(output) {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.endsWith(': test'));
}

// `#[ignore]`d Cosmos tests need a live service (Keycloak, Azure Speech) that
// the check never provides, so a filter runs them only when it names nothing
// else: a module filter skips them, an exact ignored test name still runs.
function focusedRustTestArguments(filter, { ignoredOnly = false } = {}) {
  return ['test', '--workspace', '--locked', filter, ...(ignoredOnly ? ['--', '--ignored'] : [])];
}

/** The one digest-pinned PostgreSQL image production runs. */
function productionPostgresImage(file = path.join(ROOT, 'platform', 'compose', 'production.yaml')) {
  const images = [...fs.readFileSync(file, 'utf8').matchAll(
    /^[ \t]+image:[ \t]+(postgres:\S+@sha256:[0-9a-f]{64})[ \t]*$/gmu,
  )].map((match) => match[1]);
  if (images.length !== 1) throw new Error(`${file} must pin exactly one digest-addressed postgres image`);
  return images[0];
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function dockerCommand(environment) {
  const docker = resolveTool('docker');
  return (args, env = environment) => {
    const timeout = args[0] === 'run' ? DOCKER_RUN_TIMEOUT_MS : DOCKER_TIMEOUT_MS;
    const result = child.spawnSync(docker, args, {
      cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL',
    });
    if (!result.error) return result;
    const stderr = result.error.code === 'ETIMEDOUT'
      ? `docker ${args[0]} did not answer within ${timeout / 1000}s`
      : result.error.message;
    return { status: null, signal: result.signal, stdout: '', stderr };
  };
}

function startTestPostgresReaper(name, environment) {
  const reaper = child.spawn(process.execPath, [
    '-e', TEST_POSTGRES_REAPER, String(process.pid), resolveTool('docker'), name,
  ], { detached: true, stdio: 'ignore', env: environment });
  reaper.unref();
  return { stop: () => reaper.kill() };
}

/**
 * Runs `action(databaseUrl)` against a throwaway PostgreSQL container of the
 * production image, published only on loopback, and removes the container
 * afterwards. Production stores everything in Postgres, so its tests must run.
 */
function withTestPostgres(environment, action, {
  docker = dockerCommand(environment),
  startReaper = startTestPostgresReaper,
  image = productionPostgresImage(),
  readyWithinMs = TEST_POSTGRES_READY_MS,
  sleep = sleepSync,
  now = Date.now,
} = {}) {
  const name = `luma-cosmos-test-${crypto.randomBytes(8).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('hex');
  const reaper = startReaper(name, environment);
  try {
    const daemon = docker(['version', '--format', '{{.Server.Version}}']);
    if (daemon.signal || daemon.status !== 0) {
      const detail = (daemon.stderr || '').trim().split(/\r?\n/u).at(-1) || `exit ${daemon.status}`;
      throw new Error(`${COSMOS_NEEDS_DOCKER}. Docker is not answering: ${detail}`);
    }
    // A stopped throwaway container is always garbage: one whose removal met
    // a Docker outage. Live checks' containers are running and stay. Select by
    // the exact label, not the name filter, which matches any substring and
    // could reach an unrelated container and its volumes.
    const leftovers = docker([
      'ps', '--all', '--quiet', '--filter', `label=${TEST_POSTGRES_LABEL}`, '--filter', 'status=exited',
      '--filter', 'status=dead',
    ]);
    const stale = leftovers.status === 0 ? (leftovers.stdout || '').split(/\s+/u).filter(Boolean) : [];
    if (stale.length > 0) docker(['rm', '--volumes', ...stale]);
    info(`[database] starting throwaway PostgreSQL ${name} (${image}).`);
    const started = docker([
      'run', '--detach', '--name', name, '--label', TEST_POSTGRES_LABEL, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER=cosmos_test', '--env', 'POSTGRES_DB=cosmos_test',
      // A bare name makes Docker read the value from its own environment, so
      // the password never appears in a process listing.
      '--env', 'POSTGRES_PASSWORD',
      image,
    ], { ...environment, POSTGRES_PASSWORD: password });
    if (started.signal || started.status !== 0) {
      const detail = (started.stderr || '').trim().split(/\r?\n/u).at(-1) || `exit ${started.status}`;
      throw new Error(`${COSMOS_NEEDS_DOCKER}. docker run failed: ${detail}`);
    }
    const deadline = now() + readyWithinMs;
    // The image's init phase listens only on its socket, so a TCP answer means
    // the final server is up.
    while (docker([
      'exec', name, 'pg_isready', '--host', '127.0.0.1', '--username', 'cosmos_test', '--dbname', 'cosmos_test',
    ]).status !== 0) {
      if (now() >= deadline) throw new Error(`throwaway PostgreSQL ${name} was not ready within ${readyWithinMs / 1000}s`);
      sleep(250);
    }
    const published = docker(['port', name, '5432/tcp']);
    const port = published.status === 0 ? /^127\.0\.0\.1:(\d+)$/mu.exec(published.stdout || '')?.[1] : null;
    if (!port) throw new Error(`throwaway PostgreSQL ${name} has no loopback port`);
    return action(`postgresql://cosmos_test:${password}@127.0.0.1:${port}/cosmos_test`);
  } finally {
    // When removal fails, the reaper retries once this process has exited.
    if (docker(['rm', '--force', '--volumes', name]).status === 0) reaper.stop();
  }
}

function runCosmosCheck(filter = null, dependencies = {}) {
  const environment = dependencies.environment ?? cosmosTestEnvironment();
  const runner = dependencies.runner ?? timedRun;
  const database = dependencies.database ?? withTestPostgres;
  requiredCommands(['rustc', 'cargo'], 'Cosmos check');
  if (!exists('docker')) fail(COSMOS_NEEDS_DOCKER);
  try { validateHostToolchains({ env: environment }); } catch (error) { fail(error.message); }
  const cosmos = path.join(ROOT, 'cosmos');
  const focusedOptions = { ignoredOnly: false };
  runner('cosmos format', 'cargo', ['fmt', '--all', '--check'], { cwd: cosmos, env: environment });
  if (filter !== null) {
    info(`[focused] Cosmos test filter: ${filter}`);
    const discovery = runner('cosmos test discovery', 'cargo', [
      'test', '--workspace', '--locked', filter, '--', '--list',
    ], { cwd: cosmos, env: environment, capture: true, allowFailure: true });
    if (discovery.signal || discovery.status !== 0) {
      // The listing is captured to count matches, so show cargo's own report
      // (a compile error, usually) instead of a bare exit status.
      process.stderr.write(discovery.stderr || discovery.stdout || '');
      throwLikeChild(discovery);
    }
    const matches = listedRustTests(discovery.stdout);
    if (matches.length === 0) fail(`Cosmos test filter matched zero tests: ${filter}`);
    const ignoredDiscovery = runner('cosmos ignored test discovery', 'cargo', [
      'test', '--workspace', '--locked', filter, '--', '--list', '--ignored',
    ], { cwd: cosmos, env: environment, capture: true, allowFailure: true });
    if (ignoredDiscovery.signal || ignoredDiscovery.status !== 0) {
      process.stderr.write(ignoredDiscovery.stderr || ignoredDiscovery.stdout || '');
      throwLikeChild(ignoredDiscovery);
    }
    const ignored = listedRustTests(ignoredDiscovery.stdout).length;
    focusedOptions.ignoredOnly = ignored === matches.length;
    info(`[observed] Cosmos test filter matched ${matches.length} test${matches.length === 1 ? '' : 's'}` +
      (ignored > 0 && !focusedOptions.ignoredOnly
        ? `; its ${ignored} ignored live-service test${ignored === 1 ? ' is' : 's are'} skipped (name one alone to run it).`
        : '.'));
  } else {
    runner('cosmos clippy', 'cargo', [
      'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings',
    ], { cwd: cosmos, env: environment });
    // The prompt registry's own tooling tests and the source hygiene check.
    // No bytecode is written into the checkout.
    requiredCommands(['python3'], 'Cosmos check');
    const python = { cwd: cosmos, env: { ...environment, PYTHONDONTWRITEBYTECODE: '1' } };
    runner('cosmos python tests', 'python3', ['-m', 'unittest', 'discover', '-s', 'verify'], python);
    runner('cosmos hygiene', 'python3', ['verify/hygiene.py'], python);
  }
  try {
    database(environment, (databaseUrl) => {
      const env = { ...environment, COSMOS_TEST_DATABASE_URL: databaseUrl };
      if (filter !== null) {
        runner('cosmos focused tests', 'cargo', focusedRustTestArguments(filter, focusedOptions), { cwd: cosmos, env });
      }
      else runner('cosmos tests', 'cargo', ['test', '--workspace', '--locked'], { cwd: cosmos, env });
    });
  } catch (error) {
    if (error instanceof TimedSubprocessFailure) throw error;
    fail(error.message);
  }
  info(filter === null
    ? '[implemented] Cosmos format, lint, and tests passed from the working tree.'
    : '[implemented] Cosmos format and selected tests passed from the working tree.');
  // Housekeeping after a passed check: a prune failure (a race with a
  // concurrent cargo build, a full disk) must never flip the result.
  try {
    const removed = pruneCargoIncremental(environment.CARGO_TARGET_DIR);
    if (removed > 0) info(`[cache] removed ${removed} superseded Rust incremental state${removed === 1 ? '' : 's'}.`);
  } catch (error) {
    process.stderr.write(`warning: skipped Cargo incremental pruning: ${error.message}\n`);
  }
}

function runPlatformCheck(dependencies = {}) {
  const environment = dependencies.environment ?? testProcessEnvironment();
  const full = dependencies.full === true;
  requiredCommands(['bun'], 'Platform check');
  try { validateHostToolchains({ includeRust: false, env: environment }); } catch (error) { fail(error.message); }
  (dependencies.policyRunner ?? policyTests)(environment, { contributor: !full });
  info(full
    ? '[implemented] full platform Bun acceptance inventory passed from the working tree.'
    : '[implemented] contributor platform acceptance checks passed from the working tree.');
}

function normalizeChangedPath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function orderedChecks(...components) {
  const selected = new Set(components);
  return new Set(CHECK_ORDER.filter((component) => selected.has(component)));
}

function checksForPath(file) {
  const normalized = normalizeChangedPath(file);
  if (CENTER_DEVELOPMENT_BOUNDARY.has(normalized)) return orderedChecks('platform', 'center');
  if (normalized === 'rust-toolchain.toml') return orderedChecks('platform', 'cosmos', 'pin');
  if (COSMOS_PLATFORM_BOUNDARY.has(normalized)) return orderedChecks('platform', 'cosmos');
  if (normalized.startsWith('center/')) return orderedChecks('center');
  if (normalized.startsWith('cosmos/')) return orderedChecks('cosmos');
  if (normalized.startsWith('pin/')) return orderedChecks('pin');
  if (normalized.startsWith('contracts/wire/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'contracts/operator-setup.json') return orderedChecks('platform', 'center');
  if (normalized.startsWith('contracts/')) return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('.github/')) return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('platform/cli/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'platform/compose/development.yaml') return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('platform/distribution/') || normalized.startsWith('platform/deploy/acceptance/')) {
    return normalized.startsWith('platform/deploy/acceptance/pin/')
      ? orderedChecks('platform', 'pin') : orderedChecks('platform');
  }
  if (normalized.startsWith('platform/containers/pin-builder/') ||
      normalized.startsWith('platform/deploy/pin/')) return orderedChecks('platform', 'pin');
  if (normalized.startsWith('platform/containers/observability/')) return orderedChecks('platform', 'center', 'cosmos');
  if (normalized.startsWith('platform/compose/') || normalized.startsWith('platform/deploy/vps/') ||
      normalized.startsWith('platform/edge/')) return orderedChecks('platform', 'center', 'cosmos');
  if (normalized.startsWith('platform/setup/')) return orderedChecks('platform', 'center');
  if (normalized.startsWith('platform/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'luma') return orderedChecks(...ALL_CHECKS);
  if (normalized === '.gitignore') return orderedChecks('platform');
  if (normalized === 'compose.yaml' || normalized === '.env.example') return orderedChecks('platform', 'center', 'cosmos');
  if (normalized === '.dockerignore') return orderedChecks(...ALL_CHECKS);
  // README sentences are pinned by platform suites outside the contributor
  // list and by Center's verify tests (`rg -l README.md platform center/verify`).
  if (normalized === 'README.md') return orderedChecks('platform', 'center');
  if (normalized.startsWith('docs/') || normalized.endsWith('.md')) return orderedChecks('platform');
  return orderedChecks(...ALL_CHECKS);
}

function requiresFullPlatformCheck(file) {
  const normalized = normalizeChangedPath(file);
  if (normalized === 'README.md') return true;
  if (normalized.startsWith('platform/') || normalized.startsWith('.github/') ||
      normalized.startsWith('contracts/') || FULL_PLATFORM_ROOT_PATHS.has(normalized)) return true;
  if (normalized.startsWith('center/') || normalized.startsWith('cosmos/') ||
      normalized.startsWith('pin/') || normalized.startsWith('docs/') || normalized.endsWith('.md')) return false;
  return true;
}

function changedCheckComponents(files) {
  const selected = new Set();
  for (const file of files) for (const component of checksForPath(file)) selected.add(component);
  return CHECK_ORDER.filter((component) => selected.has(component));
}

function validGitBaseRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') &&
    !ref.includes('\0') && !ref.includes('\n') && !ref.includes('\r');
}

function verifiedRef(ref, { cwd = ROOT, environment } = {}) {
  if (!validGitBaseRef(ref)) throw new Error(`invalid git base ref: ${ref || '<empty>'}`);
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true, cwd, env: environment,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function defaultBaseCommit({ cwd = ROOT, environment } = {}) {
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const commit = verifiedRef(candidate, { cwd, environment });
    if (commit) return commit;
  }
  return null;
}

function changedPaths(baseRef = null, { cwd = ROOT, environment: suppliedEnvironment } = {}) {
  const environment = suppliedEnvironment ?? testProcessEnvironment();
  if (!exists('git')) throw new Error('Changed check requires git');

  const inside = git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true, cwd, env: environment });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') throw new Error('check changed requires a Git worktree');
  const requestedBase = baseRef === null
    ? defaultBaseCommit({ cwd, environment }) : verifiedRef(baseRef, { cwd, environment });
  if (baseRef !== null && requestedBase === null) throw new Error(`git base ref does not resolve to a commit: ${baseRef}`);
  let base = null;
  if (requestedBase !== null) {
    const mergeBase = git(['merge-base', 'HEAD', requestedBase], { allowFailure: true, cwd, env: environment });
    if (mergeBase.status === 0 && mergeBase.stdout.trim()) base = mergeBase.stdout.trim();
  }
  const files = new Set();
  const add = (result) => { for (const file of nulPaths(result.stdout)) files.add(normalizeChangedPath(file)); };
  if (base === null) add(git(['ls-files', '-z', '--cached'], { cwd, env: environment }));
  else add(git(['diff', '--no-renames', '--name-only', '-z', `${base}..HEAD`], { cwd, env: environment }));
  add(git(['diff', '--no-renames', '--name-only', '-z'], { cwd, env: environment }));
  add(git(['diff', '--no-renames', '--name-only', '-z', '--cached'], { cwd, env: environment }));
  add(git(['ls-files', '-z', '--others', '--exclude-standard'], { cwd, env: environment }));
  return { base, files: [...files].sort() };
}

function parseChangedArguments(args) {
  if (args.length === 0) return { base: null };
  if (args.length === 2 && args[0] === '--base' && validGitBaseRef(args[1])) return { base: args[1] };
  fail('usage: ./luma check changed [--base REF]', 64);
}

function parseCosmosArguments(args) {
  if (args.length === 0) return { filter: null };
  if (args.length === 1 && args[0].length > 0 && !args[0].startsWith('-')) return { filter: args[0] };
  fail('usage: ./luma check cosmos [TEST_FILTER]', 64);
}

function parsePlatformArguments(args) {
  if (args.length === 0) return { full: false };
  if (args.length === 1 && args[0] === '--full') return { full: true };
  fail('usage: ./luma check platform [--full]', 64);
}

function runSelectedCheck(component, { fullPlatform = false } = {}) {
  if (component === 'platform') {
    return timedStage('check platform total', () => runPlatformCheck({ full: fullPlatform }));
  }
  if (component === 'center') return timedStage('check center total', runCenterCheck);
  if (component === 'cosmos') return timedStage('check cosmos total', () => runCosmosCheck());
  if (component === 'pin') return timedStage('check pin total', pinContributorCheck);
  throw new Error(`unknown check component: ${component}`);
}

function runSelectedComponents(components, runner = runSelectedCheck, options = {}) {
  if (!Array.isArray(components) || typeof runner !== 'function') throw new Error('selected checks require an array and a runner');
  for (const component of components) runner(component, options);
}

function checkCommand(args) {
  const [component, ...rest] = args;
  if (component === 'center') {
    if (rest.length !== 0) fail('usage: ./luma check center', 64);
    return timedStage('check center total', runCenterCheck);
  }
  if (component === 'cosmos') {
    const options = parseCosmosArguments(rest);
    return timedStage('check cosmos total', () => runCosmosCheck(options.filter));
  }
  if (component === 'platform') {
    const options = parsePlatformArguments(rest);
    return timedStage('check platform total', () => runPlatformCheck(options));
  }
  if (component === 'changed') {
    const options = parseChangedArguments(rest);
    let changeSet;
    try { changeSet = changedPaths(options.base); } catch (error) { fail(error.message, 1); }
    const selected = changedCheckComponents(changeSet.files);
    const fullPlatform = changeSet.files.some(requiresFullPlatformCheck);
    info(`[observed] changed paths: ${changeSet.files.length}; base: ${changeSet.base || '<entire tracked tree>'}.`);
    if (selected.length === 0) {
      info('[implemented] no changed source paths require checks.');
      return;
    }
    info(`[implemented] selected checks: ${selected.map((name) =>
      name === 'platform' && fullPlatform ? 'platform --full' : name).join(', ')}.`);
    runSelectedComponents(selected, undefined, { fullPlatform });
    return;
  }
  fail('usage: ./luma check center | cosmos [TEST_FILTER] | platform [--full] | changed [--base REF]', 64);
}

module.exports = {
  changedCheckComponents, changedPaths, checkCommand, checksForPath,
  defaultBaseCommit, dependencyFingerprint,
  exactPnpmVersion, focusedRustTestArguments, listedRustTests,
  normalizedPnpmInstallEnvironment, parseChangedArguments, parseCosmosArguments, parsePlatformArguments,
  preparePnpmDependencies, productionPostgresImage, pruneCargoIncremental,
  runCenterCheck, runCosmosCheck, runPlatformCheck,
  requiresFullPlatformCheck, runSelectedComponents, validGitBaseRef, withAtomicLock, withTestPostgres,
};
