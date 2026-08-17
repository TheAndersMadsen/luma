'use strict';
// Shared CLI context: external directory layout, process helpers, runtime
// configuration parsing/validation, and `./revival init`. Split out of the
// root `revival` entry point; the entry point and its command modules require
// this one. Behavior, messages, and exit codes are unchanged.


const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This module lives at platform/cli/; the workspace root is two levels up.
const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT = 'Ai Pin Revival';
const PROJECT = 'ai-pin-revival';
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const COMPOSE_BASE = path.join(ROOT, 'compose.yaml');
const COMPOSE_DEVELOPMENT = path.join(ROOT, 'platform', 'compose', 'development.yaml');
const PACKAGE_TOOL = path.join(ROOT, 'platform', 'deploy', 'release.mjs');
const PIN_RELEASE_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'release.mjs');
const PIN_RELEASE_BUILD_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'build.mjs');
const PIN_RELEASE_SHIP_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'ship.mjs');
const PIN_INSTALL_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'install.mjs');
const PIN_DOCTOR_TOOL = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'doctor.mjs');
const DEPLOY_DIR = path.join(ROOT, 'platform', 'deploy', 'vps');
const TOOLCHAIN_CONFIG = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'toolchain.json');
const MINIMUM_COMPOSE_VERSION = Object.freeze([2, 33, 1]);
const MANAGED_DIRECTORY_MARKER = '.ai-pin-revival-managed';

const DEFAULT_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  PROJECT
);
const DEFAULT_SECRETS_DIR = path.join(DEFAULT_CONFIG_DIR, 'secrets');
const DEFAULT_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  PROJECT
);
const DEFAULT_BACKUP_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  PROJECT,
  'backups'
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
const BACKUP_DIR = externalPath(
  'REVIVAL_BACKUP_DIR',
  DEFAULT_BACKUP_DIR
);
const ENV_FILE = process.env.REVIVAL_ENV_FILE
  ? path.resolve(process.env.REVIVAL_ENV_FILE)
  : path.join(SECRETS_DIR, 'runtime.env');
const RELEASE_DIR = path.join(DATA_DIR, 'releases');
const BUILD_DIR = externalPath('REVIVAL_BUILD_DIR', path.join(DATA_DIR, 'build'));
const PIN_SECRET_DIR = path.join(SECRETS_DIR, 'pin');
const PIN_SIGNING_ENV_FILE = path.join(PIN_SECRET_DIR, 'signing.env');
const PIN_PRIVATE_ASSETS_DIR = path.join(CONFIG_DIR, 'pin-assets');

const COMPATIBILITY_ALIASES = Object.freeze({
  CARRY_AUTH_MODE: 'REVIVAL_AUTH_MODE',
  CARRY_EDGE_TOKEN: 'REVIVAL_EDGE_TOKEN',
  CARRY_SHARE_TOKEN_SECRET: 'REVIVAL_SHARE_TOKEN_SECRET',
  CARRY_CENTER_PROJECTION_TOKEN: 'REVIVAL_CENTER_PROJECTION_TOKEN',
  CARRY_ADMIN_TOKEN: 'REVIVAL_ADMIN_TOKEN',
  CARRY_OPAQUE_SEED: 'REVIVAL_OPAQUE_SEED',
  CARRY_REMOTE_TTS_ENABLED: 'REVIVAL_REMOTE_TTS_ENABLED',
  CARRY_ENROLLMENT_PINCODE: 'REVIVAL_ENROLLMENT_PINCODE',
  CARRY_ENROLLMENT_USER_ID: 'REVIVAL_ENROLLMENT_USER_ID',
  CARRY_DUC_CA_CERT: 'REVIVAL_DUC_CA_CERT',
  CARRY_DUC_CA_KEY: 'REVIVAL_DUC_CA_KEY',
  CARRY_OPERATOR_EMAILS: 'REVIVAL_OPERATOR_EMAILS',
  CARRY_AZURE_SPEECH_KEY: 'AZURE_SPEECH_KEY',
  CARRY_AZURE_SPEECH_REGION: 'AZURE_SPEECH_REGION',
  CARRY_AZURE_SPEECH_VOICE: 'AZURE_SPEECH_VOICE'
});


function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function exists(command) {
  return child.spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
    stdio: 'ignore'
  }).status === 0;
}

function run(command, args, options = {}) {
  const result = child.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || operatorEnvironment(),
    input: options.input,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined
  });
  if (result.error) fail(`${path.basename(command)} could not run: ${result.error.message}`);
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
  return [DEFAULT_CONFIG_DIR, DEFAULT_SECRETS_DIR, DEFAULT_DATA_DIR, DEFAULT_BACKUP_DIR]
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
  const managedParent = [SECRETS_DIR, DATA_DIR, BACKUP_DIR, CONFIG_DIR]
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
    ['AUTH_SESSION_SECRET', null, () => crypto.randomBytes(32).toString('hex')],
    ['REVIVAL_SHARE_TOKEN_SECRET', 'CARRY_SHARE_TOKEN_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['REVIVAL_CENTER_PROJECTION_TOKEN', 'CARRY_CENTER_PROJECTION_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['REVIVAL_EDGE_TOKEN', 'CARRY_EDGE_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['REVIVAL_ADMIN_TOKEN', 'CARRY_ADMIN_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['REVIVAL_OPAQUE_SEED', 'CARRY_OPAQUE_SEED', () => crypto.randomBytes(32).toString('base64')],
    ['KEYCLOAK_CLIENT_SECRET', null, () => crypto.randomBytes(32).toString('hex')],
    ['KEYCLOAK_ADMIN', null, () => `revival-admin-${crypto.randomBytes(4).toString('hex')}`],
    ['KEYCLOAK_ADMIN_PASSWORD', null, () => crypto.randomBytes(32).toString('base64url')]
  ];
  for (const [key, compatibility, generate] of generated) {
    const canonicalPattern = new RegExp(`^${key}=(.*)$`, 'm');
    const canonicalMatch = canonicalPattern.exec(updated);
    const compatibilityMatch = compatibility
      ? new RegExp(`^${compatibility}=(.+)$`, 'm').exec(updated)
      : null;
    if (compatibilityMatch && compatibilityMatch[1].trim().length > 0) continue;
    if (canonicalMatch && canonicalMatch[1].trim().length > 0) continue;
    const replacement = `${key}=${generate()}`;
    if (canonicalMatch) updated = updated.replace(canonicalPattern, replacement);
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
      realm: [{ name: 'carry-operator', description: 'Ai Pin Revival operator access' }]
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
    [DATA_DIR, 'REVIVAL_DATA_DIR'],
    [BACKUP_DIR, 'REVIVAL_BACKUP_DIR']
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
    [DATA_DIR, 'REVIVAL_DATA_DIR'],
    [BACKUP_DIR, 'REVIVAL_BACKUP_DIR']
  ]) ensureManagedRoot(directory, label);
  secureDirectory(RELEASE_DIR);
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
  info(`[implemented] backups: ${BACKUP_DIR}`);
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
      '  You must supply this material yourself; `revival` has no CA generator, and a\n' +
      '  CA minted per process would invalidate every certificate it ever issued.\n' +
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

function parseExportEnvFile(file, allowedNames) {
  const values = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${file}:${index + 1} is not a literal export NAME=value`);
    const name = match[1];
    if (!allowedNames.has(name)) throw new Error(`${file}:${index + 1} exports unsupported ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`${file}:${index + 1} repeats ${name}`);
    const raw = match[2];
    let value;
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      const parts = raw.slice(1, -1).split("'\\''");
      if (parts.some((part) => part.includes("'"))) {
        throw new Error(`${file}:${index + 1} contains an invalid single-quoted literal`);
      }
      value = parts.join("'");
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      const body = raw.slice(1, -1);
      if (body.includes('"') || body.includes('\\')) {
        throw new Error(`${file}:${index + 1} contains an invalid double-quoted literal`);
      }
      value = body;
    } else if (/^[^\s#]+$/.test(raw)) {
      value = raw;
    } else {
      throw new Error(`${file}:${index + 1} is not a literal export NAME=value`);
    }
    values[name] = value;
  }
  return values;
}

function valueOf(values, canonical, compatibility) {
  return values[canonical] || (compatibility ? values[compatibility] : '') || '';
}

function isExactBase64Bytes(value, bytes) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
}

function rejectCompatibilityConflicts(values, problems) {
  for (const [compatibility, canonical] of Object.entries(COMPATIBILITY_ALIASES)) {
    const canonicalValue = values[canonical] || '';
    const compatibilityValue = values[compatibility] || '';
    if (canonicalValue && compatibilityValue && canonicalValue !== compatibilityValue) {
      problems.push(`${canonical} and compatibility alias ${compatibility} must not disagree`);
    }
  }
}

function requireValue(values, canonical, problems, minimum = 1, compatibility) {
  if (valueOf(values, canonical, compatibility).length < minimum) {
    const suffix = compatibility ? ` (${compatibility} remains a supported compatibility alias)` : '';
    problems.push(`${canonical} must contain at least ${minimum} characters${suffix}`);
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
  if (!roles.some((role) => role?.name === 'carry-operator')) {
    problems.push(`${realmFile} must define the optional carry-operator realm role`);
  }
}

function validateRuntime({ production = false } = {}) {
  requireExternalDirectory(ENV_FILE, 'REVIVAL_ENV_FILE');
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR: ${ENV_FILE}`);
  }
  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BACKUP_DIR, BUILD_DIR]) {
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
  rejectCompatibilityConflicts(values, problems);
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

  const authMode = valueOf(values, 'REVIVAL_AUTH_MODE', 'CARRY_AUTH_MODE');
  if (!['development-insecure', 'edge-authenticated'].includes(authMode)) {
    problems.push('REVIVAL_AUTH_MODE must be development-insecure or edge-authenticated');
  }
  if (production && authMode !== 'edge-authenticated') {
    problems.push('production requires REVIVAL_AUTH_MODE=edge-authenticated');
  }

  requireValue(values, 'AUTH_SESSION_SECRET', problems, 32);
  requireValue(values, 'REVIVAL_SHARE_TOKEN_SECRET', problems, 32, 'CARRY_SHARE_TOKEN_SECRET');
  requireValue(values, 'REVIVAL_CENTER_PROJECTION_TOKEN', problems, 32, 'CARRY_CENTER_PROJECTION_TOKEN');
  requireValue(values, 'REVIVAL_EDGE_TOKEN', problems, 32, 'CARRY_EDGE_TOKEN');
  requireValue(values, 'REVIVAL_ADMIN_TOKEN', problems, 32, 'CARRY_ADMIN_TOKEN');
  requireValue(values, 'KEYCLOAK_CLIENT_SECRET', problems, 32);
  requireValue(values, 'KEYCLOAK_ADMIN', problems, 8);
  requireValue(values, 'KEYCLOAK_ADMIN_PASSWORD', problems, 32);
  validateLocalIdentityRealm(values, problems);

  const remoteTts = valueOf(values, 'REVIVAL_REMOTE_TTS_ENABLED', 'CARRY_REMOTE_TTS_ENABLED');
  if (!/^(true|false)$/.test(remoteTts)) {
    problems.push('REVIVAL_REMOTE_TTS_ENABLED must be exactly true or false');
  } else if (remoteTts === 'true') {
    requireValue(values, 'AZURE_SPEECH_KEY', problems, 16, 'CARRY_AZURE_SPEECH_KEY');
    requireValue(values, 'AZURE_SPEECH_REGION', problems, 2);
    requireValue(values, 'AZURE_SPEECH_VOICE', problems, 2);
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

  const enrollmentCode = valueOf(values, 'REVIVAL_ENROLLMENT_PINCODE', 'CARRY_ENROLLMENT_PINCODE');
  const enrollmentUser = valueOf(values, 'REVIVAL_ENROLLMENT_USER_ID', 'CARRY_ENROLLMENT_USER_ID');
  if (enrollmentCode && !/^\d{4}$/.test(enrollmentCode)) {
    problems.push('REVIVAL_ENROLLMENT_PINCODE must be blank or exactly four digits');
  }
  if (Boolean(enrollmentCode) !== Boolean(enrollmentUser)) {
    problems.push('REVIVAL_ENROLLMENT_PINCODE and REVIVAL_ENROLLMENT_USER_ID must be set together');
  }
  if (enrollmentCode) {
    const opaqueSeed = valueOf(values, 'REVIVAL_OPAQUE_SEED', 'CARRY_OPAQUE_SEED');
    if (!isExactBase64Bytes(opaqueSeed, 32)) {
      problems.push('REVIVAL_OPAQUE_SEED must decode from canonical base64 to exactly 32 private bytes when enrollment is enabled');
    }
    if (valueOf(values, 'REVIVAL_DUC_CA_CERT', 'CARRY_DUC_CA_CERT') !== '/run/secrets/duc_ca_cert' ||
        valueOf(values, 'REVIVAL_DUC_CA_KEY', 'CARRY_DUC_CA_KEY') !== '/run/secrets/duc_ca_key') {
      problems.push('REVIVAL_DUC_CA_CERT and REVIVAL_DUC_CA_KEY must use the reviewed /run/secrets paths');
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

function operatorEnvironment(values) {
  requireExternalDirectory(BUILD_DIR, 'REVIVAL_BUILD_DIR');
  const env = {
    ...process.env,
    ...(values || {}),
    REVIVAL_CONFIG_DIR: CONFIG_DIR,
    REVIVAL_SECRETS_DIR: SECRETS_DIR,
    REVIVAL_DATA_DIR: DATA_DIR,
    REVIVAL_BACKUP_DIR: BACKUP_DIR,
    REVIVAL_ENV_FILE: ENV_FILE,
    REVIVAL_PRIVATE_DIR: process.env.REVIVAL_PRIVATE_DIR || SECRETS_DIR,
    REVIVAL_BUILD_DIR: BUILD_DIR,
    CARGO_TARGET_DIR: path.join(BUILD_DIR, 'cosmos-target'),
    GRADLE_USER_HOME: path.join(BUILD_DIR, 'gradle-home'),
    NPM_CONFIG_CACHE: path.join(BUILD_DIR, 'npm-cache'),
    npm_config_cache: path.join(BUILD_DIR, 'npm-cache'),
    PYTHONDONTWRITEBYTECODE: '1'
  };
  for (const [compatibility, canonical] of Object.entries(COMPATIBILITY_ALIASES)) {
    if (env[canonical]) env[compatibility] = env[canonical];
  }
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

function pinBuildEnvironment() {
  const signingNames = new Set([
    'PIN_SIGNING_STORE_FILE',
    'PIN_SIGNING_STORE_PASSWORD',
    'PIN_SIGNING_KEY_ALIAS',
    'PIN_SIGNING_KEY_PASSWORD'
  ]);
  for (const [file, label] of [
    [PIN_SIGNING_ENV_FILE, 'Pin signing environment']
  ]) {
    requireExternalDirectory(file, label);
    if (!isProtectedRegularFile(file, true)) {
      throw new Error(`${label} must be a nonempty regular file with mode 0600: ${file}`);
    }
  }
  const signing = parseExportEnvFile(PIN_SIGNING_ENV_FILE, signingNames);
  for (const name of signingNames) {
    if (!signing[name]) throw new Error(`${PIN_SIGNING_ENV_FILE} must define nonblank ${name}`);
  }
  const compatibilityStore = path.resolve(signing.PIN_SIGNING_STORE_FILE);
  requireExternalDirectory(compatibilityStore, 'Pin compatibility signing store');
  if (!isProtectedRegularFile(compatibilityStore, true)) {
    throw new Error(`Pin compatibility signing store must be a nonempty regular file with mode 0600: ${compatibilityStore}`);
  }
  if (!fs.existsSync(PIN_PRIVATE_ASSETS_DIR) ||
      fs.lstatSync(PIN_PRIVATE_ASSETS_DIR).isSymbolicLink() ||
      !fs.statSync(PIN_PRIVATE_ASSETS_DIR).isDirectory() ||
      (fs.statSync(PIN_PRIVATE_ASSETS_DIR).mode & 0o077) !== 0) {
    throw new Error(`Pin private assets must be an external owner-only directory: ${PIN_PRIVATE_ASSETS_DIR}`);
  }
  return operatorEnvironment({
    ...signing,
    PIN_SIGNING_STORE_FILE: compatibilityStore,
    REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE: compatibilityStore,
    REVIVAL_PIN_PRIVATE_ASSETS_DIR: PIN_PRIVATE_ASSETS_DIR
  });
}

module.exports = {
  ROOT, PRODUCT, PROJECT, ENV_EXAMPLE, COMPOSE_BASE, COMPOSE_DEVELOPMENT, PACKAGE_TOOL, PIN_RELEASE_TOOL, PIN_RELEASE_BUILD_TOOL, PIN_RELEASE_SHIP_TOOL, PIN_INSTALL_TOOL, PIN_DOCTOR_TOOL, DEPLOY_DIR, TOOLCHAIN_CONFIG, MINIMUM_COMPOSE_VERSION, MANAGED_DIRECTORY_MARKER, DEFAULT_CONFIG_DIR, DEFAULT_SECRETS_DIR, DEFAULT_DATA_DIR, DEFAULT_BACKUP_DIR, CONFIG_DIR, SECRETS_DIR, DATA_DIR, BACKUP_DIR, ENV_FILE, RELEASE_DIR, BUILD_DIR, PIN_SECRET_DIR, PIN_SIGNING_ENV_FILE, PIN_PRIVATE_ASSETS_DIR, COMPATIBILITY_ALIASES, externalPath, canonicalCandidate, isInsideDirectory, isInsideSource, requireExternalDirectory, fail, info, exists, run, hasManagedMarker, isDefaultOperatorDirectory, ensureManagedRoot, secureDirectory, atomicWrite, fillBlankGeneratedSecrets, fillBlankInitializerDefaults, localIdentityRealm, ensureLocalIdentityRealm, initialize, parseEnvFile, parseExportEnvFile, valueOf, isExactBase64Bytes, rejectCompatibilityConflicts, requireValue, isProtectedRegularFile, validateLocalIdentityRealm, validateRuntime, operatorEnvironment, pinBuildEnvironment,
};
