'use strict';
// Pin host operations: doctor, check, releases, ship, and the plan/confirm install passthrough.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const fs = require('node:fs');

const {
  PIN_RELEASE_TOOL, PIN_RELEASE_BUILD_TOOL, PIN_RELEASE_SHIP_TOOL, PIN_INSTALL_TOOL, PIN_DOCTOR_TOOL,
  PIN_ACTIVATION_TOOL, PIN_NETWORK_TOOL, ENV_FILE, fail, operatorEnvironment, parseEnvFile, resolveTool, run,
} = require('./context');
const { pinContributorCheck } = require('./gates');
const { pinDebugBuild } = require('./pin-debug');

function pinCommand(args) {
  const subcommand = args.shift();
  if (subcommand === 'doctor') {
    run(resolveTool('node'), [PIN_DOCTOR_TOOL, ...args]);
    return;
  }
  if (subcommand === 'check') {
    if (args.length !== 0) fail('usage: ./revival pin check', 64);
    pinContributorCheck();
    return;
  }
  if (subcommand === 'build-debug') {
    pinDebugBuild(args);
    return;
  }
  if (subcommand === 'release') {
    const operation = args[0];
    if (!operation || !['help', '--help', '-h', 'build', 'inspect', 'verify', 'plan', 'ship'].includes(operation)) {
      fail('usage: ./revival pin release build|inspect|verify|plan|ship ...', 64);
    }
    if (operation === 'build') run(resolveTool('node'), [PIN_RELEASE_BUILD_TOOL, ...args]);
    // `ship` is the only Pin subcommand that writes outside this machine, and
    // like `pin install` it plans until it is given --confirm.
    else if (operation === 'ship') {
      const confirmations = args.filter((argument) => argument === '--confirm').length;
      if (confirmations > 1) fail('pin release ship accepts exactly one literal --confirm', 64);
      run(resolveTool('node'), [PIN_RELEASE_SHIP_TOOL, ...args]);
      return;
    } else {
      run(resolveTool('node'), [PIN_RELEASE_TOOL, ...args]);
      return;
    }
    return null;
  }
  // The one subcommand under `pin` that can change a device, which is why it is
  // the one that demands a flag: without --confirm it resolves the release,
  // reads the Pin read-only, prints the plan and stops. The tool's own --help
  // says so in full; `./revival pin install --help` reaches it.
  if (subcommand === 'install') {
    run(resolveTool('node'), [PIN_INSTALL_TOOL, ...args]);
    return null;
  }
  if (subcommand === 'activate') {
    run(resolveTool('node'), [PIN_ACTIVATION_TOOL, ...args]);
    return null;
  }
  if (subcommand === 'network') {
    let values;
    try {
      values = fs.existsSync(ENV_FILE) ? parseEnvFile(ENV_FILE) : undefined;
    } catch (error) {
      fail(error.message);
    }
    run(resolveTool('node'), [PIN_NETWORK_TOOL, ...args], { env: operatorEnvironment(values) });
    return null;
  }
  fail(
    'usage: ./revival pin doctor | check | build-debug --role ROLE [--role ROLE] | build-debug --changed [--base REF] | release build|inspect|verify|plan|ship ... |\n' +
    '              install [--confirm] [--serial SERIAL] | activate ... | network ...\n' +
    '       `install` without --confirm only plans and leaves the device untouched;\n' +
    '       `install --confirm` modifies the connected Pin. See `./revival pin install --help`.',
    64
  );
}

module.exports = { pinCommand };
