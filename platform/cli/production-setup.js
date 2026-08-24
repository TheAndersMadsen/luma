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
  initialize,
  parseEnvFile,
  resolveTool,
  secureDirectory,
  validateRuntime,
} = require('./context');

const PRODUCTION_DIR = path.join(CONFIG_DIR, 'production');
const OPERATOR_COMPOSE = path.join(PRODUCTION_DIR, 'operator.compose.yaml');
const PROFILES = new Set(['pin', 'search', 'spotify', 'observability']);
const PIN_RELEASE_VALIDATOR = path.join(ROOT, 'platform', 'deploy', 'pin', 'validate-release-store.mjs');
const PIN_SERVER_NAMES = Object.freeze([
  'api.cosmos.humane.cloud',
  'api.clone.invalid',
  'eastus.cosmos.humane.cloud',
  'eastus-1.cosmos.humane.cloud',
  'onboarding.cosmos.humane.cloud',
  'onboarding.clone.invalid',
  'cosmos-edge',
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
    domain: current.REVIVAL_PUBLIC_DOMAIN || (() => {
      try { return new URL(current.REVIVAL_PUBLIC_ORIGIN || '').hostname; } catch { return ''; }
    })(),
    acmeEmail: current.REVIVAL_ACME_EMAIL || '',
    operatorEmail: current.REVIVAL_FIRST_OPERATOR_EMAIL || '',
    publicIpv4: current.REVIVAL_DEVICE_EDGE_IPV4 || '',
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
        throw new Error(`--profile must be one of: ${[...PROFILES].join(', ')}`);
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
    const fields = new Map([
      ['--domain', 'domain'],
      ['--acme-email', 'acmeEmail'],
      ['--operator-email', 'operatorEmail'],
      ['--public-ip', 'publicIpv4'],
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
  options.profiles = clearProfiles
    ? []
    : profilesSpecified
      ? [...selectedProfiles].sort()
      : (current.COMPOSE_PROFILES || '').split(',')
        .map((value) => value.trim()).filter((value) => PROFILES.has(value)).sort();

  const validDomain = options.domain.includes('.') && options.domain.length <= 253 &&
    options.domain.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  if (!validDomain || net.isIP(options.domain) !== 0) {
    throw new Error('a public DNS name is required with --domain');
  }
  const validEmail = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
  if (!validEmail.test(options.acmeEmail)) throw new Error('a valid address is required with --acme-email');
  if (!validEmail.test(options.operatorEmail)) throw new Error('a valid address is required with --operator-email');
  if (options.publicIpv4 && net.isIP(options.publicIpv4) !== 4) {
    throw new Error('--public-ip must be an IPv4 address');
  }
  if (options.profiles.includes('pin') && !options.publicIpv4) {
    throw new Error('the pin profile requires --public-ip');
  }
  return options;
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
      // them together below; this is the expected recovery after interruption.
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
  const edgeCa = {
    certificate: path.join(PRODUCTION_DIR, 'edge-ca.crt'),
    key: path.join(PRODUCTION_DIR, 'edge-ca.key'),
  };
  const attest = {
    certificate: path.join(PRODUCTION_DIR, 'attestation-ca.crt'),
    key: path.join(PRODUCTION_DIR, 'attestation-ca.key'),
  };
  const duc = {
    certificate: path.join(PRODUCTION_DIR, 'duc-ca.crt'),
    key: path.join(PRODUCTION_DIR, 'duc-ca.key'),
  };
  const server = {
    certificate: path.join(PRODUCTION_DIR, 'edge-server.crt'),
    key: path.join(PRODUCTION_DIR, 'edge-server.key'),
  };
  const edgeCaChanged = ensurePair(edgeCa.certificate, edgeCa.key, (certificate, key) =>
    generateCa(certificate, key, '/O=Ai Pin Revival/CN=Cosmos Edge Root CA'));
  ensurePair(attest.certificate, attest.key, (certificate, key, staging) =>
    generateIntermediateCa(
      certificate, key, staging, edgeCa,
      '/O=Ai Pin Revival/OU=DeviceAttestation/CN=Cosmos Attestation CA',
    ), { force: edgeCaChanged || !certificateVerifies(attest.certificate, edgeCa.certificate) });
  ensurePair(duc.certificate, duc.key, (certificate, key) =>
    generateCa(certificate, key, '/O=Humane/OU=DeviceUser/CN=Cosmos DeviceUser CA'));
  ensurePair(server.certificate, server.key, (certificate, key, staging) => {
    const request = path.join(staging, 'server.csr');
    const extensions = path.join(staging, 'server.ext');
    runOpenSsl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
    runOpenSsl(['req', '-new', '-key', key, '-out', request, '-subj', '/O=Ai Pin Revival/CN=cosmos-edge']);
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
    force: edgeCaChanged ||
      !certificateVerifies(server.certificate, edgeCa.certificate, 'api.cosmos.humane.cloud'),
  });
  return { edgeCa, attest, duc, server };
}

function validatePair(certificate, key) {
  const certificateKey = runOpenSsl(['x509', '-in', certificate, '-pubkey', '-noout']).trim();
  const privateKey = runOpenSsl(['pkey', '-in', key, '-pubout']).trim();
  if (certificateKey !== privateKey) throw new Error(`certificate and private key do not match: ${certificate} / ${key}`);
}

function validatePki() {
  const files = {
    edgeCa: [path.join(PRODUCTION_DIR, 'edge-ca.crt'), path.join(PRODUCTION_DIR, 'edge-ca.key')],
    attest: [path.join(PRODUCTION_DIR, 'attestation-ca.crt'), path.join(PRODUCTION_DIR, 'attestation-ca.key')],
    duc: [path.join(PRODUCTION_DIR, 'duc-ca.crt'), path.join(PRODUCTION_DIR, 'duc-ca.key')],
    server: [path.join(PRODUCTION_DIR, 'edge-server.crt'), path.join(PRODUCTION_DIR, 'edge-server.key')],
  };
  for (const [certificate, key] of Object.values(files)) validatePair(certificate, key);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], files.edgeCa[0]]);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], files.attest[0]]);
  runOpenSsl(['verify', '-CAfile', files.edgeCa[0], '-verify_hostname', 'api.cosmos.humane.cloud', files.server[0]]);
  runOpenSsl(['verify', '-CAfile', files.duc[0], files.duc[0]]);
}

function productionRealm(values, firstPassword) {
  const origin = values.REVIVAL_PUBLIC_ORIGIN;
  const email = values.REVIVAL_FIRST_OPERATOR_EMAIL;
  return {
    realm: 'humane',
    displayName: 'Ai Pin Revival',
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    resetPasswordAllowed: true,
    accessTokenLifespan: 900,
    attributes: { aiPinRevivalManaged: 'production-v1' },
    roles: { realm: [{ name: 'cosmos-operator', description: 'Ai Pin Revival operator access' }] },
    clients: [{
      clientId: values.KEYCLOAK_CLIENT_ID || 'center',
      name: 'Ai Pin Revival Center',
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
      defaultClientScopes: ['web-origins', 'acr', 'roles', 'profile', 'email'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${origin}/login`,
      },
    }],
    users: [{
      id: values.REVIVAL_FIRST_OPERATOR_ID,
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      realmRoles: ['cosmos-operator'],
      requiredActions: [],
      credentials: [{ type: 'password', value: firstPassword, temporary: false }],
    }],
  };
}

function firstLoginContents(values, firstPassword) {
  return [
    `Center: ${values.REVIVAL_PUBLIC_ORIGIN}`,
    `Operator: ${values.REVIVAL_FIRST_OPERATOR_EMAIL}`,
    `Initial password: ${firstPassword}`,
    ...(values.COSMOS_ENROLLMENT_PINCODE ? [`Pin enrollment code: ${values.COSMOS_ENROLLMENT_PINCODE}`] : []),
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
  if (center !== values.REVIVAL_PUBLIC_ORIGIN || operator !== values.REVIVAL_FIRST_OPERATOR_EMAIL || !password) {
    throw new Error(`first-login handoff is invalid or belongs to another setup: ${file}`);
  }
  return password;
}

function assertExistingRealm(existing, values) {
  const operator = Array.isArray(existing?.users)
    ? existing.users.find((candidate) => candidate?.id === values.REVIVAL_FIRST_OPERATOR_ID)
    : null;
  const credential = Array.isArray(operator?.credentials)
    ? operator.credentials.find((candidate) => candidate?.type === 'password')
    : null;
  if (typeof credential?.value !== 'string' || credential.value.length < 24) {
    throw new Error('production identity bootstrap has no usable first operator password');
  }
  const expected = productionRealm(values, credential.value);
  if (!isDeepStrictEqual(existing, expected)) {
    throw new Error('production identity bootstrap is immutable after first setup; the domain, first operator, or Keycloak client inputs changed. Migrate identity explicitly or use a fresh production data set');
  }
  return credential.value;
}

function renderTemplate(source, replacements, output) {
  let contents = fs.readFileSync(source, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    if (!contents.includes(token)) throw new Error(`template is missing ${token}: ${source}`);
    contents = contents.replaceAll(token, value);
  }
  if (/@@[A-Z_]+@@/u.test(contents)) throw new Error(`template has unresolved values: ${source}`);
  atomicWrite(output, contents, 0o444);
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

function renderOperatorCompose(profiles) {
  const enabled = new Set(profiles);
  const pinReleases = path.join(DATA_DIR, 'pin-releases');
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
      - { source: identity_realm, target: /opt/keycloak/data/import/realm.json, mode: 0444 }`,
    `  traefik:
    secrets:
      - { source: traefik_static, target: /etc/traefik/traefik.yml, mode: 0444 }
      - { source: traefik_dynamic, target: /etc/traefik/dynamic.yaml, mode: 0444 }`,
  ];
  const secrets = [
    `  identity_realm: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'realm.json'))} }`,
    `  traefik_static: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'traefik.yaml'))} }`,
    `  traefik_dynamic: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'traefik-dynamic.yaml'))} }`,
  ];
  const centerEnvironment = [];
  const centerSecrets = [];
  const centerVolumes = [];

  if (enabled.has('pin')) {
    services.push(
      `  ai-bus:
    environment:
      COSMOS_ATTEST_CA_CERT: /etc/cosmos-attest/ca.crt
      COSMOS_ATTEST_CA_KEY: /etc/cosmos-attest/ca.key
      COSMOS_DEVICE_STATUS_CA_CERT: /etc/cosmos-attest/ca.crt
      COSMOS_ONBOARDING_ENDPOINT: \${COSMOS_ONBOARDING_ENDPOINT:?run revival setup production}
    secrets:
      - { source: attestation_ca_cert, target: /etc/cosmos-attest/ca.crt, mode: 0444 }
      - { source: attestation_ca_key, target: /etc/cosmos-attest/ca.key, mode: 0444 }`,
      `  provisioning:
    secrets:
      - { source: duc_ca_cert, target: /etc/cosmos-duc/duc-ca.crt, mode: 0444 }
      - { source: duc_ca_key, target: /etc/cosmos-duc/duc-ca.key, mode: 0444 }`,
      `  edge:
    secrets:
      - { source: envoy_config, target: /etc/cosmos-edge/envoy.yaml, mode: 0444 }
      - { source: edge_server_cert, target: /etc/cosmos-edge/certs/server.crt, mode: 0444 }
      - { source: edge_server_key, target: /etc/cosmos-edge/certs/server.key, mode: 0444 }
      - { source: duc_ca_cert, target: /etc/cosmos-edge/certs/api-client-ca.crt, mode: 0444 }
      - { source: attestation_ca_cert, target: /etc/cosmos-edge/certs/onboarding-client-ca.crt, mode: 0444 }`,
    );
    for (const [name, filename] of [
      ['attestation_ca_cert', 'attestation-ca.crt'], ['attestation_ca_key', 'attestation-ca.key'],
      ['duc_ca_cert', 'duc-ca.crt'], ['duc_ca_key', 'duc-ca.key'],
      ['envoy_config', 'envoy.yaml'], ['edge_server_cert', 'edge-server.crt'],
      ['edge_server_key', 'edge-server.key'],
    ]) secrets.push(`  ${name}: { file: ${safeYaml(path.join(PRODUCTION_DIR, filename))} }`);
    centerEnvironment.push(
      '      REVIVAL_PIN_RELEASE_DIR: /var/lib/ai-pin-revival/pin-releases',
      '      REVIVAL_PIN_SETUP_ORIGIN: ${REVIVAL_PUBLIC_ORIGIN:?run revival setup production}',
      '      REVIVAL_DEVICE_EDGE_IPV4: ${REVIVAL_DEVICE_EDGE_IPV4:?run revival setup production}',
    );
    centerVolumes.push(`      - type: bind
        source: ${safeYaml(pinReleases)}
        target: /var/lib/ai-pin-revival/pin-releases
        read_only: true
        bind: { create_host_path: false }`);
  }
  if (enabled.has('spotify')) {
    services.push(`  spotify-adapter:
    secrets:
      - { source: spotify_adapter_token, target: /run/secrets/spotify_adapter_token, mode: 0444 }`);
    secrets.push(`  spotify_adapter_token: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'spotify-token'))} }`);
    centerEnvironment.push(
      '      REVIVAL_SPOTIFY_ADAPTER_URL: http://spotify-adapter:18081',
      '      REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE: /run/secrets/spotify_adapter_token',
    );
    centerSecrets.push('      - { source: spotify_adapter_token, target: /run/secrets/spotify_adapter_token, mode: 0444 }');
  }
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
      - { source: searxng_settings, target: /etc/searxng/settings.yml, mode: 0444 }`);
    secrets.push(`  searxng_settings: { file: ${safeYaml(path.join(PRODUCTION_DIR, 'searxng-settings.yml'))} }`);
  }
  if (enabled.has('observability')) {
    services.push(
      `  prometheus:
    secrets:
      - { source: prometheus_config, target: /etc/prometheus/prometheus.yml, mode: 0444 }`,
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
    'services:', ...services, 'secrets:', ...secrets, '',
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

function validatePinReleases(root, problems) {
  const result = child.spawnSync(process.execPath, [PIN_RELEASE_VALIDATOR, root], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: path.dirname(process.execPath), LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || 'unknown validation error';
    problems.push(`${path.join(root, 'current.json')} must identify a canonical, digest-matched five-APK Pin release: ${detail}`);
  }
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
      'edge-ca.crt', 'edge-ca.key', 'edge-server.crt', 'edge-server.key',
      'attestation-ca.crt', 'attestation-ca.key', 'duc-ca.crt', 'duc-ca.key', 'envoy.yaml',
    ].map((name) => path.join(PRODUCTION_DIR, name)) : []),
    ...(profiles.has('spotify') ? [path.join(PRODUCTION_DIR, 'spotify-token')] : []),
    ...(profiles.has('search') ? [path.join(PRODUCTION_DIR, 'searxng-settings.yml')] : []),
    ...(profiles.has('observability') ? [path.join(PRODUCTION_DIR, 'prometheus.yml')] : []),
  ];
}

function productionArtifacts(values = parseEnvFile(ENV_FILE)) {
  return activeArtifactFiles(values);
}

function validateProductionArtifacts(values = parseEnvFile(ENV_FILE)) {
  const problems = [];
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
  if (profiles.has('pin') && !problems.some((problem) => /(?:\.crt|\.key|envoy\.yaml)/u.test(problem))) {
    try { validatePki(); } catch (error) { problems.push(error.message); }
    const releases = path.join(DATA_DIR, 'pin-releases');
    validatePinReleases(releases, problems);
    validateReadableTree(releases, problems);
  }
  if (profiles.has('observability')) {
    validateReadableTree(path.join(PRODUCTION_DIR, 'grafana', 'provisioning'), problems);
    validateReadableTree(path.join(PRODUCTION_DIR, 'grafana', 'dashboards'), problems);
  }
  if (problems.length) throw new Error(`production artifacts are not ready:\n- ${problems.join('\n- ')}`);
  return Object.freeze({ operatorCompose: OPERATOR_COMPOSE, files: productionArtifacts(values) });
}

function setupProduction(args) {
  const before = regularFile(ENV_FILE, { mode: 0o600 }) ? parseEnvFile(ENV_FILE) : {};
  const options = parseOptions([...args], before);
  initialize({ suppressDeviceCaWarning: true, quiet: true, profiles: options.profiles, localIdentity: false });
  const initialized = parseEnvFile(ENV_FILE);
  const origin = `https://${options.domain}`;
  const pin = options.profiles.includes('pin');
  const updates = {
    COSMOS_AUTH_MODE: 'edge-authenticated',
    REVIVAL_IDENTITY_ENABLED: 'true',
    REVIVAL_PUBLIC_DOMAIN: options.domain,
    REVIVAL_PUBLIC_ORIGIN: origin,
    REVIVAL_ACME_EMAIL: options.acmeEmail,
    COSMOS_OIDC_ISSUER: `${origin}/realms/humane`,
    COSMOS_CAPTURE_SHARE_BASE_URL: origin,
    COSMOS_CAPTURE_UPLOAD_BASE_URL: origin,
    REVIVAL_MUSIC_GATEWAY_ORIGIN: origin,
    COSMOS_ONBOARDING_ENDPOINT: pin ? 'https://onboarding.cosmos.humane.cloud' : '',
    COSMOS_OPERATOR_EMAILS: options.operatorEmail,
    REVIVAL_FIRST_OPERATOR_EMAIL: options.operatorEmail,
    REVIVAL_FIRST_OPERATOR_ID: initialized.REVIVAL_FIRST_OPERATOR_ID || crypto.randomUUID(),
    REVIVAL_DEVICE_EDGE_IPV4: pin ? options.publicIpv4 : '',
    COMPOSE_PROFILES: options.profiles.join(','),
    COSMOS_SEARXNG_BASE_URL: options.profiles.includes('search') ? 'http://searxng:8080' : '',
    REVIVAL_SPOTIFY_ADAPTER_URL: '',
    COSMOS_ENROLLMENT_PINCODE: pin
      ? (initialized.COSMOS_ENROLLMENT_PINCODE || String(crypto.randomInt(1000, 10_000))) : '',
    COSMOS_ENROLLMENT_USER_ID: pin
      ? (initialized.COSMOS_ENROLLMENT_USER_ID || initialized.REVIVAL_FIRST_OPERATOR_ID || '') : '',
  };
  if (pin && !updates.COSMOS_ENROLLMENT_USER_ID) updates.COSMOS_ENROLLMENT_USER_ID = updates.REVIVAL_FIRST_OPERATOR_ID;
  const values = { ...initialized, ...updates };
  secureDirectory(PRODUCTION_DIR);

  const realmFile = path.join(PRODUCTION_DIR, 'realm.json');
  const credentials = path.join(PRODUCTION_DIR, 'first-login.txt');
  const realmExists = fs.existsSync(realmFile);
  const updatedRuntime = removeEnvironmentValues(
    replaceEnvironmentValues(fs.readFileSync(ENV_FILE, 'utf8'), updates),
    ['REVIVAL_FIRST_OPERATOR_PASSWORD'],
  );
  if (!realmExists) atomicWrite(ENV_FILE, updatedRuntime);
  if (realmExists) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(realmFile, 'utf8')); } catch { existing = null; }
    const password = assertExistingRealm(existing, values);
    const handedOffPassword = readFirstLogin(credentials, values);
    if (handedOffPassword && handedOffPassword !== password) {
      throw new Error(`first-login handoff does not match the generated realm: ${credentials}`);
    }
    atomicWrite(ENV_FILE, updatedRuntime);
  } else {
    const password = readFirstLogin(credentials, values) || crypto.randomBytes(24).toString('base64url');
    if (!fs.existsSync(credentials)) atomicWrite(credentials, firstLoginContents(values, password));
    atomicWrite(realmFile, `${JSON.stringify(productionRealm(values, password), null, 2)}\n`, 0o444);
  }

  renderTemplate(
    path.join(ROOT, 'platform', 'edge', 'traefik', 'traefik.yaml.tpl'),
    { '@@ACME_EMAIL@@': options.acmeEmail }, path.join(PRODUCTION_DIR, 'traefik.yaml'),
  );
  renderTemplate(
    path.join(ROOT, 'platform', 'edge', 'traefik', 'dynamic.yaml.tpl'),
    { '@@PUBLIC_DOMAIN@@': options.domain }, path.join(PRODUCTION_DIR, 'traefik-dynamic.yaml'),
  );
  atomicWrite(path.join(PRODUCTION_DIR, 'postgres-init.sql'), 'CREATE DATABASE keycloak OWNER cosmos;\n', 0o444);

  if (pin) {
    ensureProductionPki();
    renderTemplate(
      path.join(ROOT, 'platform', 'edge', 'envoy', 'envoy.yaml.tpl'),
      { '@@EDGE_TOKEN@@': values.COSMOS_EDGE_TOKEN, '@@CERT_DIR@@': '/etc/cosmos-edge/certs' },
      path.join(PRODUCTION_DIR, 'envoy.yaml'),
    );
    const releases = path.join(DATA_DIR, 'pin-releases');
    if (!fs.existsSync(releases)) {
      secureDirectory(releases);
    } else {
      const stat = fs.lstatSync(releases);
      if (stat.isSymbolicLink() || !stat.isDirectory() || ![0o700, 0o755].includes(stat.mode & 0o777)) {
        throw new Error(`Pin release store must be a real generated directory with mode 0700 or 0755: ${releases}`);
      }
    }
    if (fs.readdirSync(releases).length > 0) readableTree(releases);
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
  renderOperatorCompose(options.profiles);
  validateProductionArtifacts(values);
  validateRuntime({ production: true });
  return Object.freeze({
    origin,
    profiles: options.profiles,
    operatorCompose: OPERATOR_COMPOSE,
    credentials: regularFile(credentials, { mode: 0o600 }) ? credentials : null,
    pinTrustRoot: pin ? path.join(PRODUCTION_DIR, 'edge-ca.crt') : null,
  });
}

module.exports = {
  OPERATOR_COMPOSE,
  PIN_SERVER_NAMES,
  PRODUCTION_DIR,
  parseOptions,
  productionArtifacts,
  productionRealm,
  setupProduction,
  validateProductionArtifacts,
};
