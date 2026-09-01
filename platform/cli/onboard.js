'use strict';

const fs = require('node:fs');

const { fail, info, validateRuntime } = require('./context');
const { deployProduction, productionDoctor, verifyProduction } = require('./production');
const { setupCommand } = require('./setup');

const ONBOARD_USAGE = './revival onboard production';

function terminalReadLine() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('onboard production requires an interactive terminal');
  }
  const buffer = Buffer.alloc(4096);
  const length = fs.readSync(process.stdin.fd, buffer, 0, buffer.length, null);
  if (length === 0) throw new Error('onboarding ended before deployment confirmation');
  return buffer.subarray(0, length).toString('utf8').replace(/[\r\n]+$/u, '');
}

function runProductionOnboarding(runtime = {}) {
  const operations = {
    setup: runtime.setup ?? (() => setupCommand(['production', '--guided'])),
    doctor: runtime.doctor ?? (() => productionDoctor([])),
    dryRun: runtime.dryRun ?? (() => deployProduction(['production', '--dry-run'])),
    deploy: runtime.deploy ?? (() => deployProduction(['production', '--confirm'])),
    verify: runtime.verify ?? (() => verifyProduction(['production'])),
    values: runtime.values ?? (() => validateRuntime({ production: true })),
    readLine: runtime.readLine ?? terminalReadLine,
    write: runtime.write ?? info,
  };

  operations.write('[1/5] Configure this production server');
  operations.setup();
  operations.write('[2/5] Check host, release, and configuration');
  operations.doctor();
  operations.write('[3/5] Prove the deployment plan without changing production');
  operations.dryRun();
  operations.write('[4/5] Deploy the verified release');
  operations.write('Deploy this verified release now? [y/N]');
  if (!/^(?:y|yes)$/iu.test(operations.readLine().trim())) {
    throw new Error('production deployment cancelled; resume with ./revival onboard production');
  }
  operations.deploy();
  operations.write('[5/5] Verify production and hand off to Center');
  operations.verify();
  const origin = operations.values().REVIVAL_PUBLIC_ORIGIN;
  operations.write(`Setup complete: ${origin}/login?next=%2Fsettings%2Fpin%2Fsetup`);
  operations.write('Finish provider setup and the stock Pin installation in Center.');
}

function onboardCommand(args) {
  try {
    if (args.length !== 1 || args[0] !== 'production') throw new Error('usage');
    runProductionOnboarding();
  } catch (error) {
    fail(error.message === 'usage' ? `usage: ${ONBOARD_USAGE}` : error.message,
      error.message === 'usage' ? 64 : 1);
  }
}

module.exports = { ONBOARD_USAGE, onboardCommand, runProductionOnboarding };
