'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT, BUILD_DIR, exists, fail, info, secureDirectory,
  testProcessEnvironment, cosmosTestEnvironment, run,
} = require('./context');
const { pinContributorCheck, policyTests } = require('./gates');
const { throwLikeChild, timedRun, timedStage } = require('./timing');
const { validateHostToolchains } = require('./toolchain');

const CHECK_ORDER = Object.freeze(['platform', 'center', 'cosmos', 'pin']);
const ALL_CHECKS = Object.freeze([...CHECK_ORDER]);
const CENTER_DEVELOPMENT_BOUNDARY = new Set([
  'center/.dockerignore', 'center/Dockerfile', 'center/next.config.mjs',
  'center/package-lock.json', 'center/package.json',
]);
const COSMOS_PLATFORM_BOUNDARY = new Set([
  'cosmos/Cargo.lock', 'cosmos/Cargo.toml', 'cosmos/Dockerfile',
]);
const FULL_PLATFORM_ROOT_PATHS = new Set([
  '.dockerignore', '.env.example', '.gitignore', 'compose.yaml', 'revival', 'rust-toolchain.toml',
]);
const CENTER_RELEASE_SOURCE_PATHS = Object.freeze([
  'center', 'contracts', 'platform', 'pin', 'compose.yaml',
]);

function requiredCommands(commands, label, environment = testProcessEnvironment()) {
  for (const command of commands) if (!exists(command, environment)) fail(`${label} requires ${command}`);
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

function exactNpmVersion(environment) {
  const result = run('npm', ['--version'], { capture: true, allowFailure: true, env: environment });
  if (result.signal || result.status !== 0) throwLikeChild(result);
  const version = result.stdout.trim();
  if (!version || /\s/u.test(version)) fail(`npm returned an invalid version: ${version || '<empty>'}`);
  return version;
}

function normalizedNpmInstallEnvironment(environment, {
  cacheDirectory = path.join(BUILD_DIR, 'npm-cache'),
} = {}) {
  const userConfig = environment.NPM_CONFIG_USERCONFIG;
  const globalConfig = environment.NPM_CONFIG_GLOBALCONFIG;
  const normalized = {};
  for (const [name, value] of Object.entries(environment)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('npm_config_') || lower.startsWith('npm_package_') ||
        lower.startsWith('npm_lifecycle_') || ['node_env', 'node_options', 'init_cwd'].includes(lower)) continue;
    normalized[name] = value;
  }
  return {
    ...normalized,
    NODE_ENV: 'development',
    NPM_CONFIG_CACHE: cacheDirectory,
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
  npmVersion,
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (typeof npmVersion !== 'string' || npmVersion.length === 0) {
    throw new Error('dependency fingerprint requires the exact npm version');
  }
  const hash = crypto.createHash('sha256');
  hash.update(`node=${nodeVersion}\0npm=${npmVersion}\0platform=${platform}\0arch=${arch}\0`);
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(project, name);
    if (!fs.existsSync(file)) throw new Error(`npm dependency input is missing: ${file}`);
    hash.update(`${name}\0`);
    hash.update(fs.readFileSync(file));
    hash.update('\0');
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
  return current === key && fs.existsSync(modules) && fs.lstatSync(modules).isDirectory();
}

function withAtomicLock(file, contentionMessage, action) {
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`${contentionMessage}; if no matching check is running, remove stale lock ${file}`);
    }
    throw error;
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
    if (current === token) fs.unlinkSync(file);
  }
}

function prepareNpmDependencies(project, namespace, npmVersion, environment, runner = timedRun) {
  if (!safeNamespace(namespace)) throw new Error(`invalid npm dependency namespace: ${namespace}`);
  if (!projectHasDependencies(project)) return { key: null, reused: true };
  const key = dependencyFingerprint(project, { npmVersion });
  secureDirectory(BUILD_DIR);
  const state = path.join(BUILD_DIR, 'check-state');
  secureDirectory(state);
  const stamp = path.join(state, `${namespace}.dependencies`);
  const lock = path.join(state, `${namespace}.install.lock`);
  const modules = path.join(project, 'node_modules');
  if (reusableDependencies(stamp, key, modules)) {
    info(`[cached] ${namespace} dependencies.`);
    return { key, reused: true };
  }
  return withAtomicLock(lock, `npm dependency install is already running for ${namespace}`, () => {
    if (reusableDependencies(stamp, key, modules)) {
      info(`[cached] ${namespace} dependencies.`);
      return { key, reused: true };
    }
    try {
      fs.unlinkSync(stamp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = runner(`${namespace} dependencies`, 'npm', ['ci', '--include=dev'], {
      cwd: project, env: environment, allowFailure: true,
    });
    if (result.signal || result.status !== 0) throwLikeChild(result);
    writeDependencyStamp(stamp, key);
    return { key, reused: false };
  });
}

// The full release gate still needs a disposable location for `next build`.
// Contributor checks never call this helper and execute against ROOT directly.
function createCenterBuildWorkspace() {
  secureDirectory(BUILD_DIR);
  const parent = path.join(BUILD_DIR, 'release-center-workspaces');
  secureDirectory(parent);
  const container = fs.mkdtempSync(path.join(parent, 'run-'));
  fs.chmodSync(container, 0o700);
  const root = path.join(container, 'source');
  const center = path.join(root, 'center');
  fs.mkdirSync(root, { mode: 0o700 });
  const filter = (source) => !path.relative(ROOT, source).replaceAll('\\', '/').split('/')
    .some((entry) => [
      '.git', '.gradle', '.kotlin', '.next', '__pycache__',
      'build', 'coverage', 'node_modules', 'target',
    ].includes(entry));
  for (const relative of CENTER_RELEASE_SOURCE_PATHS) {
    fs.cpSync(path.join(ROOT, relative), path.join(root, relative), { recursive: true, filter });
  }
  return {
    root,
    center,
    spotify: path.join(center, 'adapters', 'spotify'),
    finish() { fs.rmSync(container, { recursive: true, force: true, maxRetries: 3 }); },
  };
}

function runCenterCheck(dependencies = {}) {
  const environment = dependencies.environment ?? testProcessEnvironment(process.env, {
    NEXT_TELEMETRY_DISABLED: '1',
  });
  const runner = dependencies.runner ?? timedRun;
  const prepare = dependencies.prepareDependencies ?? prepareNpmDependencies;
  requiredCommands(['node', 'npm'], 'Center check', environment);
  try { validateHostToolchains({ includeRust: false, env: environment }); } catch (error) { fail(error.message); }
  const npmEnvironment = normalizedNpmInstallEnvironment(environment);
  const npmVersion = dependencies.npmVersion ?? exactNpmVersion(npmEnvironment);
  const center = path.join(ROOT, 'center');
  const spotify = path.join(center, 'adapters', 'spotify');
  prepare(center, 'center-npm', npmVersion, npmEnvironment, runner);
  prepare(spotify, 'spotify-adapter-npm', npmVersion, npmEnvironment, runner);
  secureDirectory(BUILD_DIR);
  const centerBuild = path.join(BUILD_DIR, 'center');
  secureDirectory(centerBuild);
  withAtomicLock(
    path.join(centerBuild, 'typecheck.lock'),
    'Center typecheck is already running',
    () => runner('center typecheck', 'npm', [
      'run', 'typecheck', '--', '--tsBuildInfoFile', path.join(centerBuild, 'tsconfig.tsbuildinfo'),
    ], { cwd: center, env: npmEnvironment }),
  );
  runner('center server tests', 'npm', ['test'], { cwd: center, env: npmEnvironment });
  runner('center UI tests', 'npm', ['run', 'test:ui'], { cwd: center, env: npmEnvironment });
  runner('Spotify adapter tests', 'npm', ['test'], { cwd: spotify, env: npmEnvironment });
  info('[implemented] Center checks passed from the working tree.');
}

function listedRustTests(output) {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.endsWith(': test'));
}

function focusedRustTestArguments(filter) {
  return ['test', '--workspace', '--locked', filter, '--', '--include-ignored'];
}

function runCosmosCheck(filter = null, dependencies = {}) {
  const environment = dependencies.environment ?? cosmosTestEnvironment();
  const runner = dependencies.runner ?? timedRun;
  requiredCommands(['rustc', 'cargo'], 'Cosmos check', environment);
  try { validateHostToolchains({ env: environment }); } catch (error) { fail(error.message); }
  const cosmos = path.join(ROOT, 'cosmos');
  runner('cosmos format', 'cargo', ['fmt', '--all', '--check'], { cwd: cosmos, env: environment });
  if (filter !== null) {
    info(`[focused] Cosmos test filter: ${filter}`);
    const discovery = runner('cosmos test discovery', 'cargo', [
      'test', '--workspace', '--locked', filter, '--', '--list',
    ], { cwd: cosmos, env: environment, capture: true, allowFailure: true });
    if (discovery.signal || discovery.status !== 0) throwLikeChild(discovery);
    const matches = listedRustTests(discovery.stdout);
    if (matches.length === 0) fail(`Cosmos test filter matched zero tests: ${filter}`);
    info(`[observed] Cosmos test filter matched ${matches.length} test${matches.length === 1 ? '' : 's'}.`);
    runner('cosmos focused tests', 'cargo', focusedRustTestArguments(filter), { cwd: cosmos, env: environment });
  } else {
    runner('cosmos clippy', 'cargo', [
      'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings',
    ], { cwd: cosmos, env: environment });
    runner('cosmos tests', 'cargo', ['test', '--workspace', '--locked'], { cwd: cosmos, env: environment });
  }
  info(filter === null
    ? '[implemented] Cosmos format, lint, and tests passed from the working tree.'
    : '[implemented] Cosmos format and selected tests passed from the working tree.');
}

function runPlatformCheck(dependencies = {}) {
  const environment = dependencies.environment ?? testProcessEnvironment();
  const full = dependencies.full === true;
  requiredCommands(['node'], 'Platform check', environment);
  try { validateHostToolchains({ includeRust: false, env: environment }); } catch (error) { fail(error.message); }
  (dependencies.policyRunner ?? policyTests)(environment, {
    contributor: !full,
    shellPolicies: false,
  });
  info(full
    ? '[implemented] full platform Node acceptance inventory passed from the working tree.'
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
  if (normalized === '.github/workflows/release-cli.yml') return orderedChecks('platform');
  if (normalized.startsWith('.github/')) return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('platform/cli/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'platform/compose/development.yaml') return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('platform/distribution/') || normalized.startsWith('platform/deploy/acceptance/')) {
    return normalized.startsWith('platform/deploy/acceptance/pin/')
      ? orderedChecks('platform', 'pin') : orderedChecks('platform');
  }
  if (normalized.startsWith('platform/containers/pin-builder/') ||
      normalized.startsWith('platform/deploy/pin/')) return orderedChecks('platform', 'pin');
  if (normalized.startsWith('platform/deploy/bridge/')) return orderedChecks('platform', 'center', 'pin');
  if (normalized.startsWith('platform/containers/observability/')) return orderedChecks('platform', 'center', 'cosmos');
  if (normalized.startsWith('platform/compose/') || normalized.startsWith('platform/deploy/vps/') ||
      normalized.startsWith('platform/edge/')) return orderedChecks('platform', 'center', 'cosmos');
  if (normalized === 'platform/deploy/release.json' || normalized === 'platform/deploy/release.mjs') {
    return orderedChecks(...ALL_CHECKS);
  }
  if (normalized.startsWith('platform/setup/') || normalized.startsWith('platform/contracts/')) {
    return orderedChecks('platform', 'center');
  }
  if (normalized.startsWith('platform/')) return orderedChecks(...ALL_CHECKS);
  if (normalized === 'revival') return orderedChecks(...ALL_CHECKS);
  if (normalized === '.gitignore') return orderedChecks('platform');
  if (normalized === 'compose.yaml' || normalized === '.env.example') return orderedChecks('platform', 'center', 'cosmos');
  if (normalized === '.dockerignore') return orderedChecks(...ALL_CHECKS);
  if (normalized.startsWith('docs/') || normalized.endsWith('.md')) return orderedChecks('platform');
  return orderedChecks(...ALL_CHECKS);
}

function requiresFullPlatformCheck(file) {
  const normalized = normalizeChangedPath(file);
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
  if (!exists('git', environment)) throw new Error('Changed check requires git');
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
  fail('usage: ./revival check changed [--base REF]', 64);
}

function parseCosmosArguments(args) {
  if (args.length === 0) return { filter: null };
  if (args.length === 1 && args[0].length > 0 && !args[0].startsWith('-')) return { filter: args[0] };
  fail('usage: ./revival check cosmos [TEST_FILTER]', 64);
}

function parsePlatformArguments(args) {
  if (args.length === 0) return { full: false };
  if (args.length === 1 && args[0] === '--full') return { full: true };
  fail('usage: ./revival check platform [--full]', 64);
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
    if (rest.length !== 0) fail('usage: ./revival check center', 64);
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
  fail('usage: ./revival check center | cosmos [TEST_FILTER] | platform [--full] | changed [--base REF]', 64);
}

module.exports = {
  changedCheckComponents, changedPaths, checkCommand, checksForPath,
  createCenterBuildWorkspace, defaultBaseCommit, dependencyFingerprint,
  exactNpmVersion, focusedRustTestArguments, listedRustTests,
  normalizedNpmInstallEnvironment, parseChangedArguments, parseCosmosArguments, parsePlatformArguments,
  prepareNpmDependencies, runCenterCheck, runCosmosCheck, runPlatformCheck,
  requiresFullPlatformCheck, runSelectedComponents, validGitBaseRef,
};
