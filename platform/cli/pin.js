'use strict';
// Pin host operations: doctor, check, releases, ship, and the plan/confirm install passthrough.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  PIN_RELEASE_TOOL, PIN_RELEASE_BUILD_TOOL, PIN_RELEASE_SHIP_TOOL, PIN_INSTALL_TOOL, PIN_DOCTOR_TOOL, fail, run,
} = require('./context');
const { pinSourceCheck } = require('./gates');

function pinCommand(args) {
  const subcommand = args.shift();
  if (subcommand === 'doctor') {
    run('node', [PIN_DOCTOR_TOOL, ...args]);
    return;
  }
  if (subcommand === 'check') {
    if (args.length !== 0) fail('usage: ./revival pin check', 64);
    pinSourceCheck();
    return;
  }
  if (subcommand === 'release') {
    const operation = args[0];
    if (!operation || !['help', '--help', '-h', 'build', 'inspect', 'verify', 'plan', 'ship'].includes(operation)) {
      fail('usage: ./revival pin release build|inspect|verify|plan|ship ...', 64);
    }
    if (operation === 'build') run('node', [PIN_RELEASE_BUILD_TOOL, ...args]);
    // `ship` is the only Pin subcommand that writes outside this machine, and
    // like `pin install` it plans until it is given --confirm.
    else if (operation === 'ship') run('node', [PIN_RELEASE_SHIP_TOOL, ...args]);
    else run('node', [PIN_RELEASE_TOOL, ...args]);
    return;
  }
  // The one subcommand under `pin` that can change a device, which is why it is
  // the one that demands a flag: without --confirm it resolves the release,
  // reads the Pin read-only, prints the plan and stops. The tool's own --help
  // says so in full; `./revival pin install --help` reaches it.
  if (subcommand === 'install') {
    run('node', [PIN_INSTALL_TOOL, ...args]);
    return;
  }
  fail(
    'usage: ./revival pin doctor | check | release build|inspect|verify|plan|ship ... |\n' +
    '              install [--confirm] [--serial SERIAL]\n' +
    '       `install` without --confirm only plans and leaves the device untouched;\n' +
    '       `install --confirm` modifies the connected Pin. See `./revival pin install --help`.',
    64
  );
}

module.exports = { pinCommand };
