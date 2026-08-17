'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Production operations: deploy, backup/canary/drift drivers, adopt-config, prune-state, rollback.
// Split out of the root `revival` entry point; behavior, messages, and exit
// codes are unchanged.

const {
  DEPLOY_DIR, fail, exists, run,
} = require('./context');
const { releaseCheck } = require('./gates');
const { packageForDeployment } = require('./releases');

function deploymentScript(name, args) {
  const script = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(script)) fail(`deployment command is unavailable: ${script}`);
  return run('bash', [script, ...args]);
}

function productionDoctor(args) {
  deploymentScript('preflight.sh', args);
}

function deployProduction(args) {
  const releaseJsonIndex = args.indexOf('--release-json');
  let finalArgs = [...args];
  if (releaseJsonIndex === -1) {
    releaseCheck();
    const descriptorPath = packageForDeployment();
    finalArgs.push('--release-json', descriptorPath);
  } else if (!args[releaseJsonIndex + 1]) {
    fail('--release-json requires a file');
  }
  deploymentScript('deploy.sh', finalArgs);
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
  deploymentScript('rollback.sh', args);
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
}

module.exports = { deploymentScript, productionDoctor, deployProduction, rollbackProduction, adoptProtectedConfiguration, pruneState };
