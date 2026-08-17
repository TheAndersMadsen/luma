'use strict';

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

function commandVersion(command, args) {
  if (!exists(command)) throw new Error(`${command} is unavailable`);
  const result = run(command, args, { capture: true, allowFailure: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const version = result.status === 0 ? parseVersion(output) : null;
  if (!version) throw new Error(`${command} did not report a semantic version`);
  return version;
}

function validateHostToolchains({ includeRust = true, includeJava = false, report = true } = {}) {
  const supported = loadToolchainContract();
  const node = parseVersion(process.version);
  if (!node || !sameMajorAndAtLeast(node, supported.node.parsed)) {
    throw new Error(`Node.js ${supported.node.parsed[0]}.${supported.node.parsed[1]} or newer on the same major line is required; observed ${process.version}`);
  }

  let rustc;
  let cargo;
  if (includeRust) {
    rustc = commandVersion('rustc', ['--version']);
    cargo = commandVersion('cargo', ['--version']);
    for (const [name, actual] of [['rustc', rustc], ['cargo', cargo]]) {
      if (!sameMajorAndAtLeast(actual, supported.rust.parsed)) {
        throw new Error(`${name} ${supported.rust.raw} or newer on the same major line is required; observed ${versionText(actual)}`);
      }
    }
  }

  if (includeJava) {
    const java = commandVersion('java', ['-version']);
    if (java[0] !== supported.jdk.parsed[0]) {
      throw new Error(`the Pin source gate requires JDK ${supported.jdk.parsed[0]}; observed Java ${versionText(java)}`);
    }
    if (report) info(`[observed] Java ${versionText(java)} satisfies the JDK ${supported.jdk.parsed[0]} Pin-source contract.`);
  }

  if (report) {
    info(`[observed] Node.js ${versionText(node)} satisfies the Node ${supported.node.parsed[0]}.${supported.node.parsed[1]}+ contract.`);
    if (includeRust) {
      info(`[observed] rustc ${versionText(rustc)} and Cargo ${versionText(cargo)} satisfy the Rust ${supported.rust.raw}+ contract.`);
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
}

module.exports = { parseVersion, versionAtLeast, versionText, sameMajorAndAtLeast, loadToolchainContract, commandVersion, validateHostToolchains, testVersionParser };
