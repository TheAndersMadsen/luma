'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEPLOY_DIR, ENV_FILE, ROOT, configurationLocationHint, fail, info, operatorEnvironment, resolveTool, run,
  validateRuntime,
} = require('./context');
const {
  OPERATOR_SETUP_NEXT, compareReleaseVersions, describeRelease, versionInfo,
} = require('./command-spec');
const {
  PRODUCTION_DIR, hasProductionSetupMarker, renderOperatorConfig, validateProductionArtifacts,
} = require('./production-setup');
const { automaticUpdatesReport } = require('./update');

const DOCTOR_USAGE = './luma doctor production [--env-file FILE] [--project-name NAME]';
const DEPLOY_USAGE = './luma deploy production (--dry-run | --confirm) [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS]';
const VERIFY_USAGE = './luma verify production [--env-file FILE] [--project-name NAME]';
const EVAL_USAGE = './luma eval assistant production [--repeat N] [--case ID] [--json] [--env-file FILE] [--project-name NAME]';

function validateOperatorReleaseCoordinates(values) {
  const release = versionInfo();
  const configured = values.LUMA_COMPOSE_APPLICATION || '';
  const application = configured || release.application || '';
  if (!/^oci:\/\/ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(application)) {
    throw new Error('production requires LUMA_COMPOSE_APPLICATION=oci://ghcr.io/...@sha256:<64 lowercase hex characters>');
  }
  if ((release.application && configured && release.application !== configured) ||
      (release.revision !== 'source' && values.LUMA_RELEASE_ID !== release.revision)) {
    throw new Error(releaseMismatch(values, release));
  }
  return application;
}

// The configuration names one release (LUMA_RELEASE_ID and its application),
// and this operator folder is another.
function releaseMismatch(values, release) {
  const configured = values.LUMA_RELEASE_VERSION || '';
  const server = describeRelease(values.LUMA_RELEASE_ID || 'unknown', configured);
  const prefix = `this is the Luma ${release.version} operator, but this server is configured for ${server}`;
  if (compareReleaseVersions(configured, release.version) === 1) {
    return `${prefix}; run ./luma from that folder (README "Run your server")`;
  }
  const pin = new Set((values.COMPOSE_PROFILES || '').split(',')).has('pin');
  return `${prefix}; run ./luma from that release's folder, or move this server to Luma ${release.version} from ` +
    `this folder with ./luma backup production, then ./luma setup production${
      pin ? ' --pin-release-archive ../luma-pin-*.tar.gz' : ''} (README "Update Luma")`;
}

function parseProductionOptions(args, { deploy = false } = {}) {
  const values = new Set(['--env-file', '--project-name', ...(deploy ? ['--wait-timeout'] : [])]);
  const flags = new Set(deploy ? ['--dry-run', '--confirm'] : []);
  const seen = new Set();
  let envFile = ENV_FILE;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (seen.has(option) || (!values.has(option) && !flags.has(option))) {
      throw new Error('usage');
    }
    seen.add(option);
    if (!values.has(option)) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error('usage');
    if (option === '--env-file') envFile = path.resolve(ROOT, value);
    index += 1;
  }
  if (deploy && (seen.has('--dry-run') === seen.has('--confirm'))) throw new Error('mode');
  return { envFile };
}

function stop(message, options, code = 1) {
  if (options.throwOnFailure) {
    const error = new Error(message);
    error.exitCode = code;
    throw error;
  }
  fail(message, code);
}

function deploymentScript(name, args, envFile = ENV_FILE, options = {}) {
  const { confirmed = false, interpreter = 'bash', throwOnFailure = false } = options;
  // Before setup, every runtime rule below would fail at once. Name the one
  // step that creates them instead.
  if (envFile === ENV_FILE && !hasProductionSetupMarker()) {
    stop(`${configurationLocationHint()}. To set up this server, run ${OPERATOR_SETUP_NEXT}`, options);
  }
  let values;
  try {
    values = validateRuntime({ production: true, envFile });
    validateProductionArtifacts(values);
    const application = validateOperatorReleaseCoordinates(values);
    values = { ...values, LUMA_COMPOSE_APPLICATION: application };
    // A confirmed deploy applies this release's edge templates and operator
    // overlay; `up` recreates services whose mounts changed and deploy.sh then
    // recreates the edge services, which read their files only at start.
    if (confirmed) renderOperatorConfig(values, versionInfo().pin);
  } catch (error) {
    stop(error.message, options);
  }
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) stop(`deployment command is unavailable: ${script}`, options);
  const environment = operatorEnvironment(values);
  // The release notes Center shows beside this server's version come from
  // this operator's own release: free text, so never a runtime.env line.
  environment.LUMA_RELEASE_NOTES = versionInfo().notes ?? '';
  if (confirmed) environment.LUMA_DEPLOY_CONFIRMED = '1';
  const result = run(resolveTool(interpreter), [script, ...args], {
    env: environment,
    allowFailure: throwOnFailure,
  });
  if (throwOnFailure && result.status !== 0) {
    // The script printed its own reason just before it stopped.
    stop(`${name} stopped with exit status ${result.status || 1}; the error printed above says why`,
      options, result.status || 1);
  }
  return values;
}

// The options a later command needs to reach the same deployment.
function sameTarget(options) {
  return options.filter((argument) => !['--dry-run', '--confirm'].includes(argument))
    .map((argument) => ` ${argument}`).join('');
}

function productionDoctor(args, runtime = {}) {
  let parsed;
  try {
    parsed = parseProductionOptions(args);
  } catch {
    stop(`usage: ${DOCTOR_USAGE}`, runtime, 64);
  }
  const values = deploymentScript('preflight.sh', args, parsed.envFile, runtime);
  // Onboarding and restore name their own next step.
  if (!runtime.throwOnFailure) {
    for (const line of automaticUpdatesReport(values)) info(line);
    info(`NEXT ./luma deploy production --dry-run${sameTarget(args)} to see the plan, then --confirm to deploy`);
  }
}

function deployProduction(args, runtime = {}) {
  const [target, ...options] = args;
  if (target !== 'production') {
    stop(`usage: ${DEPLOY_USAGE}`, runtime, 64);
  }
  let parsed;
  try {
    parsed = parseProductionOptions(options, { deploy: true });
  } catch (error) {
    if (error.message === 'mode' && !options.includes('--dry-run') && !options.includes('--confirm')) {
      stop('deploy production requires --dry-run or --confirm', runtime, 64);
    }
    stop(`usage: ${DEPLOY_USAGE}`, runtime, 64);
  }
  const confirmed = options.includes('--confirm');
  const values = deploymentScript(
    'deploy.sh',
    options.filter((argument) => argument !== '--confirm'),
    parsed.envFile,
    { confirmed, ...runtime },
  );
  if (runtime.throwOnFailure) return;
  if (!confirmed) {
    info(`NEXT ./luma deploy production --confirm${sameTarget(options)}`);
    return;
  }
  // Setup's first sign-in file exists until the owner deletes it after
  // signing in. Its password is never printed here.
  const firstLogin = path.join(PRODUCTION_DIR, 'first-login.txt');
  info(fs.existsSync(firstLogin)
    ? `NEXT show your first sign-in once with cat ${firstLogin}, then open ` +
      `${values.LUMA_PUBLIC_ORIGIN}/login?next=%2Fsettings%2Fpin%2Fsetup (docs/install.md "Sign in and connect the Pin")`
    : `Center: ${values.LUMA_PUBLIC_ORIGIN}`);
}

function verifyProduction(args, runtime = {}) {
  const [target, ...options] = args;
  if (target !== 'production') stop(`usage: ${VERIFY_USAGE}`, runtime, 64);
  let parsed;
  try {
    parsed = parseProductionOptions(options);
  } catch {
    stop(`usage: ${VERIFY_USAGE}`, runtime, 64);
  }
  deploymentScript('verify.sh', options, parsed.envFile, runtime);
}

function evaluateAssistant(args) {
  const [subject, target, ...options] = args;
  if (subject !== 'assistant' || target !== 'production') fail(`usage: ${EVAL_USAGE}`, 64);
  let envFile = ENV_FILE;
  const seen = new Set();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (
      seen.has(option) ||
      !['--repeat', '--case', '--json', '--env-file', '--project-name'].includes(option)
    ) {
      fail(`usage: ${EVAL_USAGE}`, 64);
    }
    seen.add(option);
    if (option === '--json') continue;
    const value = options[index + 1];
    if (!value || value.startsWith('-')) fail(`usage: ${EVAL_USAGE}`, 64);
    if (option === '--env-file') envFile = path.resolve(ROOT, value);
    index += 1;
  }
  deploymentScript('assistant-eval.mjs', options, envFile, { interpreter: 'bun' });
}

module.exports = {
  productionDoctor,
  deployProduction,
  evaluateAssistant,
  validateOperatorReleaseCoordinates,
  verifyProduction,
};
