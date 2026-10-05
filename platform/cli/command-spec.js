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
  let updateSource = null;
  let notes = null;
  let publishedAt = null;
  if (!sourceCheckout) {
    // Releases since automatic updates also name their default update source,
    // release notes, and publication time. Earlier releases carry none.
    const extended = 'application\0notes\0pin\0publishedAt\0revision\0schemaVersion\0source\0updateSource\0version';
    if (fields !== 'application\0pin\0revision\0schemaVersion\0source\0version' && fields !== extended) {
      throw new Error(`${VERSION_FILE} contains missing or unexpected published release fields`);
    }
    if (fields === extended) {
      if (typeof version.updateSource !== 'string' || !/^https?:\/\/[^/\s]+$/u.test(version.updateSource) ||
          (version.notes !== null && (typeof version.notes !== 'string' || version.notes.length > 2000)) ||
          typeof version.publishedAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(version.publishedAt)) {
        throw new Error(`${VERSION_FILE} has an invalid update source, release notes, or publication time`);
      }
      ({ updateSource, notes, publishedAt } = version);
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
        pin.archive !== `luma-pin-${pin.version}.tar.gz` ||
        !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(pin.version) ||
        !Number.isSafeInteger(pin.size) || pin.size < 1 ||
        !Number.isSafeInteger(pin.versionCode) || pin.versionCode < 1 ||
        ['sha256', 'releaseId', 'signerSha256', 'manifestSha256', 'receiptsSha256']
          .some((field) => !/^[0-9a-f]{64}$/u.test(pin[field]))) {
      throw new Error(`${VERSION_FILE} has invalid matching Pin release metadata`);
    }
  }
  return Object.freeze({
    product: 'Luma',
    version: version.version,
    revision,
    application,
    source,
    pin,
    updateSource,
    notes,
    publishedAt,
    contractVersion: contract.contractVersion,
  });
}

// The released operator CLI (`luma-operator-VERSION/luma`) carries a
// published version descriptor. A source checkout does not. Next actions that
// name a checkout-only command must name the operator's own command instead.
function isOperatorRelease() {
  try {
    return versionInfo().revision !== 'source';
  } catch {
    return false;
  }
}

// -1, 0, or 1 for two MAJOR.MINOR.PATCH release versions, or null when either
// is not one (a configuration written before LUMA_RELEASE_VERSION existed).
function compareReleaseVersions(left, right) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value || '')?.slice(1).map(Number) ?? null;
  const [a, b] = [parse(left), parse(right)];
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

// A configured release as the owner finds it on the server: its version and
// release folder when runtime.env records the version, else its revision.
function describeRelease(id, version = '') {
  const short = /^[0-9a-f]{40}$/u.test(id || '') ? `${id.slice(0, 12)}…` : id;
  return version ? `Luma ${version} (release ${short}, folder luma-operator-${version})` : `release ${id}`;
}

const OPERATOR_SETUP_NEXT =
  './luma setup production --domain HOST --acme-email EMAIL --operator-email EMAIL ... (README "Get Luma")';

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
  'doctor.local': 'Reports PASS, WARN, FAIL, a fix for every failure, and one next action. Docker is read with your own Docker configuration, so doctor writes nothing.',
  'dev.center': 'Starts the development stack in the foreground. Compose syncs source changes and rebuilds only when dependency manifests change.',
  'dev.down': 'Stops only the luma-dev Compose project and retains its dependency and Next.js cache volumes.',
  'check.center': 'Runs Center and Spotify adapter checks directly from the working tree, reusing installed dependencies and external build caches without a production Next.js build.',
  'check.cosmos': 'A nonempty TEST_FILTER is verified with Cargo/libtest discovery before its matches run. Ignored tests need a live service the check does not start, so they run only when the filter matches nothing else (name one exactly). Without a filter, clippy and the full ordinary workspace tests run. Tests run against a throwaway loopback PostgreSQL container of the production image, so Docker must be running; the container is removed afterwards.',
  'check.platform': 'Runs the fast contributor acceptance suite directly from the working tree. --full dynamically includes every Node acceptance test, the Pin acceptance tests, and the Pin builder suites; CI and release own shell policies.',
  'check.changed': 'Options: --base REF. Without --base it compares with origin/HEAD, origin/main, or origin/master, so unpushed local commits count as changes; without any of them it checks the full tracked tree. For uncommitted work, --base HEAD checks only the working-tree changes. Safety-sensitive paths run platform --full.',
  'onboard.production': 'Interactive and resumable. --update-source URL is the update source guided setup offers (bootstrap passes the Center it came from). Reuses the canonical production setup, doctor, dry-run, confirmed deploy, and verification commands. --pin-release-archive FILE passes the Pin archive delivered with this release to setup; when no matching Pin release is staged, guided setup asks for its path. Failures report the stopped stage, preserved state, one recovery check, and a safe retry; provider and Pin setup continue in Center.',
  'deploy.production': 'Runs on the production host itself. --dry-run lists every step --confirm takes, then the exact commands, and changes nothing. --confirm re-renders the edge configuration and operator overlay from this release, pulls and starts its digest-pinned images, recreates the edge containers (every hostname Traefik serves pauses briefly), switches Center to the staged Pin apps with the pin profile, applies the realm policy, and runs verify production.',
  'backup.production': 'Options: --output DIR (default: a new directory under LUMA_DATA_DIR/backups), --project-name NAME. Pauses every service except PostgreSQL and Traefik while the pg_dumpall and volume copies run, then resumes them; Traefik keeps serving other hostnames. Writes a mode-0700 directory with the database dump, the cosmos-state, center-data and iroh-bridge-data volumes, the production configuration with its CA roots and keys, runtime.env, the Pin release store, and a manifest with this operator’s release, the release the server runs, and each file’s SHA-256. The next release’s operator can back up the release it replaces, before or after its setup. Prints no secret.',
  'restore.production': 'Without --confirm, verifies every checksum, this operator’s release, and the target, prints the plan, and changes nothing. Refuses a running stack, and a stack or configuration of another release. --confirm replaces the configuration, volumes, and database, then runs deploy production --confirm, unless the backup was taken before this release’s setup: that configuration is deployed by the operator of the release it holds.',
  'reset-password.production': 'Options: --confirm, --project-name NAME. Without --confirm, names the account and the file and changes nothing. With --confirm, sets a new random password on the first operator through Keycloak’s admin CLI inside the running Keycloak container, clears any sign-in lockout, ends that account’s sessions, and writes the password to the mode-0600 first-login file. It never prints the password.',
  'registry.login': 'Only a private fork needs this: Luma’s releases and images are public. Logs in to ghcr.io with Docker’s hidden interactive token prompt. Credentials are stored in the managed Docker configuration used by production deploys; on an operator release the same token is also saved, without another prompt, as LUMA_SECRETS_DIR/github-token (mode 0600), which update production uses to download releases.',
  'update.production': 'Asks the update source (LUMA_UPDATE_SOURCE, a Center’s /api/version, 5-second timeout) for the newest release and writes LUMA_DATA_DIR/updates/status.json, which Center shows. --check stops there and prints whether this server is up to date. Otherwise, when a newer release exists, it asks at a terminal (--auto skips the question; the nightly timer uses it), downloads that release’s five files from GitHub (anonymously, or on a private fork with the token registry login saved as LUMA_SECRETS_DIR/github-token), verifies SHA256SUMS.sigstore.json with the release signing key packed in this operator and every file against the signed SHA256SUMS, unpacks the new operator into LUMA_DATA_DIR/operators/VERSION, and runs from it: backup production, setup production with the saved values and the verified Pin archive, deploy production --dry-run, deploy production --confirm, and verify production. LUMA_DATA_DIR/operators/current then names the new folder. When --auto fails after the configuration moved, it stops Luma, restores the backup with the new operator (the pre-update configuration, so nothing is deployed), deploys and verifies from the old folder, and points current back; automatic updates do not retry a release that was rolled back. Every failure ends with State: and Safe retry: lines. It refuses to run from a folder that is not the current operator (or, before one is recorded, the newest).',
  'release.publish': '--notes FILE (or - for standard input) adds plain-text release notes of at most 2000 characters to the release descriptor and version, which Center shows, and names them as the GitHub release body. Without --confirm, checks the clean checkout and annotated vVERSION tag, verifies the ghcr.io login can write the repository\u2019s packages, verifies any GitHub tag matches the local annotated tag, refuses a published GitHub release or existing image tags on ghcr.io, and prints the plan. With --confirm, builds the five images for linux/amd64 and linux/arm64 in parallel into the build cache, pushes them one at a time with retries, publishes the audited digest-pinned Compose application, builds and signs the Pin release from the protected signing.env with --pin-version (otherwise republishes the pinned signed archive), packs the operator archive, and signs its SHA256SUMS with the maintainer’s release signing key (LUMA_SECRETS_DIR/release/cosign.key; the password comes from COSIGN_PASSWORD or cosign’s hidden prompt), verifying the signature against the committed platform/distribution/release-signing.pub. The plan reports a missing key or placeholder public key, and a confirmed run refuses without them: ./luma release keygen creates them. Output and receipts live in LUMA_DATA_DIR/publication/vVERSION; a rerun resumes after the last finished step. Releases are published only from the maintainer’s machine; no CI path exists.',
  'release.keygen': 'Runs cosign generate-key-pair once into LUMA_SECRETS_DIR/release/ (cosign.key at mode 0600, its password from COSIGN_PASSWORD or cosign’s hidden prompt), writes the public key to platform/distribution/release-signing.pub and embeds it in bootstrap, and prints the files to commit after `bun platform/setup/generate.mjs --write`. Refuses to replace an existing key. Never prints the private key.',
  'release.announce': 'Posts one Discord embed for a release that is already published on GitHub: the release notes `release publish --notes` stored (headings become bold lines), the commits since the previous tag as links, and how to update. Without --confirm, refuses a missing or draft GitHub release and prints the exact message, sending nothing. With --confirm, posts it through the webhook saved in LUMA_SECRETS_DIR/release/discord-webhook and writes a receipt to LUMA_DATA_DIR/publication/vVERSION/receipts/discord-announcement.json, so each release is announced once. --set-webhook saves the channel webhook URL from standard input (hidden at a terminal) at mode 0600; the URL is never printed or passed in argv. Mentions in the notes never ping.',
  'verify.production': 'Validates healthy services, the configured Center release, OIDC, that Center’s access tokens carry sub (read from the running realm without changing it), capture routing, and the configured Pin certificate chain when enabled.',
  'setup.local': 'Creates the external local configuration and generated secrets. It does not start containers.',
  'setup.contributor': 'Creates the external contributor configuration and caches. It does not run gates.',
  'setup.production': 'Requires --domain, --acme-email and --operator-email initially; a rerun keeps saved values. --update-source URL names the Center whose /api/version this server asks for newer releases (default: the saved value, else the release’s own); --auto-updates on|off installs or removes the nightly update timer (default on for a new server, off for one set up before automatic updates; the hourly check timer is always installed), through sudo when it is not run as root, printing the root commands when sudo is unavailable. Guided setup asks both. --guided asks for them instead, and asks for the Pin archive\u2019s path when nothing is staged. Without a domain, --duckdns-subdomain NAME with --duckdns-token-stdin (the token typed hidden at a terminal, or piped) points the free NAME.duckdns.org at this server once and uses it as the domain; the token is not stored. --public-ip auto uses the server\u2019s own address when one HTTPS echo confirms it, and stops with the reason otherwise; guided setup offers both. Optional profiles: pin, search, spotify, observability. --no-profiles clears active profiles. With the pin profile, --pin-release-archive FILE supplies the Pin archive delivered with this release; without it, setup verifies the GitHub release\u2019s signed SHA256SUMS with the committed public key and downloads the archive; a release published without that signature needs --pin-release-archive. Without the pin profile the archive is not read. Until the first deploy, a rerun can also correct the domain and owner email. Setup refuses to move the configuration back to an older release. Production releases use prebuilt images and a digest-pinned OCI Compose application.',
  'setup.pin': 'Creates host-side Pin prerequisites. It never reads from or writes to a device.',
  'setup.status': 'Recomputes readiness from current artifacts; no progress state is stored.',
  'config.path': 'Prints the active external runtime configuration path.',
  'config.get': 'Secret values are reported only as set or unset. ./luma config list names every supported setting.',
  'config.set': 'Secrets accept --stdin only. At a terminal, --stdin asks for the value without showing it; otherwise it reads the value from the pipe.',
  'config.check': 'Checks the contract-backed settings and their dependencies.',
  'config.list': 'Shows whether each setting is set once the runtime configuration exists, never its value.',
  'config.template': 'Omits every secret setting.',
  'support-bundle': 'Writes a fixed, redacted allowlist outside the source tree at mode 0600.',
  'stock.decompile': 'Usage: luma stock decompile --from-device SERIAL | --apk-dir DIR. --from-device only reads that exact Pin: it lists the hu.ma.ne/humane packages on the system partitions and /system/framework/humane_*.jar, then adb-pulls them. jadx, pinned by version and SHA-256 in toolchain.json, is downloaded to the external build cache, verified, and run without network in the pinned JDK container. Output goes to LUMA_DATA_DIR/stock-reference and the path is printed. The files are Humane’s code: never commit or publish them.',
  version: 'Reads the version stamped into this release.',
  'pki.init': 'Usage: luma pki init device-user [--confirm]. Plans unless --confirm is supplied; never changes the attestation CA.',
  'pki.import': 'Usage: luma pki import device-user --cert FILE --key FILE [--confirm]. Plans unless confirmed.',
  'pin.activate': 'Exact serial and confirmation are enforced by the activation tool. Center activates a Pin directly; this is the recovery path.',
  'pin.activate.status': 'Read-only.',
  'pin.network': 'Reads status without printing SSID or BSSID.',
  'pin.network.qr': 'Credentials remain browser-local and never enter argv.',
  'pin.install': 'Without --confirm this resolves the exact serial and release, prints a plan, and leaves the device untouched. --serial is required when more than one device is attached.',
  'pin.build-debug': 'Credential-free and non-installable. Select roles with repeated --role, or use --changed [--base REF]. Reuses the pinned linux/amd64 builder and external build caches; every role refuses release signing inputs.',
  'pin.release.build': 'Builds the signed five-APK release into the external store mounted by Center. It never runs ADB or mutates a device.',
  'pin.release.acquire': 'Usage: luma pin release acquire [--archive FILE | --check] [--json]. Authenticates and downloads only this operator release’s exact archive, or verifies an explicit offline copy; both paths verify size, SHA-256, internal identity, signer, and APKs before staging outside Center.',
  'pin.release.export': 'Usage: luma pin release export --output ARCHIVE [--json]. Exports the current verified five-APK release for publication.',
  'pin.dock.check': 'Usage: luma pin dock check --serial SERIAL. Read-only device inspection against the supported firmware, power, and build gates.',
  'pin.dock.build': 'Usage: luma pin dock build [--ndk PATH] [--profile ID]. Builds the dock helper in the pinned toolchain; no device is touched.',
  'pin.dock.run': 'Usage: luma pin dock run --serial SERIAL [--yes] [--min-battery N]. Starts a temporary dock session on one exact Pin; confirm interactively or use --yes. Every firmware, power, and one-attempt-per-boot guard remains in the vendored tool.',
  'pin.dock.verify': 'Usage: luma pin dock verify --serial SERIAL. Read-only: checks whether the temporary dock session is active.',
  'pin.dock.report': 'Usage: luma pin dock report RUN_DIR --output FILE. Writes a redacted dock-session report from a private run directory on this host.',
  'pin.dock.follow': 'Usage: luma pin dock follow --serial SERIAL --confirm [--min-battery N] [--ndk PATH] [--interval SECONDS]. While this exact Pin is connected, verifies and restores the temporary dock session once per boot through the vendored tool’s own guarded run; literal --confirm is required and Ctrl-C stops.',
});

function safetyText(command) {
  if (command.effect === 'read-only') {
    return command.exactSerialRequired
      ? 'Safety: read-only; an exact --serial selects the device to inspect, but no device state is changed.'
      : 'Safety: read-only; this command does not change local, remote, or device state.';
  }
  if (command.exactSerialRequired) {
    return 'Safety: device mutation requires the documented confirmation and an exact --serial; the delegated tool revalidates both.';
  }
  if (command.effect === 'remote-mutation') {
    return command.confirmationRequired
      ? 'Safety: remote mutation (it changes what production runs or a published release) requires the command’s documented confirmation and target guards; inspect the plan before confirming.'
      : 'Safety: remote mutation: this command changes what production runs or a published release; inspect its exact target before running it.';
  }
  if (command.effect === 'local-mutation' && !command.confirmationRequired) {
    return 'Safety: local mutation only; this command changes files or containers on this machine, never what production runs, a published release, or a device.';
  }
  return 'Safety: the local mutation is planned first and commits only with its documented confirmation.';
}

// One line for a command group in its parent's help. A group that is also a
// command (the bare `config`) is described as the group.
const GROUP_SUMMARIES = Object.freeze({
  backup: 'Back up this production server.',
  check: 'Run the source checks for one component or for your changes.',
  config: 'Read, set, and check configuration settings.',
  deploy: 'Deploy this release on this host.',
  dev: 'Run Center with hot reload for development.',
  eval: 'Evaluate the production assistant.',
  onboard: 'Guide one production setup, deployment, and verification.',
  pin: 'Build, install, and inspect the Pin apps.',
  'pin dock': 'Keep one exact Pin ready while docked.',
  'pin release': 'Build, export, or acquire the signed Pin release.',
  pki: 'Create or import the DeviceUser CA for a local stack.',
  registry: 'Log Docker in to GHCR; only a private fork needs this.',
  release: 'Publish a tagged release.',
  'reset-password': 'Give the first operator a new one-time password.',
  restore: 'Restore a backup onto this server.',
  setup: 'Create local, contributor, Pin, or production configuration.',
  update: 'Update this production server to the newest release.',
  stack: 'Control the local container stack.',
  stock: 'Decompile the stock apps into a local reference.',
  verify: 'Verify the running production server.',
});

function childEntries(prefix, contract) {
  const rows = new Map();
  for (const command of contract.commands.filter((entry) => entry.lifecycle === 'current')) {
    const tokens = command.tokens;
    if (tokens.length <= prefix.length || !prefix.every((token, index) => token === tokens[index])) continue;
    const childPath = tokens.slice(0, prefix.length + 1);
    const child = childPath[childPath.length - 1];
    if (!rows.has(child)) {
      const exact = findCommand(childPath, contract)?.command;
      rows.set(child, GROUP_SUMMARIES[childPath.join(' ')] || exact?.summary || `${child} commands`);
    }
  }
  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderRootHelp(contract) {
  const top = childEntries([], contract);
  const width = Math.max(...top.map(([name]) => name.length), 1);
  return [
    'Luma',
    '',
    'Usage: luma COMMAND [options]',
    '',
    'Commands:',
    ...top.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    'Short local aliases: build, up, down, status, logs, config.',
    'Pin host operations (no device mutation) are under `luma pin`; device actions plan unless explicitly confirmed.',
    '  luma pin release acquire',
    '',
    'Safety: help is read-only and side-effect-free. Each command help says whether it only reads, changes this machine (local), changes what production runs or a published release (remote), or changes a device.',
    '',
    'Run `luma COMMAND --help` for command-specific help.',
  ].join('\n');
}

function renderGroupHelp(tokens, contract) {
  const rows = childEntries(tokens, contract);
  const width = Math.max(...rows.map(([name]) => name.length), 1);
  const heading = tokens.join(' ');
  const defaultCommand = findCommand(tokens, contract)?.command || null;
  const notes = [];
  if (heading === 'pin release') notes.push('Acquire publishes only this operator release’s exact signed archive.');
  if (heading === 'config') notes.push('Bare `luma config` renders the Compose model.');
  if (heading === 'pin') notes.push('Device mutation requires an exact serial and explicit confirmation in the delegated tool.');
  if (heading === 'pin dock') notes.push('Every device guard remains in the vendored tool; `run` uses its own confirmation, and `follow --confirm` drives the same guarded run once per boot while connected.');
  return [
    defaultCommand
      ? `Usage: luma ${heading} [options] | luma ${heading} COMMAND [options]`
      : `Usage: luma ${heading} COMMAND [options]`,
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
    `Run \`luma ${heading} COMMAND --help\` for command-specific help.`,
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
  OPERATOR_SETUP_NEXT,
  VERSION_FILE,
  compareReleaseVersions,
  describeRelease,
  isOperatorRelease,
  operatorContract,
  releaseCompatibility,
  pinReleaseIdentityMatches,
  versionInfo,
  findCommand,
  isGroup,
  requestedHelp,
  renderHelp,
};
