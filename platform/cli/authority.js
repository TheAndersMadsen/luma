'use strict';

// Local executable authority for the operator CLI.  Production and release
// commands must never turn an ambient PATH entry into code execution.  The
// candidates below are deliberately boring, fixed installation locations for
// the two supported workstation families. The already-version-checked Bun
// process remains authoritative for child Bun/pnpm work. Other user-owned
// Homebrew/Rustup trees are accepted only at their conventional absolute
// boundary. Arbitrary PATH directories and per-command overrides are not.

const fs = require('node:fs');
const path = require('node:path');

function loginHome() {
  try {
    const uid = process.getuid();
    if (process.platform === 'linux') {
      const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n')
        .map((line) => line.split(':')).find((fields) => Number(fields[2]) === uid);
      if (row && path.isAbsolute(row[5])) return row[5];
    } else if (process.platform === 'darwin') {
      const account = require('node:child_process').execFileSync('/usr/bin/dscacheutil',
        ['-q', 'user', '-a', 'uid', String(uid)], {
          env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 3000,
        });
      const home = /^dir: (.+)$/mu.exec(account)?.[1];
      if (home && path.isAbsolute(home)) return home;
    }
  } catch {
    // No arbitrary PATH or environment fallback for executable authority.
  }
  return '/nonexistent';
}

const HOME = loginHome();
const ACTIVE_BUN = process.versions.bun === '1.4.2' && path.isAbsolute(process.execPath)
  ? process.execPath : null;
const ACTIVE_BUN_BIN = ACTIVE_BUN ? path.dirname(ACTIVE_BUN) : null;
const MAC_HOMEBREW = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
]);
const SYSTEM_PATH = Object.freeze([
  ...(ACTIVE_BUN_BIN ? [ACTIVE_BUN_BIN] : []),
  ...(process.platform === 'darwin'
    ? ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...MAC_HOMEBREW]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
]);
const USER_TOOL_PATHS = Object.freeze([
  path.join(HOME, '.bun', 'bin'),
  path.join(HOME, 'Library', 'pnpm', 'bin'),
  path.join(HOME, 'Library', 'pnpm'),
  path.join(HOME, '.local', 'share', 'pnpm', 'bin'),
  path.join(HOME, '.local', 'share', 'pnpm'),
  path.join(HOME, '.cargo', 'bin'),
  path.join(HOME, 'Android', 'Sdk', 'platform-tools'),
  path.join(HOME, 'Library', 'Android', 'sdk', 'platform-tools'),
]);

const PLATFORM_CANDIDATES = Object.freeze({
  bash: process.platform === 'darwin'
    ? ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash']
    : ['/bin/bash', '/usr/bin/bash'],
  bun: [
    ...(ACTIVE_BUN ? [ACTIVE_BUN] : []),
    path.join(HOME, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun', '/usr/local/bin/bun', '/usr/bin/bun',
  ],
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
  // The update timers (platform/cli/update.js) and the root step that
  // installs them.
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
  sudo: ['/usr/bin/sudo'],
  ip: ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'],
  route: ['/sbin/route'],
  cp: ['/bin/cp', '/usr/bin/cp'],
  pnpm: [
    path.join(HOME, 'Library', 'pnpm', 'bin', 'pnpm'),
    path.join(HOME, 'Library', 'pnpm', 'pnpm'),
    path.join(HOME, '.local', 'share', 'pnpm', 'bin', 'pnpm'),
    path.join(HOME, '.local', 'share', 'pnpm', 'pnpm'),
    '/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm', '/usr/bin/pnpm',
  ],
  docker: process.platform === 'darwin'
    ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker']
    : ['/usr/bin/docker', '/usr/local/bin/docker'],
  gh: process.platform === 'darwin'
    ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
    : ['/usr/bin/gh', '/usr/local/bin/gh'],
  cosign: process.platform === 'darwin'
    ? ['/opt/homebrew/bin/cosign', '/usr/local/bin/cosign']
    : ['/usr/bin/cosign', '/usr/local/bin/cosign'],
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
    ? ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl']
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

function localDockerHost(platform = process.platform, home = HOME, standard = '/var/run/docker.sock') {
  const isSocket = (candidate) => {
    try { return fs.statSync(candidate).isSocket(); } catch { return false; }
  };
  // Colima's default engine exposes a user-owned Unix socket on macOS. Keep
  // discovery at conventional local paths, never an ambient Docker endpoint.
  if (platform === 'darwin' && !isSocket(standard)) {
    const colima = path.join(home, '.colima', 'default', 'docker.sock');
    if (isSocket(colima)) return `unix://${colima}`;
  }
  return `unix://${standard}`;
}

module.exports = {
  HOME,
  PLATFORM_CANDIDATES,
  candidatesFor,
  isExecutableFile,
  localDockerHost,
  resolveTool,
  trustedPath,
};
