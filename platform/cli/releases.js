'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Immutable releases: build, verify, and packaging for deployment.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  PACKAGE_TOOL, CONFIG_DIR, SECRETS_DIR, DATA_DIR, RELEASE_DIR, isInsideDirectory, requireExternalDirectory, fail, info, run, ensureManagedRoot, secureDirectory, atomicWrite,
} = require('./context');

function buildRelease(args, { capture = false } = {}) {
  if (!fs.existsSync(PACKAGE_TOOL)) fail(`release packager is unavailable: ${PACKAGE_TOOL}`);
  const suppliedOutput = args.includes('--output');
  const suppliedJson = args.includes('--json');
  const suppliedProfile = args.includes('--profile');
  const finalArgs = ['build', ...args];
  if (!suppliedProfile) finalArgs.push('--profile', 'source');
  if (!suppliedOutput) finalArgs.push('--output', RELEASE_DIR);
  if (!suppliedJson) finalArgs.push('--json');
  const outputIndex = finalArgs.indexOf('--output');
  if (!finalArgs[outputIndex + 1] || finalArgs[outputIndex + 1].startsWith('-')) {
    fail('--output requires an external directory', 64);
  }
  try {
    const output = path.resolve(finalArgs[outputIndex + 1]);
    requireExternalDirectory(output, 'release output');
    if ([CONFIG_DIR, SECRETS_DIR].some((protectedRoot) => isInsideDirectory(output, protectedRoot))) {
      throw new Error(`release output must not be inside configuration or secrets: ${output}`);
    }
    if (isInsideDirectory(output, DATA_DIR)) {
      secureDirectory(output);
    } else {
      ensureManagedRoot(output, 'release output');
    }
  } catch (error) {
    fail(error.message, 64);
  }
  return run('node', [PACKAGE_TOOL, ...finalArgs], { capture });
}

function verifyRelease(args, { capture = false } = {}) {
  if (!fs.existsSync(PACKAGE_TOOL)) fail(`release packager is unavailable: ${PACKAGE_TOOL}`);
  return run('node', [PACKAGE_TOOL, 'verify', ...args], { capture });
}

function packageForDeployment() {
  const built = buildRelease(['--profile', 'vps'], { capture: true });
  let descriptor;
  try {
    descriptor = JSON.parse(built.stdout);
  } catch {
    fail('release packager did not return its documented JSON descriptor');
  }
  for (const key of ['releaseId', 'archivePath', 'manifestPath']) {
    if (typeof descriptor[key] !== 'string' || descriptor[key].length === 0) {
      fail(`release packager descriptor is missing ${key}`);
    }
  }

  const verified = verifyRelease([
    '--archive', descriptor.archivePath,
    '--manifest', descriptor.manifestPath,
    '--json'
  ], { capture: true });
  let verification;
  try {
    verification = JSON.parse(verified.stdout);
  } catch {
    fail('release verifier did not return its documented JSON result');
  }
  if (verification.ok !== true || verification.releaseId !== descriptor.releaseId) {
    fail('release verification did not confirm the packaged release identity');
  }

  const descriptorPath = path.join(RELEASE_DIR, `${descriptor.releaseId}.release.json`);
  atomicWrite(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  info(`[implemented] packaged and verified immutable release ${descriptor.releaseId}`);
  return descriptorPath;
}

module.exports = { buildRelease, verifyRelease, packageForDeployment };
