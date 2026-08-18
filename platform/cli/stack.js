'use strict';
// Local stack control: Compose invocation, the local doctor, and stack subcommands.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  PROJECT, COMPOSE_BASE, COMPOSE_DEVELOPMENT, MINIMUM_COMPOSE_VERSION, CONFIG_DIR, SECRETS_DIR, DATA_DIR, BACKUP_DIR, ENV_FILE, isInsideSource, fail, info, exists, run, valueOf, validateRuntime, operatorEnvironment,
} = require('./context');
const { parseVersion, validateHostToolchains, versionAtLeast } = require('./toolchain');

function composeArgs(values, args) {
  const result = [
    'compose',
    '--project-name', PROJECT,
    '--env-file', ENV_FILE,
    '--file', COMPOSE_BASE,
    '--file', COMPOSE_DEVELOPMENT
  ];
  if (values.REVIVAL_IDENTITY_ENABLED === 'true') result.push('--profile', 'identity');
  return result.concat(args);
}

function compose(args, options = {}) {
  if (!exists('docker')) fail('Docker with Compose v2 is required');
  let values;
  try {
    values = validateRuntime();
  } catch (error) {
    fail(error.message);
  }
  return run('docker', composeArgs(values, args), {
    ...options,
    env: operatorEnvironment(values)
  });
}

function probeRunningLocalIdentity(values, { emit = true } = {}) {
  const running = run('docker', composeArgs(values, [
    'ps', '--status', 'running', '--services', 'keycloak'
  ]), {
    capture: true,
    allowFailure: true,
    env: operatorEnvironment(values)
  });
  if (running.status !== 0 || !running.stdout.split(/\r?\n/).includes('keycloak')) {
    if (emit) info('[unknown] local identity is configured but not running; revival up will start and wait for it.');
    return true;
  }

  const port = values.REVIVAL_KEYCLOAK_PORT || '8088';
  const realm = values.KEYCLOAK_REALM || 'humane';
  const base = `http://127.0.0.1:${port}/realms/${realm}`;
  const expectedIssuer = `http://localhost:${port}/realms/${realm}`;
  const script = `
    const [base, expected] = process.argv.slice(1);
    (async () => {
      const discovery = await fetch(base + '/.well-known/openid-configuration');
      if (!discovery.ok) throw new Error('discovery');
      const metadata = await discovery.json();
      if (metadata.issuer !== expected) throw new Error('issuer');
      const jwks = await fetch(base + '/protocol/openid-connect/certs');
      if (!jwks.ok) throw new Error('jwks');
      const body = await jwks.json();
      if (!Array.isArray(body.keys) || !body.keys.some((key) => key.kty === 'RSA' && key.kid)) {
        throw new Error('keys');
      }
    })().catch(() => process.exit(1));
  `;
  const probe = run('node', ['-e', script, base, expectedIssuer], {
    capture: true,
    allowFailure: true,
    env: operatorEnvironment(values)
  });
  if (probe.status !== 0) {
    if (emit) info('[unknown] running local identity failed its issuer/discovery/JWKS probe.');
    return false;
  }
  if (emit) {
    info('[observed] running local identity serves the expected issuer and an RSA JWKS.');
    info('[unknown] public discovery cannot prove the imported client secret matches the external realm file; reconcile it in the admin console after any persisted-realm change.');
  }
  return true;
}

function localDoctorReport() {
  const checks = [];
  const add = (id, status, message, fix) => checks.push({
    id, status, message, ...(fix ? { fix } : {}),
  });

  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BACKUP_DIR]) {
    if (isInsideSource(directory)) {
      add('external-paths', 'FAIL', `${directory} is inside the source tree.`,
        'Set the corresponding REVIVAL_*_DIR override to an owner-only external directory.');
    }
  }
  if (!checks.some((check) => check.id === 'external-paths')) {
    add('external-paths', 'PASS', 'Configuration, secrets, data, and backups resolve outside the source tree.');
  }

  try {
    validateHostToolchains({ includeRust: false, report: false });
    add('node', 'PASS', 'Node.js satisfies the pinned host contract.');
  } catch (error) {
    add('node', 'FAIL', error.message, 'Install the Node.js major line named in platform/containers/pin-builder/toolchain.json.');
  }

  let dockerReady = false;
  if (!exists('docker')) {
    add('docker', 'FAIL', 'Docker is unavailable.', 'Install and start Docker Desktop or a compatible Docker Engine.');
  } else {
    add('docker', 'PASS', 'Docker is available.');
    const result = run('docker', ['compose', 'version', '--short'], { capture: true, allowFailure: true });
    const composeVersion = result.status === 0 ? parseVersion(result.stdout) : null;
    if (composeVersion && versionAtLeast(composeVersion, MINIMUM_COMPOSE_VERSION)) {
      add('compose', 'PASS', `Docker Compose ${composeVersion.join('.')} satisfies the 2.33.1 minimum.`);
      dockerReady = true;
    } else {
      add('compose', 'FAIL', 'Docker Compose 2.33.1 or newer is required.',
        'Upgrade Docker Compose, then rerun ./revival doctor.');
    }
  }

  let values;
  try {
    values = validateRuntime();
    add('configuration', 'PASS', `${ENV_FILE} is mode 0600 and internally coherent.`);
    add('remote-tts', valueOf(values, 'REVIVAL_REMOTE_TTS_ENABLED', 'COSMOS_REMOTE_TTS_ENABLED') === 'true' ? 'PASS' : 'WARN',
      `Remote TTS is ${valueOf(values, 'REVIVAL_REMOTE_TTS_ENABLED', 'COSMOS_REMOTE_TTS_ENABLED') === 'true' ? 'enabled' : 'disabled'} by configuration.`);
    add('spotify', values.REVIVAL_SPOTIFY_ADAPTER_URL ? 'PASS' : 'WARN',
      `Pin-native Spotify adapter configuration is ${values.REVIVAL_SPOTIFY_ADAPTER_URL ? 'present' : 'not configured'}; no token contents were read.`);
  } catch (error) {
    add('configuration', 'FAIL', error.message, './revival init, then update only the settings named by the failure.');
  }

  if (values && dockerReady) {
    const result = run('docker', composeArgs(values, ['config', '--quiet']), {
      capture: true,
      allowFailure: true,
      env: operatorEnvironment(values)
    });
    if (result.status === 0) add('compose-model', 'PASS', 'Docker Compose accepted the development model.');
    else {
      add('compose-model', 'FAIL', 'Docker Compose rejected the development model.',
        './revival stack config');
    }
    if (result.status === 0 && values.REVIVAL_IDENTITY_ENABLED === 'true') {
      if (probeRunningLocalIdentity(values, { emit: false })) {
        add('identity', 'PASS', 'Running local identity serves the expected issuer and RSA JWKS.');
      } else {
        add('identity', 'FAIL', 'Local identity is not running or failed issuer/discovery/JWKS validation.',
          './revival up');
      }
    }
  }
  const failed = checks.some((check) => check.status === 'FAIL');
  const next = checks.find((check) => check.status === 'FAIL')?.fix || './revival up';
  return Object.freeze({ schemaVersion: 1, ok: !failed, checks, next });
}

function localDoctor(args = []) {
  let json = false;
  for (const argument of args) {
    if (argument === '--json' && !json) json = true;
    else fail('usage: ./revival doctor [--json]', 64);
  }
  const report = localDoctorReport();
  if (json) info(JSON.stringify(report));
  else {
    for (const check of report.checks) {
      info(`${check.status} ${check.message}`);
      if (check.fix) info(`     fix: ${check.fix}`);
    }
    info(`NEXT ${report.next}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

function stack(subcommand, args) {
  switch (subcommand) {
    case 'build':
      compose(['build', ...args]);
      break;
    case 'up':
      try {
        if (validateRuntime().REVIVAL_IDENTITY_ENABLED === 'true') {
          info('[implemented] starting and waiting for local identity before account-bound workloads.');
          compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'keycloak']);
        }
      } catch (error) {
        fail(error.message);
      }
      compose(['up', '--detach', '--remove-orphans', ...args]);
      break;
    case 'down':
      if (args.some((argument) =>
        argument === '-v' || argument.startsWith('-v=') ||
        argument.startsWith('--volumes') || /^-[^-][A-Za-z]*v[A-Za-z]*$/.test(argument))) {
        fail('volume deletion is intentionally unavailable through revival', 64);
      }
      compose(['down', ...args]);
      break;
    case 'status':
      compose(['ps', ...args]);
      break;
    case 'logs':
      compose(['logs', '--tail', '200', ...args]);
      break;
    case 'config':
      compose(['config', '--no-interpolate', '--no-env-resolution', ...args]);
      break;
    default:
      fail('usage: ./revival stack build|up|down|status|logs|config');
  }
}

module.exports = { composeArgs, compose, probeRunningLocalIdentity, localDoctorReport, localDoctor, stack };
