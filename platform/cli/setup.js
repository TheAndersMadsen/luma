'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const {
  ENV_FILE,
  configurationLocationHint,
  locationExportLine,
  PIN_RELEASE_ACQUIRE_TOOL,
  ROOT,
  fail,
  info,
  initialize,
  parseEnvFile,
  validateRuntime,
} = require('./context');
const {
  assertNotOlderRelease,
  hasProductionSetupMarker,
  setupProduction,
  validateProductionArtifacts,
} = require('./production-setup');
const { guidedProductionArguments } = require('./guided-production-setup');
const {
  OPERATOR_SETUP_NEXT, operatorContract, releaseCompatibility, versionInfo,
} = require('./command-spec');
const { validateOperatorReleaseCoordinates } = require('./production');
const { hasRegistryLogin } = require('./registry');

const PRODUCTION_USAGE = './luma setup production --guided [--pin-release-archive FILE] [--update-source URL] | ./luma setup production (--domain HOST | --duckdns-subdomain NAME --duckdns-token-stdin) --acme-email EMAIL --operator-email EMAIL [--public-ip IPV4|auto] [--pin-release-archive FILE] [--update-source URL] [--auto-updates on|off] [--profile pin|search|spotify|observability ... | --no-profiles]';

// True when this release's matching Pin release is already staged or active,
// false when setup still needs the archive delivered with the release, and
// null when the check cannot say (a source checkout, or a store problem setup
// itself reports later).
function matchingPinReleaseStaged() {
  let result;
  try {
    result = spawnSync(process.execPath, [PIN_RELEASE_ACQUIRE_TOOL, '--check', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 180_000,
    });
  } catch {
    return null;
  }
  if (!result.error && result.status === 0) return true;
  return /neither active nor staged/u.test(result.stderr?.trim() || '') ? false : null;
}

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
  // An operator release has no local or contributor journey to start.
  const operatorFirstStep = release.revision !== 'source' && state.id === 'uninitialized';
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
    nextCommandId: operatorFirstStep ? 'setup.production' : state.nextCommandId,
    next: operatorFirstStep ? OPERATOR_SETUP_NEXT : state.next,
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
    const values = validateRuntime({ production });
    if (production && versionInfo().revision !== 'source') {
      validateOperatorReleaseCoordinates(values);
    }
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
    if (report.state === 'uninitialized') {
      info('FAIL nothing is set up yet.');
      info(`     ${configurationLocationHint('Luma configuration')}`);
    } else {
      info(`${report.ok ? 'PASS' : 'FAIL'} ${report.mode} setup ${report.ok ? 'is ready' : 'is not ready'}.`);
    }
    if (report.problem) info(`     ${report.problem}`);
    info(`NEXT ${report.next}`);
  }
  if (!report.ok) process.exitCode = 1;
}

function setupCommand(args, options = {}) {
  const operation = args.shift();
  try {
    if (operation === 'production') {
      if (args[0] === '--guided') {
        // A release delivered as files carries its Pin archive beside the
        // operator, so guided setup passes that path through.
        // Bootstrap names the Center it came from as the update source to
        // offer. The guided question passes the answer on as the flag.
        const archive = [];
        let offeredSource = '';
        const rest = args.slice(1);
        for (let index = 0; index < rest.length; index += 2) {
          const [option, value] = [rest[index], rest[index + 1]];
          if (!value || value.startsWith('-')) throw new Error('usage');
          if (option === '--pin-release-archive' && !archive.length) archive.push(option, value);
          else if (option === '--update-source' && !offeredSource) offeredSource = value;
          else throw new Error('usage');
        }
        let current = {};
        if (protectedFile(ENV_FILE)) current = parseEnvFile(ENV_FILE);
        // Refuse an older release's folder before asking anything.
        assertNotOlderRelease(current, versionInfo());
        // When nothing is staged, the guided flow asks for the archive instead
        // of dead-ending after setup. An explicit archive passes through and
        // suppresses the question.
        const staged = archive.length === 0 ? matchingPinReleaseStaged() : true;
        args = [...guidedProductionArguments(current, undefined, {
          pinReleaseStaged: staged,
          updateSource: offeredSource || versionInfo().updateSource || '',
        }), ...archive];
      }
      const result = setupProduction(args);
      info(`Production configuration is ready for ${result.origin} ` +
        `(optional profiles: ${result.profiles.join(', ') || 'none'}).`);
      if (result.credentials) {
        info(`First sign-in: ${result.credentials} (delete it after you sign in).`);
      }
      if (result.pinTrustRoot) {
        info(`${result.pinTrustRootCreated ? 'Generated a new' : 'Kept the existing'} Pin trust root: ${result.pinTrustRoot}`);
      }
      info(`Updates: this server asks ${result.updateSource || '(no update source)'} for newer releases.`);
      info(result.automaticUpdates.message);
      for (const command of result.automaticUpdates.commands ?? []) info(`  ${command}`);
      info(`After deployment: ${result.origin}/login?next=%2Fsettings%2Fpin%2Fsetup`);
      // Luma records no location of its own, so a server kept outside the
      // default directories needs the same variables in every later shell.
      const exportLine = locationExportLine();
      if (exportLine) {
        info('This configuration is outside Luma\'s default directories, so every ./luma command needs the ' +
          'same variables. Add this line to ~/.profile, then open a new shell:');
        info(`  ${exportLine}`);
      }
      // Onboarding runs the doctor next itself.
      if (!options.throwOnFailure) {
        info(hasRegistryLogin()
          ? 'NEXT ./luma doctor production'
          : 'NEXT ./luma doctor production (public images need no registry login; a private fork first runs ./luma registry login --username GITHUB_USER)');
      }
      return;
    }
    if (['local', 'contributor', 'pin'].includes(operation)) {
      if (args.length > 0) fail(`usage: ./luma setup ${operation}`, 64);
      // A contributor workspace enrolls no Pin, so the DeviceUser CA it
      // cannot fill is not worth a warning there.
      initialize({ suppressDeviceCaWarning: operation === 'contributor' });
      info(operation === 'pin'
        ? 'NEXT ./luma pin doctor'
        : 'NEXT ./luma doctor');
      return;
    }
    if (operation === 'status') {
      let json = false;
      if (args.length === 1 && args[0] === '--json') json = true;
      else if (args.length > 0) fail('usage: ./luma setup status [--json]', 64);
      printStatus(setupStatus(), json);
      return;
    }
    fail(`usage: ./luma setup local|contributor|pin | ${PRODUCTION_USAGE} | ./luma setup status [--json]`, 64);
  } catch (error) {
    const message = error.message === 'usage' ? `usage: ${PRODUCTION_USAGE}` : error.message;
    if (options.throwOnFailure) throw new Error(message);
    fail(message, error.message === 'usage' ? 64 : 1);
  }
}

module.exports = {
  PRODUCTION_USAGE,
  matchingPinReleaseStaged,
  protectedFile,
  setupCommand,
  setupStatus,
};
