'use strict';

const {
  fail,
  operatorEnvironment,
  run,
} = require('./context');

const LOGIN_USAGE = './revival registry login --username GITHUB_USER';

function parseRegistryLogin(args) {
  if (args.length !== 2 || args[0] !== '--username' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(args[1])) {
    throw new Error('usage');
  }
  return Object.freeze({ username: args[1] });
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
  return runtime.run('docker', ['login', 'ghcr.io', '--username', options.username], { env });
}

module.exports = { LOGIN_USAGE, parseRegistryLogin, registryCommand };
