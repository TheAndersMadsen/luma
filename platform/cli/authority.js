'use strict';

// Local executable authority for the operator CLI.  Production and release
// commands must never turn an ambient PATH entry into code execution.  The
// candidates below are deliberately boring, fixed installation locations for
// the two supported workstation families.  User-owned Homebrew/Rustup trees
// are accepted only at their conventional absolute boundary; arbitrary PATH
// directories and per-command environment overrides are not.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loginHome() {
  try {
    const value = os.userInfo().homedir;
    if (path.isAbsolute(value)) return value;
  } catch {
    // Fall through to an unusable home rather than trusting ambient HOME.
  }
  return process.platform === 'win32' ? 'C:\\nonexistent' : '/nonexistent';
}

const HOME = loginHome();
const MAC_HOMEBREW = Object.freeze([
  '/opt/homebrew/bin',
  '/opt/homebrew/opt/node@22/bin',
  '/usr/local/bin',
  '/usr/local/opt/node@22/bin',
]);
const SYSTEM_PATH = process.platform === 'darwin'
  ? ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...MAC_HOMEBREW]
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const USER_TOOL_PATHS = Object.freeze([
  path.join(HOME, '.cargo', 'bin'),
  path.join(HOME, 'Android', 'Sdk', 'platform-tools'),
  path.join(HOME, 'Library', 'Android', 'sdk', 'platform-tools'),
]);

const PLATFORM_CANDIDATES = Object.freeze({
  bash: process.platform === 'darwin'
    ? ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash']
    : ['/bin/bash', '/usr/bin/bash'],
  node: process.platform === 'darwin'
    ? [
      '/opt/homebrew/opt/node@22/bin/node',
      '/usr/local/opt/node@22/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ]
    : ['/usr/bin/node', '/usr/local/bin/node'],
  python3: process.platform === 'darwin'
    ? ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
    : ['/usr/bin/python3', '/usr/local/bin/python3'],
  git: process.platform === 'darwin'
    ? ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
    : ['/usr/bin/git', '/usr/local/bin/git'],
  ssh: ['/usr/bin/ssh'],
  rsync: process.platform === 'darwin'
    ? ['/usr/bin/rsync', '/opt/homebrew/bin/rsync', '/usr/local/bin/rsync']
    : ['/usr/bin/rsync', '/usr/local/bin/rsync'],
  sha256sum: process.platform === 'darwin'
    ? ['/opt/homebrew/bin/sha256sum', '/usr/local/bin/sha256sum']
    : ['/usr/bin/sha256sum', '/bin/sha256sum'],
  shasum: ['/usr/bin/shasum'],
  awk: ['/usr/bin/awk'],
  tar: ['/usr/bin/tar', '/bin/tar'],
  sh: ['/bin/sh', '/usr/bin/sh'],
  cp: ['/bin/cp', '/usr/bin/cp'],
  npm: process.platform === 'darwin'
    ? [
      '/opt/homebrew/opt/node@22/bin/npm',
      '/usr/local/opt/node@22/bin/npm',
      '/opt/homebrew/bin/npm',
      '/usr/local/bin/npm',
    ]
    : ['/usr/bin/npm', '/usr/local/bin/npm'],
  docker: process.platform === 'darwin'
    ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker']
    : ['/usr/bin/docker', '/usr/local/bin/docker'],
  cargo: [
    path.join(HOME, '.cargo', 'bin', 'cargo'),
    '/usr/bin/cargo',
    '/usr/local/bin/cargo',
    '/opt/homebrew/bin/cargo',
  ],
  rustc: [
    path.join(HOME, '.cargo', 'bin', 'rustc'),
    '/usr/bin/rustc',
    '/usr/local/bin/rustc',
    '/opt/homebrew/bin/rustc',
  ],
  java: process.platform === 'darwin'
    ? ['/usr/bin/java', '/opt/homebrew/opt/openjdk@17/bin/java', '/usr/local/opt/openjdk@17/bin/java']
    : ['/usr/bin/java', '/usr/local/bin/java'],
  adb: [
    path.join(HOME, 'Android', 'Sdk', 'platform-tools', 'adb'),
    path.join(HOME, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/usr/bin/adb',
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb',
  ],
  qemu_x86_64: ['/usr/bin/qemu-x86_64', '/usr/local/bin/qemu-x86_64'],
  openssl: process.platform === 'darwin'
    ? ['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl']
    : ['/usr/bin/openssl', '/usr/local/bin/openssl'],
});

function isExecutableFile(candidate) {
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) return false;
  try {
    const metadata = fs.statSync(candidate);
    fs.accessSync(candidate, fs.constants.X_OK);
    return metadata.isFile();
  } catch {
    return false;
  }
}

function candidatesFor(command) {
  return PLATFORM_CANDIDATES[command] || [];
}

function resolveTool(command, { required = true } = {}) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) {
    if (required) throw new Error('invalid local executable name');
    return null;
  }
  if (path.isAbsolute(command)) {
    const supported = Object.values(PLATFORM_CANDIDATES).flat().includes(command);
    if (supported && isExecutableFile(command)) return command;
  } else {
    for (const candidate of candidatesFor(command)) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  if (required) {
    throw new Error(`required local command is unavailable at a supported fixed path: ${command}`);
  }
  return null;
}

function trustedPath() {
  // PATH remains for tools which launch their own helpers.  The CLI itself
  // never searches it: run()/exists() resolve through resolveTool().
  return [...new Set([...SYSTEM_PATH, ...USER_TOOL_PATHS])].join(path.delimiter);
}

module.exports = {
  HOME,
  PLATFORM_CANDIDATES,
  candidatesFor,
  isExecutableFile,
  resolveTool,
  trustedPath,
};
