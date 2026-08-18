'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { exists, fail, info, isInsideSource } = require('./context');
const { CONTRACT_FILE, VERSION_FILE, versionInfo } = require('./command-spec');
const { STATE_DIR } = require('./setup-state');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function redactedBundle() {
  const version = versionInfo();
  // This is an intentionally closed allowlist. In particular it never reads
  // process.env, runtime.env, logs, ADB output, wearer records, or serials.
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    product: version.product,
    cli: Object.freeze({
      version: version.version,
      operatorContractVersion: version.contractVersion,
      node: process.version,
    }),
    host: Object.freeze({ platform: process.platform, architecture: process.arch }),
    capabilities: Object.freeze({
      docker: exists('docker'),
      git: exists('git'),
      adb: exists('adb'),
    }),
    contracts: Object.freeze({
      operatorSetupSha256: sha256(CONTRACT_FILE),
      versionDescriptorSha256: sha256(VERSION_FILE),
    }),
    privacy: Object.freeze({
      environmentIncluded: false,
      runtimeConfigurationIncluded: false,
      logsIncluded: false,
      serialsIncluded: false,
      wearerDataIncluded: false,
    }),
  });
}

function ensureDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`support output parent is not a real directory: ${directory}`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeBundle(output, bundle) {
  const selected = path.resolve(output);
  if (isInsideSource(selected)) throw new Error(`support bundle must be outside the source tree: ${selected}`);
  const parent = path.dirname(selected);
  ensureDirectory(parent);
  if (fs.existsSync(selected)) throw new Error(`refusing to replace an existing support bundle: ${selected}`);
  const temporary = path.join(parent, `.${path.basename(selected)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, selected);
    fs.chmodSync(selected, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return selected;
}

function defaultOutput() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(STATE_DIR, 'support-bundles', `support-${stamp}-${process.pid}.json`);
}

function supportBundleCommand(args) {
  let output = null;
  let json = false;
  while (args.length > 0) {
    const option = args.shift();
    if (option === '--json' && !json) json = true;
    else if (option === '--output' && output === null && args.length > 0) output = args.shift();
    else fail('usage: ./revival support-bundle [--output FILE] [--json]', 64);
  }
  try {
    const selected = writeBundle(output || defaultOutput(), redactedBundle());
    if (json) info(JSON.stringify({ path: selected, mode: '0600', redacted: true }));
    else {
      info(`Created redacted support bundle: ${selected}`);
      info('Included only the fixed diagnostic allowlist; no environment, runtime configuration, logs, serials, or wearer data.');
    }
  } catch (error) {
    fail(error.message);
  }
}

module.exports = { redactedBundle, writeBundle, supportBundleCommand };
