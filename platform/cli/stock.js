'use strict';
// `./luma stock decompile`: the local stock reference that faithful work cites.
//
// Stock APKs, framework jars, and their decompile are Humane's code. They are
// written only under LUMA_DATA_DIR/stock-reference, never into the source
// tree, and are never committed or published.
//
// --from-device only reads the Pin: `get-state`, `pm list packages -f`,
// `ls /system/framework`, `getprop`, and `adb pull`. jadx is the release pinned
// by version and SHA-256 in toolchain.json and runs, without network, in the
// builder's digest-pinned JDK image, because host JVMs crash at startup on
// some Macs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  BUILD_DIR,
  DATA_DIR,
  TOOLCHAIN_CONFIG,
  dockerBindMount,
  fail,
  info,
  isInsideSource,
  operatorEnvironment,
  prepareManagedRoots,
  run,
  secureDirectory,
} = require('./context');

const USAGE = 'usage: ./luma stock decompile --from-device SERIAL | --apk-dir DIR';
const SERIAL_PATTERN = /^[0-9A-Za-z._:-]{1,128}$/u;
const STOCK_PACKAGE = /^(?:hu\.ma\.ne|humane)\./u;
// Stock apps live on the read-only system partitions; /data/app holds Luma's
// own companion apps and any update, neither of which is the stock reference.
const STOCK_PARTITION = /^\/(?:system|system_ext|product|vendor)\//u;
const STOCK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:apk|jar)$/u;
const FRAMEWORK_DIRECTORY = '/system/framework';
const FRAMEWORK_JAR = /^humane_[A-Za-z0-9._-]*\.jar$/u;
// jadx exits 3 when it finished but some methods did not decompile cleanly;
// it marks them in the output, which is normal for the large stock apps.
const JADX_ACCEPTED_EXITS = new Set([0, 3]);

function stockReferencePaths(dataDir = DATA_DIR) {
  const root = path.join(path.resolve(dataDir), 'stock-reference');
  return Object.freeze({
    root,
    apks: path.join(root, 'apks'),
    decompiled: path.join(root, 'decompiled'),
    manifest: path.join(root, 'manifest.json'),
  });
}

function parseStockArgs(args) {
  if (args.length !== 3 || args[0] !== 'decompile') throw new Error(USAGE);
  const [, flag, value] = args;
  if (flag === '--from-device') {
    if (!SERIAL_PATTERN.test(value)) throw new Error('--from-device requires the exact adb serial of the Pin');
    return Object.freeze({ source: 'device', serial: value });
  }
  if (flag === '--apk-dir' && value) return Object.freeze({ source: 'directory', directory: path.resolve(value) });
  throw new Error(USAGE);
}

function jadxPin(contractFile = TOOLCHAIN_CONFIG) {
  const toolchain = JSON.parse(fs.readFileSync(contractFile, 'utf8')).toolchain;
  const jadx = toolchain?.jadx;
  const jdk = toolchain?.jdk;
  if (!/^\d+\.\d+\.\d+$/u.test(jadx?.version ?? '') ||
      typeof jadx.archive?.url !== 'string' || !jadx.archive.url.startsWith('https://') ||
      !Number.isSafeInteger(jadx.archive.size) || !/^[0-9a-f]{64}$/u.test(jadx.archive.sha256 ?? '') ||
      typeof jdk?.image !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(jdk.imageIndexDigest ?? '')) {
    throw new Error(`${contractFile} does not pin jadx (version, archive URL, size, SHA-256) and the JDK image`);
  }
  return Object.freeze({
    version: jadx.version,
    url: jadx.archive.url,
    size: jadx.archive.size,
    sha256: jadx.archive.sha256,
    jar: `lib/jadx-${jadx.version}-all.jar`,
    image: `${jdk.image}@${jdk.imageIndexDigest}`,
  });
}

function stockPackagePaths(listing) {
  const paths = [];
  for (const line of String(listing).split(/\r?\n/u)) {
    const match = /^package:(\/\S+\.apk)=([A-Za-z0-9._]+)$/u.exec(line.trim());
    if (match && STOCK_PARTITION.test(match[1]) && STOCK_PACKAGE.test(match[2])) paths.push(match[1]);
  }
  return paths;
}

function stockFrameworkJars(listing) {
  return String(listing).split(/\s+/u)
    .filter((name) => FRAMEWORK_JAR.test(name))
    .map((name) => `${FRAMEWORK_DIRECTORY}/${name}`);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
}

async function ensureJadxArchive(pin, directory, { download = downloadFile, log = info } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = path.join(directory, `jadx-${pin.version}.zip`);
  if (fs.existsSync(archive)) {
    if (await sha256File(archive) === pin.sha256) return archive;
    log(`[stock] the cached ${path.basename(archive)} does not match its pinned SHA-256; downloading it again`);
    fs.rmSync(archive);
  }
  const partial = `${archive}.partial`;
  fs.rmSync(partial, { force: true });
  log(`[stock] downloading jadx ${pin.version} into ${directory}`);
  await download(pin.url, partial);
  const size = fs.statSync(partial).size;
  const digest = await sha256File(partial);
  if (size !== pin.size || digest !== pin.sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`the downloaded jadx ${pin.version} does not match toolchain.json (size ${size}, SHA-256 ${digest})`);
  }
  fs.renameSync(partial, archive);
  return archive;
}

// The reference and the jadx cache live in Luma's data directory. Create it the
// way every command does, owner-only and marked for Luma (so a later `setup`
// accepts a custom LUMA_DATA_DIR), and keep both directories owner-only.
function prepareStockDirectories(paths, toolsDirectory) {
  prepareManagedRoots();
  secureDirectory(paths.root);
  secureDirectory(toolsDirectory);
}

function replaceDirectory(staging, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
}

// jadx writes each input to decompiled/<name>. Names are compared without case
// because a pull onto a case-insensitive disk (the macOS default) would
// otherwise overwrite one stock file with another.
function outputName(file) {
  return file.replace(/\.(?:apk|jar)$/u, '');
}

function requireDistinct(names, describe) {
  const seen = new Map();
  for (const name of names) {
    const key = describe(name).toLowerCase();
    if (seen.has(key)) throw new Error(`${seen.get(key)} and ${name} would overwrite each other`);
    seen.set(key, name);
  }
}

// Pulls into `${destination}.partial` and returns that directory. The caller
// swaps it in only after every file decompiles, so apks/, decompiled/, and
// manifest.json always describe the same run, whichever source it had.
function pullStockFiles(serial, destination, adb, log) {
  const state = adb(['get-state']);
  if (state.status !== 0 || String(state.stdout).trim() !== 'device') {
    throw new Error(`adb device ${serial} is not connected and authorized`);
  }
  const packages = adb(['shell', 'pm', 'list', 'packages', '-f']);
  const framework = adb(['shell', 'ls', FRAMEWORK_DIRECTORY]);
  if (packages.status !== 0 || framework.status !== 0) {
    throw new Error(`could not list the stock packages on ${serial}`);
  }
  const remote = [...stockPackagePaths(packages.stdout), ...stockFrameworkJars(framework.stdout)];
  if (remote.length === 0) throw new Error(`no stock Humane apps were found on ${serial}; is it an Ai Pin?`);
  for (const file of remote) {
    if (!STOCK_FILE.test(path.posix.basename(file))) throw new Error(`unexpected stock file name on ${serial}: ${file}`);
  }
  requireDistinct(remote, (file) => path.posix.basename(file));
  requireDistinct(remote, (file) => outputName(path.posix.basename(file)));

  const staging = `${destination}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const origins = new Map();
  log(`[stock] pulling ${remote.length} stock apps and framework jars from ${serial} (read-only)`);
  for (const file of remote) {
    const name = path.posix.basename(file);
    origins.set(name, file);
    const pulled = adb(['pull', file, path.join(staging, name)]);
    if (pulled.status !== 0) throw new Error(`adb pull failed for ${file}`);
  }
  const fingerprint = adb(['shell', 'getprop', 'ro.build.fingerprint']);
  return {
    staging,
    origins,
    fingerprint: fingerprint.status === 0 ? String(fingerprint.stdout).trim() || null : null,
  };
}

function stockFiles(directory) {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`stock APK directory does not exist: ${directory}`);
  const files = fs.readdirSync(directory)
    .filter((name) => STOCK_FILE.test(name) && fs.statSync(path.join(directory, name)).isFile())
    .sort();
  if (files.length === 0) throw new Error(`no .apk or .jar files in ${directory}`);
  requireDistinct(files, outputName);
  return files;
}

// --apk-dir stages a copy the same way, so apks/ always holds exactly the files
// decompiled/ and manifest.json describe. The evidence tests hash apks/ before
// they trust decompiled/. The copy is a clone where the disk supports one.
function copyStockFiles(directory, destination, log) {
  const files = stockFiles(directory);
  const staging = `${destination}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  log(`[stock] copying ${files.length} stock apps and framework jars from ${directory}`);
  for (const file of files) {
    const copy = path.join(staging, file);
    fs.copyFileSync(path.join(directory, file), copy, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(copy, 0o600);
  }
  return staging;
}

// One container per input keeps each exit status exact. The container has no
// network, a read-only root, and sees only the verified archive, one input,
// and the staging output directory.
function jadxDockerArgs(pin, { archive, input, output, platform, user }) {
  const file = path.basename(input);
  const name = outputName(file);
  return [
    'run', '--rm', '--init',
    '--platform', platform,
    '--user', user,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=1g',
    '--env', 'HOME=/tmp',
    '--mount', dockerBindMount(archive, '/tools/jadx.zip', true),
    '--mount', dockerBindMount(input, `/stock/${file}`, true),
    '--mount', dockerBindMount(output, '/out'),
    pin.image,
    'sh', '-c',
    `cd /tmp && jar xf /tools/jadx.zip ${pin.jar} && exec java -XX:MaxRAMPercentage=70 ` +
      `-Djdk.util.zip.disableZip64ExtraFieldValidation=true -cp /tmp/${pin.jar} jadx.cli.JadxCLI ` +
      '--show-bad-code -d "/out/$1" "/stock/$2"',
    'jadx', name, file,
  ];
}

function containerUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const gid = typeof process.getgid === 'function' ? process.getgid() : os.userInfo().gid;
  return `${uid}:${gid}`;
}

async function decompileStock(options, {
  paths = stockReferencePaths(),
  toolsDirectory = path.join(BUILD_DIR, 'stock-tools'),
  pin = jadxPin(),
  adb = (args) => run('adb', ['-s', options.serial, ...args], {
    capture: true, allowFailure: true, env: operatorEnvironment(),
  }),
  docker = (args) => run('docker', args, { allowFailure: true, env: operatorEnvironment() }),
  download = downloadFile,
  platform = require('./pin-debug').nativeDockerPlatform(),
  user = containerUser(),
  log = info,
  prepare = prepareStockDirectories,
} = {}) {
  const external = [['the stock reference', paths.root], ['the jadx cache', toolsDirectory]];
  if (options.source === 'directory') external.push(['--apk-dir', options.directory]);
  for (const [label, directory] of external) {
    if (isInsideSource(directory)) {
      throw new Error(`${label} must be outside the source tree (stock apps are Humane's code): ${directory}`);
    }
  }
  prepare(paths, toolsDirectory);

  let inputDirectory;
  let origins = new Map();
  let fingerprint = null;
  if (options.source === 'device') {
    ({ staging: inputDirectory, origins, fingerprint } = pullStockFiles(options.serial, paths.apks, adb, log));
  } else {
    inputDirectory = copyStockFiles(options.directory, paths.apks, log);
  }
  const files = stockFiles(inputDirectory);
  const archive = await ensureJadxArchive(pin, toolsDirectory, { download, log });

  const staging = `${paths.decompiled}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { mode: 0o700 });
  const inputs = [];
  for (const [index, file] of files.entries()) {
    const input = fs.realpathSync(path.join(inputDirectory, file));
    log(`[stock] jadx ${pin.version}: ${file} (${index + 1}/${files.length})`);
    const result = docker(jadxDockerArgs(pin, { archive, input, output: staging, platform, user }));
    if (!JADX_ACCEPTED_EXITS.has(result.status)) {
      throw new Error(`jadx failed on ${file} (exit ${result.status ?? result.signal}); partial output is in ${staging}`);
    }
    inputs.push({
      file,
      sha256: await sha256File(input),
      devicePath: origins.get(file) ?? null,
      jadxExit: result.status,
    });
  }
  replaceDirectory(inputDirectory, paths.apks);
  replaceDirectory(staging, paths.decompiled);

  const manifest = {
    schemaVersion: 1,
    jadx: { version: pin.version, sha256: pin.sha256, image: pin.image },
    buildFingerprint: fingerprint,
    inputs,
  };
  const temporary = `${paths.manifest}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, paths.manifest);

  log(`[stock] decompiled ${inputs.length} stock files; ` +
    `${inputs.filter((entry) => entry.jadxExit !== 0).length} have methods jadx marked as not decompiled cleanly`);
  log(`[stock] stock reference: ${paths.decompiled}`);
  log(`[stock] provenance: ${paths.manifest}`);
  log('[stock] this is Humane\'s code: keep it outside the checkout and never commit or publish it.');
  return manifest;
}

function stockCommand(args, dependencies) {
  let options;
  try {
    options = parseStockArgs(args);
  } catch (error) {
    fail(error.message, 64);
  }
  return decompileStock(options, dependencies).catch((error) => fail(error.message));
}

module.exports = {
  USAGE,
  decompileStock,
  ensureJadxArchive,
  jadxDockerArgs,
  jadxPin,
  parseStockArgs,
  prepareStockDirectories,
  sha256File,
  stockCommand,
  stockFrameworkJars,
  stockPackagePaths,
  stockReferencePaths,
};
