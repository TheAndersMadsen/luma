'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEPLOY_DIR, ENV_FILE, ROOT, fail, operatorEnvironment, resolveTool, run, validateRuntime,
} = require('./context');
const { versionInfo } = require('./command-spec');
const { validateProductionArtifacts } = require('./production-setup');

const DOCTOR_USAGE = './revival doctor production [--env-file FILE] [--project-name NAME]';
const DEPLOY_USAGE = './revival deploy production (--dry-run | --confirm) [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS]';
const VERIFY_USAGE = './revival verify production [--env-file FILE] [--project-name NAME]';
const EVAL_USAGE = './revival eval assistant production [--repeat N] [--case ID] [--json] [--env-file FILE] [--project-name NAME]';

function validateOperatorReleaseCoordinates(values) {
  const release = versionInfo();
  const configured = values.REVIVAL_COMPOSE_APPLICATION || '';
  const application = configured || release.application || '';
  if (!/^oci:\/\/ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(application)) {
    throw new Error('production requires REVIVAL_COMPOSE_APPLICATION=oci://ghcr.io/...@sha256:<64 lowercase hex characters>');
  }
  if (release.application && configured && release.application !== configured) {
    throw new Error('REVIVAL_COMPOSE_APPLICATION does not match this operator release');
  }
  if (release.revision !== 'source' && values.REVIVAL_RELEASE_ID !== release.revision) {
    throw new Error('REVIVAL_RELEASE_ID does not match this operator release revision');
  }
  return application;
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
  let values;
  try {
    values = validateRuntime({ production: true, envFile });
    validateProductionArtifacts(values);
    const application = validateOperatorReleaseCoordinates(values);
    values = { ...values, REVIVAL_COMPOSE_APPLICATION: application };
  } catch (error) {
    stop(error.message, options);
  }
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) stop(`deployment command is unavailable: ${script}`, options);
  const environment = operatorEnvironment(values);
  if (confirmed) environment.REVIVAL_DEPLOY_CONFIRMED = '1';
  const result = run(resolveTool(interpreter), [script, ...args], {
    env: environment,
    allowFailure: throwOnFailure,
  });
  if (throwOnFailure && result.status !== 0) {
    stop(`${name} exited with status ${result.status || 1}`, options, result.status || 1);
  }
  return result;
}

function productionDoctor(args, runtime = {}) {
  let parsed;
  try {
    parsed = parseProductionOptions(args);
  } catch {
    stop(`usage: ${DOCTOR_USAGE}`, runtime, 64);
  }
  deploymentScript('preflight.sh', args, parsed.envFile, runtime);
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
  deploymentScript(
    'deploy.sh',
    options.filter((argument) => argument !== '--confirm'),
    parsed.envFile,
    { confirmed: options.includes('--confirm'), ...runtime },
  );
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
  deploymentScript('assistant-eval.mjs', options, envFile, { interpreter: 'node' });
}

module.exports = {
  productionDoctor,
  deployProduction,
  evaluateAssistant,
  validateOperatorReleaseCoordinates,
  verifyProduction,
};
