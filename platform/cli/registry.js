'use strict';

const child = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  BUILD_DIR,
  fail,
  info,
  operatorEnvironment,
  run,
} = require('./context');
const { isOperatorRelease } = require('./command-spec');
const { hasProductionSetupMarker } = require('./production-setup');
const { saveGithubToken } = require('./update');

const LOGIN_USAGE = './luma registry login --username GITHUB_USER';
// The next step of an operator's first install (docs/install.md "Install the release").
const OPERATOR_ONBOARD_NEXT = './luma onboard production --pin-release-archive ../luma-pin-*.tar.gz';

function parseRegistryLogin(args) {
  if (args.length !== 2 || args[0] !== '--username' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(args[1])) {
    throw new Error('usage');
  }
  return Object.freeze({ username: args[1] });
}

// Whether Luma's own Docker configuration (DOCKER_CONFIG is LUMA_BUILD_DIR)
// names a ghcr.io login. Only the entry's presence is read, never its value.
function hasRegistryLogin() {
  try {
    const { auths } = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'config.json'), 'utf8'));
    return Boolean(auths?.['ghcr.io'] || auths?.['https://ghcr.io']);
  } catch {
    return false;
  }
}

// The login `./luma registry login` wrote: Docker's configuration for releases
// lives in the external build directory, as plaintext or in Docker's
// credential helper. Only user:secret comes back. It is never printed.
function dockerCredential(registry) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const stored = config.auths?.[registry]?.auth ?? config.auths?.[`https://${registry}`]?.auth;
  if (stored) {
    try {
      return Buffer.from(stored, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (typeof config.credsStore !== 'string' || !config.credsStore) return null;
  // The helper protocol takes a JSON envelope, but Docker Desktop's helper
  // answers it with a URL-parse error and wants the bare server URL instead;
  // try both before declaring the login absent.
  for (const input of [`${JSON.stringify({ ServerURL: `https://${registry}` })}\n`, `https://${registry}\n`]) {
    const helper = child.spawnSync(`docker-credential-${config.credsStore}`, ['get'], {
      input,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    if (helper.error || helper.status !== 0 || !helper.stdout.trim()) continue;
    try {
      const found = JSON.parse(helper.stdout);
      if (found.Username && found.Secret) return `${found.Username}:${found.Secret}`;
    } catch {
      continue;
    }
  }
  return null;
}

function registryCommand(args, runtime = { operatorEnvironment, run }) {
  const operation = args.shift();
  let options;
  try {
    if (operation !== 'login') throw new Error('usage');
    options = parseRegistryLogin(args);
  } catch {
    fail(`usage: ${LOGIN_USAGE}`, 64);
  }

  // Docker owns the hidden prompt and credential-file format. The CLI accepts
  // no token argument, so a registry token cannot enter argv or our output.
  const env = runtime.operatorEnvironment();
  const result = runtime.run('docker', ['login', 'ghcr.io', '--username', options.username], { env });
  // `run` exits on a failed login, so a zero status is a saved one. The same
  // token downloads the private releases `./luma update production` installs,
  // so it is kept for that too, without a second prompt.
  // A source checkout is a maintainer's machine, which installs no updates.
  const operator = (runtime.isOperatorRelease ?? isOperatorRelease)();
  if (result.status === 0 && operator) {
    const credential = (runtime.credential ?? dockerCredential)('ghcr.io');
    const token = credential?.slice(credential.indexOf(':') + 1);
    if (token) {
      (runtime.saveGithubToken ?? saveGithubToken)(token);
      info('Saved the token for downloading Luma updates (LUMA_SECRETS_DIR/github-token, mode 0600).');
    }
  }
  if (result.status === 0 && operator) {
    info(`NEXT ${hasProductionSetupMarker() ? './luma doctor production' : OPERATOR_ONBOARD_NEXT}`);
  }
  return result;
}

module.exports = { LOGIN_USAGE, dockerCredential, hasRegistryLogin, parseRegistryLogin, registryCommand };
