'use strict';

const { fail, info, validateRuntime } = require('./context');
const { interactiveTerminal, readTerminalLine } = require('./terminal');
const { deployProduction, productionDoctor, verifyProduction } = require('./production');
const { setupCommand } = require('./setup');

const ONBOARD_USAGE = './luma onboard production [--pin-release-archive FILE] [--update-source URL]';
// The Pin archive delivered beside the operator folder (README "Get Luma").
const RELEASE_PIN_ARCHIVE = '../luma-pin-*.tar.gz';

const ONBOARD_STAGES = Object.freeze([
  Object.freeze({
    operation: 'setup',
    heading: '[1/5] Configure this production server',
    label: 'stage 1/5 (configuration)',
    state: 'Production deployment was not started. Configuration files created before the failure were preserved.',
    recovery: './luma setup production --guided',
  }),
  Object.freeze({
    operation: 'doctor',
    heading: '[2/5] Check host, release, and configuration',
    label: 'stage 2/5 (preflight)',
    state: 'Production deployment was not started. The external configuration was preserved.',
    recovery: './luma doctor production',
  }),
  Object.freeze({
    operation: 'dryRun',
    heading: '[3/5] Prove the deployment plan without changing production',
    label: 'stage 3/5 (safe deployment preview)',
    state: 'Production deployment was not started. The checked configuration was preserved.',
    recovery: './luma deploy production --dry-run',
  }),
  Object.freeze({
    operation: 'deploy',
    heading: '[4/5] Deploy the verified release',
    label: 'stage 4/5 (deployment)',
    state: 'The deployment command started, so server containers may have changed. Configuration was preserved.',
    recovery: './luma verify production',
  }),
  Object.freeze({
    operation: 'verify',
    heading: '[5/5] Verify production and hand off to Center',
    label: 'stage 5/5 (verification)',
    state: 'The deployed server state was preserved so it can be inspected and retried safely.',
    recovery: './luma verify production',
  }),
]);

function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/gu, '[redacted GitHub credential]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/gu, '[redacted GitHub credential]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(password|token|secret|credential)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim();
}

function shellWord(value) {
  return /^[A-Za-z0-9_./:@%+=*-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function archiveArguments(archive) {
  return archive ? ` --pin-release-archive ${shellWord(archive)}` : '';
}

// Every command a failure names carries the Pin archive the owner gave, or the
// release's own one when setup says it needs it, so a retry cannot fail the
// same way for want of it.
function onboardingFailure(stage, error, archive = null) {
  const reason = safeFailureReason(error);
  const selected = archive || (/--pin-release-archive/u.test(reason) ? RELEASE_PIN_ARCHIVE : null);
  const recovery = stage.operation === 'setup' ? `${stage.recovery}${archiveArguments(selected)}` : stage.recovery;
  return new Error([
    `Onboarding stopped during ${stage.label}.`,
    ...(reason ? [`Reason: ${reason}`] : []),
    `State: ${stage.state}`,
    'Device state: No Pin was contacted or changed.',
    `Recovery check: ${recovery}`,
    `Safe retry: ./luma onboard production${archiveArguments(selected)}`,
  ].join('\n'));
}

function terminalReadLine() {
  if (!interactiveTerminal()) throw new Error('onboard production requires an interactive terminal');
  return readTerminalLine('onboarding ended before deployment confirmation');
}

function runProductionOnboarding(runtime = {}) {
  const archive = runtime.pinReleaseArchive ?? null;
  const offeredSource = runtime.updateSource ?? null;
  const setupArguments = [
    'production', '--guided',
    ...(archive ? ['--pin-release-archive', archive] : []),
    ...(offeredSource ? ['--update-source', offeredSource] : []),
  ];
  const operations = {
    setup: runtime.setup ?? ((args) => setupCommand(args, { throwOnFailure: true })),
    doctor: runtime.doctor ?? (() => productionDoctor([], { throwOnFailure: true })),
    dryRun: runtime.dryRun ?? (() => deployProduction(
      ['production', '--dry-run'], { throwOnFailure: true },
    )),
    deploy: runtime.deploy ?? (() => deployProduction(
      ['production', '--confirm'], { throwOnFailure: true },
    )),
    verify: runtime.verify ?? (() => verifyProduction(
      ['production'], { throwOnFailure: true },
    )),
    values: runtime.values ?? (() => validateRuntime({ production: true })),
    readLine: runtime.readLine ?? terminalReadLine,
    write: runtime.write ?? info,
  };

  const runStage = (stage, action, { announce = true } = {}) => {
    if (announce) operations.write(stage.heading);
    try {
      return action();
    } catch (error) {
      throw onboardingFailure(stage, error, archive);
    }
  };

  runStage(ONBOARD_STAGES[0], () => operations.setup([...setupArguments]));
  runStage(ONBOARD_STAGES[1], operations.doctor);
  runStage(ONBOARD_STAGES[2], operations.dryRun);
  operations.write(ONBOARD_STAGES[3].heading);
  operations.write('Deploy this verified release now? [y/N]');
  if (!/^(?:y|yes)$/iu.test(operations.readLine().trim())) {
    throw new Error([
      'Production deployment cancelled; deployment was not started.',
      'The verified configuration was preserved and no Pin was contacted or changed.',
      `Safe retry: ./luma onboard production${archiveArguments(archive)}`,
    ].join('\n'));
  }
  runStage(ONBOARD_STAGES[3], operations.deploy, { announce: false });
  const origin = runStage(ONBOARD_STAGES[4], () => {
    operations.verify();
    return operations.values().LUMA_PUBLIC_ORIGIN;
  });
  operations.write(`Setup complete: ${origin}/login?next=%2Fsettings%2Fpin%2Fsetup`);
  operations.write('Finish provider setup and the stock Pin installation in Center.');
}

function onboardCommand(args) {
  try {
    if (args[0] !== 'production' || args.length % 2 !== 1) throw new Error('usage');
    const options = {};
    for (let index = 1; index < args.length; index += 2) {
      const name = { '--pin-release-archive': 'pinReleaseArchive', '--update-source': 'updateSource' }[args[index]];
      const value = args[index + 1];
      if (!name || options[name] || !value || value.startsWith('-')) throw new Error('usage');
      options[name] = value;
    }
    runProductionOnboarding(options);
  } catch (error) {
    fail(error.message === 'usage' ? `usage: ${ONBOARD_USAGE}` : error.message,
      error.message === 'usage' ? 64 : 1);
  }
}

module.exports = { ONBOARD_USAGE, onboardCommand, runProductionOnboarding };
