'use strict';
// Shared CLI paths, process helpers, runtime configuration, and initialization.

const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  HOME: LOGIN_HOME,
  isExecutableFile,
  localDockerHost,
  resolveTool,
  trustedPath,
} = require('./authority');
const { CENTER_DEFAULT_SCOPES, REALM, realmPolicy } = require('./realm');
const { OPERATOR_SETUP_NEXT, isOperatorRelease } = require('./command-spec');

// This module lives at platform/cli/. The workspace root is two levels up.
const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT = 'luma';
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const COMPOSE_BASE = path.join(ROOT, 'compose.yaml');
const COMPOSE_DEVELOPMENT = path.join(ROOT, 'platform', 'compose', 'development.yaml');
const PIN_RELEASE_BUILD_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'build.mjs');
const PIN_RELEASE_ACQUIRE_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'acquire-release.mjs');
const PIN_RELEASE_EXPORT_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'export-release.mjs');
const PIN_INSTALL_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'install.mjs');
const PIN_DOCTOR_TOOL = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'doctor.mjs');
const PKI_TOOL = path.join(ROOT, 'platform', 'deploy', 'pki.mjs');
const PIN_ACTIVATION_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'activate.mjs');
const PIN_NETWORK_TOOL = path.join(ROOT, 'platform', 'deploy', 'pin', 'network.mjs');
const DEPLOY_DIR = path.join(ROOT, 'platform', 'deploy', 'vps');
const TOOLCHAIN_CONFIG = path.join(ROOT, 'platform', 'containers', 'pin-builder', 'toolchain.json');
const DISTRIBUTION_VERSION = path.join(ROOT, 'platform', 'distribution', 'version.json');
const MINIMUM_COMPOSE_VERSION = Object.freeze([2, 34, 0]);
const MANAGED_DIRECTORY_MARKER = '.luma-managed';

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
  'LUMA_CONFIG_DIR',
  DEFAULT_CONFIG_DIR
);
const SECRETS_DIR = externalPath('LUMA_SECRETS_DIR', process.env.LUMA_CONFIG_DIR
  ? path.join(CONFIG_DIR, 'secrets')
  : DEFAULT_SECRETS_DIR);
const DATA_DIR = externalPath(
  'LUMA_DATA_DIR',
  DEFAULT_DATA_DIR
);
const ENV_FILE = process.env.LUMA_ENV_FILE
  ? path.resolve(process.env.LUMA_ENV_FILE)
  : path.join(SECRETS_DIR, 'runtime.env');
const BUILD_DIR = externalPath('LUMA_BUILD_DIR', path.join(DATA_DIR, 'build'));
// The variables that move Luma's configuration and data. A server set up with
// them needs the same values in every shell that runs ./luma. Luma records no
// location of its own, so a shell without them sees the defaults.
const LOCATION_VARIABLES = Object.freeze([
  'LUMA_CONFIG_DIR', 'LUMA_SECRETS_DIR', 'LUMA_ENV_FILE', 'LUMA_DATA_DIR', 'LUMA_BUILD_DIR',
]);

function locationOverrides() {
  return LOCATION_VARIABLES.filter((name) => process.env[name]);
}

// Where this shell looked for the runtime configuration, and how to point it
// at a server's own directories. Paths only, never a value from the file.
function configurationLocationHint(what = 'production configuration') {
  const overrides = locationOverrides();
  if (overrides.length) {
    return `no ${what} at ${ENV_FILE}, where this shell's ${overrides.join(', ')} point; ` +
      'give them the values this server was set up with';
  }
  return `no ${what} at ${ENV_FILE}, the default location; if this server was set up with ` +
    'LUMA_CONFIG_DIR and LUMA_DATA_DIR, export the same values in this shell (README "Configuration")';
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

// The line that makes a new shell find this configuration again, or null
// when it lives in the default directories.
function locationExportLine() {
  const overrides = locationOverrides();
  if (!overrides.length) return null;
  return `export ${overrides.map((name) => `${name}=${shellQuote(path.resolve(process.env[name]))}`).join(' ')}`;
}
const PIN_SECRET_DIR = path.join(SECRETS_DIR, 'pin');

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

// Docker's `--mount` value is one comma-separated string, so a comma in a path
// would silently split it into wrong options. Every --mount string in the CLI
// goes through here.
function dockerBindMount(source, target, readOnly = false) {
  if (source.includes(',')) throw new Error(`Docker bind mounts cannot use a path containing a comma: ${source}`);
  return `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`;
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
    timeout: options.timeout,
    killSignal: options.killSignal,
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
      throw new Error(
        `${label} already exists but is not marked for Luma: ${directory}; ` +
        'Luma creates this directory itself at mode 0700, so remove it if it is empty or choose a path that does not exist yet',
      );
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
    fs.writeFileSync(marker, 'schema=1\nproduct=luma\n', { mode: 0o600, flag: 'wx' });
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

function exposeDockerDesktopCliPlugins(dockerConfig) {
  if (process.platform !== 'darwin' || !fs.existsSync(dockerConfig)) return;
  const pluginRoot = '/Applications/Docker.app/Contents/Resources/cli-plugins';
  const available = ['docker-buildx', 'docker-compose']
    .map((name) => [name, path.join(pluginRoot, name)])
    .filter(([, source]) => isExecutableFile(source));
  if (available.length === 0) return;
  const plugins = path.join(dockerConfig, 'cli-plugins');
  secureDirectory(plugins);
  for (const [name, source] of available) {
    const target = path.join(plugins, name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    try {
      fs.symlinkSync(source, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
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

function decodeEnvValue(rawValue) {
  let value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function fillBlankGeneratedSecrets(contents, profiles = null) {
  let updated = contents;
  let count = 0;
  const databasePasswordMatch = /^COSMOS_PG_PASSWORD=(.*)$/m.exec(contents);
  const configuredDatabasePassword = databasePasswordMatch
    ? decodeEnvValue(databasePasswordMatch[1])
    : '';
  const databasePassword = configuredDatabasePassword || crypto.randomBytes(32).toString('hex');
  const generated = [
    ['COSMOS_PG_PASSWORD', () => databasePassword],
    ['COSMOS_DATABASE_URL', () => `postgresql://cosmos:${encodeURIComponent(databasePassword)}@postgres:5432/cosmos`],
    ['AUTH_SESSION_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_SHARE_TOKEN_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_EDGE_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['COSMOS_ADMIN_TOKEN', () => crypto.randomBytes(32).toString('hex')],
    ['KEYCLOAK_CLIENT_SECRET', () => crypto.randomBytes(32).toString('hex')],
    ['KEYCLOAK_ADMIN', () => `luma-admin-${crypto.randomBytes(4).toString('hex')}`],
    ['KEYCLOAK_ADMIN_PASSWORD', () => crypto.randomBytes(32).toString('base64url')],
    ...(profiles === null || profiles.includes('observability')
      ? [['GRAFANA_ADMIN_PASSWORD', () => crypto.randomBytes(32).toString('hex')]]
      : []),
    ...(profiles === null || profiles.includes('search')
      ? [['SEARXNG_SECRET', () => crypto.randomBytes(32).toString('hex')]]
      : []),
    ...(profiles === null || profiles.includes('pin')
      ? [['COSMOS_OPAQUE_SEED', () => crypto.randomBytes(32).toString('base64')]]
      : []),
  ];
  for (const [key, generate] of generated) {
    const pattern = new RegExp(`^${key}=(.*)$`, 'm');
    const match = pattern.exec(updated);
    if (match && decodeEnvValue(match[1]).length > 0) continue;
    const replacement = `${key}=${generate()}`;
    if (match) updated = updated.replace(pattern, replacement);
    else updated = `${updated.replace(/\s*$/, '')}\n${replacement}\n`;
    count += 1;
  }
  return { contents: updated, count };
}

function fillBlankInitializerDefaults(contents, profiles = null) {
  const generated = fillBlankGeneratedSecrets(contents, profiles);
  let bundled = null;
  try {
    const candidate = JSON.parse(fs.readFileSync(DISTRIBUTION_VERSION, 'utf8'));
    if (candidate.schemaVersion === 2 && /^[0-9a-f]{40}$/u.test(candidate.revision) &&
        /^oci:\/\/ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(candidate.application)) {
      bundled = candidate;
    }
  } catch {
    // A source checkout has no published application identity.
  }
  const releasePattern = /^LUMA_RELEASE_ID=(.*)$/m;
  const releaseMatch = releasePattern.exec(generated.contents);
  const currentRelease = releaseMatch ? decodeEnvValue(releaseMatch[1]) : '';
  // Release identity belongs to the operator bundle, not to the operator's
  // configuration. A newer bundle must advance it while preserving every
  // user-owned setting and secret in this file.
  const release = bundled ? bundled.revision : (currentRelease || 'local');
  let updated = releaseMatch
    ? generated.contents.replace(releasePattern, `LUMA_RELEASE_ID=${release}`)
    : `${generated.contents.replace(/\s*$/, '')}\nLUMA_RELEASE_ID=${release}\n`;
  let count = generated.count + (release !== currentRelease ? 1 : 0);

  // The release's version beside its revision, so setup can refuse an older
  // operator folder and messages can name the folder (luma-operator-VERSION).
  // A source checkout keeps whatever an operator release wrote.
  const versionPattern = /^LUMA_RELEASE_VERSION=(.*)$/m;
  const versionMatch = versionPattern.exec(updated);
  const currentVersion = versionMatch ? decodeEnvValue(versionMatch[1]) : '';
  const version = bundled && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(bundled.version || '')
    ? bundled.version : currentVersion;
  if (version !== currentVersion) {
    updated = versionMatch
      ? updated.replace(versionPattern, `LUMA_RELEASE_VERSION=${version}`)
      : updated.replace(/^(LUMA_RELEASE_ID=.*)$/m, `$1\nLUMA_RELEASE_VERSION=${version}`);
    count += 1;
  }

  // The rest of the release's identity, which Center shows as this server's
  // version and compares with the update source's: its tag, its Pin release,
  // and when it was published. Only an operator release writes them.
  if (bundled) {
    const identity = [
      ['LUMA_RELEASE_TAG', /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(bundled.source?.tag || '') ? bundled.source.tag : ''],
      ['LUMA_PIN_RELEASE_VERSION', /^\d{4}-\d{2}-\d{2}\.\d+$/u.test(bundled.pin?.version || '') ? bundled.pin.version : ''],
      ['LUMA_PIN_RELEASE_VERSION_CODE', Number.isSafeInteger(bundled.pin?.versionCode) ? String(bundled.pin.versionCode) : ''],
      ['LUMA_RELEASE_PUBLISHED_AT',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(bundled.publishedAt || '') ? bundled.publishedAt : ''],
    ];
    for (const [name, value] of identity) {
      const pattern = new RegExp(`^${name}=(.*)$`, 'm');
      const match = pattern.exec(updated);
      if (match && decodeEnvValue(match[1]) === value) continue;
      updated = match
        ? updated.replace(pattern, `${name}=${value}`)
        : `${updated.replace(/\s*$/, '')}\n${name}=${value}\n`;
      count += 1;
    }
  }

  const applicationPattern = /^LUMA_COMPOSE_APPLICATION=(.*)$/m;
  const applicationMatch = applicationPattern.exec(updated);
  const currentApplication = applicationMatch ? decodeEnvValue(applicationMatch[1]) : '';
  const application = bundled ? bundled.application : currentApplication;
  if (application !== currentApplication || !applicationMatch) {
    updated = applicationMatch
      ? updated.replace(applicationPattern, `LUMA_COMPOSE_APPLICATION=${application}`)
      : `${updated.replace(/\s*$/, '')}\nLUMA_COMPOSE_APPLICATION=${application}\n`;
    count += 1;
  }
  return { contents: updated, count };
}

function localIdentityRealm(values) {
  const realm = REALM;
  const clientId = values.KEYCLOAK_CLIENT_ID || 'center';
  const centerPort = values.LUMA_CENTER_PORT || '4000';
  const origins = [
    `http://localhost:${centerPort}`,
    `http://127.0.0.1:${centerPort}`
  ];
  const redirectUris = origins.map((origin) => `${origin}/api/auth/callback/humane`);
  return {
    realm,
    displayName: 'Luma',
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    accessTokenLifespan: 900,
    attributes: { aiPinLumaManaged: 'true' },
    roles: {
      realm: [{ name: 'cosmos-operator', description: 'Luma operator access' }]
    },
    ...realmPolicy(),
    clients: [{
      clientId,
      name: 'Luma Center',
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
      defaultClientScopes: [...CENTER_DEFAULT_SCOPES],
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
      const managed = current?.attributes?.aiPinLumaManaged === 'true';
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

function prepareManagedRoots() {
  for (const [directory, label] of [
    [CONFIG_DIR, 'LUMA_CONFIG_DIR'],
    [SECRETS_DIR, 'LUMA_SECRETS_DIR'],
    [DATA_DIR, 'LUMA_DATA_DIR']
  ]) {
    requireExternalDirectory(directory, label);
  }
  requireExternalDirectory(BUILD_DIR, 'LUMA_BUILD_DIR');
  if (!isInsideDirectory(BUILD_DIR, DATA_DIR)) {
    throw new Error(`LUMA_BUILD_DIR must be inside LUMA_DATA_DIR: ${BUILD_DIR}`);
  }
  requireExternalDirectory(ENV_FILE, 'LUMA_ENV_FILE');
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`LUMA_ENV_FILE must be inside LUMA_SECRETS_DIR: ${ENV_FILE}`);
  }
  for (const [directory, label] of [
    [CONFIG_DIR, 'LUMA_CONFIG_DIR'],
    [SECRETS_DIR, 'LUMA_SECRETS_DIR'],
    [DATA_DIR, 'LUMA_DATA_DIR']
  ]) ensureManagedRoot(directory, label);
  secureDirectory(BUILD_DIR);
}

function initialize({ suppressDeviceCaWarning = false, quiet = false, profiles = null, localIdentity = true } = {}) {
  let createdRuntime = false;
  prepareManagedRoots();
  for (const directory of [
    ...(localIdentity ? [path.join(SECRETS_DIR, 'identity')] : []),
    ...(profiles === null
      ? [path.join(SECRETS_DIR, 'pki'), PIN_SECRET_DIR]
      : []),
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
  for (const placeholder of profiles === null ? [
    path.join(SECRETS_DIR, 'pki', 'duc-ca.crt'),
    path.join(SECRETS_DIR, 'pki', 'duc-ca.key')
  ] : []) {
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
    const filled = fillBlankInitializerDefaults(current, profiles);
    if (filled.count > 0) {
      atomicWrite(ENV_FILE, filled.contents);
      if (!quiet) info(`Filled ${filled.count} blank local setting${filled.count === 1 ? '' : 's'}; nonblank values were preserved.`);
    } else {
      if (!quiet) info('Runtime configuration already exists; no values were replaced.');
    }
  } else {
    const template = fillBlankInitializerDefaults(fs.readFileSync(ENV_EXAMPLE, 'utf8'), profiles).contents;
    atomicWrite(ENV_FILE, template);
    createdRuntime = true;
    if (!quiet) info('Created an external runtime configuration with independent local server secrets.');
  }

  if (localIdentity) {
    const runtimeValues = parseEnvFile(ENV_FILE);
    const wroteRealm = ensureLocalIdentityRealm(runtimeValues);
    if (!quiet && wroteRealm) {
      info('Created or refreshed a sanitized local identity realm with no wearer accounts or fixed passwords.');
    }
  }

  if (!quiet) {
    info(`Configuration: ${CONFIG_DIR}`);
    info(`Secrets: ${SECRETS_DIR}`);
    info(`Runtime data: ${DATA_DIR}`);
    info(`Generated output: ${BUILD_DIR}`);
    if (createdRuntime) {
      info('Provider credentials, Spotify pairing, wearer identity, enrollment, and device PKI remain unconfigured.');
    }
    info('Developer guide: README.md#for-developers');
  }

  // Unconditional, and on stderr. This used to be reported only inside the
  // `createdRuntime` branch above, so the common case, a rerun, or a second
  // operator on the same checkout, was told nothing and got a deployment whose
  // enrollment was silently unavailable. An empty CA is not a neutral default:
  // Cosmos answers the enrollment RPCs with UNIMPLEMENTED, which the device
  // reads as "this server does not do onboarding" rather than "the operator has
  // not supplied a CA yet". Name the exact files and the exact consequence.
  if (!suppressDeviceCaWarning && emptyDeviceUserCaFiles.length > 0) {
    const certificate = path.join(SECRETS_DIR, 'pki', 'duc-ca.crt');
    const key = path.join(SECRETS_DIR, 'pki', 'duc-ca.key');
    process.stderr.write(
      'warning: the DeviceUser CA is empty, so this local stack cannot enroll a Pin.\n' +
      emptyDeviceUserCaFiles.map((file) => `  empty: ${file}\n`).join('') +
      '  Only a local stack that enrolls a real Pin needs one: create it with\n' +
      '  `./luma pki init device-user --confirm`, or import an existing pair with\n' +
      '  `./luma pki import device-user --cert FILE --key FILE --confirm`.\n' +
      `  It must fill ${certificate} (PEM certificate) and ${key} (PKCS#8 PEM key).\n` +
      '  Production setup creates its own. See README.md#for-developers\n'
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
    values[match[1]] = decodeEnvValue(match[2]);
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

// Unset uses Cosmos's default; a value Cosmos would clamp or ignore is refused
// here instead (services/capture/objects.rs MIN_/MAX_MAX_UPLOAD_BYTES).
function requireOptionalByteCount(values, name, problems, minimum, maximum) {
  const value = values[name] || '';
  if (value && !(/^[0-9]+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum)) {
    problems.push(`${name} must be a whole number of bytes from ${minimum} to ${maximum}`);
  }
}

function requireProductionPassword(values, source, name, problems) {
  const value = values[name] || '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value) ||
      !source.split(/\r?\n/).includes(`${name}=${value}`)) {
    problems.push(`${name} must contain at least 32 characters using only letters, digits, _ or -`);
  }
}

function isPublicDnsHostname(hostname) {
  if (!hostname.includes('.') || hostname.endsWith('.') ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  const address = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(address) !== 0 || hostname.length > 253) return false;
  return hostname.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function requireProductionHttpsUrl(values, source, name, problems, { origin = false } = {}) {
  const value = values[name] || '';
  const exactSafeLine = !/[\u0000-\u0020\u007f$\\'"#]/u.test(value) &&
    source.split(/\r?\n/).includes(`${name}=${value}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} must be a valid public HTTPS ${origin ? 'origin' : 'URL'}`);
    return;
  }
  if (!exactSafeLine || url.protocol !== 'https:' || !isPublicDnsHostname(url.hostname) ||
      url.username || url.password ||
      url.hash || (origin && (url.pathname !== '/' || url.search))) {
    problems.push(`${name} must be a valid public HTTPS ${origin ? 'origin' : 'URL'}`);
  }
}

function requireProductionDatabaseUrl(values, source, problems) {
  const message = 'COSMOS_DATABASE_URL must be a PostgreSQL URL with user, password, host, and one database';
  const rawValue = values.COSMOS_DATABASE_URL || '';
  const rawValueIsSafe = /^[A-Za-z0-9._~:/@%\[\]-]+$/.test(rawValue) &&
    source.split(/\r?\n/).includes(`COSMOS_DATABASE_URL=${rawValue}`);
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    problems.push(message);
    return;
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    problems.push(message);
    return;
  }
  const database = /^\/([A-Za-z_][A-Za-z0-9_-]*)$/.exec(url.pathname)?.[1] || '';
  const host = url.hostname;
  const hostAddress = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const hostnameIsSafe = net.isIP(hostAddress) !== 0 || (
    !host.endsWith('.') && host.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
  const valid = ['postgres:', 'postgresql:'].includes(url.protocol) &&
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(username) &&
    password.length >= 32 && !/[\0\r\n]/.test(password) &&
    hostnameIsSafe && Boolean(host) && Boolean(database) && !url.search && !url.hash;
  const canonicalStackDatabase = host !== 'postgres' || (
    username === 'cosmos' && database === 'cosmos' && password === values.COSMOS_PG_PASSWORD &&
    (!url.port || url.port === '5432')
  );
  if (!rawValueIsSafe || !valid || !canonicalStackDatabase) {
    problems.push(message);
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
    problems.push(`${realmFile} must be a nonempty regular file with mode 0600; rerun ./luma init`);
    return;
  }
  let realm;
  try {
    realm = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
  } catch {
    problems.push(`${realmFile} must contain valid JSON; rerun ./luma init after moving the invalid file aside`);
    return;
  }
  const expectedRealm = 'humane';
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
  const centerPort = values.LUMA_CENTER_PORT || '4000';
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
    problems.push(`${realmFile} redirect origins do not match LUMA_CENTER_PORT=${centerPort}; regenerate the local realm intentionally`);
  }
  const roles = Array.isArray(realm.roles?.realm) ? realm.roles.realm : [];
  if (!roles.some((role) => role?.name === 'cosmos-operator')) {
    problems.push(`${realmFile} must define the optional cosmos-operator realm role`);
  }
}

function validateProductionIdentityRealm(values, problems) {
  const realmFile = path.join(CONFIG_DIR, 'production', 'realm.json');
  const realmReady = fs.existsSync(realmFile) && !fs.lstatSync(realmFile).isSymbolicLink() &&
    fs.statSync(realmFile).isFile() && fs.statSync(realmFile).size > 0 &&
    (fs.statSync(realmFile).mode & 0o777) === 0o444;
  if (!realmReady) {
    problems.push(`${realmFile} must be a nonempty regular file with mode 0444; rerun ./luma setup production`);
    return;
  }
  let realm;
  try {
    realm = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
  } catch {
    problems.push(`${realmFile} must contain valid JSON; rerun ./luma setup production`);
    return;
  }
  const origin = values.LUMA_PUBLIC_ORIGIN || '';
  const client = Array.isArray(realm.clients)
    ? realm.clients.find((candidate) => candidate?.clientId === (values.KEYCLOAK_CLIENT_ID || 'center'))
    : null;
  const operator = Array.isArray(realm.users)
    ? realm.users.find((candidate) => candidate?.id === values.LUMA_FIRST_OPERATOR_ID)
    : null;
  if (realm.realm !== 'humane' || realm.enabled !== true || realm.sslRequired !== 'external' ||
      realm.loginTheme !== 'luma' ||
      realm.attributes?.aiPinLumaManaged !== 'production-v1') {
    problems.push(`${realmFile} must define the managed production humane realm`);
  }
  if (!client || client.secret !== values.KEYCLOAK_CLIENT_SECRET || client.publicClient !== false ||
      client.standardFlowEnabled !== true || client.directAccessGrantsEnabled !== true ||
      client.implicitFlowEnabled !== false ||
      !client.redirectUris?.includes(`${origin}/api/auth/callback/humane`) ||
      !client.webOrigins?.includes(origin) ||
      client.attributes?.['pkce.code.challenge.method'] !== 'S256') {
    problems.push(`${realmFile} must define the confidential Center client for ${origin}`);
  }
  if (!operator || operator.email !== values.LUMA_FIRST_OPERATOR_EMAIL || operator.enabled !== true ||
      !operator.realmRoles?.includes('cosmos-operator') ||
      operator.requiredActions?.includes('UPDATE_PASSWORD') ||
      !operator.credentials?.some((credential) => credential?.type === 'password' &&
        typeof credential.value === 'string' && credential.value.length >= 24 && credential.temporary === false)) {
    problems.push(`${realmFile} must contain a password-grant-compatible first operator`);
  }
}

function validateRuntime({ production = false, envFile = ENV_FILE } = {}) {
  requireExternalDirectory(envFile, 'LUMA_ENV_FILE');
  if (!isInsideDirectory(envFile, SECRETS_DIR)) {
    throw new Error(`LUMA_ENV_FILE must be inside LUMA_SECRETS_DIR: ${envFile}`);
  }
  // An operator release creates its configuration with production setup. A
  // checkout with ./luma init.
  const create = isOperatorRelease() ? OPERATOR_SETUP_NEXT : './luma init';
  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BUILD_DIR]) {
    if (!fs.existsSync(directory)) throw new Error(`operator directory is missing: ${directory}; create it with ${create}`);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`operator directory must be a real directory, not a link: ${directory}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`operator directory must not be accessible by group or other users: ${directory}`);
    }
  }
  if (!fs.existsSync(envFile)) {
    throw new Error(`runtime configuration is missing (expected ${envFile}); create it with ${create}`);
  }
  if (fs.lstatSync(envFile).isSymbolicLink()) {
    throw new Error(`${envFile} must not be a symbolic link`);
  }
  if (!fs.statSync(envFile).isFile()) {
    throw new Error(`${envFile} must be a regular file`);
  }
  if ((fs.statSync(envFile).mode & 0o777) !== 0o600) {
    throw new Error(`${envFile} must have mode 0600`);
  }

  const values = parseEnvFile(envFile);
  const problems = [];
  const rawProfiles = values.COMPOSE_PROFILES || '';
  const profiles = rawProfiles.split(',').filter(Boolean);
  if (values.LUMA_CONFIG_VERSION !== '1') problems.push('LUMA_CONFIG_VERSION must be 1');
  requireValue(values, 'LUMA_RELEASE_ID', problems, 1);
  if (!production || profiles.includes('pin')) {
    const pkiRoot = production
      ? path.join(CONFIG_DIR, 'production', 'device-user-root')
      : path.join(SECRETS_DIR, 'pki');
    for (const file of ['duc-ca.crt', 'duc-ca.key'].map((name) => path.join(pkiRoot, name))) {
      const ready = production
        ? fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile() &&
          fs.statSync(file).size > 0 && (fs.statSync(file).mode & 0o777) === 0o444
        : isProtectedRegularFile(file);
      if (!ready) {
        problems.push(`${file} must be a nonempty non-symlink regular file with mode ${production ? '0444' : '0600'}`);
      }
    }
  }

  const authMode = values.COSMOS_AUTH_MODE || '';
  if (!['development-insecure', 'edge-authenticated'].includes(authMode)) {
    problems.push('COSMOS_AUTH_MODE must be development-insecure or edge-authenticated');
  }
  if (production && authMode !== 'edge-authenticated') {
    problems.push('production requires COSMOS_AUTH_MODE=edge-authenticated');
  }
  if (production) {
    const envSource = fs.readFileSync(envFile, 'utf8');
    requireProductionHttpsUrl(values, envSource, 'LUMA_PUBLIC_ORIGIN', problems, { origin: true });
    requireProductionHttpsUrl(values, envSource, 'COSMOS_OIDC_ISSUER', problems);
    requireProductionHttpsUrl(values, envSource, 'COSMOS_CAPTURE_UPLOAD_BASE_URL', problems, { origin: true });
    requireProductionHttpsUrl(values, envSource, 'COSMOS_CAPTURE_SHARE_BASE_URL', problems, { origin: true });
    requireProductionHttpsUrl(values, envSource, 'LUMA_MUSIC_GATEWAY_ORIGIN', problems, { origin: true });
    if (profiles.includes('pin')) {
      requireProductionHttpsUrl(values, envSource, 'COSMOS_ONBOARDING_ENDPOINT', problems);
    }
    requireProductionDatabaseUrl(values, envSource, problems);
    requireProductionPassword(values, envSource, 'COSMOS_PG_PASSWORD', problems);
    if (profiles.includes('observability')) {
      requireProductionPassword(values, envSource, 'GRAFANA_ADMIN_PASSWORD', problems);
    }
    let origin;
    try { origin = new URL(values.LUMA_PUBLIC_ORIGIN); } catch { origin = null; }
    if (!isPublicDnsHostname(values.LUMA_PUBLIC_DOMAIN || '') ||
        origin?.hostname !== values.LUMA_PUBLIC_DOMAIN) {
      problems.push('LUMA_PUBLIC_DOMAIN must exactly match the host in LUMA_PUBLIC_ORIGIN');
    }
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u
      .test(values.LUMA_ACME_EMAIL || '')) {
      problems.push('LUMA_ACME_EMAIL must be a valid email address');
    }
  }

  requireOptionalByteCount(values, 'COSMOS_CAPTURE_MAX_UPLOAD_BYTES', problems, 1048576, 1073741824);
  requireValue(values, 'AUTH_SESSION_SECRET', problems, 32);
  requireValue(values, 'COSMOS_SHARE_TOKEN_SECRET', problems, 32);
  requireValue(values, 'COSMOS_EDGE_TOKEN', problems, 32);
  requireValue(values, 'COSMOS_ADMIN_TOKEN', problems, 32);
  requireValue(values, 'KEYCLOAK_CLIENT_SECRET', problems, 32);
  requireValue(values, 'KEYCLOAK_ADMIN', problems, 8);
  requireValue(values, 'KEYCLOAK_ADMIN_PASSWORD', problems, 32);
  if (profiles.includes('search')) requireValue(values, 'SEARXNG_SECRET', problems, 32);
  if (production) {
    requireValue(values, 'LUMA_PUBLIC_DOMAIN', problems, 4);
    requireValue(values, 'LUMA_ACME_EMAIL', problems, 5);
    requireValue(values, 'LUMA_FIRST_OPERATOR_EMAIL', problems, 5);
    requireValue(values, 'LUMA_FIRST_OPERATOR_ID', problems, 16);
    validateProductionIdentityRealm(values, problems);
  } else {
    validateLocalIdentityRealm(values, problems);
  }

  const remoteTts = values.COSMOS_REMOTE_TTS_ENABLED || '';
  if (!/^(true|false)$/.test(remoteTts)) {
    problems.push('COSMOS_REMOTE_TTS_ENABLED must be exactly true or false');
  } else if (remoteTts === 'true') {
    requireValue(values, 'COSMOS_AZURE_SPEECH_KEY', problems, 16);
    requireValue(values, 'COSMOS_AZURE_SPEECH_REGION', problems, 2);
    requireValue(values, 'COSMOS_AZURE_SPEECH_VOICE', problems, 2);
  }

  const identityEnabled = values.LUMA_IDENTITY_ENABLED || 'false';
  if (!/^(true|false)$/.test(identityEnabled)) {
    problems.push('LUMA_IDENTITY_ENABLED must be exactly true or false');
  } else if (identityEnabled === 'true') {
    requireValue(values, 'KEYCLOAK_CLIENT_SECRET', problems, 16);
    requireValue(values, 'KEYCLOAK_ADMIN', problems, 1);
    requireValue(values, 'KEYCLOAK_ADMIN_PASSWORD', problems, 16);
    const realm = production
      ? path.join(CONFIG_DIR, 'production', 'realm.json')
      : path.join(SECRETS_DIR, 'identity', 'realm.json');
    const realmReady = production
      ? fs.existsSync(realm) && !fs.lstatSync(realm).isSymbolicLink() &&
        fs.statSync(realm).isFile() && fs.statSync(realm).size > 0 &&
        (fs.statSync(realm).mode & 0o777) === 0o444
      : isProtectedRegularFile(realm, true);
    if (!realmReady) {
      problems.push(`${realm} must contain the reviewed realm export when identity is enabled`);
    }
  }

  // Each account's Pin passcode is its owner's, set in Center. The deployment
  // holds none. The user id is the account an unpaired Pin enrolls into.
  const enrollmentUser = values.COSMOS_ENROLLMENT_USER_ID || '';
  if (enrollmentUser) {
    const opaqueSeed = values.COSMOS_OPAQUE_SEED || '';
    if (!isExactBase64Bytes(opaqueSeed, 32)) {
      problems.push('COSMOS_OPAQUE_SEED must decode from canonical base64 to exactly 32 private bytes when enrollment is enabled');
    }
    if (!production) {
      for (const filename of ['duc-ca.crt', 'duc-ca.key']) {
        const file = path.join(SECRETS_DIR, 'pki', filename);
        if (!isProtectedRegularFile(file, true)) {
          problems.push(`${file} must contain reviewed DeviceUser CA material when enrollment is configured`);
        }
      }
    }
  }

  const unsupportedProfiles = profiles.filter((profile) =>
    !['pin', 'search', 'spotify', 'observability'].includes(profile));
  if (unsupportedProfiles.length > 0) {
    problems.push(`COMPOSE_PROFILES contains unsupported values: ${unsupportedProfiles.join(', ')}`);
  }
  if (new Set(profiles).size !== profiles.length || [...profiles].sort().join(',') !== rawProfiles) {
    problems.push('COMPOSE_PROFILES must be a unique, sorted comma-separated list');
  }
  if (production && profiles.includes('pin')) {
    if (!enrollmentUser) {
      problems.push('the pin profile requires COSMOS_ENROLLMENT_USER_ID');
    }
    if (net.isIP(values.LUMA_DEVICE_EDGE_IPV4 || '') !== 4) {
      problems.push('the pin profile requires LUMA_DEVICE_EDGE_IPV4');
    }
  }

  const port = Number(values.LUMA_CENTER_PORT || '4000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('LUMA_CENTER_PORT must be an integer from 1 to 65535');
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
    'LUMA_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE',
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

// `lumaDockerConfig: false` leaves Docker on the owner's own configuration and
// writes nothing: read-only checks use it, and before setup Luma's does not
// exist yet.
function operatorEnvironment(values, { lumaDockerConfig = true } = {}) {
  requireExternalDirectory(BUILD_DIR, 'LUMA_BUILD_DIR');
  if (lumaDockerConfig) exposeDockerDesktopCliPlugins(BUILD_DIR);
  const user = (() => {
    try { return os.userInfo().username; } catch { return 'luma'; }
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
    LUMA_CONFIG_DIR: CONFIG_DIR,
    LUMA_SECRETS_DIR: SECRETS_DIR,
    LUMA_DATA_DIR: DATA_DIR,
    LUMA_ENV_FILE: ENV_FILE,
    LUMA_BUILD_DIR: BUILD_DIR,
    CARGO_TARGET_DIR: path.join(BUILD_DIR, 'cosmos-target'),
    GRADLE_USER_HOME: path.join(BUILD_DIR, 'gradle-home'),
    NPM_CONFIG_STORE_DIR: path.join(BUILD_DIR, 'pnpm-store'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(BUILD_DIR, 'bun-cache'),
    DO_NOT_TRACK: '1',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/nonexistent/luma-pnpm-globalconfig',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Docker requires this directory to exist even when no credentials are used.
    DOCKER_CONFIG: BUILD_DIR,
    DOCKER_HOST: localDockerHost(),
    DOCKER_CONTEXT: 'default',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  for (const [name, predicate] of [
    ['CI', (value) => value === 'true' || value === '1'],
    ['FORCE_COLOR', (value) => /^[0-3]$/u.test(value)],
    ['NO_COLOR', (value) => value.length <= 32],
    ['TERM', (value) => /^[A-Za-z0-9._+-]{1,64}$/u.test(value)],
    ['LUMA_PIN_ENABLE_TEST_FIXTURES', (value) => value === '1'],
  ]) {
    const value = safeOptionalEnvironment(name, predicate);
    if (value !== undefined) env[name] = value;
  }
  const adb = resolveTool('adb', { required: false });
  if (adb) env.ADB = adb;
  const openssl = resolveTool('openssl', { required: false });
  if (openssl) env.OPENSSL = openssl;
  const localIdentity = env.LUMA_IDENTITY_ENABLED === 'true';
  const identityPort = env.LUMA_KEYCLOAK_PORT || '8088';
  const identityRealm = 'humane';
  env.KEYCLOAK_BASE_URL = localIdentity ? 'http://keycloak:8080' : '';
  env.KEYCLOAK_REALM = identityRealm;
  env.LUMA_LOCAL_OIDC_ISSUER = localIdentity
    ? `http://localhost:${identityPort}/realms/${identityRealm}`
    : '';
  env.LUMA_LOCAL_OIDC_JWKS_URI = localIdentity
    ? `http://keycloak:8080/realms/${identityRealm}/protocol/openid-connect/certs`
    : '';
  if (!lumaDockerConfig) delete env.DOCKER_CONFIG;
  return env;
}

const TEST_ENVIRONMENT_PASSTHROUGH = new Set([
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
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
  'LUMA_RELEASE_ID',
]);

function conventionalAndroidSdk(platform = process.platform, home = LOGIN_HOME) {
  const candidates = platform === 'darwin'
    ? [path.join(home, 'Library', 'Android', 'sdk')]
    : platform === 'linux'
      ? [path.join(home, 'Android', 'Sdk')]
      : [];
  for (const candidate of candidates) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) return candidate;
  }
  return null;
}

function requireOwnedBuildDirectory(directory, label) {
  secureDirectory(BUILD_DIR);
  if (path.dirname(directory) !== BUILD_DIR) {
    throw new Error(`${label} must be a direct child of LUMA_BUILD_DIR: ${directory}`);
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
    throw new Error(`${label} must be an owner-owned real directory under LUMA_BUILD_DIR: ${directory}`);
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
  const dockerConfig = directory('docker-config');
  exposeDockerDesktopCliPlugins(dockerConfig);
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
  const cargo = resolveTool('cargo', { required: false });
  const user = os.userInfo().username;
  const discoveredAndroidSdk = conventionalAndroidSdk();
  const androidHome = sanitized.ANDROID_HOME || sanitized.ANDROID_SDK_ROOT || discoveredAndroidSdk;
  const androidSdkRoot = sanitized.ANDROID_SDK_ROOT || sanitized.ANDROID_HOME || discoveredAndroidSdk;

  return {
    ...sanitized,
    // Cargo's clippy/rustc subprocesses must use the same Rustup installation
    // as the version-checked cargo, even when Homebrew precedes it in PATH.
    PATH: `${cargo ? `${path.dirname(cargo)}${path.delimiter}` : ''}${sanitized.PATH || trustedPath()}`,
    ...(androidHome ? { ANDROID_HOME: androidHome } : {}),
    ...(androidSdkRoot ? { ANDROID_SDK_ROOT: androidSdkRoot } : {}),
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
    LUMA_DATA_DIR: DATA_DIR,
    LUMA_BUILD_DIR: BUILD_DIR,
    CARGO_TARGET_DIR: directory('cargo-target'),
    CARGO_HOME: cargoHome,
    ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    CARGO_TERM_COLOR: 'never',
    GRADLE_USER_HOME: gradleHome,
    ANDROID_USER_HOME: directory('android-home'),
    DOCKER_CONFIG: dockerConfig,
    DOCKER_HOST: localDockerHost(),
    DOCKER_CONTEXT: 'default',
    NPM_CONFIG_STORE_DIR: directory('pnpm-store'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: directory('bun-cache'),
    DO_NOT_TRACK: '1',
    NPM_CONFIG_USERCONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: process.platform === 'win32'
      ? 'NUL'
      : '/nonexistent/luma-pnpm-globalconfig',
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
  PIN_RELEASE_BUILD_TOOL,
  PIN_RELEASE_ACQUIRE_TOOL,
  PIN_RELEASE_EXPORT_TOOL,
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
  configurationLocationHint,
  locationExportLine,
  isInsideDirectory,
  isInsideSource,
  fail,
  info,
  exists,
  run,
  dockerBindMount,
  secureDirectory,
  atomicWrite,
  prepareManagedRoots,
  initialize,
  parseEnvFile,
  validateRuntime,
  operatorEnvironment,
  resolveTool,
  conventionalAndroidSdk,
  testProcessEnvironment,
  cosmosTestEnvironment,
};
