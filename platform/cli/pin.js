'use strict';
// Pin host operations: doctor, check, releases, and the plan/confirm install passthrough.
// Split out of the root `luma` entry point. Behavior, messages, and exit
// codes are unchanged.

const fs = require('node:fs');
const path = require('node:path');

const {
  PIN_RELEASE_BUILD_TOOL, PIN_RELEASE_ACQUIRE_TOOL, PIN_RELEASE_EXPORT_TOOL,
  PIN_INSTALL_TOOL, PIN_DOCTOR_TOOL, DATA_DIR,
  PIN_ACTIVATION_TOOL, PIN_NETWORK_TOOL, ENV_FILE, fail, info, operatorEnvironment, parseEnvFile, resolveTool, run,
  secureDirectory,
} = require('./context');
const { pinContributorCheck } = require('./gates');
const { pinDebugBuild } = require('./pin-debug');

// `pin release build` makes the new release current and removes every other
// release from the local store, so the release it replaces is exported first,
// once per release, to pin-release-exports/RELEASE_ID/luma-pin-VERSION.tar.gz.
function keepCurrentPinRelease({
  dataDir = DATA_DIR,
  exportRelease = (archive) => run(resolveTool('bun'), [PIN_RELEASE_EXPORT_TOOL, '--output', archive]),
} = {}) {
  const pointer = path.join(dataDir, 'pin-releases', 'current.json');
  let current;
  try {
    current = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`cannot read the current Pin release ${pointer} (${error.message}); ` +
      'move it aside before building, so a build cannot remove the release it names');
  }
  if (!/^[0-9a-f]{64}$/u.test(current?.releaseId ?? '') || !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(current?.version ?? '')) {
    fail(`${pointer} does not name a Pin release; move it aside before building`);
  }
  const exports = path.join(dataDir, 'pin-release-exports');
  const archive = path.join(exports, current.releaseId, `luma-pin-${current.version}.tar.gz`);
  if (!fs.existsSync(archive)) {
    secureDirectory(exports);
    secureDirectory(path.dirname(archive));
    exportRelease(archive);
  }
  info(`[pin] the current Pin release ${current.version} is kept at ${archive}`);
  return archive;
}

function pinCommand(args) {
  const subcommand = args.shift();
  if (subcommand === 'doctor') {
    run(resolveTool('bun'), [PIN_DOCTOR_TOOL, ...args]);
    return;
  }
  if (subcommand === 'check') {
    if (args.length !== 0) fail('usage: ./luma pin check', 64);
    pinContributorCheck();
    return;
  }
  if (subcommand === 'build-debug') {
    pinDebugBuild(args);
    return;
  }
  if (subcommand === 'dock') {
    const { dockCommand } = require('./pin-dock');
    const code = dockCommand(args);
    if (typeof code === 'number') process.exit(code);
    return;
  }
  if (subcommand === 'release') {
    const operation = args[0];
    const tools = {
      build: PIN_RELEASE_BUILD_TOOL,
      acquire: PIN_RELEASE_ACQUIRE_TOOL,
      export: PIN_RELEASE_EXPORT_TOOL,
    };
    if (!tools[operation]) {
      fail('usage: ./luma pin release build ... | acquire [--archive FILE | --check] [--json] | export --output ARCHIVE [--json]', 64);
    }
    if (operation === 'build') keepCurrentPinRelease();
    run(resolveTool('bun'), [tools[operation], ...(operation === 'build' ? args : args.slice(1))]);
    return null;
  }
  // The one subcommand under `pin` that can change a device, which is why it is
  // the one that demands a flag: without --confirm it resolves the release,
  // reads the Pin read-only, prints the plan and stops. The tool's own --help
  // says so in full; `./luma pin install --help` reaches it.
  if (subcommand === 'install') {
    run(resolveTool('bun'), [PIN_INSTALL_TOOL, ...args]);
    return null;
  }
  if (subcommand === 'activate') {
    run(resolveTool('bun'), [PIN_ACTIVATION_TOOL, ...args]);
    return null;
  }
  if (subcommand === 'network') {
    let values;
    try {
      values = fs.existsSync(ENV_FILE) ? parseEnvFile(ENV_FILE) : undefined;
    } catch (error) {
      fail(error.message);
    }
    run(resolveTool('bun'), [PIN_NETWORK_TOOL, ...args], { env: operatorEnvironment(values) });
    return null;
  }
  fail(
    'usage: ./luma pin doctor | check | build-debug --role ROLE [--role ROLE] | build-debug --changed [--base REF] | release build|acquire|export ... |\n' +
    '              install [--confirm] [--serial SERIAL] | activate ... | network ... | dock check|build|run|verify|report|follow ...\n' +
    '       `install` without --confirm only plans and leaves the device untouched;\n' +
    '       `install --confirm` modifies the connected Pin. See `./luma pin install --help`.',
    64
  );
}

module.exports = { keepCurrentPinRelease, pinCommand };
