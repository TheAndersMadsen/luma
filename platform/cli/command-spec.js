'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT_FILE = path.join(ROOT, 'contracts', 'operator-setup.json');
const VERSION_FILE = path.join(ROOT, 'platform', 'distribution', 'version.json');
const HELP_FLAGS = new Set(['--help', '-h']);

function loadJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function operatorContract() {
  const contract = loadJson(CONTRACT_FILE, 'operator setup contract');
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.commands) ||
      !Array.isArray(contract.journeys) || !Array.isArray(contract.settings)) {
    throw new Error(`${CONTRACT_FILE} is not a supported schema-version 1 contract`);
  }
  return contract;
}

function versionInfo() {
  const version = loadJson(VERSION_FILE, 'version descriptor');
  if (version.schemaVersion !== 1 || typeof version.version !== 'string' || !version.version) {
    throw new Error(`${VERSION_FILE} is not a supported schema-version 1 descriptor`);
  }
  const contract = operatorContract();
  return Object.freeze({
    product: 'Ai Pin Revival',
    version: version.version,
    contractVersion: contract.contractVersion,
  });
}

function sameTokens(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function commandPaths(command) {
  return [command.tokens, ...command.aliases];
}

function findCommand(tokens, contract = operatorContract()) {
  for (const command of contract.commands) {
    for (const candidate of commandPaths(command)) {
      if (sameTokens(candidate, tokens)) return { command, alias: candidate !== command.tokens };
    }
  }
  return null;
}

function commandPrefixes(contract = operatorContract()) {
  const prefixes = new Map();
  for (const command of contract.commands.filter((entry) => entry.lifecycle === 'current')) {
    for (const tokens of commandPaths(command)) {
      for (let length = 1; length < tokens.length; length += 1) {
        const prefix = tokens.slice(0, length);
        prefixes.set(prefix.join('\0'), prefix);
      }
    }
  }
  return prefixes;
}

function isGroup(tokens, contract = operatorContract()) {
  return commandPrefixes(contract).has(tokens.join('\0'));
}

function longestKnownPath(tokens, contract = operatorContract()) {
  for (let length = tokens.length; length > 0; length -= 1) {
    const candidate = tokens.slice(0, length);
    if (findCommand(candidate, contract) || isGroup(candidate, contract)) return candidate;
  }
  return [];
}

function requestedHelp(argv) {
  if (argv[0] === 'help') return { requested: true, tokens: argv.slice(1).filter((item) => !HELP_FLAGS.has(item)) };
  if (!argv.some((item) => HELP_FLAGS.has(item))) return { requested: false, tokens: [] };
  const withoutFlags = argv.filter((item) => !HELP_FLAGS.has(item));
  return { requested: true, tokens: longestKnownPath(withoutFlags) };
}

const DETAILS = Object.freeze({
  'doctor.local': 'Options: --json. Reports PASS, WARN, FAIL, a fix for every failure, and one next action.',
  'dev.center': 'Starts the development stack in the foreground. Compose syncs source changes and rebuilds only when dependency manifests change.',
  'dev.down': 'Stops only the ai-pin-revival-dev Compose project and retains its dependency and Next.js cache volumes.',
  'check.center': 'Uses a disposable Git snapshot and reusable dependency seeds under REVIVAL_BUILD_DIR; it checks Center and the Spotify adapter without a production Next.js build.',
  'check.cosmos': 'A nonempty TEST_FILTER is verified with Cargo/libtest discovery before every match, including ignored tests, runs. Without a filter, clippy and the full ordinary workspace tests run.',
  'check.platform': 'Uses a clean external snapshot, batches isolation-safe acceptance files with bounded concurrency, then serializes cleanliness/release fixtures.',
  'check.changed': 'Options: --base REF. Prefers origin/HEAD then conventional main/master refs; without one it checks the full tree. Includes both rename sides and fails closed for unknown paths.',
  'release.candidate.prepare': 'Requires a native linux/amd64 builder. Builds once from a detached exact commit and seals the release, image bundle, Git identity, toolchains, and production-state contract outside the source tree.',
  'release.candidate.verify': 'Filesystem-only verification. It never invokes Git, Docker, a shell, or candidate-controlled code.',
  'release.candidate.inspect': 'Read-only. Reports exact identities and whether the candidate matches the protected live Carry storage contract.',
  'deploy.production': 'Requires --confirm and exactly one freshly provider-reverified hosted candidate. --dry-run is local-only and cannot be combined with confirmation; local prepared candidates are never deployable.',
  backup: 'Requires --confirm before creating the production backup or fetching its verified off-host copy.',
  canary: 'Requires --confirm before running production semantic canaries.',
  rollback: 'Requires --confirm and an exact prior deployment ID. It changes application release state but never restores a database.',
  'setup.local': 'Selects the local track and recomputes evidence. It does not start containers.',
  'setup.contributor': 'Selects the contributor track and recomputes evidence. It does not run gates.',
  'setup.production': 'Selects the production track. It never connects to or changes a remote host.',
  'setup.pin': 'Selects the Pin track. It never reads from or writes to a device.',
  'setup.resume': 'Resumes the selected track by showing its current evidence and next action.',
  'setup.status': 'Options: --json. Recomputes evidence; no serial or secret is stored.',
  'config.path': 'Options: --json. Prints the active external runtime configuration path.',
  'config.get': 'Usage: revival config get NAME [--json]. Secret values are reported only as set or unset.',
  'config.set': 'Usage: revival config set NAME VALUE | revival config set NAME --stdin. Secrets accept --stdin only.',
  'config.check': 'Options: --json. Checks the contract-backed settings and their dependencies.',
  'config.list': 'Options: --group local|production|provider|pin, --json. Never prints values.',
  'config.template': 'Options: --group local|production|provider|pin. Omits every secret setting.',
  'support-bundle': 'Options: --output FILE, --json. Writes a fixed, redacted allowlist outside the source tree at mode 0600.',
  version: 'Options: --json. Reads the version stamped into this release.',
  'adopt-config': 'WITHOUT --confirm this only PLANS. A confirmation requires --reason and applies to the pending/current deployment baseline named by the plan.',
  'prune-state': 'Without --confirm this only plans retention. Use --expect-plan with confirmation to bind the exact reviewed plan.',
  'pki.init': 'Usage: revival pki init device-user [--confirm]. Plans unless --confirm is supplied; never changes the attestation CA.',
  'pki.import': 'Usage: revival pki import device-user --cert FILE --key FILE [--confirm]. Plans unless confirmed.',
  'pin.activate': 'Usage: revival pin activate --serial SERIAL --credential-file FILE --edge-ipv4 A.B.C.D [--confirm]. Exact serial and confirmation are enforced by the activation tool.',
  'pin.activate.status': 'Usage: revival pin activate status --serial SERIAL. Read-only.',
  'pin.network': 'Usage: revival pin network --serial SERIAL. Reads status without printing SSID or BSSID.',
  'pin.network.qr': 'Usage: revival pin network qr [--open]. Credentials remain browser-local and never enter argv.',
  'pin.install': 'Without --confirm this resolves the exact serial and release, prints a plan, and leaves the device untouched.',
  'pin.build-debug': 'Credential-free and non-installable. Select fixed roles with repeated --role, or use --changed [--base REF]. Uses the canonical linux/amd64 builder with fresh tool homes and only narrow external cache-data leaves; Server selections compile runtime/core Rust and every role refuses release signing inputs.',
  'pin.release.build': 'Usage: revival pin release build --version YYYY-MM-DD.N --version-code INTEGER. The retired local signing alias refuses before opening protected inputs; use the pinned Attested Pin release workflow on main. It never runs ADB or mutates a device.',
  'pin.release.ship': 'Plans by default. --confirm publishes to the remote Center release store.',
});

function safetyText(command) {
  if (command.effect === 'read-only') {
    return command.exactSerialRequired
      ? 'Safety: read-only; an exact --serial selects the device to inspect, but no device state is changed.'
      : 'Safety: read-only; this command does not change local, remote, or device state.';
  }
  if (command.exactSerialRequired) {
    return 'Safety: device mutation requires --confirm and an exact --serial; the delegated tool revalidates both.';
  }
  if (command.effect === 'remote-mutation') {
    if (['adopt-config', 'prune-state', 'pin.release.ship'].includes(command.id)) {
      return 'Safety: this remote mutation plans first and changes state only with --confirm.';
    }
    return command.confirmationRequired
      ? 'Safety: remote mutation requires the command’s documented confirmation and target guards; inspect the plan before confirming.'
      : 'Safety: this command changes remote state; inspect its exact target before running it.';
  }
  if (command.effect === 'local-mutation' && !command.confirmationRequired) {
    return 'Safety: local mutation only; this command does not change a remote host or a device.';
  }
  return 'Safety: the local mutation is planned first and commits only with its documented confirmation.';
}

function childEntries(prefix, contract) {
  const rows = new Map();
  for (const command of contract.commands.filter((entry) => entry.lifecycle === 'current')) {
    const tokens = command.tokens;
    if (tokens.length <= prefix.length || !prefix.every((token, index) => token === tokens[index])) continue;
    const childPath = tokens.slice(0, prefix.length + 1);
    const child = childPath[childPath.length - 1];
    if (!rows.has(child)) {
      const exact = findCommand(childPath, contract)?.command;
      rows.set(child, exact?.summary || `${child} commands`);
    }
  }
  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderRootHelp(contract) {
  const top = childEntries([], contract);
  const width = Math.max(...top.map(([name]) => name.length), 1);
  const backupUsage = findCommand(['backup'], contract)?.command.usage;
  return [
    'Ai Pin Revival',
    '',
    'Usage: revival COMMAND [options]',
    '',
    'Commands:',
    ...top.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    'Short local aliases: build, up, down, status, logs, config.',
    'Pin host operations (no device mutation) are under `revival pin`; device actions plan unless explicitly confirmed.',
    '  revival pin release build --version YYYY-MM-DD.N --version-code INTEGER',
    '  revival adopt-config [--confirm --reason TEXT [--expect-plan TOKEN]]',
    ...(backupUsage ? [`  ${backupUsage}`] : []),
    '`backup --fetch` creates the off-host copy of irreplaceable key material.',
    '',
    'Safety: help is read-only and side-effect-free. Each command help names whether it reads state or mutates local, remote, or device state.',
    '',
    'Run `revival COMMAND --help` for command-specific help.',
  ].join('\n');
}

function renderGroupHelp(tokens, contract) {
  const rows = childEntries(tokens, contract);
  const width = Math.max(...rows.map(([name]) => name.length), 1);
  const heading = tokens.join(' ');
  const defaultCommand = findCommand(tokens, contract)?.command || null;
  const notes = [];
  if (heading === 'pin release') notes.push('Pin release host contract (read-only). Ship still plans until explicitly confirmed.');
  if (heading === 'config') notes.push('Bare `revival config` retains its compatibility behavior: render the Compose model.');
  if (heading === 'pin') notes.push('Device mutation requires an exact serial and explicit confirmation in the delegated tool.');
  return [
    defaultCommand
      ? `Usage: revival ${heading} [options] | revival ${heading} COMMAND [options]`
      : `Usage: revival ${heading} COMMAND [options]`,
    '',
    ...notes,
    ...(notes.length ? [''] : []),
    'Safety: help is read-only and side-effect-free; inspect each command’s Safety line before running it.',
    '',
    ...(defaultCommand ? [
      `Default: ${defaultCommand.summary}`,
      ...(DETAILS[defaultCommand.id] ? [DETAILS[defaultCommand.id]] : []),
      ...(safetyText(defaultCommand) ? [safetyText(defaultCommand)] : []),
      '',
    ] : []),
    'Commands:',
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    `Run \`revival ${heading} COMMAND --help\` for command-specific help.`,
  ].join('\n');
}

function renderCommandHelp(command) {
  const detail = DETAILS[command.id];
  const safety = safetyText(command);
  return [
    `Usage: ${command.usage}`,
    '',
    command.summary,
    detail ? `\n${detail}` : '',
    safety ? `\n${safety}` : '',
    command.documentationAnchor ? `\nGuide: ${command.documentationAnchor}` : '',
  ].filter((line) => line !== '').join('\n');
}

function renderHelp(tokens = []) {
  const contract = operatorContract();
  if (tokens.length === 0) return renderRootHelp(contract);
  // A prefix with children is a group even when it is also a compatibility
  // alias (`config`), because help must expose the discoverable new surface.
  if (isGroup(tokens, contract)) return renderGroupHelp(tokens, contract);
  const resolved = findCommand(tokens, contract);
  if (resolved) return renderCommandHelp(resolved.command);
  return renderRootHelp(contract);
}

module.exports = {
  CONTRACT_FILE,
  VERSION_FILE,
  operatorContract,
  versionInfo,
  findCommand,
  isGroup,
  requestedHelp,
  renderHelp,
};
