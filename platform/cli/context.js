'use strict';
// Shared CLI paths, process helpers, runtime configuration, and initialization.

const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HOME: LOGIN_HOME,
  resolveTool,
  trustedPath,
} = require('./authority');

// This module lives at platform/cli/; the workspace root is two levels up.
const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT = 'ai-pin-revival';
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const COMPOSE_BASE = path.join(ROOT, 'compose.yaml');
const COMPOSE_DEVELOPMENT = path.join(ROOT, 'platform', 'compose', 'development.yaml');
const PIN_RELEASE_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'release.mjs');
const PIN_RELEASE_BUILD_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'build.mjs');
const PIN_RELEASE_SHIP_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'ship.mjs');
const PIN_INSTALL_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'install.mjs');
const PIN_DOCTOR_TOOL = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'doctor.mjs');
const PKI_TOOL = path.join(ROOT, 'platform', 'deploy', 'pki.mjs');
const PIN_ACTIVATION_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'activate.mjs');
const PIN_NETWORK_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'network.mjs');
const DEPLOY_DIR = path.join(ROOT, 'platform', 'deploy', 'vps');
const TOOLCHAIN_CONFIG = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'toolchain.json');
const MINIMUM_COMPOSE_VERSION = Object.freeze([2, 33, 1]);
const MANAGED_DIRECTORY_MARKER = '.ai-pin-revival-managed';

const DEFAULT_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(LOGIN_HOME, '.config'),
  PROJECT
);
const DEFAULT_SECRETS_DIR = path.join(DEFAULT_CONFIG_DIR, 'secrets');
const DEFAULT_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(LOGIN_HOME, '.local', 'share'),
  PROJECT
);
function externalPath(variable, fallback) {
  return path.resolve(process.env[variable] || fallback);
}

function canonicalCandidate(candidate) {
  let existing = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalParent = fs.realpathSync(existing);
  return path.join(canonicalParent, ...suffix);
}

function isInsideDirectory(candidate, directory) {
  const resolved = canonicalCandidate(candidate);
  const parent = canonicalCandidate(directory);
  return resolved === parent || resolved.startsWith(`${parent}${path.sep}`);
}

function isInsideSource(candidate) {
  const resolved = canonicalCandidate(candidate);
  const source = fs.realpathSync(ROOT);
  return resolved === source || resolved.startsWith(`${source}${path.sep}`);
}

function requireExternalDirectory(candidate, label) {
  if (isInsideSource(candidate)) {
    throw new Error(`${label} must be outside the source tree: ${candidate}`);
  }
}

const CONFIG_DIR = externalPath(
  'REVIVAL_CONFIG_DIR',
  DEFAULT_CONFIG_DIR
);
const SECRETS_DIR = externalPath('REVIVAL_SECRETS_DIR', process.env.REVIVAL_CONFIG_DIR
  ? path.join(CONFIG_DIR, 'secrets')
  : DEFAULT_SECRETS_DIR);
const DATA_DIR = externalPath(
  'REVIVAL_DATA_DIR',
  DEFAULT_DATA_DIR
);
const ENV_FILE = process.env.REVIVAL_ENV_FILE
  ? path.resolve(process.env.REVIVAL_ENV_FILE)
  : path.join(SECRETS_DIR, 'runtime.env');
const BUILD_DIR = externalPath('REVIVAL_BUILD_DIR', path.join(DATA_DIR, 'build'));
const PIN_SECRET_DIR = path.join(SECRETS_DIR, 'pin');
const PIN_PRIVATE_ASSETS_DIR = path.join(CONFIG_DIR, 'pin-assets');

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function exists(command) {
  return resolveTool(command, { required: false }) !== null;
}

function run(command, args, options = {}) {
  let executable;
  try {
    executable = resolveTool(command);
  } catch (error) {
    fail(error.message);
  }
  const result = child.spawnSync(executable, args, {
    cwd: options.cwd || ROOT,
    env: options.env || operatorEnvironment(),
    input: options.input,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined
  });
  if (result.error) fail(`${path.basename(executable)} could not run: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status || 1);
  return result;
}

function hasManagedMarker(directory) {
  const marker = path.join(directory, MANAGED_DIRECTORY_MARKER);
  if (!fs.existsSync(marker)) return false;
  const stat = fs.lstatSync(marker);
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600;
}

function isDefaultOperatorDirectory(directory) {
  const candidate = canonicalCandidate(directory);
  return [DEFAULT_CONFIG_DIR, DEFAULT_SECRETS_DIR, DEFAULT_DATA_DIR]
    .map((entry) => canonicalCandidate(entry))
    .includes(candidate);
}

function ensureManagedRoot(directory, label) {
  requireExternalDirectory(directory, label);
  const existed = fs.existsSync(directory);
  if (existed) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing non-directory or linked ${label}: ${directory}`);
    }
    if (!isDefaultOperatorDirectory(directory) && !hasManagedMarker(directory)) {
      throw new Error(`${label} already exists but is not marked for Ai Pin Revival: ${directory}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`${label} must already have mode 0700; refusing to chmod an existing directory: ${directory}`);
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const marker = path.join(directory, MANAGED_DIRECTORY_MARKER);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'schema=1\nproduct=ai-pin-revival\n', { mode: 0o600, flag: 'wx' });
  }
}

function secureDirectory(directory) {
  const managedParent = [SECRETS_DIR, DATA_DIR, CONFIG_DIR]
    .find((candidate) => isInsideDirectory(directory, candidate));
  if (!managedParent) {
    throw new Error(`refusing to create or modify an unmanaged directory: ${directory}`);
  }
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing non-directory or linked operator path: ${directory}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`operator directory must already have mode 0700: ${directory}`);
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicWrite(file, contents, mode = 0o600) {
  secureDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function fillBlankGeneratedSecrets(contents) {
  let updated = contents;
  let count = 0;
  const generated = [
    ['AUTH_SESSION_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_SHARE_TOKEN_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_CENTER_PROJECTION_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_EDGE_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_ADMIN_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_OPAQUE_SEED', () => crypto.randomBytes(32).toString('base64')],
    ['KEYCLOAK_CLIENT_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['KEYCLOAK_ADMIN', () => `revival-admin-${crypto.randomBytes(4).toString('hex')}`],
    ['KEYCLOAK_ADMIN_PASSWORD', () => crypto.randomBytes(32).toString('base64url')]
  ];
  for (const [key, generate] of generated) {
    const pattern = new RegExp(`^${key}=(.*)$`, 'm');
    const match = pattern.exec(updated);
    if (match && match[1].trim().length > 0) continue;
    const replacement = `${key}=${generate()}`;
    if (match) updated = updated.replace(pattern, replacement);
    else updated = `${updated.replace(/\s*$/, '')}\n${replacement}\n`;
    count += 1;
  }
  return { contents: updated, count };
}

function fillBlankInitializerDefaults(contents) {
  const generated = fillBlankGeneratedSecrets(contents);
  const releasePattern = /^REVIVAL_RELEASE_ID=(.*)$/m;
  const releaseMatch = releasePattern.exec(generated.contents);
  if (releaseMatch && releaseMatch[1].trim().length > 0) return generated;

  const replacement = 'REVIVAL_RELEASE_ID=local';
  const updated = releaseMatch
    ? generated.contents.replace(releasePattern, replacement)
    : `${generated.contents.replace(/\s*$/, '')}\n${replacement}\n`;
  return { contents: updated, count: generated.count + 1 };
}

function localIdentityRealm(values) {
  const realm = values.KEYCLOAK_REALM || 'humane';
  const clientId = values.KEYCLOAK_CLIENT_ID || 'center';
  const centerPort = values.REVIVAL_CENTER_PORT || '4000';
  const origins = [
    `http://localhost:${centerPort}`,
    `http://127.0.0.1:${centerPort}`
  ];
  const redirectUris = origins.map((origin) => `${origin}/api/auth/callback/humane`);
  return {
    realm,
    displayName: 'Ai Pin Revival',
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    accessTokenLifespan: 900,
    attributes: { aiPinRevivalManaged: 'true' },
    roles: {
      realm: [{ name: 'cosmos-operator', description: 'Ai Pin Revival operator access' }]
    },
    clients: [{
      clientId,
      name: 'Ai Pin Revival Center',
      description: 'The wearer-facing Center dashboard.',
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      secret: values.KEYCLOAK_CLIENT_SECRET,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      implicitFlowEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: true,
      redirectUris,
      webOrigins: origins,
      defaultClientScopes: ['web-origins', 'acr', 'roles', 'profile', 'email'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': origins.map((origin) => `${origin}/login`).join('##')
      }
    }],
    users: []
  };
}

function ensureLocalIdentityRealm(values) {
  const realmFile = path.join(SECRETS_DIR, 'identity', 'realm.json');
  if (fs.existsSync(realmFile)) {
    const stat = fs.lstatSync(realmFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`refusing non-regular identity realm: ${realmFile}`);
    }
    if (stat.size > 0) {
      let current;
      try {
        current = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
      } catch {
        current = null;
      }
      const managed = current?.attributes?.aiPinRevivalManaged === 'true';
      const empty = Array.isArray(current?.users) && current.users.length === 0;
      if (!managed || !empty) {
        if ((stat.mode & 0o777) !== 0o600) {
          throw new Error(`operator-managed identity realm must already have mode 0600: ${realmFile}`);
        }
        return false;
      }
      atomicWrite(realmFile, `${JSON.stringify(localIdentityRealm(values), null, 2)}\n`);
      return true;
    }
    fs.unlinkSync(realmFile);
  }
  atomicWrite(realmFile, `${JSON.stringify(localIdentityRealm(values), null, 2)}\n`);
  return true;
}

function initialize() {
  let createdRuntime = false;
  for (const [directory, label] of [
    [CONFIG_DIR, 'REVIVAL_CONFIG_DIR'],
    [SECRETS_DIR, 'REVIVAL_SECRETS_DIR'],
    [DATA_DIR, 'REVIVAL_DATA_DIR']
  ]) {
    requireExternalDirectory(directory, label);
  }
  requireExternalDirectory(BUILD_DIR, 'REVIVAL_BUILD_DIR');
  if (!isInsideDirectory(BUILD_DIR, DATA_DIR)) {
    throw new Error(`REVIVAL_BUILD_DIR must be inside REVIVAL_DATA_DIR: ${BUILD_DIR}`);
  }
  requireExternalDirectory(ENV_FILE, 'REVIVAL_ENV_FILE');
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR: ${ENV_FILE}`);
  }
  for (const [directory, label] of [
    [CONFIG_DIR, 'REVIVAL_CONFIG_DIR'],
    [SECRETS_DIR, 'REVIVAL_SECRETS_DIR'],
    [DATA_DIR, 'REVIVAL_DATA_DIR']
  ]) ensureManagedRoot(directory, label);
  secureDirectory(BUILD_DIR);
  for (const directory of [
    path.join(SECRETS_DIR, 'pki'),
    path.join(SECRETS_DIR, 'identity'),
    PIN_SECRET_DIR,
    PIN_PRIVATE_ASSETS_DIR
  ]) {
    secureDirectory(directory);
  }
  // `init` reserves the two DeviceUser CA paths at mode 0600 but cannot fill
  // them: a CA minted here would be trusted by one process for one lifetime, so
  // every certificate it ever issued would stop verifying on the next restart
  // (cosmos/crates/cosmos/src/enrollment.rs:95-104). Track which of them are
  // still empty so the operator is told, rather than discovering it as a device
  // that enrols nowhere.
  const emptyDeviceUserCaFiles = [];
  for (const placeholder of [
    path.join(SECRETS_DIR, 'pki', 'duc-ca.crt'),
    path.join(SECRETS_DIR, 'pki', 'duc-ca.key')
  ]) {
    if (fs.existsSync(placeholder)) {
      const stat = fs.lstatSync(placeholder);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`refusing non-regular secret placeholder: ${placeholder}`);
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error(`secret placeholder must already have mode 0600: ${placeholder}`);
      }
      if (stat.size === 0) emptyDeviceUserCaFiles.push(placeholder);
    } else {
      fs.writeFileSync(placeholder, '', { mode: 0o600, flag: 'wx' });
      emptyDeviceUserCaFiles.push(placeholder);
    }
  }

  if (fs.existsSync(ENV_FILE)) {
    const runtimeStat = fs.lstatSync(ENV_FILE);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isFile()) {
      throw new Error(`refusing non-regular runtime configuration: ${ENV_FILE}`);
    }
    if ((runtimeStat.mode & 0o777) !== 0o600) {
      throw new Error(`runtime configuration must already have mode 0600: ${ENV_FILE}`);
    }
    const current = fs.readFileSync(ENV_FILE, 'utf8');
    const filled = fillBlankInitializerDefaults(current);
    if (filled.count > 0) {
      atomicWrite(ENV_FILE, filled.contents);
      info(`Filled ${filled.count} blank local setting${filled.count === 1 ? '' : 's'}; nonblank values were preserved.`);
    } else {
      info('Runtime configuration already exists; no values were replaced.');
    }
  } else {
    const template = fillBlankInitializerDefaults(fs.readFileSync(ENV_EXAMPLE, 'utf8')).contents;
    atomicWrite(ENV_FILE, template);
    createdRuntime = true;
    info('Created an external runtime configuration with independent local server secrets.');
  }

  const runtimeValues = parseEnvFile(ENV_FILE);
  const wroteRealm = ensureLocalIdentityRealm(runtimeValues);
  if (wroteRealm) {
    info('Created or refreshed a sanitized local identity realm with no wearer accounts or fixed passwords.');
  }

  info(`[implemented] configuration: ${CONFIG_DIR}`);
  info(`[implemented] secrets: ${SECRETS_DIR}`);
  info(`[implemented] runtime data: ${DATA_DIR}`);
  info(`[implemented] generated output: ${BUILD_DIR}`);
  if (createdRuntime) {
    info('Provider credentials, Spotify pairing, wearer identity, enrollment, and device PKI remain unconfigured.');
  }
  info('Next steps from a stock Pin to a provisioned device: docs/operations.md#onboarding-a-pin');

  // Unconditional, and on stderr. This used to be reported only inside the
  // `createdRuntime` branch above, so the common case — a rerun, or a second
  // operator on the same checkout — was told nothing and got a deployment whose
  // enrollment was silently unavailable. An empty CA is not a neutral default:
  // Cosmos answers the enrollment RPCs with UNIMPLEMENTED, which the device
  // reads as "this server does not do onboarding" rather than "the operator has
  // not supplied a CA yet". Name the exact files and the exact consequence.
  if (emptyDeviceUserCaFiles.length > 0) {
    const certificate = path.join(SECRETS_DIR, 'pki', 'duc-ca.crt');
    const key = path.join(SECRETS_DIR, 'pki', 'duc-ca.key');
    process.stderr.write(
      'warning: the DeviceUser CA is an empty placeholder, so device enrollment is UNAVAILABLE.\n' +
      emptyDeviceUserCaFiles.map((file) => `  empty: ${file}\n`).join('') +
      '  Create a persistent DeviceUser CA with `revival pki init device-user`, or\n' +
      '  validate and import an existing pair with `revival pki import device-user`.\n' +
      '  Neither command creates or changes the separate attestation CA.\n' +
      `  ${certificate} must contain the CA certificate (PEM).\n` +
      `  ${key} must contain its private key (PKCS#8 PEM).\n` +
      '  Mount the same material in every provisioning replica and in the edge\n' +
      '  DeviceUser trust bundle. Until then a Pin can attest and connect and still\n' +
      '  never obtain a DeviceUser certificate.\n' +
      '  See docs/operations.md#onboarding-a-pin\n'
    );
  }
}

function parseEnvFile(file) {
  const values = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${file}:${index + 1} is not KEY=value`);
    if (Object.hasOwn(values, match[1])) {
      throw new Error(`${file}:${index + 1} repeats ${match[1]}`);
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function isExactBase64Bytes(value, bytes) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
}

function requireValue(values, name, problems, minimum = 1) {
  if ((values[name] || '').length < minimum) {
    problems.push(`${name} must contain at least ${minimum} characters`);
  }
}

function isProtectedRegularFile(file, requireContent = false) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if ((stat.mode & 0o777) !== 0o600) return false;
  return !requireContent || stat.size > 0;
}

function validateLocalIdentityRealm(values, problems) {
  const realmFile = path.join(SECRETS_DIR, 'identity', 'realm.json');
  if (!isProtectedRegularFile(realmFile, true)) {
    problems.push(`${realmFile} must be a nonempty regular file with mode 0600; rerun ./revival init`);
    return;
  }
  let realm;
  try {
    realm = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
  } catch {
    problems.push(`${realmFile} must contain valid JSON; rerun ./revival init after moving the invalid file aside`);
    return;
  }
  const expectedRealm = values.KEYCLOAK_REALM || 'humane';
  const expectedClient = values.KEYCLOAK_CLIENT_ID || 'center';
  const client = Array.isArray(realm.clients)
    ? realm.clients.find((candidate) => candidate?.clientId === expectedClient)
    : null;
  if (realm.realm !== expectedRealm || realm.enabled !== true) {
    problems.push(`${realmFile} must define the enabled ${expectedRealm} realm`);
  }
  if (!client || client.secret !== values.KEYCLOAK_CLIENT_SECRET || client.publicClient !== false ||
      client.standardFlowEnabled !== true || client.directAccessGrantsEnabled !== true ||
      client.implicitFlowEnabled !== false || client.serviceAccountsEnabled !== false) {
    problems.push(`${realmFile} must define the ${expectedClient} client with the runtime KEYCLOAK_CLIENT_SECRET and both supported login flows`);
  }
  if (Array.isArray(realm.users) && realm.users.length > 0) {
    problems.push(`${realmFile} must not embed wearer accounts; create them in the running local identity admin console`);
  }
  const centerPort = values.REVIVAL_CENTER_PORT || '4000';
  const expectedOrigins = [
    `http://localhost:${centerPort}`,
    `http://127.0.0.1:${centerPort}`
  ];
  const redirectUris = Array.isArray(client?.redirectUris) ? client.redirectUris : [];
  const webOrigins = Array.isArray(client?.webOrigins) ? client.webOrigins : [];
  const postLogoutUris = typeof client?.attributes?.['post.logout.redirect.uris'] === 'string'
    ? client.attributes['post.logout.redirect.uris'].split('##')
    : [];
  if (!expectedOrigins.every((origin) =>
    redirectUris.includes(`${origin}/api/auth/callback/humane`) &&
    postLogoutUris.includes(`${origin}/login`) && webOrigins.includes(origin)) ||
    redirectUris.some((uri) => uri.includes('*')) ||
    client?.attributes?.['pkce.code.challenge.method'] !== 'S256') {
    problems.push(`${realmFile} redirect origins do not match REVIVAL_CENTER_PORT=${centerPort}; regenerate the local realm intentionally`);
  }
  const roles = Array.isArray(realm.roles?.realm) ? realm.roles.realm : [];
  if (!roles.some((role) => role?.name === 'cosmos-operator')) {
    problems.push(`${realmFile} must define the optional cosmos-operator realm role`);
  }
}

function validateRuntime({ production = false } = {}) {
  requireExternalDirectory(ENV_FILE, 'REVIVAL_ENV_FILE');
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR: ${ENV_FILE}`);
  }
  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BUILD_DIR]) {
    if (!fs.existsSync(directory)) throw new Error(`operator directory is missing: ${directory}`);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`operator directory must be a real directory, not a link: ${directory}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`operator directory must not be accessible by group or other users: ${directory}`);
    }
  }
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`runtime configuration is missing; run ./revival init (expected ${ENV_FILE})`);
  }
  if (fs.lstatSync(ENV_FILE).isSymbolicLink()) {
    throw new Error(`${ENV_FILE} must not be a symbolic link`);
  }
  if (!fs.statSync(ENV_FILE).isFile()) {
    throw new Error(`${ENV_FILE} must be a regular file`);
  }
  if ((fs.statSync(ENV_FILE).mode & 0o777) !== 0o600) {
    throw new Error(`${ENV_FILE} must have mode 0600`);
  }

  const values = parseEnvFile(ENV_FILE);
  const problems = [];
  if (values.REVIVAL_CONFIG_VERSION !== '1') problems.push('REVIVAL_CONFIG_VERSION must be 1');
  requireValue(values, 'REVIVAL_RELEASE_ID', problems, 1);
  for (const file of [
    path.join(SECRETS_DIR, 'pki', 'duc-ca.crt'),
    path.join(SECRETS_DIR, 'pki', 'duc-ca.key')
  ]) {
    if (!isProtectedRegularFile(file)) {
      problems.push(`${file} must be a non-symlink regular file with mode 0600`);
    }
  }

  const authMode = values.COSMOS_AUTH_MODE || '';
  if (!['development-insecure', 'edge-authenticated'].includes(authMode)) {
    problems.push('COSMOS_AUTH_MODE must be development-insecure or edge-authenticated');
  }
  if (production && authMode !== 'edge-authenticated') {
    problems.push('production requires COSMOS_AUTH_MODE=edge-authenticated');
  }

  requireValue(values, 'AUTH_SESSION_SECRET', problems, 32);
  requireValue(values, 'COSMOS_SHARE_TOKEN_SECRET', problems, 32);
  requireValue(values, 'COSMOS_CENTER_PROJECTION_TOKEN', problems, 32);
  requireValue(values, 'COSMOS_EDGE_TOKEN', problems, 32);
  requireValue(values, 'COSMOS_ADMIN_TOKEN', problems, 32);
  requireValue(values, 'KEYCLOAK_CLIENT_SECRET', problems, 32);
  requireValue(values, 'KEYCLOAK_ADMIN', problems, 8);
  requireValue(values, 'KEYCLOAK_ADMIN_PASSWORD', problems, 32);
  validateLocalIdentityRealm(values, problems);

  const remoteTts = values.COSMOS_REMOTE_TTS_ENABLED || '';
  if (!/^(true|false)$/.test(remoteTts)) {
    problems.push('COSMOS_REMOTE_TTS_ENABLED must be exactly true or false');
  } else if (remoteTts === 'true') {
    requireValue(values, 'COSMOS_AZURE_SPEECH_KEY', problems, 16);
    requireValue(values, 'COSMOS_AZURE_SPEECH_REGION', problems, 2);
    requireValue(values, 'COSMOS_AZURE_SPEECH_VOICE', problems, 2);
  }

  const identityEnabled = values.REVIVAL_IDENTITY_ENABLED || 'false';
  if (!/^(true|false)$/.test(identityEnabled)) {
    problems.push('REVIVAL_IDENTITY_ENABLED must be exactly true or false');
  } else if (identityEnabled === 'true') {
    requireValue(values, 'KEYCLOAK_BASE_URL', problems, 8);
    requireValue(values, 'KEYCLOAK_CLIENT_SECRET', problems, 16);
    requireValue(values, 'KEYCLOAK_ADMIN', problems, 1);
    requireValue(values, 'KEYCLOAK_ADMIN_PASSWORD', problems, 16);
    const realm = path.join(SECRETS_DIR, 'identity', 'realm.json');
    if (!isProtectedRegularFile(realm, true)) {
      problems.push(`${realm} must contain the reviewed realm export when identity is enabled`);
    }
  }

  const enrollmentCode = values.COSMOS_ENROLLMENT_PINCODE || '';
  const enrollmentUser = values.COSMOS_ENROLLMENT_USER_ID || '';
  if (enrollmentCode && !/^\d{4}$/.test(enrollmentCode)) {
    problems.push('COSMOS_ENROLLMENT_PINCODE must be blank or exactly four digits');
  }
  if (Boolean(enrollmentCode) !== Boolean(enrollmentUser)) {
    problems.push('COSMOS_ENROLLMENT_PINCODE and COSMOS_ENROLLMENT_USER_ID must be set together');
  }
  if (enrollmentCode) {
    const opaqueSeed = values.COSMOS_OPAQUE_SEED || '';
    if (!isExactBase64Bytes(opaqueSeed, 32)) {
      problems.push('COSMOS_OPAQUE_SEED must decode from canonical base64 to exactly 32 private bytes when enrollment is enabled');
    }
    if (values.COSMOS_DUC_CA_CERT !== '/run/secrets/duc_ca_cert' ||
        values.COSMOS_DUC_CA_KEY !== '/run/secrets/duc_ca_key') {
      problems.push('COSMOS_DUC_CA_CERT and COSMOS_DUC_CA_KEY must use the reviewed /run/secrets paths');
    }
    for (const filename of ['duc-ca.crt', 'duc-ca.key']) {
      const file = path.join(SECRETS_DIR, 'pki', filename);
      if (!isProtectedRegularFile(file, true)) {
        problems.push(`${file} must contain reviewed DeviceUser CA material when enrollment is configured`);
      }
    }
  }

  const port = Number(values.REVIVAL_CENTER_PORT || '4000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('REVIVAL_CENTER_PORT must be an integer from 1 to 65535');
  }

  const spotifyAdapter = [
    values.REVIVAL_SPOTIFY_ADAPTER_URL || '',
    values.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE || '',
    values.REVIVAL_PIN_BRIDGE_OWNER_SUB || '',
    values.REVIVAL_PIN_BRIDGE_DEVICE_ID || ''
  ];
  if (spotifyAdapter.some(Boolean) && !spotifyAdapter.every(Boolean)) {
    problems.push('REVIVAL_SPOTIFY_ADAPTER_URL, REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE, REVIVAL_PIN_BRIDGE_OWNER_SUB, and REVIVAL_PIN_BRIDGE_DEVICE_ID must be configured together');
  }
  if (spotifyAdapter.every(Boolean)) {
    if (values.REVIVAL_SPOTIFY_ADAPTER_URL !== 'http://10.0.7.1:18081') {
      problems.push('REVIVAL_SPOTIFY_ADAPTER_URL must use the private production adapter endpoint');
    }
    if (values.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE !== '/run/secrets/spotify_adapter_token') {
      problems.push('REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE must use the read-only container secret path');
    }
    const deviceIdBytes = Buffer.byteLength(values.REVIVAL_PIN_BRIDGE_DEVICE_ID.trim(), 'utf8');
    if (deviceIdBytes < 1 || deviceIdBytes > 256) {
      problems.push('REVIVAL_PIN_BRIDGE_DEVICE_ID must be a nonblank device identifier no longer than 256 UTF-8 bytes');
    }
  }

  const uniqueProblems = [...new Set(problems)];
  if (uniqueProblems.length) {
    throw new Error(`configuration is not ready:\n- ${uniqueProblems.join('\n- ')}`);
  }
  return values;
}

function operatorValueNames() {
  let example = '';
  try {
    example = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the operator environment contract ${ENV_EXAMPLE}: ${error.message}`);
  }
  const names = new Set([
    'PIN_SIGNING_STORE_FILE',
    'PIN_SIGNING_STORE_PASSWORD',
    'PIN_SIGNING_KEY_ALIAS',
    'PIN_SIGNING_KEY_PASSWORD',
    'REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE',
    'REVIVAL_PIN_PRIVATE_ASSETS_DIR',
  ]);
  for (const line of example.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

const OPERATOR_VALUE_NAMES = operatorValueNames();

function copyOperatorValues(values) {
  const selected = {};
  if (values === undefined || values === null) return selected;
  if (typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('operator environment values must be an object');
  }
  for (const [name, value] of Object.entries(values)) {
    if (!OPERATOR_VALUE_NAMES.has(name)) continue;
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`operator environment value is invalid: ${name}`);
    }
    selected[name] = value;
  }
  return selected;
}

function safeOptionalEnvironment(name, predicate = () => true) {
  const value = process.env[name];
  return typeof value === 'string' && !value.includes('\0') && predicate(value) ? value : undefined;
}

function operatorEnvironment(values) {
  requireExternalDirectory(BUILD_DIR, 'REVIVAL_BUILD_DIR');
  const user = (() => {
    try { return os.userInfo().username; } catch { return 'revival'; }
  })();
  const temporary = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  const env = {
    HOME: LOGIN_HOME,
    USER: user,
    LOGNAME: user,
    PATH: trustedPath(),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    ...copyOperatorValues(values),
    REVIVAL_CONFIG_DIR: CONFIG_DIR,
    REVIVAL_SECRETS_DIR: SECRETS_DIR,
    REVIVAL_DATA_DIR: DATA_DIR,
    REVIVAL_ENV_FILE: ENV_FILE,
    REVIVAL_PRIVATE_DIR: safeOptionalEnvironment('REVIVAL_PRIVATE_DIR', path.isAbsolute) || SECRETS_DIR,
    REVIVAL_BUILD_DIR: BUILD_DIR,
    CARGO_TARGET_DIR: path.join(BUILD_DIR, 'cosmos-target'),
    GRADLE_USER_HOME: path.join(BUILD_DIR, 'gradle-home'),
    NPM_CONFIG_CACHE: path.join(BUILD_DIR, 'npm-cache'),
    npm_config_cache: path.join(BUILD_DIR, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: '/dev/null',
    // npm 10/11 refuses to load the same pathname as both user and global
    // config.  Keep one empty character device and one impossible root-level
    // pathname so neither ambient config is consulted and npm remains usable.
    NPM_CONFIG_GLOBALCONFIG: '/nonexistent/ai-pin-revival-npm-globalconfig',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // The ordinary CLI needs no Docker credentials. A fixed impossible root
    // is safer than a reusable build directory whose config.json or helper
    // settings could survive from an earlier same-UID process.
    DOCKER_CONFIG: '/nonexistent/ai-pin-revival-docker-config',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    DOCKER_CONTEXT: 'default',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  for (const [name, predicate] of [
    ['CI', (value) => value === 'true' || value === '1'],
    ['FORCE_COLOR', (value) => /^[0-3]$/u.test(value)],
    ['NO_COLOR', (value) => value.length <= 32],
    ['TERM', (value) => /^[A-Za-z0-9._+-]{1,64}$/u.test(value)],
    ['REVIVAL_DEPLOY_REMOTE', (value) => /^[A-Za-z0-9._@:-]{1,255}$/u.test(value)],
    ['REVIVAL_PIN_ENABLE_TEST_FIXTURES', (value) => value === '1'],
    ['REVIVAL_PIN_RELEASE_OUTPUT_DIR', path.isAbsolute],
  ]) {
    const value = safeOptionalEnvironment(name, predicate);
    if (value !== undefined) env[name] = value;
  }
  const adb = resolveTool('adb', { required: false });
  if (adb) env.ADB = adb;
  const openssl = resolveTool('openssl', { required: false });
  if (openssl) env.OPENSSL = openssl;
  const localIdentity = env.REVIVAL_IDENTITY_ENABLED === 'true';
  const identityPort = env.REVIVAL_KEYCLOAK_PORT || '8088';
  const identityRealm = env.KEYCLOAK_REALM || 'humane';
  env.REVIVAL_LOCAL_OIDC_ISSUER = localIdentity
    ? `http://localhost:${identityPort}/realms/${identityRealm}`
    : '';
  env.REVIVAL_LOCAL_OIDC_JWKS_URI = localIdentity
    ? `http://keycloak:8080/realms/${identityRealm}/protocol/openid-connect/certs`
    : '';
  return env;
}

const TEST_ENVIRONMENT_PASSTHROUGH = new Set([
  'CI',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TERM',
  'TZ',
  'WINDIR',
]);
const TEST_ENVIRONMENT_MANAGED_OVERRIDES = new Set([
  'NEXT_TELEMETRY_DISABLED',
  'REVIVAL_RELEASE_ID',
]);

function requireOwnedBuildDirectory(directory, label) {
  secureDirectory(BUILD_DIR);
  if (path.dirname(directory) !== BUILD_DIR) {
    throw new Error(`${label} must be a direct child of REVIVAL_BUILD_DIR: ${directory}`);
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
  // The mode of this fixed child may predate the managed-state contract. The
  // containing build root is exact 0700, so reject identity/type/owner attacks
  // without making a safe existing Cargo cache unusable solely for its mode.
  if (stat.isSymbolicLink() || !stat.isDirectory() || wrongOwner) {
    throw new Error(`${label} must be an owner-owned real directory under REVIVAL_BUILD_DIR: ${directory}`);
  }
  return directory;
}

function testProcessEnvironment(environment = process.env, values = {}) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment || {})) {
    if (TEST_ENVIRONMENT_PASSTHROUGH.has(name.toUpperCase())) sanitized[name] = value;
  }
  for (const name of Object.keys(values)) {
    if (!TEST_ENVIRONMENT_MANAGED_OVERRIDES.has(name)) {
      throw new Error(`unsupported source-test environment override: ${name}`);
    }
  }

  const processRoot = path.join(BUILD_DIR, 'test-process');
  secureDirectory(processRoot);
  const directory = (name) => {
    const result = path.join(processRoot, name);
    secureDirectory(result);
    return result;
  };
  const home = directory('home');
  const temporary = directory('tmp');
  const cargoHome = directory('cargo-home');
  const gradleHome = directory('gradle-home');
  for (const [tool, toolHome, entries] of [
    ['Cargo configuration', cargoHome, ['config', 'config.toml']],
    ['Gradle initialization', gradleHome, ['init.gradle', 'init.gradle.kts', 'init.d']],
  ]) {
    for (const entry of entries) {
      const configuration = path.join(toolHome, entry);
      if (fs.lstatSync(configuration, { throwIfNoEntry: false })) {
        throw new Error(`refusing persistent ${tool}: ${configuration}`);
      }
    }
  }
  const requestedRustup = environment?.RUSTUP_HOME || path.join(LOGIN_HOME, '.rustup');
  const rustupStat = typeof requestedRustup === 'string'
    ? fs.lstatSync(requestedRustup, { throwIfNoEntry: false })
    : null;
  const rustupHome = rustupStat?.isDirectory() && !rustupStat.isSymbolicLink()
    ? path.resolve(requestedRustup)
    : null;
  const user = os.userInfo().username;

  return {
    ...sanitized,
    HOME: home,
    USER: user,
    LOGNAME: user,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: directory('xdg-config'),
    XDG_CACHE_HOME: directory('xdg-cache'),
    XDG_DATA_HOME: directory('xdg-data'),
    XDG_STATE_HOME: directory('xdg-state'),
    REVIVAL_DATA_DIR: DATA_DIR,
    REVIVAL_BUILD_DIR: BUILD_DIR,
    CARGO_TARGET_DIR: directory('cargo-target'),
    CARGO_HOME: cargoHome,
    ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    CARGO_TERM_COLOR: 'never',
    GRADLE_USER_HOME: gradleHome,
    ANDROID_USER_HOME: directory('android-home'),
    NPM_CONFIG_CACHE: directory('npm-cache'),
    NPM_CONFIG_USERCONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: process.platform === 'win32'
      ? 'NUL'
      : '/nonexistent/ai-pin-revival-npm-globalconfig',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...values,
  };
}

function cosmosTestEnvironment(environment = process.env, values = {}) {
  return {
    ...testProcessEnvironment(environment, values),
    CARGO_TARGET_DIR: requireOwnedBuildDirectory(
      path.join(BUILD_DIR, 'cosmos-target'),
      'Cosmos test Cargo target',
    ),
  };
}

module.exports = {
  ROOT,
  PROJECT,
  COMPOSE_BASE,
  COMPOSE_DEVELOPMENT,
  PIN_RELEASE_TOOL,
  PIN_RELEASE_BUILD_TOOL,
  PIN_RELEASE_SHIP_TOOL,
  PIN_INSTALL_TOOL,
  PIN_DOCTOR_TOOL,
  PKI_TOOL,
  PIN_ACTIVATION_TOOL,
  PIN_NETWORK_TOOL,
  DEPLOY_DIR,
  TOOLCHAIN_CONFIG,
  MINIMUM_COMPOSE_VERSION,
  CONFIG_DIR,
  SECRETS_DIR,
  DATA_DIR,
  ENV_FILE,
  BUILD_DIR,
  isInsideDirectory,
  isInsideSource,
  fail,
  info,
  exists,
  run,
  secureDirectory,
  atomicWrite,
  initialize,
  parseEnvFile,
  validateRuntime,
  operatorEnvironment,
  resolveTool,
  testProcessEnvironment,
  cosmosTestEnvironment,
};
