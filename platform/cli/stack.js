'use strict';
// Local stack control: Compose invocation, the local doctor, and stack subcommands.
// Split out of the root `luma` entry point. Behavior, messages, and exit
// codes are unchanged.

const {
  PROJECT, COMPOSE_BASE, COMPOSE_DEVELOPMENT, MINIMUM_COMPOSE_VERSION, CONFIG_DIR, SECRETS_DIR, DATA_DIR, BUILD_DIR, ENV_FILE, isInsideDirectory, isInsideSource, fail, info, exists, run, validateRuntime, operatorEnvironment,
} = require('./context');
const { keycloakAdmin, reconcileRealm, reconcileReport } = require('./realm');
const { parseVersion, validateHostToolchains, versionAtLeast } = require('./toolchain');

function composeArgs(values, args, { project = PROJECT } = {}) {
  const result = [
    'compose',
    '--project-name', project,
    '--env-file', ENV_FILE,
    '--file', COMPOSE_BASE,
    '--file', COMPOSE_DEVELOPMENT
  ];
  if (values.LUMA_IDENTITY_ENABLED === 'true') result.push('--profile', 'identity');
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
  const { project = PROJECT, ...runOptions } = options;
  return run('docker', composeArgs(values, args, { project }), {
    ...runOptions,
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
    if (emit) info('[unknown] local identity is configured but not running; luma up will start and wait for it.');
    return true;
  }

  const port = values.LUMA_KEYCLOAK_PORT || '8088';
  const realm = 'humane';
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
  const probe = run('bun', ['-e', script, base, expectedIssuer], {
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

  for (const directory of [CONFIG_DIR, SECRETS_DIR, DATA_DIR, BUILD_DIR]) {
    if (isInsideSource(directory)) {
      add('external-paths', 'FAIL', `${directory} is inside the source tree.`,
        'Set the corresponding LUMA_*_DIR override to an owner-only external directory.');
    }
  }
  if (!isInsideDirectory(BUILD_DIR, DATA_DIR)) {
    add('external-paths', 'FAIL', `LUMA_BUILD_DIR (${BUILD_DIR}) is not inside LUMA_DATA_DIR (${DATA_DIR}).`,
      'Unset LUMA_BUILD_DIR, or point it at a path inside LUMA_DATA_DIR.');
  }
  const pathsReady = !checks.some((check) => check.id === 'external-paths');
  if (pathsReady) {
    add('external-paths', 'PASS', 'Configuration, secrets, data, and build output resolve outside the source tree.');
  }
  // Doctor reads Docker through the owner's own Docker configuration: it writes
  // nothing, and before ./luma init Luma's configuration does not exist.
  const dockerEnvironment = (values) => operatorEnvironment(values, { lumaDockerConfig: false });

  try {
    validateHostToolchains({ includeRust: false, report: false });
    add('bun', 'PASS', 'Bun satisfies the pinned host contract.');
  } catch (error) {
    add('bun', 'FAIL', error.message, 'Install the Bun version named in platform/containers/pin-builder/toolchain.json.');
  }

  let dockerReady = false;
  if (!exists('docker')) {
    add('docker', 'FAIL', 'Docker is unavailable.', 'Install and start Docker Desktop or a compatible Docker Engine.');
  } else if (!pathsReady) {
    add('docker', 'FAIL', 'Docker was not checked because the paths above are invalid.', 'Fix the paths above, then rerun ./luma doctor.');
  } else {
    add('docker', 'PASS', 'Docker is available.');
    const result = run('docker', ['compose', 'version', '--short'], {
      capture: true, allowFailure: true, env: dockerEnvironment(),
    });
    const composeVersion = result.status === 0 ? parseVersion(result.stdout) : null;
    if (composeVersion && versionAtLeast(composeVersion, MINIMUM_COMPOSE_VERSION)) {
      add('compose', 'PASS', `Docker Compose ${composeVersion.join('.')} satisfies the 2.34.0 minimum.`);
      dockerReady = true;
    } else {
      add('compose', 'FAIL', 'Docker Compose 2.34.0 or newer is required.',
        'Upgrade Docker Compose, then rerun ./luma doctor.');
    }
  }

  let values;
  try {
    values = validateRuntime();
    add('configuration', 'PASS', `${ENV_FILE} is mode 0600 and internally coherent.`);
  } catch (error) {
    add('configuration', 'FAIL', error.message, './luma init, then update only the settings named by the failure.');
  }

  if (values && dockerReady) {
    const result = run('docker', composeArgs(values, ['config', '--quiet']), {
      capture: true,
      allowFailure: true,
      env: dockerEnvironment(values)
    });
    if (result.status === 0) add('compose-model', 'PASS', 'Docker Compose accepted the development model.');
    else {
      add('compose-model', 'FAIL', 'Docker Compose rejected the development model.',
        './luma stack config');
    }
    if (result.status === 0 && values.LUMA_IDENTITY_ENABLED === 'true') {
      if (probeRunningLocalIdentity(values, { emit: false })) {
        add('identity', 'PASS', 'Running local identity serves the expected issuer and RSA JWKS.');
      } else {
        add('identity', 'FAIL', 'Local identity is not running or failed issuer/discovery/JWKS validation.',
          './luma up');
      }
    }
  }
  const failed = checks.some((check) => check.status === 'FAIL');
  const next = checks.find((check) => check.status === 'FAIL')?.fix || './luma up';
  return Object.freeze({ schemaVersion: 1, ok: !failed, checks, next });
}

function localDoctor(args = []) {
  let json = false;
  for (const argument of args) {
    if (argument === '--json' && !json) json = true;
    else fail('usage: ./luma doctor [--json]', 64);
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
}

// Keycloak imports the development realm file only when it creates the realm,
// so `up` brings the running realm onto this checkout's policy the way a
// confirmed production deploy does, before anything signs in through it.
function upLocalStack(args, runtime = {}) {
  const composeUp = runtime.compose ?? compose;
  const write = runtime.write ?? info;
  let values;
  try {
    values = (runtime.values ?? validateRuntime)();
  } catch (error) {
    fail(error.message);
  }
  if (values.LUMA_IDENTITY_ENABLED === 'true') {
    write('[implemented] starting and waiting for local identity before account-bound workloads.');
    composeUp(['up', '--detach', '--wait', '--wait-timeout', '120', 'keycloak']);
    let report;
    try {
      // The Docker endpoint and configuration Compose just used.
      const admin = (runtime.keycloakAdmin ?? keycloakAdmin)({ project: PROJECT, env: operatorEnvironment(values) });
      report = reconcileReport(reconcileRealm(admin, { clientId: values.KEYCLOAK_CLIENT_ID || 'center' }));
    } catch (error) {
      fail(`local identity realm reconcile failed: ${error.message}`);
    }
    for (const line of report) write(line);
  }
  composeUp(['up', '--detach', '--remove-orphans', ...args]);
}

function stack(subcommand, args) {
  switch (subcommand) {
    case 'build':
      compose(['build', ...args]);
      break;
    case 'up':
      upLocalStack(args);
      break;
    case 'down':
      if (args.some((argument) =>
        argument === '-v' || argument.startsWith('-v=') ||
        argument.startsWith('--volumes') || /^-[^-][A-Za-z]*v[A-Za-z]*$/.test(argument))) {
        fail('volume deletion is intentionally unavailable through luma', 64);
      }
      compose(['down', ...args]);
      break;
    case 'status':
      // `docker compose ps` exits zero for an empty project, so it cannot by
      // itself prove the setup outcome `local-stack-running`.
      compose(['ps', ...args]);
      return null;
    case 'logs':
      compose(['logs', '--tail', '200', ...args]);
      break;
    case 'config':
      compose(['config', '--no-interpolate', '--no-env-resolution', ...args]);
      break;
    default:
      fail('usage: ./luma stack build|up|down|status|logs|config');
  }
  return null;
}

function developmentCommand(args) {
  const [component, ...rest] = args;
  if (component === 'down' && rest.length === 0) {
    info(`[implemented] stopping the isolated ${PROJECT}-dev Compose project without deleting volumes.`);
    compose(['down'], { project: `${PROJECT}-dev` });
    return;
  }
  if (component !== 'center' || rest.length !== 0) {
    fail('usage: ./luma dev center | down', 64);
  }
  info('[implemented] starting Center with Next.js Turbopack and Compose source watch.');
  info('[implemented] dependencies and .next output remain in the development image/volume, outside the source checkout.');
  info(`[implemented] isolated Compose project: ${PROJECT}-dev.`);
  compose(['watch', 'center'], { project: `${PROJECT}-dev` });
}

module.exports = {
  composeArgs,
  compose,
  developmentCommand,
  probeRunningLocalIdentity,
  localDoctorReport,
  localDoctor,
  stack,
  upLocalStack,
};
