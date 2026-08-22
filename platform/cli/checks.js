'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  BUILD_DIR,
  exists,
  fail,
  info,
  isInsideDirectory,
  ensureEmptyTestNpmConfig,
  testProcessEnvironment,
  cosmosTestEnvironment,
  run,
  secureDirectory,
} = require('./context');
const { pinContributorCheck } = require('./gates');
const {
  readStableRootedEntries,
} = require('./rooted-source');
const { throwLikeChild, timedRun, timedStage } = require('./timing');
const { validateHostToolchains } = require('./toolchain');

const CHECK_ORDER = Object.freeze(['platform', 'center', 'cosmos', 'pin']);
const ALL_CHECKS = Object.freeze([...CHECK_ORDER]);
const NPM_INSTALL_MODE = 'npm-ci--include=dev';
const NPM_INSTALL_POLICY_VERSION = '2';
const CACHE_SCHEMA = 2;
const CACHE_MARKER = '.revival-cache.json';
const STALE_FAST_CHECK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_RETENTION_PER_NAMESPACE = 4;
const FAST_CHECK_LEASE_DIRECTORY = 'fast-check-leases';
const CHANGED_POLICY_SCRIPTS = Object.freeze([
  'source-policy.sh',
  'layout.sh',
]);
const CENTER_DEVELOPMENT_BOUNDARY = new Set([
  'center/.dockerignore',
  'center/Dockerfile',
  'center/next.config.mjs',
  'center/package-lock.json',
  'center/package.json',
]);
const COSMOS_PLATFORM_BOUNDARY = new Set([
  'cosmos/Cargo.lock',
  'cosmos/Cargo.toml',
  'cosmos/Dockerfile',
]);

function requiredCommands(commands, label, environment = testProcessEnvironment()) {
  for (const command of commands) {
    if (!exists(command, environment)) fail(`${label} requires ${command}`);
  }
}

function git(args, { allowFailure = false, cwd = ROOT, env = testProcessEnvironment() } = {}) {
  const result = run('git', args, {
    cwd,
    capture: true,
    allowFailure: true,
    env,
  });
  if ((result.signal || result.status !== 0) && !allowFailure) {
    fail((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result;
}

function isolatedSnapshotGitEnvironment(destination, environment = process.env) {
  const isolated = { ...environment };
  for (const name of Object.keys(isolated)) {
    // Git has many process-level injection channels (repository routing,
    // config pairs, hooks, pagers, external diffs, object stores, tracing,
    // and more). Deny the entire namespace, then add back only the four
    // isolation controls below.
    if (name.toUpperCase().startsWith('GIT_')) delete isolated[name];
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  // Git receives an isolated HOME and XDG root while every ambient
  // global/system configuration and system attributes file is disabled.
  isolated.HOME = path.join(destination, '.git', 'revival-isolated-home');
  isolated.XDG_CONFIG_HOME = path.join(destination, '.git', 'revival-isolated-xdg');
  isolated.GIT_CONFIG_GLOBAL = nullDevice;
  isolated.GIT_CONFIG_SYSTEM = nullDevice;
  isolated.GIT_CONFIG_NOSYSTEM = '1';
  isolated.GIT_ATTR_NOSYSTEM = '1';
  return isolated;
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean);
}

function safeRelativePath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  return normalized.length > 0 &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split('/').includes('..');
}

function snapshotSourcePaths(sourceRoot, destination) {
  const listed = git(
    [
      '-c', 'core.fsmonitor=false',
      'ls-files', '-z', '--cached', '--others', '--exclude-standard',
    ],
    {
      cwd: sourceRoot,
      env: isolatedSnapshotGitEnvironment(destination),
    },
  );
  return nulPaths(listed.stdout);
}

function deletedSourcePaths(sourceRoot, destination) {
  const listed = git(['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--deleted'], {
    cwd: sourceRoot,
    env: isolatedSnapshotGitEnvironment(destination),
  });
  return new Set(nulPaths(listed.stdout));
}

function assertNoForbiddenRealTreeRoots(sourceRoot) {
  const rootDirectory = readStableRootedEntries(
    sourceRoot,
    ['.'],
    'check snapshots',
  ).entries[0];
  for (const boundary of ['private', 'state']) {
    if (rootDirectory.names.includes(boundary)) {
      throw new Error(`forbidden top-level private/state boundary exists before snapshot: ${boundary}`);
    }
  }
  return rootDirectory;
}

function initializeSnapshotRepository(destination) {
  // The snapshot is data for checks, never an extension point. Every Git
  // command here ignores ambient configuration, templates, hooks, attributes,
  // and configured clean filters.
  const env = isolatedSnapshotGitEnvironment(destination);
  git(['init', '--quiet', '--initial-branch=main', '--template='], {
    cwd: destination,
    env,
  });
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  const emptyHooks = path.join(destination, '.git', 'revival-empty-hooks');
  fs.mkdirSync(emptyHooks, { mode: 0o700 });
  git(['config', '--local', 'core.hooksPath', emptyHooks], { cwd: destination, env });
  // Force is intentional: an already-tracked source file remains part of the
  // snapshot even if a later ignore rule happens to match its name.
  git(['-c', `core.hooksPath=${emptyHooks}`, 'add', '--all', '--force'], {
    cwd: destination,
    env,
  });
  git([
    '-c', 'user.name=Ai Pin Revival checks',
    '-c', 'user.email=checks@localhost.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${emptyHooks}`,
    'commit', '--quiet', '--no-verify', '-m', 'Disposable source snapshot',
  ], { cwd: destination, env });
}

function snapshotRepository(destination, {
  sourceRoot = ROOT,
  initializeGit = true,
  beforeStabilityCheck,
} = {}) {
  const sourceRootDirectory = assertNoForbiddenRealTreeRoots(sourceRoot);
  const { path: _rootPath, ...sourceRootReceipt } = sourceRootDirectory.receipt.ancestry[0];
  if (!isInsideDirectory(destination, BUILD_DIR)) {
    throw new Error(`refusing to create a check snapshot outside REVIVAL_BUILD_DIR: ${destination}`);
  }
  if (!fs.existsSync(destination) || !fs.lstatSync(destination).isDirectory()) {
    throw new Error(`check snapshot destination must be an existing directory: ${destination}`);
  }
  if (fs.readdirSync(destination).length !== 0) {
    throw new Error(`check snapshot destination must be empty: ${destination}`);
  }

  const initialPaths = snapshotSourcePaths(sourceRoot, destination);
  const initialDeleted = deletedSourcePaths(sourceRoot, destination);
  const initialFiles = initialPaths.filter((relative) => !initialDeleted.has(relative));
  const initialBatch = readStableRootedEntries(
    sourceRoot,
    initialFiles,
    'check snapshots',
    { expectedRoot: sourceRootReceipt },
  );
  const initialEntries = new Map(initialBatch.entries.map((entry) => [entry.receipt.path, entry]));
  const initialReceipt = [];
  for (const relative of initialPaths) {
    if (!safeRelativePath(relative)) throw new Error(`git reported an unsafe source path: ${relative}`);
    if (initialDeleted.has(relative)) {
      initialReceipt.push({ path: relative, absent: true });
      continue;
    }
    const target = path.join(destination, relative);
    const stable = initialEntries.get(relative);
    if (!stable || stable.kind !== 'file') {
      throw new Error(`git source path is not one stable regular file: ${relative}`);
    }
    const mode = Number(stable.stat.mode) & 0o777;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, stable.data, { flag: 'wx', mode });
    fs.chmodSync(target, mode);
    initialReceipt.push(stable.receipt);
  }
  if (beforeStabilityCheck !== undefined) {
    if (typeof beforeStabilityCheck !== 'function') {
      throw new Error('snapshot beforeStabilityCheck must be a function');
    }
    beforeStabilityCheck();
  }
  const finalPaths = snapshotSourcePaths(sourceRoot, destination);
  const finalDeleted = deletedSourcePaths(sourceRoot, destination);
  if (JSON.stringify(finalPaths) !== JSON.stringify(initialPaths)) {
    throw new Error('source path manifest changed while creating check snapshot');
  }
  if (JSON.stringify([...finalDeleted].sort()) !== JSON.stringify([...initialDeleted].sort())) {
    throw new Error('source deletion manifest changed while creating check snapshot');
  }
  const finalBatch = readStableRootedEntries(
    sourceRoot,
    finalPaths.filter((relative) => !finalDeleted.has(relative)),
    'check snapshots',
    { expectedRoot: sourceRootReceipt },
  );
  const finalEntries = new Map(finalBatch.entries.map((entry) => [entry.receipt.path, entry]));
  const finalReceipt = [];
  for (const relative of finalPaths) {
    if (finalDeleted.has(relative)) finalReceipt.push({ path: relative, absent: true });
    else finalReceipt.push(finalEntries.get(relative)?.receipt ?? { path: relative, missing: true });
  }
  if (JSON.stringify(finalReceipt) !== JSON.stringify(initialReceipt)) {
    throw new Error('source content manifest changed while creating check snapshot');
  }
  const finalRootDirectory = readStableRootedEntries(
    sourceRoot,
    ['.'],
    'check snapshots',
    { expectedRoot: sourceRootReceipt },
  ).entries[0];
  if (JSON.stringify(finalRootDirectory.receipt) !== JSON.stringify(sourceRootDirectory.receipt)) {
    throw new Error('source root manifest changed while creating check snapshot');
  }
  if (initializeGit) initializeSnapshotRepository(destination);
  return destination;
}

function safeNamespace(namespace) {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(namespace);
}

function createDisposableWorkspace(namespace, options = {}) {
  if (!safeNamespace(namespace)) throw new Error(`invalid check workspace namespace: ${namespace}`);
  secureDirectory(BUILD_DIR);
  const workspaces = path.join(BUILD_DIR, 'fast-check-workspaces');
  secureDirectory(workspaces);
  const namespaceRoot = path.join(workspaces, namespace);
  secureDirectory(namespaceRoot);
  pruneFastCheckState();
  const lease = acquireFastCheckLease('workspace');
  let workspace;
  try {
    workspace = fs.mkdtempSync(path.join(namespaceRoot, 'run-'));
  } catch (error) {
    lease.release();
    throw error;
  }
  fs.chmodSync(workspace, 0o700);
  let active = true;
  const finish = () => {
    if (!active) return;
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    } finally {
      lease.release();
      active = false;
      process.removeListener('exit', finish);
    }
  };
  process.once('exit', finish);
  try {
    snapshotRepository(workspace, options);
  } catch (error) {
    finish();
    throw error;
  }
  return { root: workspace, finish };
}

function isRegularDirectory(candidate) {
  if (!fs.existsSync(candidate)) return false;
  const stat = fs.lstatSync(candidate);
  return !stat.isSymbolicLink() && stat.isDirectory();
}

function dependencyFingerprint(project, {
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  npmVersion,
  installMode = NPM_INSTALL_MODE,
  installPolicy = NPM_INSTALL_POLICY_VERSION,
} = {}) {
  if (!npmVersion || typeof npmVersion !== 'string') {
    throw new Error('dependency fingerprint requires the exact npm version');
  }
  const hash = crypto.createHash('sha256');
  for (const [name, value] of Object.entries({
    platform,
    arch,
    nodeVersion,
    npmVersion,
    installMode,
    installPolicy,
  })) {
    hash.update(`${name}=${value}\0`);
  }
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    const file = path.join(project, name);
    if (!fs.existsSync(file)) {
      if (name === '.npmrc') continue;
      throw new Error(`npm dependency input is missing: ${file}`);
    }
    hash.update(`${name}\0`);
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function ensureEmptyNpmConfig(kind) {
  return ensureEmptyTestNpmConfig(kind);
}

function normalizedNpmInstallEnvironment(environment, {
  userConfigFile = ensureEmptyNpmConfig('user'),
  globalConfigFile = ensureEmptyNpmConfig('global'),
  cacheDirectory = path.join(BUILD_DIR, 'npm-cache'),
} = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(environment)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('npm_config_') ||
        lower.startsWith('npm_package_') ||
        lower.startsWith('npm_lifecycle_') ||
        ['node_env', 'node_options', 'init_cwd'].includes(lower)) {
      continue;
    }
    normalized[name] = value;
  }
  return {
    ...normalized,
    NODE_ENV: 'development',
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_USERCONFIG: userConfigFile,
    NPM_CONFIG_GLOBALCONFIG: globalConfigFile,
    NPM_CONFIG_INCLUDE: 'dev',
    NPM_CONFIG_OMIT: '',
    NPM_CONFIG_PRODUCTION: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    NPM_CONFIG_LEGACY_PEER_DEPS: 'false',
    NPM_CONFIG_STRICT_PEER_DEPS: 'false',
    NPM_CONFIG_INSTALL_LINKS: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

function cacheManifest(candidate, namespace, key) {
  const entries = [];
  const canonicalRoot = fs.realpathSync(candidate);
  const visit = (directory, relativeDirectory = '') => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en'))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relativeDirectory === '' && name === CACHE_MARKER) continue;
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolutePath);
        if (path.isAbsolute(target)) throw new Error(`absolute link in dependency cache: ${relativePath}`);
        const resolved = path.resolve(path.dirname(absolutePath), target);
        if (!isInsideDirectory(resolved, candidate) || !fs.existsSync(resolved) ||
            !isInsideDirectory(fs.realpathSync(resolved), canonicalRoot)) {
          throw new Error(`escaping or dangling link in dependency cache: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: 'symlink', mode, target });
      } else if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode });
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: 'file',
          mode,
          size: stat.size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
        });
      } else {
        throw new Error(`special file in dependency cache: ${relativePath}`);
      }
    }
  };
  visit(candidate);
  return { schema: CACHE_SCHEMA, namespace, key, entries };
}

function cacheManifestText(candidate, namespace, key) {
  return `${JSON.stringify(cacheManifest(candidate, namespace, key))}\n`;
}

function completeCache(candidate, namespace, key) {
  try {
    if (!isRegularDirectory(candidate)) return false;
    const marker = path.join(candidate, CACHE_MARKER);
    if (!fs.existsSync(marker)) return false;
    const stat = fs.lstatSync(marker);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    return fs.readFileSync(marker, 'utf8') === cacheManifestText(candidate, namespace, key);
  } catch {
    return false;
  }
}

function removeClaimedPath(candidate) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(candidate, { recursive: true, force: false, maxRetries: 3 });
  } else {
    fs.unlinkSync(candidate);
  }
}

function ensurePrivateLeaseDirectory(directory, buildDirectory) {
  if (buildDirectory === BUILD_DIR) {
    secureDirectory(buildDirectory);
    secureDirectory(directory);
  } else if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const stat = fs.lstatSync(directory);
  const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 || wrongOwner) {
    throw new Error(`fast-check lease root must be an owner-owned mode-0700 directory: ${directory}`);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function leasePid(name) {
  const match = /^lease-(\d+)-/u.exec(name);
  return match ? Number(match[1]) : null;
}

function synchronousPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireFastCheckLease(label, { buildDirectory = BUILD_DIR } = {}) {
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9-]+/gu, '-');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(safeLabel)) {
    throw new Error(`invalid fast-check lease label: ${label}`);
  }
  const root = path.join(buildDirectory, FAST_CHECK_LEASE_DIRECTORY);
  ensurePrivateLeaseDirectory(root, buildDirectory);
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    const maintenance = path.join(root, 'maintenance');
    if (fs.existsSync(maintenance)) {
      synchronousPause(10);
      continue;
    }
    const name = `lease-${process.pid}-${safeLabel}-${crypto.randomUUID()}`;
    const lease = path.join(root, name);
    fs.mkdirSync(lease, { mode: 0o700 });
    if (fs.existsSync(maintenance)) {
      fs.rmdirSync(lease);
      synchronousPause(10);
      continue;
    }
    let active = true;
    return {
      path: lease,
      release() {
        if (!active) return;
        fs.rmdirSync(lease);
        active = false;
      },
    };
  }
  throw new Error('timed out waiting for fast-check maintenance intent');
}

function acquireFastCheckMaintenance(buildDirectory) {
  const root = path.join(buildDirectory, FAST_CHECK_LEASE_DIRECTORY);
  ensurePrivateLeaseDirectory(root, buildDirectory);
  // A dead owner cannot retain the maintenance barrier forever. Live owners
  // and live reader leases always win; PID reuse therefore leaks cache space
  // conservatively rather than risking deletion under an active process.
  const intent = path.join(root, 'maintenance');
  const claimDeadIntent = () => {
    const claimed = path.join(root, `.dead-maintenance-${crypto.randomUUID()}`);
    try {
      fs.renameSync(intent, claimed);
      fs.rmSync(claimed, { recursive: true, force: false });
      return true;
    } catch (error) {
      if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      return false;
    }
  };
  try {
    fs.mkdirSync(intent, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ownerPath = path.join(intent, 'owner');
    let owner = null;
    try {
      owner = Number(fs.readFileSync(ownerPath, 'utf8').trim());
    } catch (readError) {
      if (readError.code !== 'ENOENT') throw readError;
    }
    const stat = fs.lstatSync(intent, { throwIfNoEntry: false });
    if (processIsAlive(owner) || !stat || Date.now() - stat.mtimeMs < 60_000 || !claimDeadIntent()) {
      return null;
    }
    try {
      fs.mkdirSync(intent, { mode: 0o700 });
    } catch (retryError) {
      if (retryError.code === 'EEXIST') return null;
      throw retryError;
    }
  }
  fs.writeFileSync(path.join(intent, 'owner'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  const release = () => fs.rmSync(intent, { recursive: true, force: false });
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('lease-')) continue;
    if (processIsAlive(leasePid(name))) {
      release();
      return null;
    }
    const candidate = path.join(root, name);
    const claimed = path.join(root, `.dead-${name}-${crypto.randomUUID()}`);
    try {
      fs.renameSync(candidate, claimed);
      fs.rmSync(claimed, { recursive: true, force: false });
    } catch (error) {
      if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        release();
        throw error;
      }
    }
  }
  return { release };
}

function claimAndRemoveManagedPath(candidate, parent, kind = 'stale') {
  if (path.dirname(candidate) !== parent || !fs.existsSync(candidate)) return false;
  const claim = path.join(
    parent,
    `.prune-${kind}-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.renameSync(candidate, claim);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
    throw error;
  }
  removeClaimedPath(claim);
  return true;
}

function staleManagedPath(candidate, cutoff) {
  try {
    return fs.lstatSync(candidate).mtimeMs < cutoff;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function pruneFastCheckState({
  buildDirectory = BUILD_DIR,
  now = Date.now(),
  staleAgeMs = STALE_FAST_CHECK_AGE_MS,
  cacheRetention = CACHE_RETENTION_PER_NAMESPACE,
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(staleAgeMs) || staleAgeMs < 0 ||
      !Number.isSafeInteger(cacheRetention) || cacheRetention < 1) {
    throw new Error('invalid fast-check pruning policy');
  }
  const cutoff = now - staleAgeMs;
  const removed = { workspaces: 0, publications: 0, caches: 0, claims: 0 };
  const maintenance = acquireFastCheckMaintenance(buildDirectory);
  if (maintenance === null) return removed;
  try {
  const workspacesRoot = path.join(buildDirectory, 'fast-check-workspaces');
  if (isRegularDirectory(workspacesRoot)) {
    for (const namespace of fs.readdirSync(workspacesRoot)) {
      const namespaceRoot = path.join(workspacesRoot, namespace);
      if (!isRegularDirectory(namespaceRoot)) continue;
      for (const name of fs.readdirSync(namespaceRoot)) {
        if (!name.startsWith('run-') && !name.startsWith('.prune-')) continue;
        const candidate = path.join(namespaceRoot, name);
        if (staleManagedPath(candidate, cutoff) &&
            claimAndRemoveManagedPath(candidate, namespaceRoot, 'workspace')) {
          removed[name.startsWith('.prune-') ? 'claims' : 'workspaces'] += 1;
        }
      }
    }
  }

  const cacheRoot = path.join(buildDirectory, 'fast-check-cache');
  if (isRegularDirectory(cacheRoot)) {
    for (const namespace of fs.readdirSync(cacheRoot)) {
      const namespaceRoot = path.join(cacheRoot, namespace);
      if (!isRegularDirectory(namespaceRoot)) continue;
      const cacheEntries = [];
      for (const name of fs.readdirSync(namespaceRoot)) {
        const candidate = path.join(namespaceRoot, name);
        if (name.startsWith('.publish-') || name.startsWith('.prune-')) {
          if (staleManagedPath(candidate, cutoff) &&
              claimAndRemoveManagedPath(candidate, namespaceRoot, 'publication')) {
            removed[name.startsWith('.prune-') ? 'claims' : 'publications'] += 1;
          }
          continue;
        }
        if (!/^[a-f0-9]{64}$/u.test(name)) continue;
        const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (stat) cacheEntries.push({ candidate, mtimeMs: stat.mtimeMs });
      }
      cacheEntries.sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const entry of cacheEntries.slice(cacheRetention)) {
        if (entry.mtimeMs < cutoff && claimAndRemoveManagedPath(entry.candidate, namespaceRoot, 'cache')) {
          removed.caches += 1;
        }
      }
    }
  }
    return removed;
  } finally {
    maintenance.release();
  }
}

function ensureContentAddressedDirectory(namespace, key, builder) {
  if (!safeNamespace(namespace)) throw new Error(`invalid dependency-cache namespace: ${namespace}`);
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error(`invalid dependency-cache key: ${key}`);
  if (typeof builder !== 'function') throw new Error('dependency-cache builder must be a function');

  secureDirectory(BUILD_DIR);
  const cacheRoot = path.join(BUILD_DIR, 'fast-check-cache');
  secureDirectory(cacheRoot);
  const namespaceRoot = path.join(cacheRoot, namespace);
  secureDirectory(namespaceRoot);
  pruneFastCheckState();
  const lease = acquireFastCheckLease('cache-publish');
  try {
  const published = path.join(namespaceRoot, key);
  if (completeCache(published, namespace, key)) {
    const now = new Date();
    fs.utimesSync(published, now, now);
    return { path: published, reused: true };
  }
  if (fs.existsSync(published)) {
    // A concurrent publisher can win between the first validation and this
    // existence check. Validate once more before treating the entry as bad.
    if (completeCache(published, namespace, key)) {
      const now = new Date();
      fs.utimesSync(published, now, now);
      return { path: published, reused: true };
    }
    // Invalid entries are never reused. Rename first so a concurrent process
    // observes either the old name or no name, then remove only our exact
    // claimed path and rebuild under the content-addressed key.
    claimAndRemoveManagedPath(published, namespaceRoot, 'invalid-cache');
    if (fs.existsSync(published)) {
      if (completeCache(published, namespace, key)) return { path: published, reused: true };
      throw new Error(`could not atomically invalidate dependency cache: ${published}`);
    }
  }

  const staging = fs.mkdtempSync(path.join(namespaceRoot, '.publish-'));
  fs.chmodSync(staging, 0o700);
  const artifact = path.join(staging, 'artifact');
  fs.mkdirSync(artifact, { mode: 0o700 });
  try {
    builder(artifact);
    fs.writeFileSync(path.join(artifact, CACHE_MARKER), cacheManifestText(artifact, namespace, key), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      // Same-filesystem directory rename is the publication boundary: another
      // invocation sees either no cache or one complete cache, never a partial
      // npm installation.
      fs.renameSync(artifact, published);
      return { path: published, reused: false };
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
          !completeCache(published, namespace, key)) {
        throw error;
      }
      return { path: published, reused: true };
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
  } finally {
    lease.release();
  }
}

function cloneCachedDirectory(source, destination, {
  buildDirectory = BUILD_DIR,
  beforeCopy,
} = {}) {
  const lease = acquireFastCheckLease('cache-clone', { buildDirectory });
  try {
  const copyEnvironment = testProcessEnvironment();
  if (!isRegularDirectory(source)) throw new Error(`dependency cache is not a directory: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`dependency destination already exists: ${destination}`);
  if (beforeCopy !== undefined) {
    if (typeof beforeCopy !== 'function') throw new Error('clone beforeCopy must be a function');
    beforeCopy();
  }

  // Prefer copy-on-write clones where the host supports them. A private copy
  // keeps Vitest/npm cache writes from racing in the immutable shared seed.
  if (process.platform === 'linux' && exists('cp', copyEnvironment)) {
    fs.mkdirSync(destination, { mode: 0o700 });
    const result = run('cp', ['-a', '--reflink=auto', `${source}${path.sep}.`, destination], {
      capture: true,
      allowFailure: true,
      env: copyEnvironment,
    });
    if (result.status === 0) return;
    fs.rmSync(destination, { recursive: true, force: true });
  } else if (process.platform === 'darwin' && exists('cp', copyEnvironment)) {
    fs.mkdirSync(destination, { mode: 0o700 });
    const result = run('cp', ['-cR', `${source}${path.sep}.`, destination], {
      capture: true,
      allowFailure: true,
      env: copyEnvironment,
    });
    if (result.status === 0) return;
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  } finally {
    lease.release();
  }
}

function exactNpmVersion(environment) {
  const result = run('npm', ['--version'], {
    capture: true,
    allowFailure: true,
    env: environment,
  });
  if (result.signal || result.status !== 0) throwLikeChild(result);
  const version = result.stdout.trim();
  if (!version || /\s/u.test(version)) fail(`npm returned an invalid version: ${version || '<empty>'}`);
  return version;
}

function prepareNpmDependencies(project, namespace, npmVersion, environment) {
  const key = dependencyFingerprint(project, { npmVersion });
  let installFailure = null;
  let cache;
  try {
    cache = ensureContentAddressedDirectory(namespace, key, (artifact) => {
      for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
        const source = path.join(project, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(artifact, name));
      }
      const result = timedRun(`${namespace} dependencies`, 'npm', ['ci', '--include=dev'], {
        cwd: artifact,
        env: environment,
        allowFailure: true,
      });
      if (result.signal || result.status !== 0) {
        installFailure = result;
        throw new Error(`${namespace} dependency installation failed`);
      }
      const modules = path.join(artifact, 'node_modules');
      if (!fs.existsSync(modules)) fs.mkdirSync(modules, { mode: 0o700 });
    });
  } catch (error) {
    if (installFailure) throwLikeChild(installFailure);
    throw error;
  }

  if (cache.reused) info(`[cached] ${namespace} dependencies: ${key.slice(0, 12)}.`);
  timedStage(`${namespace} dependency clone`, () => {
    cloneCachedDirectory(path.join(cache.path, 'node_modules'), path.join(project, 'node_modules'));
  });
  return { key, reused: cache.reused };
}

function prepareCenterWorkspace() {
  const workspace = createDisposableWorkspace('center');
  return {
    ...workspace,
    center: path.join(workspace.root, 'center'),
    spotify: path.join(workspace.root, 'center', 'adapters', 'spotify'),
  };
}

function preparePlatformWorkspace() {
  return createDisposableWorkspace('platform');
}

function runCenterCheck() {
  const testEnvironment = testProcessEnvironment(process.env, {
    NEXT_TELEMETRY_DISABLED: '1',
  });
  requiredCommands(['git', 'node', 'npm'], 'Center check', testEnvironment);
  try {
    validateHostToolchains({ includeRust: false, env: testEnvironment });
  } catch (error) {
    fail(error.message);
  }

  const prepared = timedStage('center source snapshot', prepareCenterWorkspace);
  try {
    const environment = isolatedSnapshotGitEnvironment(
      prepared.root,
      testEnvironment,
    );
    const npmEnvironment = normalizedNpmInstallEnvironment(environment);
    const npmVersion = exactNpmVersion(npmEnvironment);
    prepareNpmDependencies(prepared.center, 'center-npm', npmVersion, npmEnvironment);
    prepareNpmDependencies(prepared.spotify, 'spotify-adapter-npm', npmVersion, npmEnvironment);
    timedRun('center typecheck', 'npm', ['run', 'typecheck'], {
      cwd: prepared.center,
      env: npmEnvironment,
    });
    timedRun('center server tests', 'npm', ['test'], {
      cwd: prepared.center,
      env: npmEnvironment,
    });
    timedRun('center UI tests', 'npm', ['run', 'test:ui'], {
      cwd: prepared.center,
      env: npmEnvironment,
    });
    timedRun('Spotify adapter tests', 'npm', ['test'], {
      cwd: prepared.spotify,
      env: npmEnvironment,
    });
  } finally {
    prepared.finish();
  }
  info('[implemented] Center type, server, UI, and Spotify adapter checks passed; release builds remain in ./revival test.');
}

function listedRustTests(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(': test'));
}

function focusedRustTestArguments(filter) {
  return [
    'test', '--workspace', '--locked', filter,
    '--', '--include-ignored',
  ];
}

function runCosmosCheck(filter = null) {
  const environment = cosmosTestEnvironment();
  requiredCommands(['rustc', 'cargo'], 'Cosmos check', environment);
  try {
    validateHostToolchains({ env: environment });
  } catch (error) {
    fail(error.message);
  }
  const cosmos = path.join(ROOT, 'cosmos');
  secureDirectory(BUILD_DIR);
  timedRun('cosmos format', 'cargo', ['fmt', '--all', '--check'], {
    cwd: cosmos,
    env: environment,
  });
  if (filter !== null) {
    info(`[focused] Cosmos test filter: ${filter}`);
    const discovery = timedRun('cosmos test discovery', 'cargo', [
      'test', '--workspace', '--locked', filter, '--', '--list',
    ], { cwd: cosmos, env: environment, capture: true, allowFailure: true });
    if (discovery.signal || discovery.status !== 0) {
      if (discovery.stdout) process.stdout.write(discovery.stdout);
      if (discovery.stderr) process.stderr.write(discovery.stderr);
      throwLikeChild(discovery);
    }
    const matches = listedRustTests(discovery.stdout);
    if (matches.length === 0) fail(`Cosmos test filter matched zero tests: ${filter}`);
    info(`[observed] Cosmos test filter matched ${matches.length} test${matches.length === 1 ? '' : 's'}.`);
    // Discovery includes ignored tests. Explicit filters are requests to run
    // what matched, so include ignored tests instead of reporting a misleading
    // zero-executed success for a release-only test.
    timedRun('cosmos focused tests', 'cargo', focusedRustTestArguments(filter), {
      cwd: cosmos,
      env: environment,
    });
  } else {
    timedRun('cosmos clippy', 'cargo', [
      'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings',
    ], { cwd: cosmos, env: environment });
    timedRun('cosmos tests', 'cargo', [
      'test', '--workspace', '--locked',
    ], { cwd: cosmos, env: environment });
  }
  info(filter === null
    ? '[implemented] focused Cosmos format, lint, and test checks passed.'
    : '[implemented] focused Cosmos format and selected tests passed; run `./revival check cosmos` before release.');
}

function runPlatformCheck() {
  const testEnvironment = testProcessEnvironment();
  requiredCommands(['git', 'node', 'sh'], 'Platform check', testEnvironment);
  try {
    validateHostToolchains({ includeRust: false, env: testEnvironment });
  } catch (error) {
    fail(error.message);
  }
  // Inspect the working tree before Git selects the disposable acceptance
  // snapshot. Ignored AGENTS/CLAUDE files and hidden source directories remain
  // policy inputs even though they are intentionally absent from that snapshot.
  timedRun('platform real-tree source policy', 'sh', [
    path.join(ROOT, 'platform', 'deploy', 'acceptance', 'source-policy.sh'),
  ], { env: testEnvironment });
  const workspace = timedStage('platform source snapshot', preparePlatformWorkspace);
  try {
    const environment = isolatedSnapshotGitEnvironment(
      workspace.root,
      testEnvironment,
    );
    timedRun('platform check process', process.execPath, [
      '-e', "require('./platform/cli/timing').runTimedBoundary(() => require('./platform/cli/gates').policyTests())",
    ], {
      cwd: workspace.root,
      env: environment,
    });
  } finally {
    workspace.finish();
  }
  info('[implemented] focused platform policy and acceptance checks passed.');
}

function changedPolicyScripts(root = ROOT) {
  const acceptance = path.join(root, 'platform', 'deploy', 'acceptance');
  return CHANGED_POLICY_SCRIPTS.map((name) => path.join(acceptance, name));
}

function runChangedSourcePolicies() {
  const environment = testProcessEnvironment();
  requiredCommands(['sh'], 'Changed source policy', environment);
  const [sourcePolicy] = changedPolicyScripts();
  // Inspect the real tree first so even ignored credential/key artifacts are
  // caught. This policy deliberately prunes supported external state and build
  // caches, so ordinary local residue cannot make it fail.
  timedRun(`changed ${path.basename(sourcePolicy)}`, 'sh', [sourcePolicy], { env: environment });

  // Layout checks need the opposite view: tracked plus non-ignored additions,
  // without ignored agent/editor files or generated residue. Use the same
  // disposable snapshot contract as `check platform`, keeping `check changed`
  // cheap while still rejecting a committed/generated or unknown source shape.
  const workspace = timedStage(
    'changed layout snapshot',
    () => createDisposableWorkspace('changed-layout-policy'),
  );
  try {
    const [, layoutPolicy] = changedPolicyScripts(workspace.root);
    timedRun(`changed ${path.basename(layoutPolicy)}`, 'sh', [layoutPolicy], {
      cwd: workspace.root,
      env: isolatedSnapshotGitEnvironment(workspace.root, environment),
    });
  } finally {
    workspace.finish();
  }
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
  if (CENTER_DEVELOPMENT_BOUNDARY.has(normalized)) {
    return orderedChecks('platform', 'center');
  }
  if (normalized === 'rust-toolchain.toml') {
    return orderedChecks('platform', 'cosmos', 'pin');
  }
  if (COSMOS_PLATFORM_BOUNDARY.has(normalized)) {
    return orderedChecks('platform', 'cosmos');
  }
  if (normalized.startsWith('center/')) return orderedChecks('center');
  if (normalized.startsWith('cosmos/')) return orderedChecks('cosmos');
  if (normalized.startsWith('pin/')) return orderedChecks('pin');

  if (normalized.startsWith('contracts/wire/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'contracts/operator-setup.json') return orderedChecks('platform', 'center');
  if (normalized.startsWith('contracts/')) return orderedChecks(...ALL_CHECKS);

  if (normalized === '.github/workflows/release-cli.yml') return orderedChecks('platform');
  if (normalized === '.github/workflows/ci.yml') return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('.github/')) return orderedChecks(...ALL_CHECKS);

  // CLI modules own the shared process, environment, probe, and dispatch
  // boundaries used by every component. Route them through every real
  // consumer; source-text similarity is not evidence that a change is local.
  if (normalized.startsWith('platform/cli/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'platform/compose/development.yaml') {
    return orderedChecks(...ALL_CHECKS);
  }
  if (normalized.startsWith('platform/distribution/') ||
      normalized.startsWith('platform/deploy/acceptance/')) {
    if (normalized.startsWith('platform/deploy/acceptance/pin/')) {
      return orderedChecks('platform', 'pin');
    }
    return orderedChecks('platform');
  }
  if (normalized.startsWith('platform/containers/pin-builder/') ||
      normalized.startsWith('platform/deploy/pin/')) {
    return orderedChecks('platform', 'pin');
  }
  if (normalized.startsWith('platform/deploy/bridge/')) {
    return orderedChecks('platform', 'center', 'pin');
  }
  if (normalized.startsWith('platform/containers/observability/')) {
    return orderedChecks('platform', 'center', 'cosmos');
  }
  if (normalized.startsWith('platform/compose/') ||
      normalized.startsWith('platform/deploy/vps/') ||
      normalized.startsWith('platform/edge/')) {
    return orderedChecks('platform', 'center', 'cosmos');
  }
  if (normalized === 'platform/deploy/release.json' ||
      normalized === 'platform/deploy/release.mjs') {
    return orderedChecks(...ALL_CHECKS);
  }
  if (normalized.startsWith('platform/setup/') || normalized.startsWith('platform/contracts/')) {
    return orderedChecks('platform', 'center');
  }
  if (normalized.startsWith('platform/')) return orderedChecks(...ALL_CHECKS);

  if (normalized === 'revival') return orderedChecks(...ALL_CHECKS);
  if (normalized === '.gitignore') return orderedChecks('platform');
  if (normalized === 'compose.yaml' || normalized === '.env.example') {
    return orderedChecks('platform', 'center', 'cosmos');
  }
  if (normalized === '.dockerignore') return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('docs/') || normalized.endsWith('.md')) return orderedChecks('platform');
  // An unfamiliar root or component can alter packaging or cross-component
  // behavior. Fail closed until its ownership is made explicit here.
  return orderedChecks(...ALL_CHECKS);
}

function changedCheckComponents(files) {
  const selected = new Set();
  for (const file of files) {
    for (const component of checksForPath(file)) selected.add(component);
  }
  return CHECK_ORDER.filter((component) => selected.has(component));
}

function validGitBaseRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') &&
    !ref.includes('\0') && !ref.includes('\n') && !ref.includes('\r');
}

function verifiedRef(ref, { cwd = ROOT, environment } = {}) {
  if (!validGitBaseRef(ref)) throw new Error(`invalid git base ref: ${ref || '<empty>'}`);
  const result = git(
    ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { allowFailure: true, cwd, env: environment },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function defaultBaseCommit({ cwd = ROOT, environment } = {}) {
  // The remote's default branch is authoritative. A feature branch upstream
  // may equal HEAD and would silently hide commits already pushed to it.
  const candidates = ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master'];
  for (const candidate of candidates) {
    const commit = verifiedRef(candidate, { cwd, environment });
    if (commit) return commit;
  }
  return null;
}

function changedPaths(baseRef = null, { cwd = ROOT, environment: suppliedEnvironment } = {}) {
  const environment = suppliedEnvironment ?? testProcessEnvironment();
  if (!exists('git', environment)) throw new Error('Changed check requires git');
  const inside = git(
    ['rev-parse', '--is-inside-work-tree'],
    { allowFailure: true, cwd, env: environment },
  );
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error('check changed requires a Git worktree');
  }

  const requestedBase = baseRef === null
    ? defaultBaseCommit({ cwd, environment })
    : verifiedRef(baseRef, { cwd, environment });
  if (baseRef !== null && requestedBase === null) {
    throw new Error(`git base ref does not resolve to a commit: ${baseRef}`);
  }
  let base = null;
  if (requestedBase !== null) {
    const mergeBase = git(
      ['merge-base', 'HEAD', requestedBase],
      { allowFailure: true, cwd, env: environment },
    );
    if (mergeBase.status === 0 && mergeBase.stdout.trim()) base = mergeBase.stdout.trim();
  }

  const files = new Set();
  const add = (result) => {
    for (const file of nulPaths(result.stdout)) files.add(normalizeChangedPath(file));
  };
  if (base === null) add(git(['ls-files', '-z', '--cached'], { cwd, env: environment }));
  else add(git(
    ['diff', '--no-renames', '--name-only', '-z', `${base}..HEAD`],
    { cwd, env: environment },
  ));
  add(git(['diff', '--no-renames', '--name-only', '-z'], { cwd, env: environment }));
  add(git(
    ['diff', '--no-renames', '--name-only', '-z', '--cached'],
    { cwd, env: environment },
  ));
  add(git(
    ['ls-files', '-z', '--others', '--exclude-standard'],
    { cwd, env: environment },
  ));
  return { base, files: [...files].sort() };
}

function parseChangedArguments(args) {
  if (args.length === 0) return { base: null };
  if (args.length === 2 && args[0] === '--base' && validGitBaseRef(args[1])) return { base: args[1] };
  fail('usage: ./revival check changed [--base REF]', 64);
}

function parseCosmosArguments(args) {
  if (args.length === 0) return { filter: null };
  if (args.length === 1 && args[0].length > 0 && !args[0].startsWith('-')) {
    return { filter: args[0] };
  }
  fail('usage: ./revival check cosmos [TEST_FILTER]', 64);
}

function runSelectedCheck(component) {
  if (component === 'platform') return timedStage('check platform total', runPlatformCheck);
  if (component === 'center') return timedStage('check center total', runCenterCheck);
  if (component === 'cosmos') return timedStage('check cosmos total', () => runCosmosCheck());
  if (component === 'pin') return timedStage('check pin total', pinContributorCheck);
  throw new Error(`unknown check component: ${component}`);
}

function runSelectedComponents(components, runner = runSelectedCheck) {
  if (!Array.isArray(components) || typeof runner !== 'function') {
    throw new Error('selected checks require an array and a runner');
  }
  for (const component of components) runner(component);
}

function checkCommand(args) {
  const [component, ...rest] = args;
  if (component === 'center') {
    if (rest.length !== 0) fail('usage: ./revival check center', 64);
    return timedStage('check center total', runCenterCheck);
  }
  if (component === 'cosmos') {
    const options = parseCosmosArguments(rest);
    return timedStage('check cosmos total', () => runCosmosCheck(options.filter));
  }
  if (component === 'platform') {
    if (rest.length !== 0) fail('usage: ./revival check platform', 64);
    return timedStage('check platform total', runPlatformCheck);
  }
  if (component === 'changed') {
    const options = parseChangedArguments(rest);
    let changeSet;
    try {
      changeSet = changedPaths(options.base);
    } catch (error) {
      fail(error.message, 1);
    }
    // Always scan the complete working source before component selection. A
    // secret-like or forbidden addition under an otherwise ordinary Cosmos,
    // Center, or Pin path must fail cheaply without promoting every source edit
    // to the full platform acceptance suite.
    runChangedSourcePolicies();
    const selected = changedCheckComponents(changeSet.files);
    info(`[observed] changed paths: ${changeSet.files.length}; base: ${changeSet.base || '<entire tracked tree>'}.`);
    if (selected.length === 0) {
      info('[implemented] no changed source paths require checks.');
      return;
    }
    info(`[implemented] selected checks: ${selected.join(', ')}.`);
    runSelectedComponents(selected);
    return;
  }
  fail('usage: ./revival check center | cosmos [TEST_FILTER] | platform | changed [--base REF]', 64);
}

module.exports = {
  CACHE_MARKER,
  CACHE_RETENTION_PER_NAMESPACE,
  FAST_CHECK_LEASE_DIRECTORY,
  STALE_FAST_CHECK_AGE_MS,
  NPM_INSTALL_MODE,
  NPM_INSTALL_POLICY_VERSION,
  assertNoForbiddenRealTreeRoots,
  acquireFastCheckLease,
  changedCheckComponents,
  changedPolicyScripts,
  changedPaths,
  checkCommand,
  checksForPath,
  cloneCachedDirectory,
  completeCache,
  createDisposableWorkspace,
  defaultBaseCommit,
  dependencyFingerprint,
  exactNpmVersion,
  ensureContentAddressedDirectory,
  focusedRustTestArguments,
  isolatedSnapshotGitEnvironment,
  listedRustTests,
  normalizedNpmInstallEnvironment,
  parseChangedArguments,
  parseCosmosArguments,
  prepareCenterWorkspace,
  prepareNpmDependencies,
  preparePlatformWorkspace,
  pruneFastCheckState,
  runCenterCheck,
  runChangedSourcePolicies,
  runCosmosCheck,
  runPlatformCheck,
  runSelectedComponents,
  snapshotRepository,
  validGitBaseRef,
};
