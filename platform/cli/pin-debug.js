'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BUILD_DIR,
  ROOT,
  fail,
  info,
  testProcessEnvironment,
} = require('./context');
const {
  changedPaths: authoritativeChangedPaths,
  validGitBaseRef,
} = require('./checks');
const { TimedSubprocessFailure, timedRun } = require('./timing');

const DEBUG_ROLES = Object.freeze(['installer', 'bootstrap', 'hook', 'server', 'hook-injector']);
const ROLE_SET = new Set(DEBUG_ROLES);
const BUILDER_IMAGE = 'ai-pin-revival/pin-builder:dev';
const BUILDER_INPUTS = Object.freeze([
  'platform/containers/pin-builder/Dockerfile',
  'platform/containers/pin-builder/entrypoint.sh',
]);

function rolesForChangedPath(input) {
  const value = input.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!value || value.startsWith('/') || value.split('/').includes('..')) return DEBUG_ROLES;
  const exact = [
    ['pin/injector/installer/', ['installer']],
    ['pin/injector/exploit/', ['bootstrap']],
    ['pin/hook/payload/', ['hook']],
    ['pin/runtime/', ['server']],
    ['pin/hook/loader/', ['hook-injector']],
  ];
  for (const [prefix, roles] of exact) {
    if (value.startsWith(prefix)) return roles;
  }
  if (value.startsWith('pin/contracts/')) return ['hook', 'server'];
  return DEBUG_ROLES;
}

function selectChangedRoles(paths) {
  const selected = new Set();
  for (const changedPath of paths) {
    for (const role of rolesForChangedPath(changedPath)) selected.add(role);
  }
  return DEBUG_ROLES.filter((role) => selected.has(role));
}

function changedPaths(base, options) {
  return authoritativeChangedPaths(base ?? null, options).files;
}

function parseDebugBuildSyntax(args) {
  const requested = [];
  let changed = false;
  let base;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--role') {
      const role = args[index += 1];
      if (!ROLE_SET.has(role)) throw new Error('--role must be installer, bootstrap, hook, server, or hook-injector');
      requested.push(role);
    } else if (value === '--changed') {
      changed = true;
    } else if (value === '--base') {
      base = args[index += 1];
      if (!validGitBaseRef(base)) throw new Error('--base requires a safe Git revision');
    } else {
      throw new Error(`unknown pin build-debug option: ${value}`);
    }
  }
  if (base && !changed) throw new Error('--base requires --changed');
  if (changed && requested.length > 0) throw new Error('--changed cannot be combined with --role');
  if (!changed && requested.length === 0) throw new Error('at least one --role is required');
  return Object.freeze({ requested: Object.freeze([...requested]), changed, base });
}

function resolveDebugBuildSelection(parsed, pathResolver = changedPaths, resolverOptions) {
  const roles = parsed.changed
    ? selectChangedRoles(pathResolver(parsed.base, resolverOptions))
    : DEBUG_ROLES.filter((role) => parsed.requested.includes(role));
  if (roles.length === 0) throw new Error('no changed paths selected a Pin debug role');
  return Object.freeze({ roles: Object.freeze(roles), changed: parsed.changed, base: parsed.base });
}

function parseDebugBuildArgs(args, pathResolver = changedPaths) {
  return resolveDebugBuildSelection(parseDebugBuildSyntax(args), pathResolver);
}

function debugDirectories() {
  const state = path.join(BUILD_DIR, 'pin-debug-builder-state');
  const cache = path.join(BUILD_DIR, 'pin-builder-cache');
  return Object.freeze({
    state,
    cache,
    artifacts: path.join(state, 'artifacts', 'device-debug'),
    imageStamp: path.join(cache, 'image.sha256'),
  });
}

function prepareDebugDirectories(directories = debugDirectories()) {
  for (const directory of [directories.state, directories.cache]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return directories;
}

function builderFingerprint() {
  const digest = crypto.createHash('sha256');
  for (const relative of BUILDER_INPUTS) {
    digest.update(relative);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(ROOT, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function mount(source, target, readOnly = false) {
  return `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`;
}

function nativeDockerPlatform(architecture = process.arch) {
  if (architecture === 'x64') return 'linux/amd64';
  if (architecture === 'arm64') return 'linux/arm64';
  throw new Error(`Pin debug builds do not support host architecture ${architecture}`);
}

function pinBuilderBuildInvocation(image = BUILDER_IMAGE, architecture = process.arch) {
  return Object.freeze({
    command: 'docker',
    args: Object.freeze([
      'build',
      '--platform', nativeDockerPlatform(architecture),
      '--file', path.join(ROOT, 'platform/containers/pin-builder/Dockerfile'),
      '--tag', image,
      ROOT,
    ]),
  });
}

function pinBuilderRunInvocation(
  roles,
  directories = debugDirectories(),
  image = BUILDER_IMAGE,
  architecture = process.arch,
) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const gid = typeof process.getgid === 'function' ? process.getgid() : os.userInfo().gid;
  return Object.freeze({
    command: 'docker',
    args: Object.freeze([
      'run', '--rm', '--init',
      '--platform', nativeDockerPlatform(architecture),
      '--user', `${uid}:${gid}`,
      '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=2g',
      '--mount', mount(ROOT, '/workspace', true),
      '--mount', mount(directories.state, '/state'),
      '--mount', mount(directories.cache, '/cache'),
      image,
      'build-debug-role',
      ...roles.flatMap((role) => ['--role', role]),
    ]),
  });
}

function debugBuildInvocations(roles, directories = debugDirectories(), image = BUILDER_IMAGE) {
  return Object.freeze({
    build: pinBuilderBuildInvocation(image),
    run: pinBuilderRunInvocation(roles, directories, image),
  });
}

function ensurePinBuilderImage({
  directories = debugDirectories(),
  environment = testProcessEnvironment(),
  runner = timedRun,
  image = BUILDER_IMAGE,
} = {}) {
  prepareDebugDirectories(directories);
  const fingerprint = builderFingerprint();
  const current = fs.existsSync(directories.imageStamp)
    ? fs.readFileSync(directories.imageStamp, 'utf8').trim()
    : '';
  if (current === fingerprint) {
    const inspected = runner('Pin builder image cache', 'docker', ['image', 'inspect', image], {
      cwd: ROOT,
      env: environment,
      allowFailure: true,
      stdio: 'ignore',
    });
    if (!inspected.signal && inspected.status === 0) return false;
  }
  const invocation = pinBuilderBuildInvocation(image);
  runner('Build Pin builder image', invocation.command, invocation.args, {
    cwd: ROOT,
    env: environment,
  });
  fs.writeFileSync(directories.imageStamp, `${fingerprint}\n`, { mode: 0o600 });
  return true;
}

function validateDebugBuildRoots() {
  return debugDirectories();
}

function pinDebugBuild(args, dependencies = {}) {
  let parsed;
  try {
    parsed = parseDebugBuildSyntax(args);
  } catch (error) {
    fail(error.message, 64);
    return;
  }

  try {
    const selection = resolveDebugBuildSelection(
      parsed,
      dependencies.pathResolver ?? changedPaths,
      dependencies.resolverOptions,
    );
    const directories = dependencies.directories ?? debugDirectories();
    const environment = dependencies.environment ?? testProcessEnvironment();
    const runner = dependencies.runner ?? timedRun;
    const image = dependencies.image ?? BUILDER_IMAGE;
    (dependencies.ensureImage ?? ensurePinBuilderImage)({
      directories, environment, runner, image,
    });
    const invocation = pinBuilderRunInvocation(selection.roles, directories, image);
    runner('Build Pin debug APKs', invocation.command, invocation.args, {
      cwd: ROOT,
      env: environment,
    });
    info(`[implemented] compile-only Pin debug APKs: ${selection.roles.join(', ')}`);
    info(`[implemented] debug artifacts: ${directories.artifacts}`);
  } catch (error) {
    if (error instanceof TimedSubprocessFailure) throw error;
    fail(error.message, 1);
  }
}

module.exports = {
  DEBUG_ROLES,
  BUILDER_IMAGE,
  rolesForChangedPath,
  selectChangedRoles,
  changedPaths,
  parseDebugBuildSyntax,
  resolveDebugBuildSelection,
  parseDebugBuildArgs,
  debugDirectories,
  prepareDebugDirectories,
  builderFingerprint,
  nativeDockerPlatform,
  pinBuilderBuildInvocation,
  pinBuilderRunInvocation,
  debugBuildInvocations,
  ensurePinBuilderImage,
  validateDebugBuildRoots,
  pinDebugBuild,
};
