'use strict';
// Backup and restore of the owner's production server. A backup holds what
// Luma cannot recreate: the Cosmos and Keycloak databases, the Cosmos state,
// Center data and Pin bridge volumes, the production configuration with its CA
// roots and keys, runtime.env with every secret (the OPAQUE seed included),
// and the verified Pin release store, so a restore needs no download. Losing
// the roots or the seed would otherwise mean re-activating every Pin over USB.

const child = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  CONFIG_DIR,
  DATA_DIR,
  ENV_FILE,
  configurationLocationHint,
  ROOT,
  atomicWrite,
  fail,
  info,
  isInsideDirectory,
  isInsideSource,
  operatorEnvironment,
  parseEnvFile,
  prepareManagedRoots,
  resolveTool,
} = require('./context');
const { describeRelease, versionInfo } = require('./command-spec');
const { deployProduction } = require('./production');
const { PRODUCTION_DIR, interruptedRestoreProblems } = require('./production-setup');

const BACKUP_USAGE = './luma backup production [--output DIR] [--project-name NAME]';
const RESTORE_USAGE = './luma restore production --from DIR [--confirm] [--project-name NAME]';
const MANIFEST = 'manifest.json';
const MANIFEST_KIND = 'luma-production-backup';
const MANIFEST_SCHEMA = 2;
const PIN_RELEASES_DIR = path.join(DATA_DIR, 'pin-releases');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const DATABASE_FILE = 'postgres.sql';
const ENV_ENTRY = 'runtime.env';
// Compose volume keys (compose.yaml, platform/compose/production.yaml) whose
// contents Luma cannot recreate. Postgres is dumped instead of copied.
const VOLUMES = Object.freeze([
  Object.freeze({ key: 'cosmos-state', required: true }),
  Object.freeze({ key: 'center-data', required: true }),
  // The Pin bridge endpoint key and assignment. Only with the pin profile.
  Object.freeze({ key: 'iroh-bridge-data', required: false }),
]);
const DATABASE_VOLUME = 'cosmos-pgdata';
const DATABASE_USER = 'cosmos';
const TREES = Object.freeze({ production: PRODUCTION_DIR, 'pin-releases': PIN_RELEASES_DIR });
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MODE = /^0[0-7]{3}$/u;
const SEGMENT = /^[^/\u0000-\u001f\u007f]+$/u;
// Traefik holds none of the copied state and also serves the owner's other
// hostnames (traefik-extra.json), so it keeps running during the copy.
const UNPAUSED_SERVICES = new Set(['postgres', 'traefik']);
const PAUSE_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const ACTIVE_STATES = new Set(['running', 'paused', 'restarting']);
const READY_TIMEOUT_MS = 120_000;
// pg_dumpall recreates every role, but a fresh cluster already has the stack's
// bootstrap superuser, which cannot be dropped. Skip only that first CREATE;
// the ALTER ROLE after it still restores the saved password. ON_ERROR_STOP
// then stops at any real error.
const DATABASE_RESTORE_FILTER = `!skipped && $0 == "CREATE ROLE ${DATABASE_USER};" { skipped = 1; next } { print }`;
const DATABASE_RESTORE_SCRIPT = [
  'set -eo pipefail',
  `awk '${DATABASE_RESTORE_FILTER}' | psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse ` +
    `--username=${DATABASE_USER} --dbname=postgres >/dev/null`,
].join('\n');

function runDocker(args, { stdin = 'ignore', stdout = 'pipe', env = {} } = {}) {
  const result = child.spawnSync(resolveTool('docker'), args, {
    cwd: ROOT,
    env: { ...operatorEnvironment(), ...env },
    stdio: [stdin, stdout, 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`docker could not run: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
  return line ? line.slice(0, 300) : 'no error output';
}

function shellWord(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

function octal(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseArguments(args, valueOptions, flagOptions) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (seen.has(option)) throw new Error('usage');
    seen.add(option);
    if (flagOptions.includes(option)) {
      options[option] = true;
    } else if (valueOptions.includes(option)) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('usage');
      options[option] = value;
      index += 1;
    } else {
      throw new Error('usage');
    }
  }
  if (options['--project-name'] !== undefined && !PROJECT_NAME.test(options['--project-name'])) {
    throw new Error('usage');
  }
  return options;
}

function projectContainers(docker, project) {
  const result = docker([
    'ps', '--all', '--no-trunc',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--format', '{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "dk.andersmadsen.luma.release"}}',
  ]);
  if (result.status !== 0) {
    throw new Error(`docker could not list the ${project} containers: ${firstLine(result.stderr)}`);
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [id, state, service, release] = line.split('\t');
    return Object.freeze({ id, state, service, release: release || '' });
  });
}

function volumeExists(docker, name) {
  return docker(['volume', 'inspect', '--format', '{{.Name}}', name]).status === 0;
}

function ensureVolume(docker, project, key) {
  const name = `${project}_${key}`;
  if (volumeExists(docker, name)) return name;
  // The labels Compose sets itself, so `up` adopts the volume as its own.
  const created = docker([
    'volume', 'create',
    '--label', `com.docker.compose.project=${project}`,
    '--label', `com.docker.compose.volume=${key}`,
    name,
  ]);
  if (created.status !== 0) throw new Error(`docker could not create volume ${name}: ${firstLine(created.stderr)}`);
  return name;
}

function readRuntimeValues() {
  const stat = fs.lstatSync(ENV_FILE, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(configurationLocationHint());
  }
  return parseEnvFile(ENV_FILE);
}

function requireRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${label} does not exist: ${directory}`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
}

// ---------------------------------------------------------------- backup

function backupOutput(selected, version, now) {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const output = path.resolve(selected || path.join(BACKUPS_DIR, `luma-backup-${version}-${stamp}`));
  if (isInsideSource(output)) throw new Error(`the backup must be outside the source tree: ${output}`);
  for (const tree of Object.values(TREES)) {
    if (isInsideDirectory(output, tree)) throw new Error(`the backup cannot be inside ${tree}, which it copies`);
  }
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error(`refusing to replace an existing path: ${output}`);
  }
  const parent = path.dirname(output);
  if (fs.existsSync(parent)) requireRealDirectory(parent, 'the backup parent');
  else fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return output;
}

function capturedEntry(staging, relative) {
  const file = path.join(staging, relative);
  return { path: relative, size: fs.statSync(file).size, sha256: sha256File(file) };
}

function captureStream(staging, relative, label, produce) {
  const target = path.join(staging, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(target, 'wx', 0o600);
  let result;
  try {
    result = produce(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.status !== 0) throw new Error(`${label} failed: ${firstLine(result.stderr)}`);
  return capturedEntry(staging, relative);
}

function copyPrivate(source, staging, relative, mode) {
  const target = path.join(staging, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  return { ...capturedEntry(staging, relative), mode: octal(mode) };
}

function copyTree(source, prefix, staging, manifest) {
  const walk = (directory, relative) => {
    manifest.directories.push({ path: relative, mode: octal(fs.lstatSync(directory).mode) });
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const selected = path.join(directory, entry.name);
      const inner = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(selected, inner);
      else if (entry.isFile()) manifest.files.push(copyPrivate(selected, staging, inner, fs.lstatSync(selected).mode));
      else throw new Error(`refusing to back up ${selected}: only regular files and directories are supported`);
    }
  };
  walk(source, prefix);
}

// A signal while the stack is paused must not end this process before the
// stack resumes. The running Docker step receives the same signal and fails,
// which unwinds through the resume.
function whilePaused(docker, containers, action) {
  const paused = [];
  const hold = () => {};
  for (const signal of PAUSE_SIGNALS) process.on(signal, hold);
  try {
    for (const container of containers) {
      const result = docker(['pause', container.id]);
      if (result.status !== 0) {
        throw new Error(`docker could not pause ${container.service || container.id}: ${firstLine(result.stderr)}`);
      }
      paused.push(container);
    }
    return action();
  } finally {
    const stuck = paused.filter((container) => docker(['unpause', container.id]).status !== 0);
    for (const signal of PAUSE_SIGNALS) process.removeListener(signal, hold);
    if (stuck.length) {
      // Reported on stderr even when the backup itself failed, because a
      // paused service is an outage.
      process.stderr.write(`error: Luma could not resume ${stuck.map((entry) => entry.service || entry.id).join(', ')}; ` +
        `run: docker unpause ${stuck.map((entry) => entry.id).join(' ')}\n`);
    }
  }
}

// The operator release that made a backup, which alone restores it.
function operatorRelease(release, values) {
  return release.revision === 'source'
    ? { version: release.version, id: values.LUMA_RELEASE_ID, application: values.LUMA_COMPOSE_APPLICATION || '' }
    : { version: release.version, id: release.revision, application: release.application };
}

function backupProduction(options = {}, runtime = {}) {
  const docker = runtime.docker ?? runDocker;
  const release = (runtime.release ?? versionInfo)();
  const now = runtime.now ?? new Date();
  const project = options.projectName ?? 'luma';

  const values = readRuntimeValues();
  const configured = values.LUMA_RELEASE_ID || '';
  if (!RELEASE_ID.test(configured)) throw new Error(`${ENV_FILE} has no valid LUMA_RELEASE_ID`);
  const operator = operatorRelease(release, values);
  requireRealDirectory(PRODUCTION_DIR, 'the production configuration');

  const containers = projectContainers(docker, project);
  const database = containers.find((container) => container.service === 'postgres' && container.state === 'running');
  if (!database) {
    throw new Error(`the ${project} stack's PostgreSQL is not running; start the stack with ` +
      './luma deploy production --confirm, then rerun the backup');
  }
  const alreadyPaused = containers.filter((container) => container.state === 'paused');
  if (alreadyPaused.length) {
    throw new Error(`some ${project} containers are paused; resume them with ` +
      `docker unpause ${alreadyPaused.map((container) => container.id).join(' ')}, then rerun the backup`);
  }
  const running = containers.filter((container) => container.state === 'running');
  const deployedReleases = [...new Set(running.map((container) => container.release))];
  if (deployedReleases.length !== 1 || !RELEASE_ID.test(deployedReleases[0])) {
    throw new Error(`the running ${project} stack is not one Luma release ` +
      `(found ${deployedReleases.map((id) => id || 'unlabelled').join(', ')}); ` +
      'finish ./luma deploy production --confirm, then rerun the backup');
  }
  // The new operator backs up the release it is about to replace, before or
  // after its own setup has moved the configuration to it.
  const [deployed] = deployedReleases;
  if (configured !== deployed && configured !== operator.id) {
    throw new Error(`this server runs release ${deployed} but is configured for ` +
      `${describeRelease(configured, values.LUMA_RELEASE_VERSION)}, and this operator is Luma ${release.version} ` +
      `(release ${operator.id}); run the backup from the folder of the release it is configured for`);
  }
  const inspected = docker(['inspect', '--format', '{{.Config.Image}}', database.id]);
  const postgresImage = inspected.stdout.trim();
  if (inspected.status !== 0 || !DIGEST_PINNED_IMAGE.test(postgresImage)) {
    throw new Error('the running PostgreSQL is not the digest-pinned image of a Luma release');
  }
  const volumes = [];
  for (const { key, required } of VOLUMES) {
    if (volumeExists(docker, `${project}_${key}`)) volumes.push(key);
    else if (required) throw new Error(`the ${project} stack has no ${project}_${key} volume`);
  }

  const output = backupOutput(options.output, release.version, now);
  const staging = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}.partial-`));
  try {
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA,
      kind: MANIFEST_KIND,
      createdAt: now.toISOString(),
      release: operator,
      deployedRelease: deployed,
      project,
      postgresImage,
      directories: [],
      files: [],
    };
    // Every service that writes the copied state is frozen, so the dump and
    // the volume copies are one moment of the server. Nothing restarts.
    const writers = running.filter((container) => !UNPAUSED_SERVICES.has(container.service));
    whilePaused(docker, writers, () => {
      manifest.files.push(captureStream(staging, DATABASE_FILE, 'the PostgreSQL dump', (descriptor) => docker([
        'exec', database.id, 'pg_dumpall', `--username=${DATABASE_USER}`, '--lock-wait-timeout=60s',
      ], { stdout: descriptor })));
      for (const key of volumes) {
        manifest.files.push(captureStream(staging, `volumes/${key}.tar`, `copying volume ${project}_${key}`,
          (descriptor) => docker([
            'run', '--rm', '--network', 'none', '--entrypoint', 'tar',
            '--volume', `${project}_${key}:/volume:ro`, postgresImage,
            '--numeric-owner', '-C', '/volume', '-cf', '-', '.',
          ], { stdout: descriptor })));
      }
    });
    manifest.files.push(copyPrivate(ENV_FILE, staging, ENV_ENTRY, fs.lstatSync(ENV_FILE).mode));
    copyTree(PRODUCTION_DIR, 'production', staging, manifest);
    if (fs.existsSync(PIN_RELEASES_DIR)) {
      requireRealDirectory(PIN_RELEASES_DIR, 'the Pin release store');
      copyTree(PIN_RELEASES_DIR, 'pin-releases', staging, manifest);
    }
    fs.writeFileSync(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error(`refusing to replace an existing path: ${output}`);
    fs.renameSync(staging, output);
    return Object.freeze({ output, manifest, volumes });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function backupCommand(args, runtime = {}) {
  const write = runtime.write ?? info;
  let options;
  try {
    if (args[0] !== 'production') throw new Error('usage');
    options = parseArguments(args.slice(1), ['--output', '--project-name'], []);
  } catch {
    fail(`usage: ${BACKUP_USAGE}`, 64);
  }
  let result;
  try {
    result = backupProduction({ output: options['--output'], projectName: options['--project-name'] }, runtime);
  } catch (error) {
    fail(`backup stopped: ${error.message}`);
  }
  const { manifest, output, volumes } = result;
  const size = manifest.files.reduce((total, entry) => total + entry.size, 0);
  const configuration = manifest.files.filter((entry) => entry.mode !== undefined).length;
  let user = 'YOU';
  try { user = os.userInfo().username; } catch { /* keep the placeholder */ }
  // The public domain may sit behind a proxy such as Cloudflare, which does
  // not carry SSH. The server's own public IPv4 does, when it is configured.
  const host = (() => {
    try {
      const address = parseEnvFile(ENV_FILE).LUMA_DEVICE_EDGE_IPV4 || '';
      return net.isIPv4(address) ? address : '<your-server>';
    } catch {
      return '<your-server>';
    }
  })();
  write(manifest.deployedRelease === manifest.release.id
    ? `Backed up Luma ${manifest.release.version} (release ${manifest.release.id}) to ${output}`
    : `Backed up the server running release ${manifest.deployedRelease} with Luma ${manifest.release.version} ` +
      `(release ${manifest.release.id}) to ${output}`);
  write(`  database: ${DATABASE_FILE}; volumes: ${volumes.join(', ')}; configuration and keys: ${configuration} files`);
  write(`  ${manifest.files.length} files, ${formatBytes(size)}, each with its SHA-256 in ${MANIFEST}`);
  write('It holds every key and secret of this server and is readable only by you.');
  write('Copy it off this server; from your own computer, for example:');
  write(`  scp -r ${shellWord(`${user}@${host}:${output}`)} .`);
  write(`To restore it, run from the Luma ${manifest.release.version} operator directory:`);
  write(`  ./luma restore production --from ${shellWord(output)}`);
}

// ---------------------------------------------------------------- restore

function safeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  return value.split('/').every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

function treeOf(relative) {
  return Object.keys(TREES).find((name) => relative === name || relative.startsWith(`${name}/`)) ?? null;
}

function validateManifest(manifest) {
  const problems = [];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(manifest) || manifest.kind !== MANIFEST_KIND) {
    throw new Error(`${MANIFEST} is not a Luma production backup`);
  }
  const { release } = manifest;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    const named = typeof release?.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/u.test(release.version)
      ? `Luma ${release.version}` : 'another Luma release';
    throw new Error(`${MANIFEST} is a backup made by ${named}; restore it with that operator release`);
  }
  if (!object(release) || typeof release.version !== 'string' || !release.version ||
      !RELEASE_ID.test(release.id || '') || typeof release.application !== 'string') {
    problems.push('release identity is invalid');
  }
  if (typeof manifest.deployedRelease !== 'string' || !RELEASE_ID.test(manifest.deployedRelease)) {
    problems.push('deployedRelease is invalid');
  }
  if (!DIGEST_PINNED_IMAGE.test(manifest.postgresImage || '')) problems.push('postgresImage is not digest-pinned');
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
    throw new Error(`${MANIFEST} is invalid: files and directories must be lists`);
  }
  const directories = new Set();
  for (const entry of manifest.directories) {
    if (!object(entry) || !safeRelative(entry.path) || !treeOf(entry.path) || !MODE.test(entry.mode || '') ||
        directories.has(entry.path)) {
      problems.push(`directory entry ${JSON.stringify(entry?.path)} is invalid`);
      continue;
    }
    directories.add(entry.path);
  }
  for (const directory of directories) {
    if (directory.includes('/') && !directories.has(path.posix.dirname(directory))) {
      problems.push(`directory ${directory} has no listed parent`);
    }
  }
  const volumeKeys = new Set(VOLUMES.map((volume) => volume.key));
  const files = new Set();
  for (const entry of manifest.files) {
    const relative = entry?.path;
    const tree = safeRelative(relative) ? treeOf(relative) : null;
    const volume = /^volumes\/(.+)\.tar$/u.exec(relative || '')?.[1];
    const known = relative === DATABASE_FILE || relative === ENV_ENTRY ||
      (volume !== undefined && volumeKeys.has(volume)) || (tree !== null && relative !== tree);
    const needsMode = relative === ENV_ENTRY || tree !== null;
    if (!object(entry) || !known || files.has(relative) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256 || '') ||
        (needsMode ? !MODE.test(entry.mode || '') : entry.mode !== undefined) ||
        (relative === ENV_ENTRY && entry.mode !== '0600') ||
        (tree !== null && !directories.has(path.posix.dirname(relative)))) {
      problems.push(`file entry ${JSON.stringify(relative)} is invalid`);
      continue;
    }
    files.add(relative);
  }
  for (const required of [DATABASE_FILE, ENV_ENTRY,
    ...VOLUMES.filter((volume) => volume.required).map((volume) => `volumes/${volume.key}.tar`)]) {
    if (!files.has(required)) problems.push(`${required} is missing from the manifest`);
  }
  if (!directories.has('production')) problems.push('the production configuration is missing from the manifest');
  if (problems.length) throw new Error(`${MANIFEST} is invalid:\n- ${problems.join('\n- ')}`);
  return files;
}

function verifyBackup(selected) {
  const directory = path.resolve(selected);
  requireRealDirectory(directory, 'the backup');
  for (const tree of Object.values(TREES)) {
    if (isInsideDirectory(directory, tree)) {
      throw new Error(`the backup cannot be inside ${tree}, which the restore replaces; move it elsewhere first`);
    }
  }
  const manifestFile = path.join(directory, MANIFEST);
  const manifestStat = fs.lstatSync(manifestFile, { throwIfNoEntry: false });
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 16 * 1024 * 1024) {
    throw new Error(`${manifestFile} is missing; choose the directory that ./luma backup production created`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new Error(`${manifestFile} is not valid JSON`);
  }
  const listed = validateManifest(manifest);
  const present = new Set();
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const inner = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), inner);
      else if (entry.isFile()) present.add(inner);
      else throw new Error(`the backup contains ${inner}, which is not a regular file or directory`);
    }
  };
  walk(directory, '');
  present.delete(MANIFEST);
  const unexpected = [...present].filter((entry) => !listed.has(entry));
  if (unexpected.length) {
    // Copying through a desktop file manager can add files such as .DS_Store.
    throw new Error(`the backup contains files its manifest does not list: ${unexpected.slice(0, 5).join(', ')}; ` +
      'delete them from the backup folder, then rerun');
  }
  for (const entry of manifest.files) {
    const file = path.join(directory, entry.path);
    if (!present.has(entry.path)) throw new Error(`the backup is incomplete: ${entry.path} is missing`);
    if (fs.statSync(file).size !== entry.size || sha256File(file) !== entry.sha256) {
      throw new Error(`the backup is damaged: ${entry.path} does not match its SHA-256 checksum`);
    }
  }
  return Object.freeze({ directory, manifest });
}

// The target is this backup's server: a fresh host, or a stopped stack of the
// release it ran or of the operator release that backed it up.
function inspectTarget(docker, project, manifest) {
  const wanted = new Set([manifest.release.id, manifest.deployedRelease]);
  const named = [...wanted].join(' or ');
  const containers = projectContainers(docker, project);
  if (containers.some((container) => ACTIVE_STATES.has(container.state))) {
    throw new Error(`the ${project} stack is running on this host; stop it first, then rerun this restore:\n` +
      `  docker stop $(docker ps --quiet --filter label=com.docker.compose.project=${project})`);
  }
  const otherReleases = [...new Set(containers
    .filter((container) => !wanted.has(container.release))
    .map((container) => container.release || 'unlabelled'))];
  if (otherReleases.length) {
    throw new Error(`this host has a stopped ${project} stack of release ${otherReleases.join(', ')}, and the backup is ` +
      `release ${named}; restore onto a fresh host or a stopped stack of the same release`);
  }
  const envExists = Boolean(fs.lstatSync(ENV_FILE, { throwIfNoEntry: false }));
  if (envExists) {
    let configured;
    try {
      configured = readRuntimeValues().LUMA_RELEASE_ID || '';
    } catch (error) {
      throw new Error(`the existing configuration cannot be read: ${error.message}`);
    }
    if (!wanted.has(configured)) {
      throw new Error(`${ENV_FILE} is configured for release ${configured || 'none'}, and the backup is release ` +
        `${named}; restore onto a fresh host or a stopped stack of the same release`);
    }
  }
  const volumes = [...manifest.files
    .map((entry) => /^volumes\/(.+)\.tar$/u.exec(entry.path)?.[1])
    .filter(Boolean), DATABASE_VOLUME];
  return Object.freeze({
    containers: containers.length,
    envExists,
    existingVolumes: new Set(volumes.filter((key) => volumeExists(docker, `${project}_${key}`))),
    volumes,
  });
}

function restorePlan(backup, target, project, release, configured, configuredVersion = '') {
  const { manifest, directory } = backup;
  const verb = (exists) => (exists ? 'replace' : 'create');
  const treeFiles = (tree) => manifest.files.filter((entry) => treeOf(entry.path) === tree).length;
  const hasPinReleases = manifest.directories.some((entry) => entry.path === 'pin-releases');
  const ran = manifest.deployedRelease === manifest.release.id
    ? '' : ` while the server ran release ${manifest.deployedRelease}`;
  return [
    `Restore Luma ${manifest.release.version} (release ${manifest.release.id}) from ${directory}`,
    `  Backup made ${manifest.createdAt}${ran}; all ${manifest.files.length} files match their SHA-256 checksums.`,
    `  This operator: Luma ${release.version}. Target: ${target.containers
      ? `stopped ${project} stack (${target.containers} containers)` : `no ${project} containers on this host`}.`,
    `  Configuration: ${verb(fs.existsSync(PRODUCTION_DIR))} ${PRODUCTION_DIR} (${treeFiles('production')} files), ` +
      `${verb(target.envExists)} ${ENV_FILE}`,
    ...(hasPinReleases
      ? [`  Pin releases: ${verb(fs.existsSync(PIN_RELEASES_DIR))} ${PIN_RELEASES_DIR} (${treeFiles('pin-releases')} files)`]
      : []),
    `  Volumes: ${target.volumes.map((key) =>
      `${project}_${key} (${verb(target.existingVolumes.has(key))})`).join(', ')}`,
    `  Database: ${DATABASE_FILE} into ${project}_${DATABASE_VOLUME}`,
    configured === manifest.release.id
      ? `  Then: ./luma deploy production --confirm${project === 'luma' ? '' : ` --project-name ${project}`}`
      : `  Then: nothing is deployed. The configuration is ${describeRelease(configured, configuredVersion)}, ` +
        `from before the Luma ${manifest.release.version} setup ran, so that release's operator deploys it.`,
  ];
}

// Fill a staged copy, then swap it in with two renames, so an interruption
// never leaves a half-restored configuration in place. The tree it replaces
// always moves to the one fixed sibling name `<destination>.previous`, so an
// interruption can never hide the old tree under a random suffix;
// validateProductionArtifacts reports exactly that path when it survives.
function restoreTree(backup, tree) {
  const destination = TREES[tree];
  const replaced = `${destination}.previous`;
  // restoreProduction refuses before changing anything. This is the backstop.
  if (fs.lstatSync(replaced, { throwIfNoEntry: false })) throw new Error(interruptedRestoreProblems().join('; '));
  const parent = path.dirname(destination);
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.restore-`));
  try {
    const directories = backup.manifest.directories
      .filter((entry) => treeOf(entry.path) === tree)
      .sort((left, right) => left.path.split('/').length - right.path.split('/').length);
    const local = (relative) => path.join(staging, ...relative.split('/').slice(1));
    for (const entry of directories) {
      if (entry.path !== tree) fs.mkdirSync(local(entry.path), { mode: 0o700 });
    }
    for (const entry of backup.manifest.files.filter((file) => treeOf(file.path) === tree)) {
      fs.copyFileSync(path.join(backup.directory, entry.path), local(entry.path), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(local(entry.path), Number.parseInt(entry.mode, 8));
    }
    // Deepest first, so no directory closes before its contents are written.
    for (const entry of [...directories].reverse()) fs.chmodSync(local(entry.path), Number.parseInt(entry.mode, 8));
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
      fs.renameSync(destination, replaced);
      fs.renameSync(staging, destination);
      fs.rmSync(replaced, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, destination);
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function restoreVolume(docker, project, backup, entry) {
  const key = /^volumes\/(.+)\.tar$/u.exec(entry.path)[1];
  const volume = ensureVolume(docker, project, key);
  const descriptor = fs.openSync(path.join(backup.directory, entry.path), 'r');
  let result;
  try {
    result = docker([
      'run', '--rm', '--interactive', '--network', 'none', '--entrypoint', 'sh',
      '--volume', `${volume}:/volume`, backup.manifest.postgresImage,
      '-c', 'set -e; find /volume -mindepth 1 -delete; tar --numeric-owner -xpf - -C /volume',
    ], { stdin: descriptor });
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.status !== 0) throw new Error(`restoring volume ${volume} failed: ${firstLine(result.stderr)}`);
}

function restoreDatabase(docker, project, backup, pause) {
  const image = backup.manifest.postgresImage;
  const volume = ensureVolume(docker, project, DATABASE_VOLUME);
  const name = `${project}-restore-postgres`;
  docker(['rm', '--force', name]);
  const emptied = docker([
    'run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--volume', `${volume}:/volume`, image,
    '-c', 'find /volume -mindepth 1 -delete',
  ]);
  if (emptied.status !== 0) throw new Error(`emptying volume ${volume} failed: ${firstLine(emptied.stderr)}`);
  // A fresh cluster with only the bootstrap superuser. Its throwaway password
  // travels in Docker's environment, never in argv, and the dump then sets the
  // saved one.
  const started = docker([
    'run', '--detach', '--name', name, '--network', 'none',
    '--env', `POSTGRES_USER=${DATABASE_USER}`, '--env', 'POSTGRES_DB=postgres', '--env', 'POSTGRES_PASSWORD',
    '--volume', `${volume}:/var/lib/postgresql/data`, image,
  ], { env: { POSTGRES_PASSWORD: crypto.randomBytes(24).toString('hex') } });
  if (started.status !== 0) throw new Error(`starting PostgreSQL for the restore failed: ${firstLine(started.stderr)}`);
  try {
    // TCP readiness: the image's first-run server listens only on its socket
    // and restarts once initialization ends.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (docker(['exec', name, 'pg_isready', '--host=127.0.0.1', `--username=${DATABASE_USER}`,
      '--dbname=postgres', '--quiet']).status !== 0) {
      if (Date.now() >= deadline) {
        const logs = docker(['logs', '--tail', '10', name]);
        throw new Error(`PostgreSQL did not become ready for the restore:\n${`${logs.stdout}${logs.stderr}`.trim()}`);
      }
      pause(1000);
    }
    const descriptor = fs.openSync(path.join(backup.directory, DATABASE_FILE), 'r');
    let restored;
    try {
      restored = docker(['exec', '--interactive', name, 'sh', '-c', DATABASE_RESTORE_SCRIPT], { stdin: descriptor });
    } finally {
      fs.closeSync(descriptor);
    }
    if (restored.status !== 0) throw new Error(`PostgreSQL refused the dump: ${firstLine(restored.stderr)}`);
    const stopped = docker(['stop', '--time', '60', name]);
    if (stopped.status !== 0) throw new Error(`stopping the restore PostgreSQL failed: ${firstLine(stopped.stderr)}`);
  } finally {
    docker(['rm', '--force', name]);
  }
}

function restoreProduction(options = {}, runtime = {}) {
  const docker = runtime.docker ?? runDocker;
  const release = (runtime.release ?? versionInfo)();
  const write = runtime.write ?? info;
  const deploy = runtime.deploy ?? ((args) => deployProduction(args, { throwOnFailure: true }));
  const project = options.projectName ?? 'luma';

  const backup = verifyBackup(options.from);
  const saved = backup.manifest.release;
  if (saved.version !== release.version ||
      (release.revision !== 'source' && (saved.id !== release.revision || saved.application !== release.application))) {
    throw new Error(`the backup is Luma ${saved.version} (release ${saved.id}), and this operator is Luma ` +
      `${release.version}; restore it with the Luma ${saved.version} operator release`);
  }
  // A backup taken before this operator's setup ran holds the configuration of
  // the release the server ran, which only that release's operator deploys.
  const savedValues = parseEnvFile(path.join(backup.directory, ENV_ENTRY));
  const configured = savedValues.LUMA_RELEASE_ID || '';
  const configuredRelease = describeRelease(configured, savedValues.LUMA_RELEASE_VERSION);
  if (configured !== saved.id && configured !== backup.manifest.deployedRelease) {
    throw new Error(`the backup's ${ENV_ENTRY} is configured for neither release ${saved.id} nor ` +
      `${backup.manifest.deployedRelease}`);
  }
  const interrupted = interruptedRestoreProblems();
  if (interrupted.length) throw new Error(interrupted.join('\n'));
  const target = inspectTarget(docker, project, backup.manifest);
  for (const line of restorePlan(backup, target, project, release, configured, savedValues.LUMA_RELEASE_VERSION)) {
    write(line);
  }
  const projectArgs = project === 'luma' ? [] : ['--project-name', project];
  if (!options.confirm) {
    write('Nothing was changed. To restore, run:');
    write(`  ./luma restore production --from ${shellWord(backup.directory)} --confirm${projectArgs.map((arg) => ` ${arg}`).join('')}`);
    return Object.freeze({ restored: false });
  }

  prepareManagedRoots();
  restoreTree(backup, 'production');
  if (backup.manifest.directories.some((entry) => entry.path === 'pin-releases')) restoreTree(backup, 'pin-releases');
  atomicWrite(ENV_FILE, fs.readFileSync(path.join(backup.directory, ENV_ENTRY)), 0o600);
  write('Restored the configuration, keys, and secrets.');
  for (const entry of backup.manifest.files.filter((file) => file.path.startsWith('volumes/'))) {
    restoreVolume(docker, project, backup, entry);
  }
  write('Restored the volumes.');
  restoreDatabase(docker, project, backup, runtime.sleep ?? sleep);
  const deployCommand = ['production', '--confirm', ...projectArgs];
  if (configured !== saved.id) {
    write(`Restored the database. Nothing was deployed: the configuration is ${configuredRelease}, ` +
      `from before the Luma ${saved.version} setup ran.`);
    write(`To start the server as it was, run from the folder of ${configuredRelease}:`);
    write(`  ./luma deploy ${deployCommand.join(' ')}`);
    return Object.freeze({ restored: true });
  }
  write('Restored the database. Deploying the restored server.');
  try {
    deploy(deployCommand);
  } catch (error) {
    const failure = new Error(`the backup is restored, but the deployment stopped: ${error.message}\n` +
      `Fix the cause, then run: ./luma deploy ${deployCommand.join(' ')}`);
    failure.restored = true;
    throw failure;
  }
  write(`Restored Luma ${saved.version} from ${backup.directory}.`);
  return Object.freeze({ restored: true });
}

function restoreCommand(args, runtime = {}) {
  let options;
  try {
    if (args[0] !== 'production') throw new Error('usage');
    options = parseArguments(args.slice(1), ['--from', '--project-name'], ['--confirm']);
    if (!options['--from']) throw new Error('usage');
  } catch {
    fail(`usage: ${RESTORE_USAGE}`, 64);
  }
  try {
    restoreProduction({
      from: options['--from'],
      confirm: options['--confirm'] === true,
      projectName: options['--project-name'],
    }, runtime);
  } catch (error) {
    if (error.restored) fail(`restore stopped: ${error.message}`);
    fail(options['--confirm']
      ? `restore stopped: ${error.message}\nThe stack was not started. Fix the cause, then rerun the same command.`
      : `restore check failed: ${error.message}\nNothing was changed.`);
  }
}

module.exports = {
  DATABASE_RESTORE_FILTER,
  backupCommand,
  backupProduction,
  restoreCommand,
  restoreProduction,
};
