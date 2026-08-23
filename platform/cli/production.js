'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEPLOY_DIR, fail, localProductionEnvironment, resolveTool, run,
} = require('./context');

function deploymentScript(name, args) {
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) fail(`deployment command is unavailable: ${script}`);
  return run(resolveTool('bash'), [script, ...args], { env: localProductionEnvironment() });
}

function productionDoctor(args) {
  deploymentScript('preflight.sh', args);
}

function deployProduction(args) {
  deploymentScript('deploy.sh', args);
}

module.exports = { deploymentScript, productionDoctor, deployProduction };
