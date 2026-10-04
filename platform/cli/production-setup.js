'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const child = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const {
  ROOT,
  CONFIG_DIR,
  DATA_DIR,
  ENV_FILE,
  atomicWrite,
  fail,
  info,
  initialize,
  operatorEnvironment,
  parseEnvFile,
  PIN_RELEASE_ACQUIRE_TOOL,
  prepareManagedRoots,
  resolveTool,
  secureDirectory,
  validateRuntime,
} = require('./context');
const {
  compareReleaseVersions, describeRelease, pinReleaseIdentityMatches, versionInfo,
} = require('./command-spec');
const {
  CENTER_DEFAULT_SCOPES, REALM, keycloakAdmin, realmPolicy, setAccountPassword,
} = require('./realm');
const { detectPublicIpv4, duckDnsDomain, duckDnsSubdomain, registerDuckDns } = require('./public-network');
const { secretFromStdin } = require('./terminal');
const {
  REQUESTS_DIR, UPDATES_DIR, configureAutomaticUpdates, ensureRequestsDirectory, ensureUpdatesDirectory,
  pointCurrentOperator,
} = require('./update');
const { isUpdateSourceOrigin } = require('../distribution/release-descriptor.mjs');

const PRODUCTION_DIR = path.join(CONFIG_DIR, 'production');
const OPERATOR_COMPOSE = path.join(PRODUCTION_DIR, 'operator.compose.yaml');
const PIN_BRIDGE_TOKEN_FILE = path.join(PRODUCTION_DIR, 'pin-bridge-token');
const EDGE_ROOT_DIR = path.join(PRODUCTION_DIR, 'edge-root');
const DEVICE_USER_ROOT_DIR = path.join(PRODUCTION_DIR, 'device-user-root');
const PIN_TRUST_FILE = path.join(PRODUCTION_DIR, 'pin-trust.json');
const EDGE_ROOT = Object.freeze({
  certificate: path.join(EDGE_ROOT_DIR, 'edge-ca.crt'),
  key: path.join(EDGE_ROOT_DIR, 'edge-ca.key'),
});
const DEVICE_USER_ROOT = Object.freeze({
  certificate: path.join(DEVICE_USER_ROOT_DIR, 'duc-ca.crt'),
  key: path.join(DEVICE_USER_ROOT_DIR, 'duc-ca.key'),
});
const PRODUCTION_PROFILE_NAMES = Object.freeze(['pin', 'search', 'spotify', 'observability']);
const PROFILES = new Set(PRODUCTION_PROFILE_NAMES);
const PIN_SERVER_NAMES = Object.freeze([
  'api.cosmos.humane.cloud',
  'api.clone.invalid',
  'eastus.cosmos.humane.cloud',
  'eastus-1.cosmos.humane.cloud',
  'onboarding.cosmos.humane.cloud',
  'onboarding.clone.invalid',
  'cosmos-edge',
]);
// Owner-managed Traefik extras. Setup and deploy mount them and never create,
// write, chmod, or delete them.
const TRAEFIK_EXTRA_FILE = path.join(PRODUCTION_DIR, 'traefik-extra.json');
const TRAEFIK_EXTRA_CERTS_DIR = path.join(PRODUCTION_DIR, 'traefik-extra-certs');
const TRAEFIK_EXTRA_CERTS_TARGET = '/etc/traefik/extra-certs';
const TRAEFIK_EXTRA_MAX_BYTES = 64 * 1024;
const TRAEFIK_EXTRA_NAME = /^extra-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// Hosts Luma's own edge answers; `connectivity-check` and `n` are the Pin's
// plain-HTTP connectivity probes.
const TRAEFIK_LUMA_HOSTS = Object.freeze([
  ...PIN_SERVER_NAMES, 'connectivity-check.cosmos.humane.cloud', 'n.cosmos.humane.cloud',
]);
// Luma's own Compose services (compose.yaml and platform/compose/production.yaml).
// Traefik shares networks with them, so an owner route to one would publish a
// Luma internal under the owner's hostname. `cosmos-` names are Luma's too, and
// `luma-`/`luma_` are its container, network, and volume names.
const LUMA_SERVICE_NAMES = Object.freeze([
  'account', 'ai-bus', 'center', 'center-iroh-bridge', 'connectivity', 'contacts', 'edge',
  'feature-flags', 'grafana', 'keycloak', 'notable-events', 'postgres', 'prometheus',
  'provisioning', 'searxng', 'spotify-adapter', 'traefik',
]);

function lumaServiceHost(host) {
  const name = host.toLowerCase().replace(/\.+$/u, '');
  return LUMA_SERVICE_NAMES.includes(name) || /^(?:cosmos-|luma[-_])/u.test(name);
}

// Luma's own Compose network keys (platform/compose/production.yaml). An
// external network under one of these keys would replace Luma's definition.
const LUMA_NETWORK_KEYS = Object.freeze([
  'cosmos-internal', 'loopback-publish', 'pin-control', 'provider-egress', 'public-edge',
  'search-egress', 'search-service',
]);

function safeYaml(value) {
  return JSON.stringify(path.resolve(value));
}

function regularFile(file, { mode, nonempty = true } = {}) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && stat.isFile() && (!nonempty || stat.size > 0) &&
    (mode === undefined || (stat.mode & 0o777) === mode);
}

function hasProductionSetupMarker(values = null) {
  if (regularFile(OPERATOR_COMPOSE) || regularFile(path.join(PRODUCTION_DIR, 'realm.json'))) return true;
  let configured = values;
  if (configured === null) {
    if (!regularFile(ENV_FILE, { nonempty: true })) return false;
    try { configured = parseEnvFile(ENV_FILE); } catch { return false; }
  }
  return [
    'LUMA_PUBLIC_DOMAIN',
    'LUMA_PUBLIC_ORIGIN',
    'LUMA_ACME_EMAIL',
    'LUMA_FIRST_OPERATOR_EMAIL',
    'LUMA_COMPOSE_APPLICATION',
  ].some((name) => Boolean(configured?.[name]?.trim()));
}

function validProductionDomain(value) {
  return value.includes('.') && value.length <= 253 && net.isIP(value) === 0 &&
    value.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function validProductionEmail(value) {
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(value);
}

// Let's Encrypt refuses an account email at the reserved example domains.
function reservedExampleEmail(value) {
  return /@(?:[^@]+\.)?example\.(?:com|net|org)$/iu.test(value);
}

function replaceEnvironmentValues(contents, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/u).map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  while (lines.at(-1) === '') lines.pop();
  for (const [name, value] of pending) lines.push(`${name}=${value}`);
  return `${lines.join('\n')}\n`;
}

function removeEnvironmentValues(contents, names) {
  const removed = new Set(names);
  const lines = contents.split(/\r?\n/u)
    .filter((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
      return !match || !removed.has(match[1]);
    });
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function parseOptions(args, current = {}) {
  const options = {
    domain: current.LUMA_PUBLIC_DOMAIN || (() => {
      try { return new URL(current.LUMA_PUBLIC_ORIGIN || '').hostname; } catch { return ''; }
    })(),
    acmeEmail: current.LUMA_ACME_EMAIL || '',
    operatorEmail: current.LUMA_FIRST_OPERATOR_EMAIL || '',
    publicIpv4: current.LUMA_DEVICE_EDGE_IPV4 || '',
    pinReleaseArchive: '',
    duckDnsSubdomain: '',
    duckDnsTokenStdin: false,
    // The release names the default update source. A server keeps its own.
    updateSource: current.LUMA_UPDATE_SOURCE || versionInfo().updateSource || '',
    // New servers install updates at night. A server set up before automatic
    // updates existed keeps updating by hand until its owner turns them on.
    autoUpdates: current.LUMA_AUTO_UPDATES || (hasProductionSetupMarker(current) ? 'off' : 'on'),
  };
  const selectedProfiles = new Set();
  const seen = new Set();
  let profilesSpecified = false;
  let clearProfiles = false;
  while (args.length > 0) {
    const option = args.shift();
    if (option === '--profile') {
      const value = args.shift();
      if (!value || !PROFILES.has(value)) {
        throw new Error(`--profile must be one of: ${PRODUCTION_PROFILE_NAMES.join(', ')}`);
      }
      profilesSpecified = true;
      selectedProfiles.add(value);
      continue;
    }
    if (option === '--no-profiles') {
      if (clearProfiles) throw new Error('usage');
      clearProfiles = true;
      continue;
    }
    if (option === '--duckdns-token-stdin') {
      if (options.duckDnsTokenStdin) throw new Error('usage');
      options.duckDnsTokenStdin = true;
      continue;
    }
    const fields = new Map([
      ['--domain', 'domain'],
      ['--acme-email', 'acmeEmail'],
      ['--operator-email', 'operatorEmail'],
      ['--public-ip', 'publicIpv4'],
      ['--pin-release-archive', 'pinReleaseArchive'],
      ['--duckdns-subdomain', 'duckDnsSubdomain'],
      ['--update-source', 'updateSource'],
      ['--auto-updates', 'autoUpdates'],
    ]);
    if (!fields.has(option) || seen.has(option)) throw new Error('usage');
    const value = args.shift();
    if (!value || value.startsWith('-')) throw new Error('usage');
    seen.add(option);
    options[fields.get(option)] = value;
  }
  if (clearProfiles && profilesSpecified) throw new Error('usage');
  options.domain = options.domain.trim().toLowerCase();
  options.acmeEmail = options.acmeEmail.trim().toLowerCase();
  options.operatorEmail = options.operatorEmail.trim().toLowerCase();
  options.publicIpv4 = options.publicIpv4.trim();
  options.pinReleaseArchive = options.pinReleaseArchive.trim();
  options.profiles = clearProfiles
    ? []
    : profilesSpecified
      ? [...selectedProfiles].sort()
      : (current.COMPOSE_PROFILES || '').split(',')
        .map((value) => value.trim()).filter((value) => PROFILES.has(value)).sort();

  // A free DuckDNS name replaces --domain: setup points NAME.duckdns.org at
  // this server (setupProduction, with the token from stdin) and stores that
  // name as the public domain.
  if (options.duckDnsSubdomain || options.duckDnsTokenStdin) {
    if (seen.has('--domain') || !options.duckDnsSubdomain || !options.duckDnsTokenStdin) throw new Error('usage');
    const subdomain = duckDnsSubdomain(options.duckDnsSubdomain);
    if (!subdomain) throw new Error('--duckdns-subdomain must be one DNS label of letters, digits and hyphens');
    options.duckDnsSubdomain = subdomain;
    options.domain = duckDnsDomain(subdomain);
  }
  if (!validProductionDomain(options.domain)) {
    throw new Error('a public DNS name is required with --domain');
  }
  if (!validProductionEmail(options.acmeEmail)) throw new Error('a valid address is required with --acme-email');
  if (reservedExampleEmail(options.acmeEmail)) {
    throw new Error("--acme-email needs a real address: Let's Encrypt refuses example.com, example.net, and example.org");
  }
  if (!validProductionEmail(options.operatorEmail)) throw new Error('a valid address is required with --operator-email');
  // `auto` asks setupProduction to detect the address. The flag path
  // otherwise takes the literal address, as before.
  if (options.publicIpv4 && options.publicIpv4 !== 'auto' && net.isIP(options.publicIpv4) !== 4) {
    throw new Error('--public-ip must be an IPv4 address or auto');
  }
  if (options.profiles.includes('pin') && !options.publicIpv4) {
    throw new Error('the pin profile requires --public-ip');
  }
  if (options.profiles.includes('spotify') && !options.profiles.includes('pin')) {
    throw new Error('the spotify profile requires the pin profile');
  }
  options.updateSource = options.updateSource.trim().replace(/\/$/u, '');
  if (options.updateSource && !isUpdateSourceOrigin(options.updateSource)) {
    throw new Error('--update-source must be an https origin such as https://center.example.com, with no path');
  }
  if (!['on', 'off'].includes(options.autoUpdates)) throw new Error('--auto-updates must be on or off');
  return options;
}

function validatePinReleaseArchiveInput(file) {
  if (!file) return null;
  const selected = path.resolve(file);
  if (!fs.existsSync(selected)) throw new Error(`Pin release archive does not exist: ${selected}`);
  const metadata = fs.lstatSync(selected);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 ||
      metadata.size > 3 * 1024 * 1024 * 1024) {
    throw new Error(`Pin release archive must be a nonempty regular file no larger than 3 GiB: ${selected}`);
  }
  return selected;
}

function runOpenSsl(args) {
  const executable = resolveTool('openssl');
  const result = child.spawnSync(executable, args, {
    encoding: 'utf8',
    env: { PATH: path.dirname(executable), LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`OpenSSL failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout;
}

function ensurePair(certificate, key, generate, { force = false } = {}) {
  const certificateReady = regularFile(certificate, { mode: 0o444 });
  const keyReady = regularFile(key, { mode: 0o444 });
  for (const selected of [certificate, key]) {
    if (!fs.existsSync(selected)) continue;
    const stat = fs.lstatSync(selected);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`production PKI output is not a regular generated file: ${selected}`);
    }
  }
  if (!force && certificateReady && keyReady) {
    try {
      validatePair(certificate, key);
      return false;
    } catch {
      // Both fixed, generated paths exist but do not form one pair. Regenerate
      // them together below. This is the expected recovery after interruption.
    }
  }
  const staging = fs.mkdtempSync(path.join(PRODUCTION_DIR, '.pki-'));
  try {
    const stagedCertificate = path.join(staging, 'certificate.pem');
    const stagedKey = path.join(staging, 'private-key.pem');
    generate(stagedCertificate, stagedKey, staging);
    validatePair(stagedCertificate, stagedKey);
    atomicWrite(key, fs.readFileSync(stagedKey), 0o444);
    atomicWrite(certificate, fs.readFileSync(stagedCertificate), 0o444);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return true;
}

function ensureImmutableRootPair(
  { label, directory, certificate, key, issuingCaAllowed = false },
  generate,
) {
  if (fs.existsSync(directory)) {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
        (directoryStat.mode & 0o777) !== 0o700 ||
        !regularFile(certificate, { mode: 0o444 }) || !regularFile(key, { mode: 0o444 })) {
      throw new Error(`${label} is established but incomplete or unsafe; restore its original pair instead of regenerating it: ${directory}`);
    }
    try {
      validatePair(certificate, key);
      // An operator's own PKI usually signs from an issuing CA under a root it
      // keeps offline, and only this certificate reaches the edge trust store.
      // Requiring a self-signature there would reject the real credential and
      // leave every device it already enrolled unable to connect.
      if (issuingCaAllowed) {
        assertCertificateAuthority(certificate);
      } else {
        runOpenSsl(['verify', '-CAfile', certificate, certificate]);
      }
    } catch {
      throw new Error(`${label} is established but does not contain its original matching root pair; restore it instead of regenerating it: ${directory}`);
    }
    return Object.freeze({ certificate, key, created: false });
  }

  const staging = fs.mkdtempSync(path.join(PRODUCTION_DIR, `.${path.basename(directory)}-`));
  const stagedCertificate = path.join(staging, path.basename(certificate));
  const stagedKey = path.join(staging, path.basename(key));
  let committed = false;
  try {
    generate(stagedCertificate, stagedKey);
    fs.chmodSync(stagedCertificate, 0o444);
    fs.chmodSync(stagedKey, 0o444);
    fs.chmodSync(staging, 0o700);
    validatePair(stagedCertificate, stagedKey);
    runOpenSsl(['verify', '-CAfile', stagedCertificate, stagedCertificate]);
    // One directory rename publishes the pair. A crash before this point can
    // leave staging, but never an incomplete established root.
    fs.renameSync(staging, directory);
    committed = true;
  } finally {
    if (!committed && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
  return Object.freeze({ certificate, key, created: true });
}

function certificateSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readPinTrust() {
  if (!fs.existsSync(PIN_TRUST_FILE)) return null;
  if (!regularFile(PIN_TRUST_FILE, { mode: 0o444 })) {
    throw new Error(`Pin trust record must be a nonempty regular mode-0444 file: ${PIN_TRUST_FILE}`);
  }
  let trust;
  try { trust = JSON.parse(fs.readFileSync(PIN_TRUST_FILE, 'utf8')); } catch {
    throw new Error(`Pin trust record is not valid JSON: ${PIN_TRUST_FILE}`);
  }
  if (trust?.schemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/u.test(trust.edgeRootSha256 || '') ||
      !/^[a-f0-9]{64}$/u.test(trust.deviceUserRootSha256 || '')) {
    throw new Error(`Pin trust record has an unsupported shape: ${PIN_TRUST_FILE}`);
  }
  return Object.freeze(trust);
}

function assertRootFingerprint(label, certificate, expected) {
  if (certificateSha256(certificate) !== expected) {
    throw new Error(`${label} does not match the established Pin trust record; restore the original root instead of rotating it`);
  }
}

function generateCa(certificate, key, subject) {
  runOpenSsl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
  runOpenSsl([
    'req', '-x509', '-new', '-key', key, '-out', certificate, '-days', '3650', '-sha256',
    '-subj', subject,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature',
    '-addext', 'subjectKeyIdentifier=hash',
    '-addext', 'authorityKeyIdentifier=keyid:always',
  ]);
}

function generateIntermediateCa(certificate, key, staging, issuer, subject) {
  const request = path.join(staging, 'intermediate.csr');
  const extensions = path.join(staging, 'intermediate.ext');
  runOpenSsl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
  runOpenSsl(['req', '-new', '-key', key, '-out', request, '-subj', subject]);
  fs.writeFileSync(extensions, [
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    'keyUsage=critical,keyCertSign,cRLSign,digitalSignature',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    '',
  ].join('\n'), { mode: 0o600 });
  runOpenSsl([
    'x509', '-req', '-in', request, '-CA', issuer.certificate, '-CAkey', issuer.key,
    '-set_serial', '2', '-out', certificate, '-days', '1825', '-sha256', '-extfile', extensions,
  ]);
}

function certificateVerifies(certificate, authority, hostname = null) {
  if (!regularFile(certificate, { mode: 0o444 }) || !regularFile(authority, { mode: 0o444 })) return false;
  try {
    runOpenSsl([
      'verify', '-CAfile', authority,
      ...(hostname ? ['-verify_hostname', hostname] : []),
      certificate,
    ]);
    return true;
  } catch {
    return false;
  }
}

function ensureProductionPki() {
  const establishedTrust = readPinTrust();
  if (establishedTrust && (!fs.existsSync(EDGE_ROOT_DIR) || !fs.existsSync(DEVICE_USER_ROOT_DIR))) {
    throw new Error('Pin trust is established but a root directory is missing; restore the original roots instead of regenerating them');
  }
  const attest = {
    certificate: path.join(PRODUCTION_DIR, 'attestation-ca.crt'),
    key: path.join(PRODUCTION_DIR, 'attestation-ca.key'),
  };
  const server = {
    certificate: path.join(PRODUCTION_DIR, 'edge-server.crt'),
    key: path.join(PRODUCTION_DIR, 'edge-server.key'),
  };
  const edgeCa = ensureImmutableRootPair({
    label: 'Cosmos edge root CA',
    directory: EDGE_ROOT_DIR,
    ...EDGE_ROOT,
  }, (certificate, key) => generateCa(certificate, key, '/O=Luma/CN=Cosmos Edge Root CA'));
  if (establishedTrust) {
    assertRootFingerprint('Cosmos edge root CA', edgeCa.certificate, establishedTrust.edgeRootSha256);
  }
  ensurePair(attest.certificate, attest.key, (certificate, key, staging) =>
    generateIntermediateCa(
      certificate, key, staging, edgeCa,
      '/O=Luma/OU=DeviceAttestation/CN=Cosmos Attestation CA',
    ), { force: !certificateVerifies(attest.certificate, edgeCa.certificate) });
  const duc = ensureImmutableRootPair({
    label: 'Cosmos DeviceUser root CA',
    directory: DEVICE_USER_ROOT_DIR,
    ...DEVICE_USER_ROOT,
    issuingCaAllowed: true,
  }, (certificate, key) => generateCa(certificate, key, '/O=Humane/OU=DeviceUser/CN=Cosmos DeviceUser CA'));
  if (establishedTrust) {
    assertRootFingerprint(
      'Cosmos DeviceUser root CA', duc.certificate, establishedTrust.deviceUserRootSha256,
    );
  } else {
    atomicWrite(PIN_TRUST_FILE, `${JSON.stringify({
      schemaVersion: 1,
      edgeRootSha256: certificateSha256(edgeCa.certificate),
      deviceUserRootSha256: certificateSha256(duc.certificate),
    }, null, 2)}\n`, 0o444);
  }
  ensurePair(server.certificate, server.key, (certificate, key, staging) => {
    const request = path.join(staging, 'server.csr');
    const extensions = path.join(staging, 'server.ext');
    runOpenSsl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
    runOpenSsl(['req', '-new', '-key', key, '-out', request, '-subj', '/O=Luma/CN=cosmos-edge']);
    fs.writeFileSync(extensions, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${PIN_SERVER_NAMES.map((name) => `DNS:${name}`).join(',')}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
      '',
    ].join('\n'), { mode: 0o600 });
    runOpenSsl([
      'x509', '-req', '-in', request, '-CA', edgeCa.certificate, '-CAkey', edgeCa.key,
      '-set_serial', '1', '-out', certificate, '-days', '825', '-sha256', '-extfile', extensions,
    ]);
  }, {
    force: !certificateVerifies(server.certificate, edgeCa.certificate, 'api.cosmos.humane.cloud'),
  });
  return { edgeCa, attest, duc, server };
}

function assertCertificateAuthority(certificate) {
  const constraints = runOpenSsl(['x509', '-in', certificate, '-noout', '-ext', 'basicConstraints']);
  if (!/CA\s*:\s*TRUE/iu.test(constraints)) {
    throw new Error(`not a certificate authority: ${certificate}`);
  }
}

function validatePair(certificate, key) {
  const certificateKey = runOpenSsl(['x509', '-in', certificate, '-pubkey', '-noout']).trim();
  const privateKey = runOpenSsl(['pkey', '-in', key, '-pubout']).trim();
  if (certificateKey !== privateKey) throw new Error(`certificate and private key do not match: ${certificate} / ${key}`);
}

function validatePki() {
  const files = {
    edgeCa: [EDGE_ROOT.certificate, EDGE_ROOT.key],
    attest: [path.join(PRODUCTION_DIR, 'attestation-ca.crt'), path.join(PRODUCTION_DIR, 'attestation-ca.key')],
    duc: [DEVICE_USER_ROOT.certificate, DEVICE_USER_ROOT.key],
    server: [path.join(PRODUCTION_DIR, 'edge-server.crt'), path.join(PRODUCTION_DIR, 'edge-server.key')],
  };
  for (const [certificate, key] of Object.values(files)) validatePair(certificate, key);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], files.edgeCa[0]]);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], files.attest[0]]);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], '-verify_hostname', 'api.cosmos.humane.cloud', files.server[0]]);
  // The DeviceUser CA is operator-supplied and is commonly an issuing CA whose
  // root stays offline, so it is held to being a CA rather than self-signed.
  assertCertificateAuthority(files.duc[0]);
  const trust = readPinTrust();
  if (!trust) throw new Error(`Pin trust record is missing: ${PIN_TRUST_FILE}`);
  assertRootFingerprint('Cosmos edge root CA', files.edgeCa[0], trust.edgeRootSha256);
  assertRootFingerprint('Cosmos DeviceUser root CA', files.duc[0], trust.deviceUserRootSha256);
}

function productionRealm(values, firstPassword) {
  const origin = values.LUMA_PUBLIC_ORIGIN;
  const email = values.LUMA_FIRST_OPERATOR_EMAIL;
  return {
    realm: REALM,
    displayName: 'Luma',
    loginTheme: 'luma',
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    accessTokenLifespan: 900,
    attributes: { aiPinLumaManaged: 'production-v1' },
    roles: { realm: [{ name: 'cosmos-operator', description: 'Luma operator access' }] },
    ...realmPolicy(),
    clients: [{
      clientId: values.KEYCLOAK_CLIENT_ID || 'center',
      name: 'Luma Center',
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      secret: values.KEYCLOAK_CLIENT_SECRET,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      implicitFlowEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: true,
      redirectUris: [`${origin}/api/auth/callback/humane`],
      webOrigins: [origin],
      defaultClientScopes: [...CENTER_DEFAULT_SCOPES],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${origin}/login`,
      },
    }],
    users: [{
      id: values.LUMA_FIRST_OPERATOR_ID,
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      // An imported user gets only the roles listed here. The default roles
      // let the operator use the account console, where Center sends them to
      // change their password or finish a Keycloak step.
      realmRoles: ['default-roles-humane', 'cosmos-operator'],
      requiredActions: [],
      credentials: [{ type: 'password', value: firstPassword, temporary: false }],
    }],
  };
}

function firstLoginContents(values, firstPassword) {
  const guidedSetup = `${values.LUMA_PUBLIC_ORIGIN}/login?next=%2Fsettings%2Fpin%2Fsetup`;
  return [
    `Center: ${values.LUMA_PUBLIC_ORIGIN}`,
    `Guided setup: ${guidedSetup}`,
    `Operator: ${values.LUMA_FIRST_OPERATOR_EMAIL}`,
    `Initial password: ${firstPassword}`,
    '',
  ].join('\n');
}

function readFirstLogin(file, values) {
  if (!fs.existsSync(file)) return null;
  if (!regularFile(file, { mode: 0o600 })) {
    throw new Error(`first-login handoff must be a nonempty regular file with mode 0600: ${file}`);
  }
  const contents = fs.readFileSync(file, 'utf8');
  const center = /^Center: (.+)$/mu.exec(contents)?.[1];
  const operator = /^Operator: (.+)$/mu.exec(contents)?.[1];
  const password = /^Initial password: ([A-Za-z0-9_-]{24,})$/mu.exec(contents)?.[1];
  if (center !== values.LUMA_PUBLIC_ORIGIN || operator !== values.LUMA_FIRST_OPERATOR_EMAIL || !password) {
    throw new Error(`first-login handoff is invalid or belongs to another setup: ${file}`);
  }
  return password;
}

function assertExistingRealm(existing, values) {
  const operator = Array.isArray(existing?.users)
    ? existing.users.find((candidate) => candidate?.id === values.LUMA_FIRST_OPERATOR_ID)
    : null;
  const credential = Array.isArray(operator?.credentials)
    ? operator.credentials.find((candidate) => candidate?.type === 'password')
    : null;
  if (typeof credential?.value !== 'string' || credential.value.length < 24) {
    throw new Error('production identity bootstrap has no usable first operator password');
  }
  // The Keycloak client and the first operator's ID are generated once and
  // never change. The domain and owner email are the owner's own inputs
  // (identityCorrections). Luma's realm policy may change in a release, and
  // setup then rewrites the file with it.
  const inputs = (realm) => {
    const client = Array.isArray(realm?.clients) ? realm.clients[0] : null;
    const user = Array.isArray(realm?.users) ? realm.users[0] : null;
    return [realm?.realm, client?.clientId, client?.secret, user?.id];
  };
  if (!isDeepStrictEqual(inputs(existing), inputs(productionRealm(values, credential.value)))) {
    throw new Error(`${path.join(PRODUCTION_DIR, 'realm.json')} and ${ENV_FILE} name a different Keycloak client ` +
      'or first operator, so they come from different setups; restore both from one backup ' +
      '(README "Back up and restore")');
  }
  return credential.value;
}

function realmOrigin(realm) {
  const origins = Array.isArray(realm?.clients) ? realm.clients[0]?.webOrigins : null;
  return Array.isArray(origins) && origins.length === 1 && typeof origins[0] === 'string' ? origins[0] : '';
}

function realmOwnerEmail(realm) {
  const email = Array.isArray(realm?.users) ? realm.users[0]?.email : null;
  return typeof email === 'string' ? email : '';
}

// The owner's own inputs that the realm file carries: the public domain (the
// Center client's origin) and the first operator's email.
function identityCorrections(existing, origin, email) {
  const corrections = [];
  const previousOrigin = realmOrigin(existing);
  if (previousOrigin !== origin) {
    let previous = previousOrigin;
    try { previous = new URL(previousOrigin).hostname; } catch { /* keep the raw value */ }
    corrections.push({ label: 'public domain', option: '--domain', previous, next: new URL(origin).hostname });
  }
  const previousEmail = realmOwnerEmail(existing);
  if (previousEmail !== email) {
    corrections.push({ label: 'owner email', option: '--operator-email', previous: previousEmail, next: email });
  }
  return corrections;
}

// Keycloak imports realm.json once, when the first deploy creates its database
// in the production PostgreSQL volume (`cosmos-pgdata`, under any project
// name). Until that volume exists the domain and owner are only files setup
// wrote, so setup may still correct them.
function productionDatabaseVolumes() {
  const docker = resolveTool('docker', { required: false });
  if (!docker) return [];
  const result = child.spawnSync(docker, [
    'volume', 'ls', '--quiet', '--filter', 'label=com.docker.compose.volume=cosmos-pgdata',
  ], {
    encoding: 'utf8',
    env: operatorEnvironment({}, { lumaDockerConfig: false }),
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').split(/\r?\n/u)
      .map((line) => line.trim()).find(Boolean) || `exit ${result.status}`;
    throw new Error(`Docker could not list this server's volumes: ${detail}`);
  }
  return result.stdout.split(/\s+/u).filter(Boolean);
}

function assertIdentityCorrectable(corrections, listVolumes) {
  const changed = corrections.map(({ label, previous, next }) => `the ${label} (${previous} → ${next})`).join(' and ');
  const keep = corrections.map(({ option, previous }) => `${option} ${previous}`).join(' ');
  const keepAdvice = `Nothing was changed. To keep the current values, rerun setup without ${
    corrections.map(({ option }) => option).join(' or ')} (or with ${keep}).`;
  let volumes;
  try {
    volumes = listVolumes();
  } catch (error) {
    throw new Error(`setup would change ${changed}, which is safe only before the first deploy, but ${error.message}. ` +
      `Start Docker (or add your account to the docker group) and rerun setup. ${keepAdvice}`);
  }
  if (volumes.length > 0) {
    throw new Error(`setup would change ${changed}, but this server has already been deployed ` +
      `(Docker volume ${volumes.join(', ')}), so its Keycloak holds the current values. Changing the domain or ` +
      `owner email of a deployed server is not supported yet. ${keepAdvice}`);
  }
}

function renderTemplate(source, replacements, output) {
  let contents = fs.readFileSync(source, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    if (!contents.includes(token)) throw new Error(`template is missing ${token}: ${source}`);
    if (typeof value !== 'string' || !value) throw new Error(`template value for ${token} is empty: ${source}`);
    // Every token sits inside a double-quoted YAML scalar.
    if (/["\\\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`template value for ${token} cannot be quoted safely: ${source}`);
    }
    // A replacer function inserts the value literally. A replacement string
    // would expand `$'` or `$&`, which a valid ACME email may contain.
    contents = contents.replaceAll(token, () => value);
  }
  if (/@@[A-Z_]+@@/u.test(contents)) throw new Error(`template has unresolved values: ${source}`);
  atomicWrite(output, contents, 0o444);
}

// Setup and every confirmed deploy render the edge, and the operator Compose
// overlay that mounts it, from this release's templates and the saved runtime
// values, so an upgrade applies edge fixes, including a changed or new mount.
// `pinRelease` is this operator release's Pin binding (null in a source checkout).
function renderOperatorConfig(values, pinRelease) {
  const profiles = (values.COMPOSE_PROFILES || '').split(',').filter(Boolean);
  const extraNetworks = traefikExtraNetworks(values);
  const edge = path.join(ROOT, 'platform', 'edge');
  renderTemplate(
    path.join(edge, 'traefik', 'traefik.yaml.tpl'),
    { '@@ACME_EMAIL@@': values.LUMA_ACME_EMAIL }, path.join(PRODUCTION_DIR, 'traefik.yaml'),
  );
  renderTemplate(
    path.join(edge, 'traefik', 'dynamic.yaml.tpl'),
    { '@@PUBLIC_DOMAIN@@': values.LUMA_PUBLIC_DOMAIN }, path.join(PRODUCTION_DIR, 'traefik-dynamic.yaml'),
  );
  if (profiles.includes('pin')) {
    renderTemplate(
      path.join(edge, 'envoy', 'envoy.yaml.tpl'),
      { '@@EDGE_TOKEN@@': values.COSMOS_EDGE_TOKEN, '@@CERT_DIR@@': '/etc/cosmos-edge/certs' },
      path.join(PRODUCTION_DIR, 'envoy.yaml'),
    );
  }
  renderOperatorCompose(profiles, pinRelease, extraNetworks);
}

// LUMA_TRAEFIK_EXTRA_NETWORKS: existing external Docker networks Traefik joins
// so the owner's extra routes can reach services outside Luma.
function traefikExtraNetworks(values) {
  const raw = values.LUMA_TRAEFIK_EXTRA_NETWORKS || '';
  if (!raw) return [];
  const names = raw.split(',');
  for (const [index, name] of names.entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)) {
      throw new Error(`LUMA_TRAEFIK_EXTRA_NETWORKS must be a comma-separated list of Docker network names; invalid entry: ${JSON.stringify(name)}`);
    }
    if (names.indexOf(name) !== index) {
      throw new Error(`LUMA_TRAEFIK_EXTRA_NETWORKS lists ${name} more than once`);
    }
    if (['host', 'none', 'bridge', 'default', ...LUMA_NETWORK_KEYS].includes(name) || name.startsWith('luma_')) {
      throw new Error(`LUMA_TRAEFIK_EXTRA_NETWORKS cannot name ${name}; it is a Docker or Luma network`);
    }
  }
  return names;
}

function isPresent(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extraCertificateSource(target) {
  const prefix = `${TRAEFIK_EXTRA_CERTS_TARGET}/`;
  if (typeof target !== 'string' || !target.startsWith(prefix)) return null;
  const segments = target.slice(prefix.length).split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment) || /^\.\.?$/u.test(segment))) return null;
  return path.join(TRAEFIK_EXTRA_CERTS_DIR, ...segments);
}

// JSON.parse keeps the last of two equal keys in one object, but Traefik's
// YAML decoder refuses the whole file. Returns the first repeated key's path
// in valid JSON text, or null.
function repeatedJsonKey(text) {
  const open = [];
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (expectKey) {
        const container = open.at(-1);
        container.key = JSON.parse(text.slice(index, end + 1));
        if (container.keys.has(container.key)) {
          return open.map((entry) => (entry.keys ? `.${entry.key}` : `[${entry.index}]`)).join('').replace(/^\./u, '');
        }
        container.keys.add(container.key);
        expectKey = false;
      }
      index = end;
    } else if (character === '{') {
      open.push({ keys: new Set(), key: '' });
      expectKey = true;
    } else if (character === '[') {
      open.push({ keys: null, index: 0 });
      expectKey = false;
    } else if (character === '}' || character === ']') {
      open.pop();
      expectKey = false;
    } else if (character === ',') {
      const container = open.at(-1);
      if (container.keys) expectKey = true;
      else container.index += 1;
    }
  }
  return null;
}

// Traefik loads every file in its dynamic directory as one configuration, and
// a file it cannot decode stops every route, including Center and the Pin.
// The owner file is therefore held to a small, closed schema before any
// render or recreate.
function validateTraefikExtra(values) {
  const problems = [];
  try { traefikExtraNetworks(values); } catch (error) { problems.push(error.message); }
  if (isPresent(TRAEFIK_EXTRA_CERTS_DIR)) validateReadableTree(TRAEFIK_EXTRA_CERTS_DIR, problems);
  const file = TRAEFIK_EXTRA_FILE;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return problems;
  const problem = (keyPath, message) => problems.push(`${file}: ${keyPath ? `${keyPath} ` : ''}${message}`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    problem('', 'must be a regular file, not a symbolic link');
    return problems;
  }
  if (![0o644, 0o444].includes(stat.mode & 0o777)) problem('', 'must have mode 0644 or 0444');
  if (stat.size > TRAEFIK_EXTRA_MAX_BYTES) {
    problem('', `must be at most ${TRAEFIK_EXTRA_MAX_BYTES / 1024} KiB`);
    return problems;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('{{')) problem('', 'must not contain "{{"; Traefik runs every dynamic file through Go templates');
  // Traefik decodes the file as YAML, which refuses JSON's `\/` escape. No
  // supported value needs an escape.
  if (text.includes('\\')) problem('', 'must not contain a backslash; write every value as plain text (Traefik refuses JSON escapes such as \\/)');
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const position = /at position \d+(?: \(line \d+ column \d+\))?/u.exec(error.message)?.[0];
    problem('', `is not valid JSON${position ? ` (${position})` : ''}`);
    return problems;
  }
  if (!isPlainObject(document)) {
    problem('', 'must be a JSON object');
    return problems;
  }
  const repeated = repeatedJsonKey(text);
  if (repeated !== null) problem(repeated, 'is repeated in its object; Traefik refuses a file that repeats a key');
  const onlyKeys = (value, keyPath, allowed) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) problem(keyPath ? `${keyPath}.${key}` : key, 'is not supported');
    }
  };
  onlyKeys(document, '', ['http', 'tls']);

  const services = new Set();
  const { http, tls } = document;
  if (http !== undefined && !isPlainObject(http)) problem('http', 'must be an object');
  // Traefik refuses the whole file when one of these sections is empty.
  const emptySection = 'must not be empty; remove it instead';
  if (isPlainObject(http)) {
    onlyKeys(http, 'http', ['routers', 'services']);
    if (!Object.keys(http).length) problem('http', emptySection);
    for (const [section, entries] of [['services', http.services], ['routers', http.routers]]) {
      if (entries !== undefined && !isPlainObject(entries)) problem(`http.${section}`, 'must be an object');
      else if (isPlainObject(entries) && !Object.keys(entries).length) problem(`http.${section}`, emptySection);
    }
    for (const [name, service] of Object.entries(isPlainObject(http.services) ? http.services : {})) {
      const at = `http.services.${name}`;
      services.add(name);
      if (!TRAEFIK_EXTRA_NAME.test(name)) problem(at, 'must be named extra-<lowercase letters, digits, hyphens>');
      const balancer = isPlainObject(service) && Object.keys(service).length === 1 ? service.loadBalancer : null;
      if (!isPlainObject(balancer)) {
        problem(at, 'must be exactly {"loadBalancer": {"servers": [{"url": "..."}]}}');
        continue;
      }
      onlyKeys(balancer, `${at}.loadBalancer`, ['servers', 'passHostHeader']);
      if (balancer.passHostHeader !== undefined && typeof balancer.passHostHeader !== 'boolean') {
        problem(`${at}.loadBalancer.passHostHeader`, 'must be true or false');
      }
      if (!Array.isArray(balancer.servers) || balancer.servers.length < 1 || balancer.servers.length > 8) {
        problem(`${at}.loadBalancer.servers`, 'must list 1 to 8 servers');
        continue;
      }
      for (const [index, server] of balancer.servers.entries()) {
        const serverAt = `${at}.loadBalancer.servers[${index}]`;
        if (!isPlainObject(server) || Object.keys(server).join() !== 'url') {
          problem(serverAt, 'must be exactly {"url": "..."}');
          continue;
        }
        const upstream = /^(?:https?|h2c):\/\/([A-Za-z0-9._-]+)(?::([0-9]{1,5}))?$/u.exec(server.url);
        if (typeof server.url !== 'string' || !upstream ||
            (upstream[2] && (Number(upstream[2]) < 1 || Number(upstream[2]) > 65535))) {
          problem(`${serverAt}.url`, 'must be http://, https://, or h2c:// with a host and optional port, and no path');
        } else if (lumaServiceHost(upstream[1])) {
          problem(`${serverAt}.url`,
            `must not target ${upstream[1]}, which is Luma's own service; Luma routes its services itself`);
        }
      }
    }
    const reserved = new Set([values.LUMA_PUBLIC_DOMAIN, ...TRAEFIK_LUMA_HOSTS]);
    for (const [name, router] of Object.entries(isPlainObject(http.routers) ? http.routers : {})) {
      const at = `http.routers.${name}`;
      if (!TRAEFIK_EXTRA_NAME.test(name)) problem(at, 'must be named extra-<lowercase letters, digits, hyphens>');
      if (!isPlainObject(router)) {
        problem(at, 'must be an object');
        continue;
      }
      onlyKeys(router, at, ['entryPoints', 'rule', 'service', 'priority', 'tls']);
      if (!isDeepStrictEqual(router.entryPoints, ['websecure'])) problem(`${at}.entryPoints`, 'must be exactly ["websecure"]');
      const hosts = typeof router.rule === 'string'
        ? router.rule.split('||').map((part) => /^\s*Host\(`([^`]*)`\)\s*$/u.exec(part)?.[1])
        : [undefined];
      if (hosts.includes(undefined)) {
        problem(`${at}.rule`, 'must be Host(`name`) or several joined by ||');
      } else {
        for (const host of hosts) {
          if (!validProductionDomain(host)) problem(`${at}.rule`, `names an invalid host: ${host}`);
          else if (reserved.has(host)) problem(`${at}.rule`, `must not claim ${host}, which Luma serves`);
        }
      }
      if (typeof router.service !== 'string' || !services.has(router.service)) {
        problem(`${at}.service`, 'must name a service in this file');
      }
      if (router.priority !== undefined &&
          (!Number.isInteger(router.priority) || router.priority < 1 || router.priority > 1000)) {
        problem(`${at}.priority`, 'must be an integer from 1 to 1000');
      }
      if (!isDeepStrictEqual(router.tls, {}) && !isDeepStrictEqual(router.tls, { certResolver: 'letsencrypt' })) {
        problem(`${at}.tls`, 'must be {} or {"certResolver": "letsencrypt"}');
      }
    }
  }
  if (tls !== undefined && !isPlainObject(tls)) problem('tls', 'must be an object');
  if (isPlainObject(tls)) {
    onlyKeys(tls, 'tls', ['certificates']);
    if (!Array.isArray(tls.certificates) || tls.certificates.length < 1 || tls.certificates.length > 32) {
      problem('tls.certificates', 'must list 1 to 32 certificates');
    } else {
      for (const [index, certificate] of tls.certificates.entries()) {
        const at = `tls.certificates[${index}]`;
        if (!isPlainObject(certificate) || Object.keys(certificate).sort().join() !== 'certFile,keyFile') {
          problem(at, 'must be exactly {"certFile": "...", "keyFile": "..."}');
          continue;
        }
        for (const key of ['certFile', 'keyFile']) {
          const source = extraCertificateSource(certificate[key]);
          if (!source) {
            problem(`${at}.${key}`, `must be a file under ${TRAEFIK_EXTRA_CERTS_TARGET}/ without . or .. segments`);
          } else if (!regularFile(source, { mode: 0o444 })) {
            problem(`${at}.${key}`, `must map to a nonempty regular mode-0444 file: ${source}`);
          }
        }
      }
    }
  }
  return problems;
}

function readableTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const selected = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) readableTree(selected);
    else if (entry.isFile() && !entry.isSymbolicLink()) fs.chmodSync(selected, 0o444);
    else throw new Error(`container input has an unsupported entry: ${selected}`);
  }
  fs.chmodSync(directory, 0o755);
}

// Outside Swarm, Compose bind-mounts a file secret and ignores its `mode`,
// `uid`, and `gid`, with a warning each time it creates a container. The
// container sees the host file's own mode, which setup writes and checks as 0444
// (validateProductionArtifacts), so the secrets here carry no `mode`.
function renderOperatorCompose(profiles, expectedPinRelease = null, extraNetworks = []) {
  const enabled = new Set(profiles);
  const pinReleases = path.join(DATA_DIR, 'pin-releases');
  const traefik = [
    '  traefik:',
    '    secrets:',
    '      - { source: traefik_static, target: /etc/traefik/traefik.yml }',
    '      - { source: traefik_dynamic, target: /etc/traefik/dynamic/10-luma.yaml }',
  ];
  const secrets = [
    `  identity_realm: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'realm.json'))} }`,
    `  traefik_static: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'traefik.yaml'))} }`,
    `  traefik_dynamic: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'traefik-dynamic.yaml'))} }`,
  ];
  const networks = [];
  // Directory mode loads only .yaml, .yml, and .toml files. JSON is YAML.
  if (fs.lstatSync(TRAEFIK_EXTRA_FILE, { throwIfNoEntry: false })?.isFile()) {
    traefik.push('      - { source: traefik_extra, target: /etc/traefik/dynamic/20-extra.yaml }');
    secrets.push(`  traefik_extra: { file: ${safeYaml(TRAEFIK_EXTRA_FILE)} }`);
  }
  if (fs.lstatSync(TRAEFIK_EXTRA_CERTS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    traefik.push(`    volumes:
      - type: bind
        source: ${safeYaml(TRAEFIK_EXTRA_CERTS_DIR)}
        target: ${TRAEFIK_EXTRA_CERTS_TARGET}
        read_only: true
        bind: { create_host_path: false }`);
  }
  if (extraNetworks.length) {
    // public-edge keeps the default route when Traefik joins more networks.
    traefik.push('    networks:', '      public-edge: { gw_priority: 1 }',
      ...extraNetworks.map((name) => `      ${JSON.stringify(name)}: {}`));
    networks.push(...extraNetworks.map((name) =>
      `  ${JSON.stringify(name)}: { name: ${JSON.stringify(name)}, external: true }`));
  }
  const services = [
    `  postgres:
    volumes:
      - type: bind
        source: ${safeYaml(path.join(PRODUCTION_DIR, 'postgres-init.sql'))}
        target: /docker-entrypoint-initdb.d/10-keycloak.sql
        read_only: true
        bind: { create_host_path: false }`,
    `  keycloak:
    secrets:
      - { source: identity_realm, target: /opt/keycloak/data/import/realm.json }`,
    traefik.join('\n'),
  ];
  const centerEnvironment = [];
  const centerSecrets = [];
  const centerVolumes = [];

  if (enabled.has('pin')) {
    if (!expectedPinRelease) throw new Error('the pin profile requires an expected release binding');
    services.push(
      `  ai-bus:
    environment:
      COSMOS_ATTEST_CA_CERT: /etc/cosmos-attest/ca.crt
      COSMOS_ATTEST_CA_KEY: /etc/cosmos-attest/ca.key
      COSMOS_ATTEST_ROOT_CERT: /etc/cosmos-attest/root.crt
      COSMOS_DEVICE_STATUS_CA_CERT: /etc/cosmos-attest/ca.crt
      COSMOS_ONBOARDING_ENDPOINT: \${COSMOS_ONBOARDING_ENDPOINT:?run luma setup production}
    secrets:
      - { source: attestation_ca_cert, target: /etc/cosmos-attest/ca.crt }
      - { source: attestation_ca_key, target: /etc/cosmos-attest/ca.key }
      - { source: edge_ca_cert, target: /etc/cosmos-attest/root.crt }`,
      `  provisioning:
    secrets:
      - { source: duc_ca_cert, target: /etc/cosmos-duc/duc-ca.crt }
      - { source: duc_ca_key, target: /etc/cosmos-duc/duc-ca.key }`,
      `  edge:
    secrets:
      - { source: envoy_config, target: /etc/cosmos-edge/envoy.yaml }
      - { source: edge_server_cert, target: /etc/cosmos-edge/certs/server.crt }
      - { source: edge_server_key, target: /etc/cosmos-edge/certs/server.key }
      - { source: duc_ca_cert, target: /etc/cosmos-edge/certs/api-client-ca.crt }
      - { source: attestation_ca_cert, target: /etc/cosmos-edge/certs/onboarding-client-ca.crt }`,
    );
    for (const [name, file] of [
      ['edge_ca_cert', EDGE_ROOT.certificate],
      ['attestation_ca_cert', path.join(PRODUCTION_DIR, 'attestation-ca.crt')],
      ['attestation_ca_key', path.join(PRODUCTION_DIR, 'attestation-ca.key')],
      ['duc_ca_cert', DEVICE_USER_ROOT.certificate],
      ['duc_ca_key', DEVICE_USER_ROOT.key],
      ['envoy_config', path.join(PRODUCTION_DIR, 'envoy.yaml')],
      ['edge_server_cert', path.join(PRODUCTION_DIR, 'edge-server.crt')],
      ['edge_server_key', path.join(PRODUCTION_DIR, 'edge-server.key')],
    ]) secrets.push(`  ${name}: { file: ${safeYaml(file)} }`);
    centerEnvironment.push(
      '      LUMA_PIN_RELEASE_DIR: /var/lib/luma/pin-releases',
      '      LUMA_PIN_SETUP_ORIGIN: ${LUMA_PUBLIC_ORIGIN:?run luma setup production}',
      '      LUMA_DEVICE_EDGE_IPV4: ${LUMA_DEVICE_EDGE_IPV4:?run luma setup production}',
      `      LUMA_PIN_RELEASE_EXPECTED_ID: ${JSON.stringify(expectedPinRelease.releaseId)}`,
      `      LUMA_PIN_RELEASE_EXPECTED_MANIFEST_SHA256: ${JSON.stringify(expectedPinRelease.manifestSha256)}`,
    );
    centerVolumes.push(`      - type: bind
        source: ${safeYaml(pinReleases)}
        target: /var/lib/luma/pin-releases
        read_only: true
        bind: { create_host_path: false }`);
  }
  if (enabled.has('pin')) {
    services.push(
      `  center-iroh-bridge:
    secrets:
      - { source: pin_bridge_control_token, target: /run/secrets/pin_bridge_control_token }`,
    );
    secrets.push(`  pin_bridge_control_token: { file: ${safeYaml(PIN_BRIDGE_TOKEN_FILE)} }`);
    centerEnvironment.push(
      '      LUMA_PIN_BRIDGE_URL: http://center-iroh-bridge:18080',
      '      LUMA_PIN_BRIDGE_TOKEN_FILE: /run/secrets/pin_bridge_control_token',
    );
    centerSecrets.push('      - { source: pin_bridge_control_token, target: /run/secrets/pin_bridge_control_token }');
  }
  if (enabled.has('spotify')) {
    services.push(
      `  spotify-adapter:
    secrets:
      - { source: spotify_adapter_token, target: /run/secrets/spotify_adapter_token }`,
    );
    secrets.push(`  spotify_adapter_token: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'spotify-token'))} }`);
    centerEnvironment.push(
      '      LUMA_SPOTIFY_ADAPTER_URL: http://spotify-adapter:18081',
      '      LUMA_SPOTIFY_ADAPTER_TOKEN_FILE: /run/secrets/spotify_adapter_token',
    );
    centerSecrets.push('      - { source: spotify_adapter_token, target: /run/secrets/spotify_adapter_token }');
  }
  // The update status `./luma update production` writes for Center, and the
  // request directory a Center's Install now button drops its marker into,
  // which the luma-update-request.path unit turns into an update run. The
  // mount never creates its source, so the directories are made here, before
  // every deploy that could start Center (a restore onto a fresh host
  // included).
  ensureUpdatesDirectory();
  ensureRequestsDirectory();
  centerEnvironment.push('      LUMA_UPDATE_STATUS_FILE: /luma-updates/status.json');
  centerVolumes.push(`      - type: bind
        source: ${safeYaml(UPDATES_DIR)}
        target: /luma-updates
        read_only: true
        bind: { create_host_path: false }`);
  centerEnvironment.push('      LUMA_UPDATE_REQUESTS_DIR: /luma-update-requests');
  centerVolumes.push(`      - type: bind
        source: ${safeYaml(REQUESTS_DIR)}
        target: /luma-update-requests
        bind: { create_host_path: false }`);
  if (centerEnvironment.length || centerVolumes.length || centerSecrets.length) {
    services.push([
      '  center:',
      ...(centerEnvironment.length ? ['    environment:', ...centerEnvironment] : []),
      ...(centerVolumes.length ? ['    volumes:', ...centerVolumes] : []),
      ...(centerSecrets.length ? ['    secrets:', ...centerSecrets] : []),
    ].join('\n'));
  }
  if (enabled.has('search')) {
    services.push(`  searxng:
    secrets:
      - { source: searxng_settings, target: /etc/searxng/settings.yml }`);
    secrets.push(`  searxng_settings: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'searxng-settings.yml'))} }`);
  }
  if (enabled.has('observability')) {
    services.push(
      `  prometheus:
    secrets:
      - { source: prometheus_config, target: /etc/prometheus/prometheus.yml }`,
      `  grafana:
    volumes:
      - type: bind
        source: ${safeYaml(path.join(PRODUCTION_DIR, 'grafana', 'provisioning'))}
        target: /etc/grafana/provisioning
        read_only: true
        bind: { create_host_path: false }
      - type: bind
        source: ${safeYaml(path.join(PRODUCTION_DIR, 'grafana', 'dashboards'))}
        target: /etc/grafana/dashboards
        read_only: true
        bind: { create_host_path: false }`,
    );
    secrets.push(`  prometheus_config: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'prometheus.yml'))} }`);
  }
  atomicWrite(OPERATOR_COMPOSE, [
    '# Generated local overlay for the digest-pinned OCI Compose application.',
    'services:', ...services, 'secrets:', ...secrets,
    ...(networks.length ? ['networks:', ...networks] : []), '',
  ].join('\n'));
}

function validateReadableTree(directory, problems) {
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
    problems.push(`${directory} must be a real directory`);
    return;
  }
  if ((fs.statSync(directory).mode & 0o777) !== 0o755) problems.push(`${directory} must have mode 0755`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const selected = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) validateReadableTree(selected, problems);
    else if (!entry.isFile() || entry.isSymbolicLink() || (fs.statSync(selected).mode & 0o777) !== 0o444) {
      problems.push(`${selected} must be a regular file with mode 0444`);
    }
  }
}

function acquireBundledPinRelease(archive = null) {
  const release = versionInfo();
  if (!release.pin) {
    throw new Error('the pin production profile is not bound to an exact Pin release');
  }
  const existing = child.spawnSync(process.execPath, [PIN_RELEASE_ACQUIRE_TOOL, '--check', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 180_000,
  });
  if (!existing.error && existing.status === 0) {
    if (archive) {
      info(`Pin release ${release.pin.version} is already staged or active; --pin-release-archive was not needed and ${archive} was not read.`);
    }
    return JSON.parse(existing.stdout);
  }
  const existingProblem = existing.stderr?.trim() || existing.error?.message || '';
  if (!/matching Pin release is neither active nor staged/u.test(existingProblem)) {
    throw new Error(`matching Pin release validation failed before production setup: ${existingProblem}`);
  }
  const result = child.spawnSync(
    process.execPath,
    [PIN_RELEASE_ACQUIRE_TOOL, ...(archive ? ['--archive', archive] : []), '--json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 180_000,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || 'unknown acquisition error';
    // Without an archive, setup verifies the GitHub release's signed
    // SHA256SUMS with the committed public key and downloads the asset. A
    // release published without that signature, or one the token cannot
    // read, has nothing it can verify.
    throw new Error(`matching Pin release acquisition failed before production setup: ${detail}` + (archive ? '' :
      `\nfix: this release's Pin archive could not be verified and downloaded from GitHub (no signed ` +
      'SHA256SUMS on that release, or the token cannot read it). Rerun setup with ' +
      `--pin-release-archive /path/to/${release.pin.archive}, the Pin archive delivered with this release ` +
      '(README "Get Luma"); no configuration was written.'));
  }
  return JSON.parse(result.stdout);
}

function checkBundledPinRelease() {
  const release = versionInfo();
  if (!release.pin) {
    throw new Error('the pin production profile is not bound to an exact Pin release');
  }
  const result = child.spawnSync(process.execPath, [PIN_RELEASE_ACQUIRE_TOOL, '--check', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || 'unknown validation error';
    throw new Error(`matching Pin release is not ready: ${detail}`);
  }
  const observed = JSON.parse(result.stdout);
  if (observed.compatible !== true || !pinReleaseIdentityMatches(release.pin, observed)) {
    throw new Error('matching Pin release check returned an incompatible identity');
  }
  return Object.freeze(observed);
}

function activeArtifactFiles(values) {
  const profiles = new Set((values.COMPOSE_PROFILES || '').split(',').filter(Boolean));
  return [
    OPERATOR_COMPOSE,
    path.join(PRODUCTION_DIR, 'realm.json'),
    path.join(PRODUCTION_DIR, 'traefik.yaml'),
    path.join(PRODUCTION_DIR, 'traefik-dynamic.yaml'),
    path.join(PRODUCTION_DIR, 'postgres-init.sql'),
    ...(profiles.has('pin') ? [
      PIN_TRUST_FILE,
      EDGE_ROOT.certificate, EDGE_ROOT.key,
      DEVICE_USER_ROOT.certificate, DEVICE_USER_ROOT.key,
      ...['edge-server.crt', 'edge-server.key', 'attestation-ca.crt', 'attestation-ca.key', 'envoy.yaml']
        .map((name) => path.join(PRODUCTION_DIR, name)),
    ] : []),
    ...(profiles.has('pin') ? [
      PIN_BRIDGE_TOKEN_FILE,
    ] : []),
    ...(profiles.has('spotify') ? [
      path.join(PRODUCTION_DIR, 'spotify-token'),
    ] : []),
    ...(profiles.has('search') ? [path.join(PRODUCTION_DIR, 'searxng-settings.yml')] : []),
    ...(profiles.has('observability') ? [path.join(PRODUCTION_DIR, 'prometheus.yml')] : []),
  ];
}

function productionArtifacts(values = parseEnvFile(ENV_FILE)) {
  return activeArtifactFiles(values);
}

// A restore swaps each tree in with two renames and moves the tree it replaces
// to the one fixed name `<tree>.previous`, then deletes it. A leftover copy
// means that restore was interrupted, and what to do depends on where:
// between the renames the tree itself is missing and the copy is the real
// one. After both, the restored tree is in place and the copy is the old one.
function interruptedRestoreProblems() {
  const problems = [];
  for (const tree of [PRODUCTION_DIR, path.join(DATA_DIR, 'pin-releases')]) {
    const replaced = `${tree}.previous`;
    if (!fs.lstatSync(replaced, { throwIfNoEntry: false })) continue;
    problems.push(fs.lstatSync(tree, { throwIfNoEntry: false })
      ? `an interrupted restore replaced ${tree} but left the copy it replaced at ${replaced}; ` +
        `delete that copy with rm -rf ${replaced}, then rerun the restore (it stopped before the rest of the server)`
      : `an interrupted restore moved ${tree} to ${replaced} before putting the restored copy in place; ` +
        `move it back with mv ${replaced} ${tree}`);
  }
  return problems;
}

// `ownerExtras: false` leaves the owner's Traefik extras to the caller, which
// reports them with their own fix (`config check`).
function validateProductionArtifacts(values = parseEnvFile(ENV_FILE), { ownerExtras = true } = {}) {
  const problems = [...interruptedRestoreProblems()];
  if (!fs.existsSync(PRODUCTION_DIR) || fs.lstatSync(PRODUCTION_DIR).isSymbolicLink() ||
      !fs.statSync(PRODUCTION_DIR).isDirectory() || (fs.statSync(PRODUCTION_DIR).mode & 0o777) !== 0o700) {
    problems.push(`${PRODUCTION_DIR} must be a real directory with mode 0700`);
  }
  for (const file of activeArtifactFiles(values)) {
    const expectedMode = file === OPERATOR_COMPOSE ? 0o600 : 0o444;
    if (!regularFile(file, { mode: expectedMode })) {
      problems.push(`${file} must be a nonempty regular file with mode ${expectedMode.toString(8).padStart(4, '0')}`);
    }
  }
  const firstLogin = path.join(PRODUCTION_DIR, 'first-login.txt');
  if (fs.existsSync(firstLogin) && !regularFile(firstLogin, { mode: 0o600 })) {
    problems.push(`${firstLogin} must be a nonempty regular file with mode 0600, or be deleted after first login`);
  }
  const profiles = new Set((values.COMPOSE_PROFILES || '').split(',').filter(Boolean));
  let pinRelease = null;
  if (profiles.has('pin') && !problems.some((problem) => /(?:\.crt|\.key|envoy\.yaml)/u.test(problem))) {
    try { validatePki(); } catch (error) { problems.push(error.message); }
    const releases = path.join(DATA_DIR, 'pin-releases');
    try { pinRelease = checkBundledPinRelease(); } catch (error) { problems.push(error.message); }
    if (fs.existsSync(releases)) validateReadableTree(releases, problems);
  }
  if (profiles.has('observability')) {
    validateReadableTree(path.join(PRODUCTION_DIR, 'grafana', 'provisioning'), problems);
    validateReadableTree(path.join(PRODUCTION_DIR, 'grafana', 'dashboards'), problems);
  }
  if (ownerExtras) problems.push(...validateTraefikExtra(values));
  if (problems.length) throw new Error(`production artifacts are not ready:\n- ${problems.join('\n- ')}`);
  return Object.freeze({
    operatorCompose: OPERATOR_COMPOSE,
    files: productionArtifacts(values),
    pinRequired: profiles.has('pin'),
    pinRelease,
  });
}

// Setup moves the configuration to the release it runs from, so an older
// operator folder would silently roll the server back on the next deploy.
// Restore, the supported way back, writes the older configuration itself.
function assertNotOlderRelease(values, release) {
  if (release.revision === 'source') return;
  const configured = values.LUMA_RELEASE_VERSION || '';
  if (compareReleaseVersions(configured, release.version) !== 1) return;
  throw new Error(`this is the Luma ${release.version} operator, but this server is configured for ` +
    `${describeRelease(values.LUMA_RELEASE_ID, configured)}. Run ./luma from that folder ` +
    '(README "Run your server"); nothing was changed. To return this server to Luma ' +
    `${release.version}, restore the backup taken before the update (README "Back up and restore").`);
}

function setupProduction(args, runtime = {}) {
  const before = regularFile(ENV_FILE, { mode: 0o600 }) ? parseEnvFile(ENV_FILE) : {};
  const options = parseOptions([...args], before);
  const operatorRelease = versionInfo();
  assertNotOlderRelease(before, operatorRelease);
  const realmFile = path.join(PRODUCTION_DIR, 'realm.json');
  let existingRealm = null;
  if (fs.existsSync(realmFile)) {
    try { existingRealm = JSON.parse(fs.readFileSync(realmFile, 'utf8')); } catch { existingRealm = null; }
  }
  // A domain or owner email typed wrong can be corrected by rerunning setup
  // until Keycloak has imported the realm. Refuse before anything is written.
  const corrections = existingRealm
    ? identityCorrections(existingRealm, `https://${options.domain}`, options.operatorEmail) : [];
  if (corrections.length) {
    assertIdentityCorrectable(corrections, runtime.productionDatabaseVolumes ?? productionDatabaseVolumes);
  }
  // The public address is resolved before any network side effect or write,
  // so a failed detection ends setup with the reason and nothing changed.
  const network = {
    ...(runtime.fetchText ? { fetchText: runtime.fetchText } : {}),
    ...(runtime.routeAddress ? { routeAddress: runtime.routeAddress } : {}),
  };
  if (options.publicIpv4 === 'auto' || (options.duckDnsSubdomain && !options.publicIpv4)) {
    const detected = detectPublicIpv4(network);
    if (!detected.address) {
      throw new Error(`could not detect this server's public IPv4: ${detected.reason}; pass --public-ip IPV4 instead`);
    }
    if (options.publicIpv4 === 'auto') options.publicIpv4 = detected.address;
    options.duckDnsIpv4 = detected.address;
  } else if (options.duckDnsSubdomain) {
    options.duckDnsIpv4 = options.publicIpv4;
  }
  // One update command serves every server (README "Update Luma"): without
  // the pin profile the Pin archive is not needed, so it is not read.
  const pinReleaseArchive = options.profiles.includes('pin')
    ? validatePinReleaseArchiveInput(options.pinReleaseArchive) : null;
  if (options.pinReleaseArchive && !pinReleaseArchive) {
    info(`The pin profile is off, so --pin-release-archive was not needed and ${options.pinReleaseArchive} was not read.`);
  }
  if (options.profiles.includes('pin') &&
      (!operatorRelease.pin || !operatorRelease.source || !operatorRelease.application ||
       operatorRelease.revision === 'source')) {
    throw new Error(
      'setup production with the pin profile must run from an extracted operator release ' +
      '(luma-operator-VERSION/, README "Get Luma"), not a source checkout: only a release is bound to one exact Pin archive',
    );
  }
  // The DuckDNS record is the one remote side effect, made once after every
  // local check passed and before anything is written. The token comes from
  // stdin (hidden at a terminal, piped otherwise) and is used, not kept.
  if (options.duckDnsSubdomain) {
    const token = (runtime.secretFromStdin ?? secretFromStdin)('the DuckDNS token');
    registerDuckDns({ subdomain: options.duckDnsSubdomain, token, ipv4: options.duckDnsIpv4, ...network });
    info(`${options.domain} now points at ${options.duckDnsIpv4}.`);
  }
  // Acquisition is allowed to populate only the managed release staging root.
  // It must finish before initialize advances the persisted operator revision
  // and application, so a rejected mixed or unavailable release cannot leave
  // production configuration claiming an update that never closed.
  if (options.profiles.includes('pin')) {
    prepareManagedRoots();
    acquireBundledPinRelease(pinReleaseArchive);
  }
  initialize({ suppressDeviceCaWarning: true, quiet: true, profiles: options.profiles, localIdentity: false });
  const initialized = parseEnvFile(ENV_FILE);
  const origin = `https://${options.domain}`;
  const pin = options.profiles.includes('pin');
  const updates = {
    COSMOS_AUTH_MODE: 'edge-authenticated',
    LUMA_IDENTITY_ENABLED: 'true',
    LUMA_PUBLIC_DOMAIN: options.domain,
    LUMA_PUBLIC_ORIGIN: origin,
    LUMA_ACME_EMAIL: options.acmeEmail,
    COSMOS_OIDC_ISSUER: `${origin}/realms/humane`,
    COSMOS_CAPTURE_SHARE_BASE_URL: origin,
    COSMOS_CAPTURE_UPLOAD_BASE_URL: origin,
    LUMA_MUSIC_GATEWAY_ORIGIN: origin,
    COSMOS_ONBOARDING_ENDPOINT: pin ? 'https://onboarding.cosmos.humane.cloud' : '',
    COSMOS_OPERATOR_EMAILS: options.operatorEmail,
    LUMA_FIRST_OPERATOR_EMAIL: options.operatorEmail,
    LUMA_FIRST_OPERATOR_ID: initialized.LUMA_FIRST_OPERATOR_ID || crypto.randomUUID(),
    LUMA_DEVICE_EDGE_IPV4: pin ? options.publicIpv4 : '',
    COMPOSE_PROFILES: options.profiles.join(','),
    COSMOS_SEARXNG_BASE_URL: options.profiles.includes('search') ? 'http://searxng:8080' : '',
    LUMA_SPOTIFY_ADAPTER_URL: '',
    COSMOS_ENROLLMENT_USER_ID: pin
      ? (initialized.COSMOS_ENROLLMENT_USER_ID || initialized.LUMA_FIRST_OPERATOR_ID || '') : '',
    LUMA_UPDATE_SOURCE: options.updateSource,
    LUMA_AUTO_UPDATES: options.autoUpdates,
  };
  if (pin && !updates.COSMOS_ENROLLMENT_USER_ID) updates.COSMOS_ENROLLMENT_USER_ID = updates.LUMA_FIRST_OPERATOR_ID;
  const values = { ...initialized, ...updates };
  secureDirectory(PRODUCTION_DIR);

  const credentials = path.join(PRODUCTION_DIR, 'first-login.txt');
  const realmExists = fs.existsSync(realmFile);
  const updatedRuntime = removeEnvironmentValues(
    replaceEnvironmentValues(fs.readFileSync(ENV_FILE, 'utf8'), updates),
    ['LUMA_FIRST_OPERATOR_PASSWORD'],
  );
  if (!realmExists) atomicWrite(ENV_FILE, updatedRuntime);
  let password;
  if (realmExists) {
    password = assertExistingRealm(existingRealm, values);
    // A handoff written for the values being corrected belongs to this setup
    // too. It keeps its password and takes the corrected Center and owner.
    const handedOffPassword = readFirstLogin(credentials, corrections.length ? {
      LUMA_PUBLIC_ORIGIN: realmOrigin(existingRealm),
      LUMA_FIRST_OPERATOR_EMAIL: realmOwnerEmail(existingRealm),
    } : values);
    if (handedOffPassword && handedOffPassword !== password) {
      throw new Error(`first-login handoff does not match the generated realm: ${credentials}`);
    }
    atomicWrite(ENV_FILE, updatedRuntime);
    if (handedOffPassword && corrections.length) atomicWrite(credentials, firstLoginContents(values, password));
  } else {
    password = readFirstLogin(credentials, values) || crypto.randomBytes(24).toString('base64url');
    if (!fs.existsSync(credentials)) atomicWrite(credentials, firstLoginContents(values, password));
  }
  // Keycloak imports this file only when it creates the realm. Rewriting it
  // keeps the seed on this release's policy. Every confirmed deploy reconciles
  // the running realm (realm.js).
  atomicWrite(realmFile, `${JSON.stringify(productionRealm(values, password), null, 2)}\n`, 0o444);

  atomicWrite(path.join(PRODUCTION_DIR, 'postgres-init.sql'), 'CREATE DATABASE keycloak OWNER cosmos;\n', 0o444);

  let pinTrustRootCreated = false;
  if (pin) {
    if (!regularFile(PIN_BRIDGE_TOKEN_FILE)) {
      atomicWrite(PIN_BRIDGE_TOKEN_FILE, `${crypto.randomBytes(32).toString('base64url')}\n`, 0o444);
    }
    pinTrustRootCreated = ensureProductionPki().edgeCa.created;
    const releases = path.join(DATA_DIR, 'pin-releases');
    if (!fs.existsSync(releases)) {
      secureDirectory(releases);
    } else {
      const stat = fs.lstatSync(releases);
      if (stat.isSymbolicLink() || !stat.isDirectory() || ![0o700, 0o755].includes(stat.mode & 0o777)) {
        throw new Error(`Pin release store must be a real generated directory with mode 0700 or 0755: ${releases}`);
      }
    }
    readableTree(releases);
  }
  if (options.profiles.includes('spotify')) {
    const token = path.join(PRODUCTION_DIR, 'spotify-token');
    if (!regularFile(token)) atomicWrite(token, `${crypto.randomBytes(32).toString('base64url')}\n`, 0o444);
  }
  if (options.profiles.includes('search')) {
    atomicWrite(
      path.join(PRODUCTION_DIR, 'searxng-settings.yml'),
      fs.readFileSync(path.join(ROOT, 'cosmos', 'search', 'settings.yml')), 0o444,
    );
  }
  if (options.profiles.includes('observability')) {
    atomicWrite(
      path.join(PRODUCTION_DIR, 'prometheus.yml'),
      fs.readFileSync(path.join(ROOT, 'platform', 'containers', 'observability', 'prometheus.yml')), 0o444,
    );
    const grafana = path.join(PRODUCTION_DIR, 'grafana');
    if (fs.existsSync(grafana)) fs.rmSync(grafana, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'platform', 'containers', 'observability', 'grafana'), grafana, { recursive: true });
    readableTree(grafana);
  }
  renderOperatorConfig(values, operatorRelease.pin);
  validateProductionArtifacts(values);
  validateRuntime({ production: true });
  // The configuration is this release's now, so its folder is the operator
  // the update timers run.
  if (operatorRelease.revision !== 'source') pointCurrentOperator(ROOT);
  const automaticUpdates = (runtime.configureAutomaticUpdates ?? configureAutomaticUpdates)({
    enabled: options.autoUpdates === 'on',
  });
  return Object.freeze({
    origin,
    profiles: options.profiles,
    updateSource: options.updateSource,
    automaticUpdates,
    operatorCompose: OPERATOR_COMPOSE,
    credentials: regularFile(credentials, { mode: 0o600 }) ? credentials : null,
    pinTrustRoot: pin ? EDGE_ROOT.certificate : null,
    pinTrustRootCreated,
  });
}

const RESET_PASSWORD_USAGE = './luma reset-password production [--confirm] [--project-name NAME]';

/**
 * A new one-time password for the first operator, handed off the way setup
 * hands off the first one: in the mode-0600 first-login file, never on the
 * terminal. The realm seed takes the same password, so a later setup still
 * accepts the handoff. `admin` is Keycloak's admin CLI (realm.js).
 */
function resetFirstOperatorPassword({ admin, values = validateRuntime({ production: true }) }) {
  const realmFile = path.join(PRODUCTION_DIR, 'realm.json');
  const credentials = path.join(PRODUCTION_DIR, 'first-login.txt');
  if (!regularFile(realmFile) || !values.LUMA_FIRST_OPERATOR_EMAIL || !values.LUMA_PUBLIC_ORIGIN) {
    throw new Error('production identity is not set up on this host; run ./luma setup production first');
  }
  const password = crypto.randomBytes(24).toString('base64url');
  setAccountPassword(admin, { email: values.LUMA_FIRST_OPERATOR_EMAIL, password });
  atomicWrite(credentials, firstLoginContents(values, password));
  atomicWrite(realmFile, `${JSON.stringify(productionRealm(values, password), null, 2)}\n`, 0o444);
  return Object.freeze({
    email: values.LUMA_FIRST_OPERATOR_EMAIL,
    origin: values.LUMA_PUBLIC_ORIGIN,
    credentials,
  });
}

function resetPasswordCommand(args, { admin = null } = {}) {
  const [target, ...options] = args;
  let confirmed = false;
  let project = 'luma';
  const seen = new Set();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (target !== 'production' || seen.has(option)) fail(`usage: ${RESET_PASSWORD_USAGE}`, 64);
    seen.add(option);
    if (option === '--confirm') {
      confirmed = true;
    } else if (option === '--project-name' && /^[a-z0-9][a-z0-9_-]*$/u.test(options[index + 1] || '')) {
      project = options[index + 1];
      index += 1;
    } else {
      fail(`usage: ${RESET_PASSWORD_USAGE}`, 64);
    }
  }
  if (target !== 'production') fail(`usage: ${RESET_PASSWORD_USAGE}`, 64);
  let values;
  try {
    values = validateRuntime({ production: true });
  } catch (error) {
    fail(error.message);
  }
  const email = values.LUMA_FIRST_OPERATOR_EMAIL;
  const credentials = path.join(PRODUCTION_DIR, 'first-login.txt');
  if (!confirmed) {
    info(`This replaces the password of ${email || 'the first operator'} in this server's Keycloak, signs that account out everywhere, and writes a new one-time password to ${credentials}.`);
    info(`Nothing changed. Run ./luma reset-password production --confirm${project === 'luma' ? '' : ` --project-name ${project}`} to do it.`);
    return;
  }
  let result;
  try {
    result = resetFirstOperatorPassword({
      admin: admin || keycloakAdmin({ project, env: operatorEnvironment(values) }),
      values,
    });
  } catch (error) {
    fail(error.message);
  }
  info(`${result.email} has a new one-time password. Keycloak ended every earlier sign-in of that account; a browser already signed in to Center loses access within 15 minutes, when its current token expires.`);
  info(`First login: ${result.credentials} (show it once with cat, sign in at ${result.origin}/login, then delete the file).`);
  info('If Center already asked you to wait after wrong passwords, that wait still applies, for at most 15 minutes.');
  info('Change it to your own password in Settings → Passcode & password.');
}

module.exports = {
  assertNotOlderRelease,
  hasProductionSetupMarker,
  interruptedRestoreProblems,
  OPERATOR_COMPOSE,
  PIN_SERVER_NAMES,
  PRODUCTION_PROFILE_NAMES,
  PRODUCTION_DIR,
  parseOptions,
  productionArtifacts,
  productionRealm,
  renderOperatorConfig,
  resetFirstOperatorPassword,
  resetPasswordCommand,
  setupProduction,
  TRAEFIK_EXTRA_FILE,
  validProductionDomain,
  reservedExampleEmail,
  validProductionEmail,
  validateProductionArtifacts,
  validateTraefikExtra,
};
