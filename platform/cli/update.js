'use strict';
// `./luma update production` keeps a server on the newest Luma release without
// the owner running anything (INFERRED: Luma's own operator behaviour. Stock
// Humane had no self-hosted cloud to update).
//
//   --check  asks the update source (a Center's public /api/version) which
//            release is newest, and writes $LUMA_DATA_DIR/updates/status.json,
//            which Center reads (mounted read-only at /luma-updates).
//   (none)   also installs a newer release: it downloads that release's five
//            files from GitHub, verifies SHA256SUMS.sigstore.json with the
//            release signing key packed in THIS operator and every file
//            against the signed SHA256SUMS, unpacks the new operator into
//            $LUMA_DATA_DIR/operators/VERSION, and runs, from that folder,
//            the documented update (README "Update Luma"): backup, setup with
//            the saved values and the verified Pin archive, deploy --dry-run,
//            deploy --confirm, verify. At a terminal it asks first.
//   --auto   the same without a terminal (the nightly systemd timer). When the
//            update fails after the configuration moved to the new release,
//            it puts the server back the way README "Back up and restore"
//            documents: stop Luma, restore the backup with the release that
//            made it (the new operator. A backup taken before the new setup
//            holds the old configuration, so that restore deploys nothing),
//            then deploy and verify from the old release's folder.
//
// `operators/current` names the operator folder of the release this server is
// configured for. Setup points it at itself, the timer runs through it, and a
// rollback points it back.

const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  BUILD_DIR,
  CONFIG_DIR,
  DATA_DIR,
  ENV_FILE,
  ROOT,
  SECRETS_DIR,
  atomicWrite,
  fail,
  info,
  operatorEnvironment,
  parseEnvFile,
  resolveTool,
  secureDirectory,
} = require('./context');
const { compareReleaseVersions, versionInfo } = require('./command-spec');
const { interactiveTerminal, readTerminalLine } = require('./terminal');
const { isUpdateSourceOrigin, validateReleaseDescriptor } = require('../distribution/release-descriptor.mjs');

const USAGE = './luma update production [--check | --auto]';
const OPERATORS_DIR = path.join(DATA_DIR, 'operators');
const CURRENT_LINK = path.join(OPERATORS_DIR, 'current');
// Center reads status.json through a read-only bind mount as its own user, so
// this one directory and its file are world-readable. Nothing secret is in it.
const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const STATUS_FILE = path.join(UPDATES_DIR, 'status.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'update-downloads');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const LOCK_FILE = path.join(DATA_DIR, 'update.lock');
const GITHUB_TOKEN_FILE = path.join(SECRETS_DIR, 'github-token');
const UNITS_DIR = path.join(CONFIG_DIR, 'production', 'systemd');
const SYSTEM_UNITS_DIR = '/etc/systemd/system';
const UPDATE_TIMER = 'luma-update.timer';
const CHECK_TIMER = 'luma-update-check.timer';
const UNIT_NAMES = Object.freeze(['luma-update.service', UPDATE_TIMER, 'luma-update-check.service', CHECK_TIMER]);
const CHECK_TIMEOUT_MS = 5_000;
const MAX_VERSION_BYTES = 64 * 1024;
const MAX_NOTES = 2_000;
// Backups the updater made itself. Older ones are pruned after a successful
// update so a server that updates for years does not fill its disk.
const KEPT_UPDATE_BACKUPS = 3;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const PIN_VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/u;
const STOP_LUMA = 'docker stop $(docker ps --quiet --filter label=com.docker.compose.project=luma)';

// ----------------------------------------------------------- shared state

function readGithubToken() {
  const stat = fs.lstatSync(GITHUB_TOKEN_FILE, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`the saved GitHub token must be a regular mode-0600 file (${path.basename(GITHUB_TOKEN_FILE)} ` +
      'in Luma\'s secrets directory); save it again with ./luma registry login');
  }
  const token = fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8').split(/\r?\n/u)[0].trim();
  return token || null;
}

// Keeps the token a private fork's updater downloads releases with (public
// releases need none). It never leaves this file except as the Authorization
// header of a GitHub request.
function saveGithubToken(token) {
  if (typeof token !== 'string' || !token || token.length > 1024 || /\s/u.test(token)) {
    throw new Error('a GitHub token is one line without spaces');
  }
  atomicWrite(GITHUB_TOKEN_FILE, `${token}\n`, 0o600);
}

function realDirectory(selected) {
  try {
    return fs.realpathSync(selected);
  } catch {
    return null;
  }
}

function currentOperator() {
  const stat = fs.lstatSync(CURRENT_LINK, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw new Error(`${CURRENT_LINK} must be a symbolic link to an operator folder`);
  return realDirectory(CURRENT_LINK);
}

// Points operators/current at `folder` with one rename, so the timer never
// sees a missing link.
function pointCurrentOperator(folder) {
  secureDirectory(OPERATORS_DIR);
  const existing = fs.lstatSync(CURRENT_LINK, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${CURRENT_LINK} must be a symbolic link to an operator folder`);
  }
  const target = path.resolve(folder);
  if (existing && fs.readlinkSync(CURRENT_LINK) === target) return;
  const temporary = path.join(OPERATORS_DIR, `.current.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  fs.symlinkSync(target, temporary);
  try {
    fs.renameSync(temporary, CURRENT_LINK);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ensureUpdatesDirectory() {
  const stat = fs.lstatSync(UPDATES_DIR, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`${UPDATES_DIR} must be a real directory`);
  }
  if (!stat) {
    secureDirectory(DATA_DIR);
    fs.mkdirSync(UPDATES_DIR, { mode: 0o755 });
  }
  fs.chmodSync(UPDATES_DIR, 0o755);
}

function readStatus() {
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return status?.schemaVersion === 1 ? status : null;
  } catch {
    return null;
  }
}

function writeStatus(status) {
  ensureUpdatesDirectory();
  const temporary = path.join(UPDATES_DIR, `.status.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644, flag: 'w' });
    fs.chmodSync(temporary, 0o644);
    fs.renameSync(temporary, STATUS_FILE);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Error text as status.json and the journal keep it: one line, bounded, with
// no token and no path into the secrets directory.
function publicMessage(text) {
  return String(text)
    .replaceAll(SECRETS_DIR, 'the secrets directory')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/gu, '[redacted GitHub credential]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/gu, '[redacted GitHub credential]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 500);
}

// ------------------------------------------------------ automatic updates

function unitValue(value) {
  if (/["\\%\n\r]/u.test(value)) {
    throw new Error(`automatic updates cannot name a path containing a quote, backslash, percent sign, or line break: ${value}`);
  }
  return `"${value}"`;
}

// The four systemd units: a nightly update (03:00 plus up to two hours, and a
// missed night runs at the next boot) and an hourly check that keeps Center's
// update status fresh even with automatic updates off.
function renderUpdateUnits({ user = os.userInfo().username, home = os.homedir() } = {}) {
  const luma = path.join(CURRENT_LINK, 'luma');
  const environment = [
    ['HOME', home],
    ['PATH', '/usr/local/bin:/usr/bin:/bin'],
    ['LUMA_CONFIG_DIR', CONFIG_DIR],
    ['LUMA_SECRETS_DIR', SECRETS_DIR],
    ['LUMA_DATA_DIR', DATA_DIR],
    ['LUMA_BUILD_DIR', BUILD_DIR],
    ['LUMA_ENV_FILE', ENV_FILE],
  ].map(([name, value]) => `Environment=${unitValue(`${name}=${value}`)}`);
  if (!/^[a-z_][a-z0-9_-]*\$?$/iu.test(user)) throw new Error(`automatic updates cannot run as user ${user}`);
  const service = (description, mode) => [
    '[Unit]',
    `Description=${description}`,
    'Wants=network-online.target',
    'After=network-online.target docker.service',
    '',
    '[Service]',
    'Type=oneshot',
    `User=${user}`,
    ...environment,
    `ExecStart=${unitValue(luma)} update production ${mode}`,
    '',
  ].join('\n');
  const timer = (description, calendar, delay) => [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Timer]',
    `OnCalendar=${calendar}`,
    `RandomizedDelaySec=${delay}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return Object.freeze({
    'luma-update.service': service('Install a newer Luma release (luma update production --auto)', '--auto'),
    [UPDATE_TIMER]: timer('Install newer Luma releases at night', '*-*-* 03:00:00', '2h'),
    'luma-update-check.service': service('Check for a newer Luma release (luma update production --check)', '--check'),
    [CHECK_TIMER]: timer('Check for newer Luma releases every hour', 'hourly', '5m'),
  });
}

function systemctl(args) {
  const executable = resolveTool('systemctl', { required: false });
  if (!executable) return 'unavailable';
  const result = child.spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return (result.stdout || '').trim() || (result.error ? 'unavailable' : 'unknown');
}

function hasSystemd() {
  return fs.existsSync('/run/systemd/system');
}

// Runs a root shell script the way bootstrap does: directly as root, through
// sudo at a terminal (sudo asks for its own password), and through
// passwordless sudo otherwise. Returns false when none of them is possible.
function runPrivileged(script) {
  const shell = resolveTool('sh');
  let result;
  if (process.getuid?.() === 0) {
    result = child.spawnSync(shell, ['-c', script], { stdio: ['ignore', 'inherit', 'inherit'] });
  } else {
    const sudo = resolveTool('sudo', { required: false });
    if (!sudo) return false;
    result = interactiveTerminal()
      ? child.spawnSync(sudo, [shell, '-c', script], { stdio: 'inherit' })
      : child.spawnSync(sudo, ['-n', shell, '-c', script], { stdio: ['ignore', 'inherit', 'pipe'] });
  }
  return !result.error && result.status === 0;
}

// Installs, refreshes, or removes the timers so they match `enabled`, and says
// what it did. Only an operator release installs them: a source checkout is
// a development machine.
function configureAutomaticUpdates({ enabled }, runtime = {}) {
  const release = (runtime.release ?? versionInfo)();
  if (release.revision === 'source') {
    return Object.freeze({ state: 'source', message: 'This is a source checkout, so no update timers were installed.' });
  }
  // The timers run operators/current, so they belong to releases installed
  // there: the one-line installer and every update put them there. A release
  // unpacked elsewhere by hand gets them from its first update.
  const root = realDirectory(runtime.root ?? ROOT);
  const operators = realDirectory(OPERATORS_DIR);
  if (!operators || !root || path.dirname(root) !== operators) {
    return Object.freeze({
      state: 'not-installed',
      message: `Automatic updates are ${enabled ? 'on' : 'off'}; the timers start once this server runs a release ` +
        `in ${OPERATORS_DIR}, where the one-line installer and ./luma update production put them. ` +
        'Unpack the operator archive there and run setup from that folder to start them now.',
    });
  }
  if (!(runtime.hasSystemd ?? hasSystemd)()) {
    return Object.freeze({
      state: 'no-systemd',
      message: 'systemd is not running on this host, so nothing checks for updates on its own; ' +
        'run ./luma update production yourself (README "Update Luma").',
    });
  }
  const units = renderUpdateUnits(runtime.identity ?? {});
  const unitsDir = runtime.unitsDir ?? UNITS_DIR;
  const systemDir = runtime.systemUnitsDir ?? SYSTEM_UNITS_DIR;
  secureDirectory(path.dirname(unitsDir));
  if (!fs.existsSync(unitsDir)) fs.mkdirSync(unitsDir, { mode: 0o755 });
  fs.chmodSync(unitsDir, 0o755);
  const wanted = enabled ? UNIT_NAMES : UNIT_NAMES.filter((name) => name.startsWith('luma-update-check.'));
  for (const name of UNIT_NAMES) {
    const file = path.join(unitsDir, name);
    if (wanted.includes(name)) {
      fs.writeFileSync(file, units[name], { mode: 0o644 });
      fs.chmodSync(file, 0o644);
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  const installed = (name) => {
    try { return fs.readFileSync(path.join(systemDir, name), 'utf8'); } catch { return null; }
  };
  const status = runtime.systemctl ?? systemctl;
  const upToDate = UNIT_NAMES.every((name) => installed(name) === (wanted.includes(name) ? units[name] : null)) &&
    status(['is-enabled', CHECK_TIMER]) === 'enabled' &&
    (!enabled || status(['is-enabled', UPDATE_TIMER]) === 'enabled');
  const on = enabled ? 'on: this server installs newer releases between 03:00 and 05:00' : 'off';
  if (upToDate) return Object.freeze({ state: 'unchanged', message: `Automatic updates are ${on}.` });
  const commands = [
    ...wanted.map((name) => `install -m 0644 ${JSON.stringify(path.join(unitsDir, name))} ${systemDir}/${name}`),
    ...(enabled ? [] : [
      `systemctl disable --now ${UPDATE_TIMER} 2>/dev/null || true`,
      `rm -f ${systemDir}/luma-update.service ${systemDir}/${UPDATE_TIMER}`,
    ]),
    'systemctl daemon-reload',
    `systemctl enable --now ${CHECK_TIMER}${enabled ? ` ${UPDATE_TIMER}` : ''}`,
  ];
  if ((runtime.runPrivileged ?? runPrivileged)(commands.join(' && '))) {
    return Object.freeze({ state: 'installed', message: `Automatic updates are ${on}.` });
  }
  return Object.freeze({
    state: 'manual',
    message: `Automatic updates are ${on}, but installing the systemd timers needs root and sudo was not available. ` +
      'Run these once as root (sudo -i):',
    commands,
  });
}

// What doctor reports: whether the timers exist and when they run next.
function automaticUpdatesReport(values, runtime = {}) {
  const wanted = values.LUMA_AUTO_UPDATES === 'on';
  if (!(runtime.hasSystemd ?? hasSystemd)()) {
    return [`Automatic updates: ${wanted ? 'on, but' : 'off, and'} systemd is not running here; ` +
      'run ./luma update production yourself'];
  }
  const status = runtime.systemctl ?? systemctl;
  const describe = (timer) => {
    const enabled = status(['is-enabled', timer]);
    const active = status(['is-active', timer]);
    const next = status(['show', timer, '--property=NextElapseUSecRealtime', '--value']);
    return `${timer} ${enabled}, ${active}${next && !['unknown', 'unavailable', 'n/a'].includes(next) ? `, next ${next}` : ''}`;
  };
  const lines = [
    `Automatic updates: ${wanted ? 'on' : 'off'} (${describe(UPDATE_TIMER)}; ${describe(CHECK_TIMER)})`,
  ];
  const updateEnabled = status(['is-enabled', UPDATE_TIMER]) === 'enabled';
  if (wanted !== updateEnabled || status(['is-enabled', CHECK_TIMER]) !== 'enabled') {
    lines.push(`WARN the timers do not match LUMA_AUTO_UPDATES=${values.LUMA_AUTO_UPDATES || '(unset)'}; ` +
      `run ./luma setup production --auto-updates ${wanted ? 'on' : 'off'} to install them, from a release in ${OPERATORS_DIR}`);
  }
  const last = readStatus()?.lastUpdate;
  if (last) lines.push(`Last update: ${last.from} to ${last.to}, ${last.outcome} at ${last.finishedAt}`);
  return lines;
}

// ------------------------------------------------------------------ check

class UpdateStopped extends Error {
  constructor({ stage, reason, state, retry }) {
    super(reason);
    this.stage = stage;
    this.state = state;
    this.retry = retry;
  }
}

function nullableString(value, pattern = null, maximum = 200) {
  if (typeof value !== 'string' || !value || value.length > maximum) return null;
  return pattern && !pattern.test(value) ? null : value;
}

// The update source's /api/version answer, with every field it lacks as null.
function parseLatest(document) {
  const pin = document?.pin && typeof document.pin === 'object' && !Array.isArray(document.pin)
    ? {
      version: nullableString(document.pin.version, PIN_VERSION),
      versionCode: Number.isSafeInteger(document.pin.versionCode) && document.pin.versionCode > 0
        ? document.pin.versionCode : null,
    }
    : null;
  return {
    version: nullableString(document?.version, RELEASE_VERSION),
    tag: nullableString(document?.tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u),
    pin: pin && (pin.version || pin.versionCode) ? pin : null,
    notes: nullableString(document?.notes, null, MAX_NOTES),
    publishedAt: nullableString(document?.publishedAt, /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u),
  };
}

async function fetchLatest(source, fetchImpl) {
  const url = `${source}/api/version`;
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`${url} could not be reached within ${CHECK_TIMEOUT_MS / 1000} seconds ` +
      `(${error?.cause?.code || error?.name || 'failed'})`);
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_VERSION_BYTES) throw new Error(`${url} answered more than 64 KiB`);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not answer JSON`);
  }
  const latest = parseLatest(document);
  if (!latest.version) throw new Error(`${url} names no Luma release version`);
  return latest;
}

function readValues() {
  const stat = fs.lstatSync(ENV_FILE, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new UpdateStopped({
      stage: 'Read this server\'s configuration',
      reason: `no production configuration at ${ENV_FILE}`,
      state: 'Nothing was changed.',
      retry: 'Set this server up first (README "Get Luma"), then run ./luma update production --check',
    });
  }
  return parseEnvFile(ENV_FILE);
}

function currentRelease(values, release) {
  const version = values.LUMA_RELEASE_VERSION || release.version;
  return {
    version,
    tag: values.LUMA_RELEASE_TAG || release.source?.tag || `v${version}`,
    pinVersion: values.LUMA_PIN_RELEASE_VERSION || release.pin?.version || null,
  };
}

function updateSource(values, release) {
  const source = values.LUMA_UPDATE_SOURCE || release.updateSource || '';
  if (!isUpdateSourceOrigin(source)) {
    throw new UpdateStopped({
      stage: 'Check for a newer release',
      reason: source ? `LUMA_UPDATE_SOURCE is not an https origin: ${source}` : 'this server has no update source',
      state: 'Nothing was changed.',
      retry: 'Name one with ./luma setup production --update-source https://CENTER, then run ./luma update production --check',
    });
  }
  return source;
}

// Asks the update source for the newest release and records the answer for
// Center. An unreachable source records `latest: null` and stops.
async function checkForUpdate(runtime) {
  const release = runtime.release;
  const values = readValues();
  const source = updateSource(values, release);
  const previous = readStatus();
  const status = {
    schemaVersion: 1,
    checkedAt: runtime.now().toISOString(),
    source,
    current: currentRelease(values, release),
    latest: null,
    autoUpdates: values.LUMA_AUTO_UPDATES === 'on' ? 'on' : 'off',
    lastUpdate: previous?.lastUpdate ?? null,
  };
  let latest;
  try {
    latest = await fetchLatest(source, runtime.fetch);
  } catch (error) {
    writeStatus(status);
    throw new UpdateStopped({
      stage: 'Check for a newer release',
      reason: error.message,
      state: 'Nothing was changed. Center shows that the last check could not reach the update source.',
      retry: './luma update production --check (the source may only be down for a while)',
    });
  }
  status.latest = {
    version: latest.version,
    tag: latest.tag,
    pinVersion: latest.pin?.version ?? null,
    notes: latest.notes,
    publishedAt: latest.publishedAt,
  };
  writeStatus(status);
  return { status, latest, values };
}

function isNewer(latest, current) {
  return compareReleaseVersions(latest.version, current.version) === 1;
}

// ---------------------------------------------------------------- install

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

async function downloadAsset({ asset, destination, proof, fetchImpl, githubToken }) {
  const response = await proof.fetchPublishedReleaseAsset({ asset, fetchImpl, githubToken, timeoutMs: 30 * 60_000 });
  const output = fs.openSync(destination, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error(`${asset.name} is larger than GitHub said`);
      fs.writeSync(output, chunk);
    }
  } finally {
    fs.closeSync(output);
  }
  if (size !== asset.size) throw new Error(`${asset.name} did not match its published size`);
}

// The verified release, downloaded into a private folder: the signature over
// SHA256SUMS holds under THIS operator's release signing key, and every other
// file matches its signed checksum before anything reads it.
async function downloadRelease({ latest, githubToken, runtime, directory }) {
  const proof = await runtime.releaseProof();
  const tag = `v${latest.version}`;
  const descriptorName = `luma-${latest.version}.release.json`;
  const proofNames = [proof.RELEASE_CHECKSUMS_NAME, proof.RELEASE_SIGNATURE_NAME, descriptorName];
  const assets = await proof.resolvePublishedReleaseAssets({
    tag, names: proofNames, fetchImpl: runtime.fetch, githubToken,
  });
  for (const name of proofNames) {
    if (assets[name].size > 2 * 1024 * 1024) throw new Error(`${name} is larger than a release proof file can be`);
    await downloadAsset({ asset: assets[name], destination: path.join(directory, name), proof, fetchImpl: runtime.fetch, githubToken });
  }
  const checksums = await proof.verifyReleaseChecksums({
    checksumsPath: path.join(directory, proof.RELEASE_CHECKSUMS_NAME),
    signaturePath: path.join(directory, proof.RELEASE_SIGNATURE_NAME),
    publicKeyPath: path.join(runtime.root, 'platform', 'distribution', 'release-signing.pub'),
    ...(runtime.provisionVerifier ? { provisionVerifier: runtime.provisionVerifier } : {}),
  });
  const listed = (name) => {
    if (checksums[name] !== sha256File(path.join(directory, name))) {
      throw new Error(`${name} does not match the signed ${proof.RELEASE_CHECKSUMS_NAME}`);
    }
  };
  listed(descriptorName);
  const descriptor = validateReleaseDescriptor(JSON.parse(fs.readFileSync(path.join(directory, descriptorName), 'utf8')));
  if (descriptor.version !== latest.version || descriptor.source.tag !== tag ||
      descriptor.source.repository !== proof.RELEASE_PROOF_POLICY.repository) {
    throw new Error(`the signed release descriptor is not Luma ${latest.version} of ${proof.RELEASE_PROOF_POLICY.repository}`);
  }
  const archives = [descriptor.operator, descriptor.pin];
  const more = await proof.resolvePublishedReleaseAssets({
    tag, names: archives.map((entry) => entry.archive), fetchImpl: runtime.fetch, githubToken,
  });
  for (const entry of archives) {
    const asset = more[entry.archive];
    if (asset.size !== entry.size) throw new Error(`${entry.archive} on GitHub is not the size the signed descriptor names`);
    const file = path.join(directory, entry.archive);
    await downloadAsset({ asset, destination: file, proof, fetchImpl: runtime.fetch, githubToken });
    listed(entry.archive);
    if (checksums[entry.archive] !== entry.sha256) {
      throw new Error(`${entry.archive} is not the file the signed descriptor names`);
    }
  }
  return Object.freeze({
    descriptor,
    operatorArchive: path.join(directory, descriptor.operator.archive),
    pinArchive: path.join(directory, descriptor.pin.archive),
  });
}

// Unpacks the verified operator archive into operators/VERSION. A folder
// already there that is not the running or current operator is a leftover of
// an earlier attempt and is replaced by this verified copy.
function unpackOperator(archive, version, runtime) {
  secureDirectory(OPERATORS_DIR);
  const destination = path.join(OPERATORS_DIR, version);
  const incoming = fs.mkdtempSync(path.join(OPERATORS_DIR, '.incoming-'));
  try {
    const tar = child.spawnSync(resolveTool('tar'), ['-xzf', archive, '--no-same-owner', '-C', incoming], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.status !== 0) throw new Error(`the operator archive could not be unpacked: ${(tar.stderr || '').trim()}`);
    const extracted = path.join(incoming, `luma-operator-${version}`);
    const stat = fs.lstatSync(extracted, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(incoming).length !== 1) {
      throw new Error('the operator archive does not hold exactly one luma-operator-VERSION folder');
    }
    const packed = JSON.parse(fs.readFileSync(path.join(extracted, 'platform', 'distribution', 'version.json'), 'utf8'));
    if (packed.version !== version) throw new Error(`the operator archive is not Luma ${version}`);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing) {
      const real = realDirectory(destination);
      if ([realDirectory(runtime.root), currentOperator()].includes(real)) {
        throw new Error(`${destination} is the operator this server runs; it is not replaced`);
      }
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(extracted, destination);
    return destination;
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      return () => fs.rmSync(LOCK_FILE, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      let alive = false;
      try { process.kill(pid, 0); alive = Number.isSafeInteger(pid) && pid > 0; } catch { alive = false; }
      if (alive) throw new Error(`another update (process ${pid}) is running`);
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  throw new Error(`${LOCK_FILE} could not be taken`);
}

// Runs `luma ARGS` from an operator folder, with this server's locations, and
// its output on this terminal or journal.
function runOperator(folder, args) {
  const result = child.spawnSync(path.join(folder, 'luma'), args, {
    cwd: folder,
    env: operatorEnvironment(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new Error(`${path.join(folder, 'luma')} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`./luma ${args.join(' ')} exited with status ${result.status ?? 1}`);
}

function stopLuma() {
  const docker = resolveTool('docker');
  const env = operatorEnvironment();
  const listed = child.spawnSync(docker, ['ps', '--quiet', '--filter', 'label=com.docker.compose.project=luma'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (listed.status !== 0) throw new Error(`docker ps failed: ${(listed.stderr || '').trim()}`);
  const ids = listed.stdout.split(/\s+/u).filter(Boolean);
  if (!ids.length) return;
  const stopped = child.spawnSync(docker, ['stop', ...ids], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (stopped.status !== 0) throw new Error(`docker stop failed: ${(stopped.stderr || '').trim()}`);
}

function pruneUpdateBackups(keep) {
  let entries;
  try {
    entries = fs.readdirSync(BACKUPS_DIR).filter((name) => name.startsWith('luma-update-'))
      .map((name) => [name, fs.lstatSync(path.join(BACKUPS_DIR, name)).mtimeMs])
      .sort(([, left], [, right]) => left - right)
      .map(([name]) => name);
  } catch {
    return;
  }
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(path.join(BACKUPS_DIR, name), { recursive: true, force: true });
  }
}

// This folder may install updates only while it is the current operator, or
// the newest one when no link names one yet.
function assertRunnableFolder(root, release) {
  const current = currentOperator();
  const here = realDirectory(root);
  if (current && current === here) return;
  const newer = (fs.existsSync(OPERATORS_DIR) ? fs.readdirSync(OPERATORS_DIR) : [])
    .filter((name) => RELEASE_VERSION.test(name) && compareReleaseVersions(name, release.version) === 1);
  if (current || newer.length) {
    throw new UpdateStopped({
      stage: 'Check this operator folder',
      reason: `this is the Luma ${release.version} operator in ${root}, but this server's operator is ` +
        `${current || path.join(OPERATORS_DIR, newer.sort().at(-1))}`,
      state: 'Nothing was changed.',
      retry: `${path.join(CURRENT_LINK, 'luma')} update production`,
    });
  }
}

function confirmInstall(latest, current, runtime) {
  if (runtime.auto) return;
  if (!(runtime.interactive ?? interactiveTerminal)()) {
    throw new UpdateStopped({
      stage: 'Confirm the update',
      reason: 'installing an update needs a terminal that confirms it, or --auto',
      state: 'Nothing was changed.',
      retry: './luma update production at a terminal, or ./luma update production --auto',
    });
  }
  runtime.write(`Install Luma ${latest.version} now (you have ${current.version})? This backs up the server first, ` +
    'then deploys the new release; Center pauses for a few minutes. [y/N]');
  const answer = (runtime.readLine ?? (() => readTerminalLine('update cancelled')))();
  if (!/^(?:y|yes)$/iu.test(answer.trim())) {
    throw new UpdateStopped({
      stage: 'Confirm the update',
      reason: 'the update was not confirmed',
      state: 'Nothing was changed.',
      retry: './luma update production',
    });
  }
}

// Luma's releases are public, so a server with no saved token downloads them
// anonymously. A private fork saves its token once with `./luma registry
// login`, and every GitHub request then carries it.
function githubToken() {
  return readGithubToken();
}

async function installUpdate(checked, runtime) {
  const { latest, values, status } = checked;
  const release = runtime.release;
  const current = status.current;
  const from = current.version;
  const to = latest.version;
  const target = `Luma ${to}`;
  const startedAt = runtime.now();
  let installed = null;
  const record = (outcome, message) => {
    const last = readStatus() ?? status;
    last.lastUpdate = {
      startedAt: startedAt.toISOString(),
      finishedAt: runtime.now().toISOString(),
      from,
      to,
      outcome,
      message: publicMessage(message),
    };
    if (outcome !== 'failed' && outcome !== 'rolled-back') {
      last.current = { version: to, tag: `v${to}`, pinVersion: installed?.descriptor.pin.version ?? null };
    }
    writeStatus(last);
  };

  if (values.LUMA_RELEASE_ID !== release.revision) {
    throw new UpdateStopped({
      stage: 'Check this server',
      reason: `this server is configured for release ${values.LUMA_RELEASE_ID || 'none'}, not this ` +
        `operator's Luma ${release.version}`,
      state: 'Nothing was changed.',
      retry: `Finish the previous update or restore first (./luma setup status names the next step), then ${path.join(CURRENT_LINK, 'luma')} update production`,
    });
  }
  confirmInstall(latest, current, runtime);
  const token = githubToken();
  secureDirectory(DOWNLOADS_DIR);
  const downloads = fs.mkdtempSync(path.join(DOWNLOADS_DIR, `${to}-`));
  const stopped = (fields) => {
    record(fields.outcome ?? 'failed', `${fields.stage}: ${fields.reason}`);
    return new UpdateStopped(fields);
  };
  try {
    runtime.write(`Downloading and verifying ${target} from GitHub`);
    try {
      installed = await downloadRelease({ latest, githubToken: token, runtime, directory: downloads });
    } catch (error) {
      throw stopped({
        stage: 'Download and verify the release',
        reason: error.message,
        state: 'Nothing was changed; the partial download was discarded.',
        retry: token
          ? './luma update production'
          : './luma update production (a private fork first saves a token with ./luma registry login --username YOUR_GITHUB_USER)',
      });
    }
    let folder;
    try {
      folder = unpackOperator(installed.operatorArchive, to, runtime);
    } catch (error) {
      throw stopped({
        stage: 'Unpack the new operator',
        reason: error.message,
        state: 'Nothing was changed.',
        retry: './luma update production',
      });
    }
    runtime.write(`${target} is verified and unpacked in ${folder}`);
    const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
    const backup = path.join(BACKUPS_DIR, `luma-update-${from}-to-${to}-${stamp}`);
    const oldFolder = realDirectory(runtime.root);
    const steps = [
      ['Back up this server', ['backup', 'production', '--output', backup]],
      ['Configure the new release', ['setup', 'production', '--pin-release-archive', installed.pinArchive]],
      ['Prove the deployment plan', ['deploy', 'production', '--dry-run']],
      ['Deploy the new release', ['deploy', 'production', '--confirm']],
      ['Verify the new release', ['verify', 'production']],
    ];
    let deployStarted = false;
    for (const [stage, args] of steps) {
      runtime.write(`== ${stage}: ./luma ${args.join(' ')}`);
      if (args[1] === 'production' && args[2] === '--confirm') deployStarted = true;
      try {
        runOperator(folder, args);
        if (args[0] === 'setup') pointCurrentOperator(folder);
      } catch (error) {
        const configured = (() => {
          try { return parseEnvFile(ENV_FILE).LUMA_RELEASE_ID || ''; } catch { return ''; }
        })();
        if (args[0] === 'backup' || (!deployStarted && configured === values.LUMA_RELEASE_ID)) {
          pointCurrentOperator(oldFolder);
          throw stopped({
            stage,
            reason: error.message,
            state: `This server still runs Luma ${from} unchanged. ${target} stays unpacked in ${folder}.`,
            retry: `${path.join(CURRENT_LINK, 'luma')} update production`,
          });
        }
        const back = [
          STOP_LUMA,
          `cd ${folder} && ./luma restore production --from ${backup} --confirm`,
          `cd ${oldFolder} && ./luma deploy production --confirm`,
        ];
        if (!runtime.auto) {
          throw stopped({
            stage,
            reason: error.message,
            state: `This server is configured for ${target}${deployStarted ? ' and may be partly deployed' : ''}. ` +
              `The backup from before the update is ${backup}.`,
            retry: `fix the cause and run cd ${folder} && ./luma deploy production --confirm; ` +
              `or go back to Luma ${from}: ${back.join('; then ')} (README "Back up and restore")`,
          });
        }
        runtime.write(`${stage} failed: ${error.message}. Putting Luma ${from} back from ${backup}.`);
        try {
          (runtime.stopLuma ?? stopLuma)();
          runOperator(folder, ['restore', 'production', '--from', backup, '--confirm']);
          runOperator(oldFolder, ['deploy', 'production', '--confirm']);
          runOperator(oldFolder, ['verify', 'production']);
          pointCurrentOperator(oldFolder);
        } catch (rollbackError) {
          throw stopped({
            stage: `${stage}, then the return to Luma ${from}`,
            reason: `${error.message}; returning to Luma ${from} also failed: ${rollbackError.message}`,
            state: `This server may be stopped or partly restored. The backup from before the update is ${backup}.`,
            retry: `${back.join('; then ')}; then ./luma verify production (README "Back up and restore")`,
          });
        }
        throw stopped({
          outcome: 'rolled-back',
          stage,
          reason: `${error.message}; Luma ${from} was restored from the backup taken before the update and passed verification`,
          state: `This server runs Luma ${from} again, as it was before the update. ` +
            `Automatic updates do not retry ${target}.`,
          retry: `${path.join(CURRENT_LINK, 'luma')} update production at a terminal, once the cause is fixed`,
        });
      }
    }
    record('updated', `Updated from Luma ${from} to ${to}.`);
    pruneUpdateBackups(KEPT_UPDATE_BACKUPS);
    runtime.write(`Luma ${to} is installed and passed production verification (backup: ${backup}).`);
    const pinEnabled = (values.COMPOSE_PROFILES || '').split(',').includes('pin');
    const pin = installed.descriptor.pin.version;
    runtime.write(pinEnabled && pin !== current.pinVersion
      ? `Pin apps ${pin} are ready: install them from Center → Settings → Advanced → Software & updates`
      : 'The Pin apps did not change.');
    return { updated: true };
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ command

function parseArguments(args) {
  if (args[0] !== 'production') throw new Error('usage');
  const flags = args.slice(1);
  if (flags.length > 1 || (flags.length === 1 && !['--check', '--auto'].includes(flags[0]))) throw new Error('usage');
  return { check: flags[0] === '--check', auto: flags[0] === '--auto' };
}

async function updateProduction(options, overrides = {}) {
  const runtime = {
    root: ROOT,
    release: versionInfo(),
    fetch: (...args) => globalThis.fetch(...args),
    now: () => new Date(),
    write: info,
    releaseProof: () => import(pathToFileURL(path.join(ROOT, 'platform', 'distribution', 'release-proof.mjs')).href),
    ...overrides,
    auto: options.auto,
  };
  if (runtime.release.revision === 'source') {
    throw new UpdateStopped({
      stage: 'Check this operator folder',
      reason: 'update production runs from an installed operator release, not a source checkout',
      state: 'Nothing was changed.',
      retry: 'Run it on the server from its operator folder (README "Update Luma")',
    });
  }
  assertRunnableFolder(runtime.root, runtime.release);
  const checked = await checkForUpdate(runtime);
  const { latest, status } = checked;
  const newer = isNewer(latest, status.current);
  if (!newer) {
    runtime.write(`Luma ${status.current.version} is up to date (the newest release at ${status.source} is ${latest.version}).`);
    return { updated: false, status };
  }
  runtime.write(`Luma ${latest.version} is available (this server runs ${status.current.version}).`);
  if (latest.notes) runtime.write(latest.notes);
  if (options.check) return { updated: false, status };
  const last = status.lastUpdate;
  if (runtime.auto && last?.to === latest.version && last.outcome === 'rolled-back') {
    runtime.write(`Luma ${latest.version} was rolled back on ${last.finishedAt}, so it is not installed automatically ` +
      'again; run ./luma update production at a terminal to try it once more.');
    return { updated: false, status };
  }
  let release;
  try {
    release = acquireLock();
  } catch (error) {
    throw new UpdateStopped({
      stage: 'Start the update',
      reason: error.message,
      state: 'Nothing was changed.',
      retry: './luma update production once the other update has finished',
    });
  }
  try {
    return await installUpdate(checked, runtime);
  } finally {
    release();
  }
}

function reportStopped(error, write = (line) => process.stderr.write(`${line}\n`)) {
  write('');
  write(`Update stopped · ${error.stage}`);
  write(`  What failed: ${publicMessage(error.message)}`);
  write(`  State: ${error.state}`);
  write(`  Safe retry: ${error.retry}`);
}

function updateCommand(args, overrides = {}) {
  let options;
  try {
    options = parseArguments(args);
  } catch {
    fail(`usage: ${USAGE}`, 64);
  }
  return updateProduction(options, overrides).catch((error) => {
    if (error instanceof UpdateStopped) {
      reportStopped(error);
      process.exit(1);
    }
    fail(publicMessage(error.message));
  });
}

module.exports = {
  CURRENT_LINK,
  GITHUB_TOKEN_FILE,
  OPERATORS_DIR,
  STATUS_FILE,
  UPDATES_DIR,
  USAGE,
  UpdateStopped,
  automaticUpdatesReport,
  configureAutomaticUpdates,
  ensureUpdatesDirectory,
  parseLatest,
  pointCurrentOperator,
  readGithubToken,
  renderUpdateUnits,
  reportStopped,
  saveGithubToken,
  updateCommand,
  updateProduction,
};
