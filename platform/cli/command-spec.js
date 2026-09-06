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
      !Array.isArray(contract.journeys) || !Array.isArray(contract.settings) ||
      contract.status?.schemaVersion !== 4 || !Array.isArray(contract.status.states) ||
      !Array.isArray(contract.status.releaseCompatibility?.operatorFields) ||
      !Array.isArray(contract.status.releaseCompatibility?.pinIdentityFields) ||
      !Array.isArray(contract.status.releaseCompatibility?.observedPinFields)) {
    throw new Error(`${CONTRACT_FILE} is not a supported schema-version 1 contract`);
  }
  return contract;
}

function releaseCompatibility() {
  return operatorContract().status.releaseCompatibility;
}

function pinReleaseIdentityMatches(left, right) {
  if (!left || !right) return false;
  return releaseCompatibility().pinIdentityFields.every((field) => left[field] === right[field]);
}

function versionInfo() {
  const version = loadJson(VERSION_FILE, 'version descriptor');
  const sourceCheckout = version?.kind === 'source-checkout';
  const fields = version && typeof version === 'object' && !Array.isArray(version)
    ? Object.keys(version).sort().join('\0') : '';
  if (typeof version.version !== 'string' || !version.version ||
      (sourceCheckout
        ? fields !== 'application\0kind\0revision\0version' || version.revision !== 'source' || version.application !== null
        : version.schemaVersion !== 2)) {
    throw new Error(`${VERSION_FILE} is not a supported version descriptor`);
  }
  const revision = version.revision ?? 'source';
  const application = version.application ?? null;
  if (revision !== 'source' && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(`${VERSION_FILE} has an invalid source revision`);
  }
  if (application !== null &&
      !/^oci:\/\/ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(application)) {
    throw new Error(`${VERSION_FILE} has an invalid OCI application reference`);
  }
  const contract = operatorContract();
  let source = null;
  let pin = null;
  if (!sourceCheckout) {
    if (fields !== 'application\0pin\0revision\0schemaVersion\0source\0version') {
      throw new Error(`${VERSION_FILE} contains missing or unexpected published release fields`);
    }
    source = version.source;
    pin = version.pin;
    const sourceFields = source && typeof source === 'object' && !Array.isArray(source)
      ? Object.keys(source).sort() : [];
    const pinFields = pin && typeof pin === 'object' && !Array.isArray(pin)
      ? Object.keys(pin).sort() : [];
    if (sourceFields.join('\0') !== 'repository\0tag' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository) ||
        source.tag !== `v${version.version}` ||
        pinFields.join('\0') !== [
          'archive', 'manifestSha256', 'receiptsSha256', 'releaseId', 'schemaVersion',
          'sha256', 'signerSha256', 'size', 'version', 'versionCode',
        ].sort().join('\0') || pin.schemaVersion !== 1 ||
        pin.archive !== `ai-pin-revival-pin-${pin.version}.tar.gz` ||
        !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(pin.version) ||
        !Number.isSafeInteger(pin.size) || pin.size < 1 ||
        !Number.isSafeInteger(pin.versionCode) || pin.versionCode < 1 ||
        ['sha256', 'releaseId', 'signerSha256', 'manifestSha256', 'receiptsSha256']
          .some((field) => !/^[0-9a-f]{64}$/u.test(pin[field]))) {
      throw new Error(`${VERSION_FILE} has invalid matching Pin release metadata`);
    }
  }
  return Object.freeze({
    product: 'Ai Pin Revival',
    version: version.version,
    revision,
    application,
    source,
    pin,
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
  if (argv.at(-1) === 'help') return { requested: true, tokens: longestKnownPath(argv.slice(0, -1)) };
  if (!argv.some((item) => HELP_FLAGS.has(item))) return { requested: false, tokens: [] };
  const withoutFlags = argv.filter((item) => !HELP_FLAGS.has(item));
  return { requested: true, tokens: longestKnownPath(withoutFlags) };
}

const DETAILS = Object.freeze({
  'doctor.local': 'Options: --json. Reports PASS, WARN, FAIL, a fix for every failure, and one next action.',
  'dev.center': 'Starts the development stack in the foreground. Compose syncs source changes and rebuilds only when dependency manifests change.',
  'dev.down': 'Stops only the ai-pin-revival-dev Compose project and retains its dependency and Next.js cache volumes.',
  'check.center': 'Runs Center and Spotify adapter checks directly from the working tree, reusing installed dependencies and external build caches without a production Next.js build.',
  'check.cosmos': 'A nonempty TEST_FILTER is verified with Cargo/libtest discovery before every match, including ignored tests, runs. Without a filter, clippy and the full ordinary workspace tests run.',
  'check.platform': 'Runs the fast contributor acceptance suite directly from the working tree. --full dynamically includes every top-level Node acceptance test; CI and release own shell policies.',
  'check.changed': 'Options: --base REF. Uses only origin/HEAD, origin/main, or origin/master automatically; without one it checks the full tracked tree. Safety-sensitive paths run platform --full.',
  'client.build.macos': 'Apple Silicon macOS source build. Compiles the shared Rust client and Swift shell into a development app at a stable path under the external build directory, ad-hoc signed unless REVIVAL_MACOS_CODESIGN_IDENTITY names a Keychain code-signing identity that keeps the stored installation identity readable across rebuilds. Does not launch, install, enroll or access the user Keychain.',
  'client.check.macos': 'Compiles the shared Rust library and Swift shell, then runs native client tests with external caches. Does not launch or install the app.',
  'client.build.android': 'Cross-compiles the shared Rust client with the Pin builder’s pinned NDK and assembles the Kotlin shell into a debug APK under the external build directory. Requires an Android SDK with platform 35, the NDK and the aarch64-linux-android Rust target. Does not install or enroll.',
  'client.check.android': 'Cross-compiles the shared Rust client, runs the Android unit tests and assembles the debug APK with external caches. Does not install the app.',
  'client.install.android': 'Options: --serial SERIAL [--confirm]. Installs the previously built development APK on exactly one attached Android device with adb. Without --confirm it only prints the plan. Enrollment and Center approval stay explicit steps in the app.',
  'client.build.linux': 'Cross-compiles the shared Rust client for x86_64 Linux inside the digest-pinned Trixie builder image (Docker with network for crates and the digest-verified libwebrtc archive, which stays in a Docker volume because its tree cannot live on a case-insensitive host filesystem), then writes cosmos-linux-x86_64.tar.gz with the Python/Qt Quick app, the library, requirements, the user-local installer and the optional Hyprland/Waybar examples under the external build directory. Does not install, launch or enroll.',
  'client.check.linux': 'Runs the Linux client’s Python unit tests (unittest) and compiles every module with a host Python 3.11 or newer; the ctypes smoke test runs against the shared client library left in the external Cargo target by client check macos. No Docker, no app launch.',
  'onboard.production': 'Interactive and resumable. Reuses the canonical production setup, doctor, dry-run, confirmed deploy, and verification commands. Failures report the stopped stage, preserved state, one recovery check, and a safe retry; provider and Pin setup continue in Center.',
  'deploy.production': 'Runs the direct Cosmos deployment on this host. Use --dry-run to print the Compose command or --confirm to apply it.',
  'registry.login': 'Logs in to ghcr.io with Docker’s hidden interactive token prompt. Credentials are stored only in the managed Docker configuration used by production deploys.',
  'verify.production': 'Validates healthy services, the configured Center release, OIDC, capture routing, and the configured Pin certificate chain when enabled.',
  'setup.local': 'Creates the external local configuration and generated secrets. It does not start containers.',
  'setup.contributor': 'Creates the external contributor configuration and caches. It does not run gates.',
  'setup.production': 'Requires --domain, --acme-email and --operator-email initially. Optional profiles: pin, search, spotify, observability. --no-profiles clears active profiles. Production releases use prebuilt images and a digest-pinned OCI Compose application.',
  'setup.pin': 'Creates host-side Pin prerequisites. It never reads from or writes to a device.',
  'setup.status': 'Options: --json. Recomputes readiness from current artifacts; no progress state is stored.',
  'config.path': 'Options: --json. Prints the active external runtime configuration path.',
  'config.get': 'Usage: revival config get NAME [--json]. Secret values are reported only as set or unset.',
  'config.set': 'Usage: revival config set NAME VALUE | revival config set NAME --stdin. Secrets accept --stdin only.',
  'config.check': 'Options: --json. Checks the contract-backed settings and their dependencies.',
  'config.list': 'Options: --group local|production|provider|pin, --json. Never prints values.',
  'config.template': 'Options: --group local|production|provider|pin. Omits every secret setting.',
  'support-bundle': 'Options: --output FILE, --json. Writes a fixed, redacted allowlist outside the source tree at mode 0600.',
  version: 'Options: --json. Reads the version stamped into this release.',
  'pki.init': 'Usage: revival pki init device-user [--confirm]. Plans unless --confirm is supplied; never changes the attestation CA.',
  'pki.import': 'Usage: revival pki import device-user --cert FILE --key FILE [--confirm]. Plans unless confirmed.',
  'pin.activate': 'Usage: revival pin activate --serial SERIAL --credential-file FILE --edge-ipv4 A.B.C.D [--confirm]. Exact serial and confirmation are enforced by the activation tool.',
  'pin.activate.status': 'Usage: revival pin activate status --serial SERIAL. Read-only.',
  'pin.network': 'Usage: revival pin network --serial SERIAL. Reads status without printing SSID or BSSID.',
  'pin.network.qr': 'Usage: revival pin network qr [--open]. Credentials remain browser-local and never enter argv.',
  'pin.install': 'Without --confirm this resolves the exact serial and release, prints a plan, and leaves the device untouched.',
  'pin.build-debug': 'Credential-free and non-installable. Select roles with repeated --role, or use --changed [--base REF]. Reuses the pinned linux/amd64 builder and external build caches; every role refuses release signing inputs.',
  'pin.release.build': 'Usage: revival pin release build --version YYYY-MM-DD.N --version-code INTEGER. Builds the signed five-APK release into the external store mounted by Center. It never runs ADB or mutates a device.',
  'pin.release.acquire': 'Usage: revival pin release acquire [--archive FILE | --check] [--json]. Authenticates and downloads only this operator release’s exact archive, or verifies an explicit offline copy; both paths verify size, SHA-256, internal identity, signer, and APKs before staging outside Center.',
  'pin.release.export': 'Usage: revival pin release export --output ARCHIVE [--json]. Exports the current verified five-APK release for publication.',
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
    '  revival pin release acquire',
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
  if (heading === 'pin release') notes.push('Acquire publishes only this operator release’s exact signed archive.');
  if (heading === 'config') notes.push('Bare `revival config` renders the Compose model.');
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
  // A prefix with children is a group even when it is also the bare `config`
  // command, because help must expose the discoverable subcommands.
  if (isGroup(tokens, contract)) return renderGroupHelp(tokens, contract);
  const resolved = findCommand(tokens, contract);
  if (resolved) return renderCommandHelp(resolved.command);
  return renderRootHelp(contract);
}

module.exports = {
  CONTRACT_FILE,
  VERSION_FILE,
  operatorContract,
  releaseCompatibility,
  pinReleaseIdentityMatches,
  versionInfo,
  findCommand,
  isGroup,
  requestedHelp,
  renderHelp,
};
