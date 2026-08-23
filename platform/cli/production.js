'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEPLOY_DIR, ENV_FILE, ROOT, fail, operatorEnvironment, resolveTool, run, validateRuntime,
} = require('./context');

const DOCTOR_USAGE = './revival doctor production [--env-file FILE] [--project-name NAME]';
const DEPLOY_USAGE = './revival deploy production (--dry-run | --confirm) [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS]';

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

function deploymentScript(name, args, envFile = ENV_FILE) {
  try {
    validateRuntime({ production: true, envFile });
  } catch (error) {
    fail(error.message);
  }
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) fail(`deployment command is unavailable: ${script}`);
  return run(resolveTool('bash'), [script, ...args], { env: operatorEnvironment() });
}

function productionDoctor(args) {
  let options;
  try {
    options = parseProductionOptions(args);
  } catch {
    fail(`usage: ${DOCTOR_USAGE}`, 64);
  }
  deploymentScript('preflight.sh', args, options.envFile);
}

function deployProduction(args) {
  const [target, ...options] = args;
  if (target !== 'production') {
    fail(`usage: ${DEPLOY_USAGE}`, 64);
  }
  let parsed;
  try {
    parsed = parseProductionOptions(options, { deploy: true });
  } catch (error) {
    if (error.message === 'mode' && !options.includes('--dry-run') && !options.includes('--confirm')) {
      fail('deploy production requires --dry-run or --confirm', 64);
    }
    fail(`usage: ${DEPLOY_USAGE}`, 64);
  }
  deploymentScript('deploy.sh', options.filter((argument) => argument !== '--confirm'), parsed.envFile);
}

module.exports = { productionDoctor, deployProduction };
