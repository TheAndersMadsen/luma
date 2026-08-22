'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Production operations: deploy, backup/canary/drift drivers, adopt-config, prune-state, rollback.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  DEPLOY_DIR, authoritativeCompletion, fail, localProductionEnvironment, resolveTool, run,
} = require('./context');
const CANDIDATE_TOOL = path.join(DEPLOY_DIR, '..', 'release-candidate.mjs');

function deploymentScript(name, args) {
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) fail(`deployment command is unavailable: ${script}`);
  return run(resolveTool('bash'), [script, ...args], { env: localProductionEnvironment() });
}

function productionDoctor(args) {
  const result = deploymentScript('preflight.sh', args);
  return authoritativeCompletion('doctor.production', 'production-preflight-passed', result);
}

function confirmationCount(args) {
  return args.filter((argument) => argument === '--confirm').length;
}

function requireConfirmedMutation(args, label, { allowDryRun = false } = {}) {
  const confirmations = confirmationCount(args);
  if (confirmations > 1) fail(`${label} accepts exactly one literal --confirm`, 64);
  if (args.includes('--dry-run')) {
    if (!allowDryRun) fail(`${label} does not support --dry-run`, 64);
    if (confirmations !== 0) fail(`${label} --dry-run cannot be combined with --confirm`, 64);
    return false;
  }
  if (confirmations !== 1) fail(`${label} changes production and requires one literal --confirm`, 64);
  return true;
}

function deployProduction(args) {
  if (args.includes('--release-json')) {
    fail('production deploy no longer accepts --release-json or builds implicitly; select a verified immutable candidate with --candidate PATH or --candidate-id SHA256', 64);
  }
  const candidateIndexes = args.flatMap((value, index) => value === '--candidate' ? [index] : []);
  const idIndexes = args.flatMap((value, index) => value === '--candidate-id' ? [index] : []);
  const candidateIndex = candidateIndexes[0] ?? -1;
  const idIndex = idIndexes[0] ?? -1;
  const candidate = candidateIndex >= 0 ? args[candidateIndex + 1] : '';
  const candidateId = idIndex >= 0 ? args[idIndex + 1] : '';
  if (candidateIndexes.length + idIndexes.length !== 1 || Boolean(candidate) === Boolean(candidateId) ||
      candidate?.startsWith('-') || candidateId?.startsWith('-') ||
      (candidateId && !/^[0-9a-f]{64}$/.test(candidateId))) {
    fail('deploy production requires exactly one of --candidate PATH or --candidate-id SHA256; it never builds a release', 64);
  }
  const confirmed = requireConfirmedMutation(args, 'deploy production', { allowDryRun: true });
  const result = deploymentScript('deploy.sh', args);
  return confirmed
    ? authoritativeCompletion('deploy.production', 'production-deployment-applied', result)
    : null;
}

function registerCarryBaseline(args) {
  if (args.includes('--release-json')) {
    fail('Carry baseline registration requires one verified immutable hosted candidate; --release-json and implicit builds are retired', 64);
  }
  const candidateIndexes = args.flatMap((value, index) => value === '--candidate' ? [index] : []);
  const idIndexes = args.flatMap((value, index) => value === '--candidate-id' ? [index] : []);
  const candidateIndex = candidateIndexes[0] ?? -1;
  const idIndex = idIndexes[0] ?? -1;
  const candidate = candidateIndex >= 0 ? args[candidateIndex + 1] : '';
  const candidateId = idIndex >= 0 ? args[idIndex + 1] : '';
  if (candidateIndexes.length + idIndexes.length !== 1 || Boolean(candidate) === Boolean(candidateId) ||
      candidate?.startsWith('-') || candidateId?.startsWith('-') ||
      (candidateId && !/^[0-9a-f]{64}$/.test(candidateId))) {
    fail('deploy carry-baseline requires exactly one of --candidate PATH or --candidate-id SHA256', 64);
  }
  const confirmed = requireConfirmedMutation(args, 'deploy carry-baseline', { allowDryRun: true });
  const result = deploymentScript('register-carry-baseline.sh', args);
  return confirmed
    ? authoritativeCompletion('deploy.carry-baseline', 'carry-baseline-registered', result)
    : null;
}

function releaseCandidate(args) {
  const subcommand = args[0];
  if (!['prepare', 'verify', 'inspect'].includes(subcommand)) {
    fail('usage: ./revival release candidate prepare|verify|inspect [options]', 64);
  }
  run(resolveTool('node'), [CANDIDATE_TOOL, ...args]);
  return null;
}

function backupProduction(args) {
  requireConfirmedMutation(args, 'backup');
  const result = deploymentScript('backup.sh', args);
  return authoritativeCompletion('backup', 'production-backup-created', result);
}

function canaryProduction(args) {
  requireConfirmedMutation(args, 'canary');
  const result = deploymentScript('canary.sh', args);
  return authoritativeCompletion('canary', 'production-canary-passed', result);
}

function rollbackProduction(args) {
  const deploymentIndex = args.indexOf('--deployment');
  const deploymentId = deploymentIndex >= 0 ? args[deploymentIndex + 1] : '';
  if (!deploymentId || deploymentId.startsWith('-')) {
    fail('rollback requires --deployment with the exact deployment ID', 64);
  }
  // This flag was documented on three surfaces and implemented in none: the
  // local wrapper, the remote driver and the CLI all dropped it, so the one
  // command the runbook named as the safe path answered `usage:` — indis-
  // tinguishable from a typo — at exactly the moment an operator needed it.
  // Rollback restores no database, so rather than pretend the control exists,
  // refuse it by name and say where the real procedure is.
  if (args.includes('--confirm-database-restore')) {
    fail(
      'rollback never restores a database, and --confirm-database-restore is not a command this project implements.\n' +
      '       `./revival rollback --deployment ID` returns the app to the previous release and leaves every\n' +
      '       post-cutover write in place. To restore a database, follow the manual procedure in\n' +
      '       docs/recovery.md (Restoring a database) — it names the writers to stop and what the restore discards.',
      64
    );
  }
  requireConfirmedMutation(args, 'rollback');
  deploymentScript('rollback.sh', args);
  return null;
}

// The supported way to change a protected configuration input. It is deliberately
// its own top-level command and not a flag on `deploy` or `drift`: those run the
// drift gate, and a control that answers "the gate refused, accept it anyway"
// must never be reachable from the thing being gated. Without --confirm it only
// shows what differs, exactly like `pin install` without --confirm.
function adoptProtectedConfiguration(args) {
  const confirmed = args.includes('--confirm');
  const reasonIndex = args.indexOf('--reason');
  if (confirmed && (reasonIndex === -1 || !args[reasonIndex + 1] || args[reasonIndex + 1].startsWith('-'))) {
    fail(
      'adopt-config --confirm requires --reason "why this protected input legitimately changed".\n' +
      '       The reason is written into the deployment record beside the before/after digests;\n' +
      '       an adoption with no stated reason is the hand-edit this command exists to replace.',
      64
    );
  }
  deploymentScript('adopt-config.sh', args);
  return null;
}

// Retention for backups/ and releases/. Its own top-level command and never a
// step inside `deploy`, for the same reason adopt-config is: a deploy must never
// be able to free its own headroom by removing the position it would recover to.
// The failure this exists for is silent — both stores only ever grow, nothing
// prunes either, and the end state is preflight refusing every deploy on free
// space while production serves normally — so the command has to be reachable
// without a deploy, which is also why it streams instead of running out of
// `current`. Without --confirm it plans and removes nothing.
function pruneState(args) {
  if (args.includes('--expect-plan') && !args.includes('--confirm')) {
    fail(
      '--expect-plan is only meaningful with --confirm; without it nothing is removed anyway.\n' +
      '       Run `./revival prune-state` on its own to see the plan and its token first.',
      64
    );
  }
  deploymentScript('prune-state.sh', args);
  return null;
}

module.exports = {
  deploymentScript,
  productionDoctor,
  deployProduction,
  registerCarryBaseline,
  releaseCandidate,
  backupProduction,
  canaryProduction,
  rollbackProduction,
  adoptProtectedConfiguration,
  pruneState,
};
