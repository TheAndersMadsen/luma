'use strict';

const fs = require('node:fs');

const {
  ENV_FILE,
  fail,
  info,
  initialize,
  parseEnvFile,
  validateRuntime,
} = require('./context');
const {
  hasProductionSetupMarker,
  setupProduction,
  validateProductionArtifacts,
} = require('./production-setup');
const { operatorContract, releaseCompatibility, versionInfo } = require('./command-spec');

const PRODUCTION_USAGE = './revival setup production --domain HOST --acme-email EMAIL --operator-email EMAIL [--public-ip IPV4] [--pin-release-archive FILE] [--iroh-ticket-file FILE] [--profile pin|search|spotify|observability ... | --no-profiles]';

function protectedFile(file, requireContent = true) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600 &&
    (!requireContent || stat.size > 0);
}

function selectedFields(value, fields) {
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field]])));
}

function statusEnvelope(stateId, fields = {}) {
  const { pinRelease = null, pinRequired = false, ...publicFields } = fields;
  const contract = operatorContract();
  const state = contract.status.states.find((candidate) => candidate.id === stateId);
  if (!state) throw new Error(`operator setup contract does not define status state ${stateId}`);
  const journey = contract.journeys.find((candidate) => candidate.id === state.journeyId);
  if (!journey) throw new Error(`operator setup contract is missing ${state.journeyId} journey`);
  const release = versionInfo();
  const compatibility = releaseCompatibility();
  const pinDisabled = compatibility.profileDisabled;
  return Object.freeze({
    schemaVersion: contract.status.schemaVersion,
    contract: Object.freeze({
      id: contract.contractId,
      version: contract.contractVersion,
      journey: journey.id,
    }),
    state: state.id,
    mode: state.mode,
    ok: state.ok,
    ...publicFields,
    nextCommandId: state.nextCommandId,
    next: state.next,
    release: Object.freeze({
      operator: selectedFields(release, compatibility.operatorFields),
      pin: release.pin ? Object.freeze({
        enabled: pinRequired,
        expected: selectedFields(release.pin, compatibility.pinIdentityFields),
        observed: pinRequired && pinRelease
          ? selectedFields(pinRelease, compatibility.observedPinFields)
          : pinDisabled.observed,
        compatible: pinRequired
          ? (pinRelease?.compatible ?? compatibility.profileEnabledMissingCompatible)
          : pinDisabled.compatible,
      }) : null,
    }),
  });
}

function setupStatus() {
  const production = hasProductionSetupMarker();
  if (!protectedFile(ENV_FILE) && !production) {
    return statusEnvelope('uninitialized');
  }
  try {
    validateRuntime({ production });
    const artifacts = production ? validateProductionArtifacts() : null;
    return statusEnvelope(production ? 'production-ready' : 'local-ready', {
      pinRequired: artifacts?.pinRequired ?? false,
      ...(artifacts?.pinRelease ? { pinRelease: artifacts.pinRelease } : {}),
    });
  } catch (error) {
    let pinRequired = false;
    if (production && protectedFile(ENV_FILE)) {
      try {
        pinRequired = new Set((parseEnvFile(ENV_FILE).COMPOSE_PROFILES || '').split(',')).has('pin');
      } catch {
        // The original validation error remains the actionable setup boundary.
      }
    }
    return statusEnvelope(production ? 'production-invalid' : 'local-invalid', {
      problem: error.message,
      pinRequired,
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
