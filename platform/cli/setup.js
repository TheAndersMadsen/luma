'use strict';

const fs = require('node:fs');

const {
  ENV_FILE,
  fail,
  info,
  initialize,
  validateRuntime,
} = require('./context');
const {
  hasProductionSetupMarker,
  setupProduction,
  validateProductionArtifacts,
} = require('./production-setup');

const PRODUCTION_USAGE = './revival setup production --domain HOST --acme-email EMAIL --operator-email EMAIL [--public-ip IPV4] [--iroh-ticket-file FILE] [--profile pin|search|spotify|observability ... | --no-profiles]';

function protectedFile(file, requireContent = true) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600 &&
    (!requireContent || stat.size > 0);
}

function setupStatus() {
  const production = hasProductionSetupMarker();
  if (!protectedFile(ENV_FILE) && !production) {
    return Object.freeze({
      schemaVersion: 3,
      mode: 'uninitialized',
      ok: false,
      next: './revival setup local or ./revival setup production --help',
    });
  }
  try {
    validateRuntime({ production });
    if (production) validateProductionArtifacts();
    return Object.freeze({
      schemaVersion: 3,
      mode: production ? 'production' : 'local',
      ok: true,
      next: production ? './revival deploy production --dry-run' : './revival doctor',
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: 3,
      mode: production ? 'production' : 'local',
      ok: false,
      problem: error.message,
      next: production ? './revival setup production' : './revival init',
    });
  }
}

function printStatus(report, json) {
  if (json) info(JSON.stringify(report));
  else {
    info(`${report.ok ? 'PASS' : 'FAIL'} ${report.mode} setup ${report.ok ? 'is ready' : 'is not ready'}.`);
    if (report.problem) info(`     ${report.problem}`);
    info(`NEXT ${report.next}`);
  }
  if (!report.ok) process.exitCode = 1;
}

function setupCommand(args) {
  const operation = args.shift();
  try {
    if (operation === 'production') {
      const result = setupProduction(args);
      info(`Production configuration is ready for ${result.origin}.`);
      info(`Operator overlay: ${result.operatorCompose}`);
      if (result.credentials) {
        info(`First login: ${result.credentials} (delete this handoff after signing in).`);
      } else {
        info('First login handoff has been consumed or removed; setup did not recreate it.');
      }
      if (result.pinTrustRoot) info(`Generated Pin trust root: ${result.pinTrustRoot}`);
      info(`Enabled optional profiles: ${result.profiles.join(', ') || 'none'}.`);
      info('Production uses the digest-pinned OCI Compose application stamped into this operator release.');
      info('NEXT ./revival doctor production');
      return;
    }
    if (['local', 'contributor', 'pin'].includes(operation)) {
      if (args.length > 0) fail(`usage: ./revival setup ${operation}`, 64);
      initialize();
      info(operation === 'pin'
        ? 'NEXT ./revival pin doctor'
        : 'NEXT ./revival doctor');
      return;
    }
    if (operation === 'status') {
      let json = false;
      if (args.length === 1 && args[0] === '--json') json = true;
      else if (args.length > 0) fail('usage: ./revival setup status [--json]', 64);
      printStatus(setupStatus(), json);
      return;
    }
    fail(`usage: ./revival setup local|contributor|pin | ${PRODUCTION_USAGE} | ./revival setup status [--json]`, 64);
  } catch (error) {
    if (error.message === 'usage') fail(`usage: ${PRODUCTION_USAGE}`, 64);
    fail(error.message);
  }
}

module.exports = { PRODUCTION_USAGE, protectedFile, setupCommand, setupStatus };
