'use strict';

const path = require('node:path');

const {
  BUILD_DIR,
  fail,
  info,
} = require('./context');
const {
  assertPinAmd64ConsumerHost,
  pinLaneSessionArguments,
  executePinLaneSession,
} = require('./gates');
const {
  changedPaths: authoritativeChangedPaths,
  validGitBaseRef,
} = require('./checks');
const { TimedSubprocessFailure } = require('./timing');

const DEBUG_ROLES = Object.freeze(['installer', 'bootstrap', 'hook', 'server', 'hook-injector']);
const ROLE_SET = new Set(DEBUG_ROLES);

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
  // Contracts are consumed by the Hook and Server graphs. Everything else —
  // including Gradle settings, toolchains, shared injector code, and unknown
  // paths — deliberately fails closed to the full five-role compile.
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

/** Parse only argv grammar. Git discovery is an operational step, not usage. */
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

// Retained as a pure convenience for callers/tests that already supply a fake
// path resolver. The actual command keeps syntax and operational resolution in
// separate error-code boundaries below.
function parseDebugBuildArgs(args, pathResolver = changedPaths) {
  return resolveDebugBuildSelection(parseDebugBuildSyntax(args), pathResolver);
}

function debugDirectories() {
  const state = path.join(BUILD_DIR, 'pin-debug-builder-state');
  const cache = path.join(BUILD_DIR, 'pin-builder-cache-data');
  return Object.freeze({
    lane: 'debug',
    state,
    cache,
    artifacts: path.join(state, 'artifacts', 'device-debug'),
  });
}

/** Prove every potential debug write root is external before creating any one. */
function validateDebugBuildRoots() {
  // Compatibility-only topology projection. The command never authorizes or
  // writes these strings; the continuous Python session owns that boundary.
  return debugDirectories();
}

function debugBuildInvocations(roles) {
  const selection = Object.freeze({ roles: Object.freeze([...roles]) });
  return Object.freeze({
    lane: 'debug',
    selection,
    brokerArguments: pinLaneSessionArguments('debug', selection),
  });
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
    const preflight = dependencies.preflight ?? assertPinAmd64ConsumerHost;
    // Refuse ARM/emulated/macOS before Git discovery or any external-root
    // preparation. `--changed` must be just as write-free as an explicit role
    // selection until the native compiler contract has been proved.
    preflight(Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }));
    const selection = parsed.changed
      ? Object.freeze({ changed: true, base: parsed.base })
      : Object.freeze({
          roles: Object.freeze(DEBUG_ROLES.filter((role) => parsed.requested.includes(role))),
        });
    (dependencies.sessionRunner ?? executePinLaneSession)(
      'debug',
      selection,
      dependencies,
    );
    const selectedLabel = parsed.changed
      ? `changed paths${parsed.base ? ` from ${parsed.base}` : ''}`
      : selection.roles.join(', ');
    info(`[implemented] credential-free Pin debug checks and APK graphs: ${selectedLabel}`);
    info(`[implemented] non-installable debug artifacts: ${debugDirectories().artifacts}`);
    info('[unknown] this lane does not sign, publish a release, install, connect to a device, or prove physical-device behavior.');
  } catch (error) {
    if (error instanceof TimedSubprocessFailure) throw error;
    fail(error.message, 1);
  }
}

module.exports = {
  DEBUG_ROLES,
  rolesForChangedPath,
  selectChangedRoles,
  changedPaths,
  parseDebugBuildSyntax,
  resolveDebugBuildSelection,
  parseDebugBuildArgs,
  debugDirectories,
  validateDebugBuildRoots,
  debugBuildInvocations,
  pinDebugBuild,
};
