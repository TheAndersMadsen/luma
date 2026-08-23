'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEPLOY_DIR, fail, operatorEnvironment, resolveTool, run,
} = require('./context');

function deploymentScript(name, args) {
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) fail(`deployment command is unavailable: ${script}`);
  return run(resolveTool('bash'), [script, ...args], { env: operatorEnvironment() });
}

function productionDoctor(args) {
  deploymentScript('preflight.sh', args);
}

function deployProduction(args) {
  const [target, ...options] = args;
  if (target !== 'production') {
    fail('usage: ./revival deploy production (--dry-run | --confirm) [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS]', 64);
  }
  const confirmations = options.filter((argument) => argument === '--confirm').length;
  const dryRuns = options.filter((argument) => argument === '--dry-run').length;
  if (confirmations > 1 || dryRuns > 1 || (confirmations && dryRuns)) {
    fail('usage: ./revival deploy production (--dry-run | --confirm) [--env-file FILE] [--project-name NAME] [--wait-timeout SECONDS]', 64);
  }
  if (!confirmations && !dryRuns) {
    fail('deploy production requires --dry-run or --confirm', 64);
  }
  deploymentScript('deploy.sh', options.filter((argument) => argument !== '--confirm'));
}

module.exports = { deploymentScript, productionDoctor, deployProduction };
