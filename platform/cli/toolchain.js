'use strict';

const child = require('node:child_process');
const fs = require('node:fs');
// Host toolchain contracts: version parsing and the pinned Node/Rust/JDK checks.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  TOOLCHAIN_CONFIG, MINIMUM_COMPOSE_VERSION, info, exists, run,
} = require('./context');

function parseVersion(value) {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(value.trim());
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

function parseNamedCommandVersion(value, command) {
  if (typeof value !== 'string' || !['rustc', 'cargo'].includes(command)) return null;
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}[ \\t]+(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+ \\t].*)?$`, 'gm');
  const matches = [...value.matchAll(pattern)];
  return matches.length === 1 ? matches[0].slice(1, 4).map(Number) : null;
}

function parseJavaVersionBanner(value) {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(/^(?:openjdk|java)[ \t]+version[ \t]+"([^"]+)"(?:[ \t].*)?$/gm)];
  if (matches.length !== 1) return null;
  const raw = matches[0][1];
  if (!/^\d+(?:[._+-]\d+)*(?:-[A-Za-z0-9._+-]+)?$/.test(raw)) return null;
  const numeric = raw.match(/\d+/g)?.map(Number) ?? [];
  if (numeric.length === 0) return null;
  if (numeric[0] === 1 && numeric.length > 1) return [numeric[1], numeric[2] ?? 0, numeric[3] ?? 0];
  return [numeric[0], numeric[1] ?? 0, numeric[2] ?? 0];
}

function parseCommandVersion(value, command) {
  if (command === 'java') return parseJavaVersionBanner(value);
  return parseNamedCommandVersion(value, command);
}

function parseQemuX86VersionBanner(value) {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(/^qemu-x86_64 version (\d+)\.(\d+)\.(\d+)(?:[ \t].*)?$/gm)];
  return matches.length === 1 ? matches[0].slice(1, 4).map(Number) : null;
}

const PIN_AMD64_HOSTED_GUIDANCE =
  'Run the canonical Pin Android consumer on a native hosted linux/amd64 runner; ' +
  'keep this ARM host for static/image-assembly validation and do not alter its binfmt registration.';
const QEMU_VERSION_PROBE_ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C' });

function diagnosePinAmd64Runtime({
  architecture,
  platform,
  binfmtRegistered = false,
  qemuVersionBanner = '',
  cpuInfo = '',
  emulationEvidence = '',
}) {
  const evidence = `${qemuVersionBanner}\n${cpuInfo}\n${emulationEvidence}`.toLowerCase();
  const nativeVendor = /vendor_id\s*:\s*(?:genuineintel|authenticamd)/iu.test(cpuInfo);
  const translated = ['qemu', 'tcg', 'rosetta', 'emulat', 'box64', 'fex-emu']
    .some((token) => evidence.includes(token));
  if (platform === 'linux' && architecture === 'x64' &&
      !binfmtRegistered && nativeVendor && !translated) {
    return Object.freeze({ safe: true, detail: 'native linux/amd64 runtime' });
  }
  return Object.freeze({
    safe: false,
    detail: `unsupported non-native Pin consumer host ${platform || '<unknown>'}/${architecture || '<unknown>'}`,
    guidance: PIN_AMD64_HOSTED_GUIDANCE,
  });
}

function probePinAmd64Runtime({
  architecture = process.arch,
  platform = process.platform,
  readRegistration = () => fs.readFileSync('/proc/sys/fs/binfmt_misc/qemu-x86_64', 'utf8'),
  readBinfmtRegistrations = () => fs.readdirSync('/proc/sys/fs/binfmt_misc')
    .filter((name) => !['register', 'status'].includes(name))
    .map((name) => `${name}\n${fs.readFileSync(`/proc/sys/fs/binfmt_misc/${name}`, 'utf8')}`)
    .join('\n'),
  readCpuInfo = () => fs.readFileSync('/proc/cpuinfo', 'utf8'),
  readEvidence = () => [
    '/proc/self/status',
    '/proc/self/maps',
    '/sys/class/dmi/id/product_name',
    '/sys/class/dmi/id/sys_vendor',
    '/sys/class/dmi/id/board_vendor',
  ].map((filename) => {
    try { return fs.readFileSync(filename, 'utf8'); } catch { return ''; }
  }).join('\n'),
  resolveInterpreter = (value) => fs.realpathSync(value),
  spawn = child.spawnSync,
} = {}) {
  // The credential-free APK lane is deliberately native-only. Do not inspect
  // or execute binfmt/QEMU on ARM: even a newer emulator is not evidence for
  // the native linux/amd64 compiler contract proved by hosted CI.
  if (platform !== 'linux' || architecture !== 'x64') {
    void readRegistration;
    void readBinfmtRegistrations;
    void readCpuInfo;
    void readEvidence;
    void resolveInterpreter;
    void spawn;
    return diagnosePinAmd64Runtime({
      architecture,
      platform,
      binfmtRegistered: false,
      qemuVersionBanner: '',
      cpuInfo: '',
      emulationEvidence: '',
    });
  }
  let registration = '';
  try { registration = readBinfmtRegistrations(); } catch {
    try { registration = readRegistration(); } catch { registration = ''; }
  }
  let cpuInfo = '';
  let emulationEvidence = '';
  try { cpuInfo = readCpuInfo(); } catch { cpuInfo = ''; }
  try { emulationEvidence = readEvidence(); } catch { emulationEvidence = 'unreadable-emulation-evidence'; }
  void resolveInterpreter;
  void spawn;
  return diagnosePinAmd64Runtime({
    architecture,
    platform,
    binfmtRegistered: registration.length > 0,
    qemuVersionBanner: registration,
    cpuInfo,
    emulationEvidence,
  });
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function versionText(version) {
  return version.join('.');
}

function sameMajorAndAtLeast(actual, supported) {
  return actual[0] === supported[0] && versionAtLeast(actual, supported);
}

function sameVersion(actual, supported) {
  return actual.length === supported.length &&
    actual.every((part, index) => part === supported[index]);
}

function loadToolchainContract() {
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(TOOLCHAIN_CONFIG, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the toolchain contract ${TOOLCHAIN_CONFIG}: ${error.message}`);
  }
  if (contract.schemaVersion !== 1 || !contract.toolchain) {
    throw new Error(`${TOOLCHAIN_CONFIG} is not a supported schema-version 1 contract`);
  }
  const result = {};
  for (const name of ['node', 'rust', 'jdk']) {
    const raw = contract.toolchain[name]?.version;
    const parsed = typeof raw === 'string' ? parseVersion(raw) : null;
    if (!parsed) throw new Error(`${TOOLCHAIN_CONFIG} has no valid ${name} version`);
    result[name] = { raw, parsed };
  }
  return result;
}

function commandVersion(command, args, { env } = {}) {
  if (!exists(command, env || process.env)) throw new Error(`${command} is unavailable`);
  const result = run(command, args, {
    capture: true,
    allowFailure: true,
    ...(env ? { env } : {}),
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const version = result.status === 0 ? parseCommandVersion(output, command) : null;
  if (!version) throw new Error(`${command} did not report a semantic version`);
  return version;
}

function validateHostToolchains({
  includeRust = true,
  includeJava = false,
  report = true,
  env,
} = {}) {
  const supported = loadToolchainContract();
  const node = parseVersion(process.version);
  if (!node || !sameMajorAndAtLeast(node, supported.node.parsed)) {
    throw new Error(`Node.js ${supported.node.parsed[0]}.${supported.node.parsed[1]} or newer on the same major line is required; observed ${process.version}`);
  }

  let rustc;
  let cargo;
  if (includeRust) {
    rustc = commandVersion('rustc', ['--version'], { env });
    cargo = commandVersion('cargo', ['--version'], { env });
    for (const [name, actual] of [['rustc', rustc], ['cargo', cargo]]) {
      if (!sameVersion(actual, supported.rust.parsed)) {
        throw new Error(`${name} ${supported.rust.raw} exactly is required by rust-toolchain.toml; observed ${versionText(actual)}`);
      }
    }
  }

  if (includeJava) {
    const java = commandVersion('java', ['-version'], { env });
    if (java[0] !== supported.jdk.parsed[0]) {
      throw new Error(`the Pin source gate requires JDK ${supported.jdk.parsed[0]}; observed Java ${versionText(java)}`);
    }
    if (report) info(`[observed] Java ${versionText(java)} satisfies the JDK ${supported.jdk.parsed[0]} Pin-source contract.`);
  }

  if (report) {
    info(`[observed] Node.js ${versionText(node)} satisfies the Node ${supported.node.parsed[0]}.${supported.node.parsed[1]}+ contract.`);
    if (includeRust) {
      info(`[observed] rustc ${versionText(rustc)} and Cargo ${versionText(cargo)} satisfy the exact Rust ${supported.rust.raw} contract.`);
    }
  }
  return { supported, node, rustc, cargo };
}

function testVersionParser() {
  const cases = [
    ['2.33.1', true],
    ['Docker Compose version v2.35.0-desktop.1', true],
    ['5.1.0', true],
    ['2.33.0', false],
    ['2.24.4', false],
    ['not-a-version', null]
  ];
  for (const [input, expected] of cases) {
    const parsed = parseVersion(input);
    const actual = parsed ? versionAtLeast(parsed, MINIMUM_COMPOSE_VERSION) : null;
    if (actual !== expected) throw new Error(`Compose version parser failed fixture: ${input}`);
  }
  if (!sameMajorAndAtLeast([22, 22, 3], [22, 14, 0]) ||
      sameMajorAndAtLeast([23, 0, 0], [22, 14, 0])) {
    throw new Error('toolchain major-line version fixtures failed');
  }
  if (!sameVersion([1, 91, 1], [1, 91, 1]) ||
      sameVersion([1, 97, 1], [1, 91, 1]) ||
      sameVersion([1, 91, 0], [1, 91, 1])) {
    throw new Error('exact Rust toolchain version fixtures failed');
  }
  const java = parseJavaVersionBanner([
    'Picked up JAVA_TOOL_OPTIONS: synthetic',
    'openjdk version "17.0.14" 2025-01-21 LTS',
    'OpenJDK Runtime Environment (build 17.0.14+7-LTS)',
  ].join('\n'));
  if (!java || !sameVersion(java, [17, 0, 14]) ||
      parseJavaVersionBanner('wrapper 99.88.77\nnot a Java banner') !== null ||
      parseJavaVersionBanner('java version "17.0.14"\nopenjdk version "17.0.14"') !== null ||
      !sameVersion(parseNamedCommandVersion('rustc 1.91.1 (fixture)', 'rustc'), [1, 91, 1]) ||
      parseNamedCommandVersion('99.88.77\nrustc 1.91.1\nrustc 1.91.1', 'rustc') !== null) {
    throw new Error('command-specific toolchain banner fixtures failed');
  }
}

module.exports = {
  parseVersion,
  parseNamedCommandVersion,
  parseJavaVersionBanner,
  parseCommandVersion,
  parseQemuX86VersionBanner,
  diagnosePinAmd64Runtime,
  probePinAmd64Runtime,
  PIN_AMD64_HOSTED_GUIDANCE,
  QEMU_VERSION_PROBE_ENVIRONMENT,
  versionAtLeast,
  versionText,
  sameMajorAndAtLeast,
  sameVersion,
  loadToolchainContract,
  commandVersion,
  validateHostToolchains,
  testVersionParser,
};
