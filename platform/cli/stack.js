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

function probeRunningLocalIdentity(values) {
  const running = run('docker', composeArgs(values, [
    'ps', '--status', 'running', '--services', 'keycloak'
  ]), {
    capture: true,
    allowFailure: true,
    env: operatorEnvironment(values)
  });
  if (running.status !== 0 || !running.stdout.split(/\r?\n/).includes('keycloak')) {
    info('[unknown] local identity is configured but not running; revival up will start and wait for it.');
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
    info('[unknown] running local identity failed its issuer/discovery/JWKS probe.');
    return false;
  }
  info('[observed] running local identity serves the expected issuer and an RSA JWKS.');
  info('[unknown] public discovery cannot prove the imported client secret matches the external realm file; reconcile it in the admin console after any persisted-realm change.');
  return true;
}

function localDoctor() {
  let failed = false;
  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BACKUP_DIR]) {
    if (isInsideSource(directory)) {
      info(`[unknown] ${directory} is inside the source tree; use the corresponding REVIVAL_*_DIR override.`);
      failed = true;
    }
  }

  try {
    validateHostToolchains({ includeRust: false, report: true });
  } catch (error) {
    info(`[unknown] ${error.message}`);
    failed = true;
  }

  if (!exists('docker')) {
    info('[unknown] Docker is unavailable.');
    failed = true;
  } else {
    const result = run('docker', ['compose', 'version', '--short'], { capture: true, allowFailure: true });
    const composeVersion = result.status === 0 ? parseVersion(result.stdout) : null;
    if (composeVersion && versionAtLeast(composeVersion, MINIMUM_COMPOSE_VERSION)) {
      info(`[observed] Docker Compose ${composeVersion.join('.')} satisfies the 2.33.1 minimum.`);
    } else {
      info('[unknown] Docker Compose 2.33.1 or newer is required.');
      failed = true;
    }
  }

  let values;
  try {
    values = validateRuntime();
    info(`[observed] ${ENV_FILE} is mode 0600 and internally coherent.`);
    info(`[implemented] Azure speech selection is ${valueOf(values, 'REVIVAL_REMOTE_TTS_ENABLED', 'CARRY_REMOTE_TTS_ENABLED') === 'true' ? 'enabled' : 'disabled'} by configuration.`);
    info(`[implemented] Pin-native Spotify adapter configuration is ${values.REVIVAL_SPOTIFY_ADAPTER_URL ? 'present' : 'not configured'}; token-file contents were not read or printed.`);
  } catch (error) {
    info(`[unknown] ${error.message}`);
    failed = true;
  }

  if (!failed && exists('docker')) {
    const result = run('docker', composeArgs(values, ['config', '--quiet']), {
      capture: true,
      allowFailure: true,
      env: operatorEnvironment(values)
    });
    if (result.status === 0) info('[observed] Docker Compose accepted the development model.');
    else {
      info('[unknown] Docker Compose rejected the development model; run the component-specific check for details.');
      failed = true;
    }
    if (!failed && values.REVIVAL_IDENTITY_ENABLED === 'true' && !probeRunningLocalIdentity(values)) {
      failed = true;
    }
  }
  if (failed) process.exit(1);
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

module.exports = { composeArgs, compose, probeRunningLocalIdentity, localDoctor, stack };
