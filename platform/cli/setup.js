'use strict';

const fs = require('node:fs');

const {
  ENV_FILE,
  fail,
  info,
} = require('./context');
const { operatorContract } = require('./command-spec');
const { readSetupState, selectSetupTrack } = require('./setup-state');

function protectedFile(file, requireContent = true) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600 &&
    (!requireContent || stat.size > 0);
}

function commandEvidence(commandId, selectedTrack) {
  if (commandId.startsWith('setup.')) {
    return { complete: commandId === `setup.${selectedTrack}`, evidence: 'journey selection' };
  }
  if (commandId === 'init') {
    return { complete: protectedFile(ENV_FILE), evidence: 'external runtime configuration' };
  }
  if (commandId === 'doctor.local') {
    return {
      complete: false,
      evidence: 'authoritative doctor must be run; setup does not execute Docker',
    };
  }
  if (commandId === 'stack.up' || commandId === 'stack.status') {
    return { complete: false, evidence: 'live stack verification is explicit' };
  }
  if (commandId === 'pin.doctor') {
    return {
      complete: false,
      evidence: 'authoritative Pin doctor must be run; setup does not inspect a device',
    };
  }
  if (commandId.startsWith('pin.release.')) {
    return { complete: false, evidence: 'authoritative release command must be run' };
  }
  if (commandId === 'pki.import' || commandId === 'pki.init') {
    return { complete: false, evidence: 'authoritative PKI validation must be run' };
  }
  if (commandId === 'config.check') {
    return { complete: false, evidence: 'authoritative configuration check must be run' };
  }
  if (commandId === 'version') {
    return { complete: true, evidence: 'stamped release descriptor' };
  }
  // Remote, device, physical, and test actions deliberately have no sticky
  // completion bit. Their authoritative tools must be rerun and accepted.
  return { complete: false, evidence: 'authoritative command must be run' };
}

function normalizeCommand(command) {
  const usage = command.usage.replace(/ \[options\]$/, '');
  return usage.startsWith('revival ')
    ? `./${usage}`
    : usage;
}

function setupReport(selectedTrack) {
  const contract = operatorContract();
  const journey = contract.journeys.find((candidate) => candidate.id === selectedTrack);
  if (!journey) throw new Error(`operator contract has no ${selectedTrack} journey`);
  const commands = new Map(contract.commands.map((command) => [command.id, command]));
  let waiting = false;
  const steps = journey.steps.map((step) => {
    const command = commands.get(step.commandId);
    if (!command) throw new Error(`operator contract journey references unknown command ${step.commandId}`);
    const evidence = commandEvidence(step.commandId, selectedTrack);
    let status;
    if (evidence.complete) status = 'complete';
    else if (waiting) status = 'blocked';
    else {
      status = 'pending';
      waiting = true;
    }
    return Object.freeze({
      id: step.id,
      title: step.title,
      status,
      evidence: evidence.evidence,
      action: normalizeCommand(command),
      verification: step.verification,
    });
  });
  const next = steps.find((step) => step.status === 'pending') || null;
  return Object.freeze({
    schemaVersion: 1,
    selectedTrack,
    label: journey.label,
    steps,
    next: next ? { step: next.id, action: next.action } : null,
    physicalAcceptanceRequired: steps.some((step) => step.verification === 'physical'),
  });
}

function parseJsonOnly(args, usage) {
  let json = false;
  for (const argument of args) {
    if (argument === '--json' && !json) json = true;
    else fail(`usage: ${usage}`, 64);
  }
  return json;
}

function printSetupReport(report, json) {
  if (json) {
    info(JSON.stringify(report));
    return;
  }
  info(`${report.label} (${report.selectedTrack})`);
  for (const step of report.steps) {
    const marker = { complete: 'PASS', pending: 'NEXT', blocked: 'WAIT' }[step.status];
    info(`${marker.padEnd(4)} ${step.title}`);
    if (step.status === 'pending') info(`     action: ${step.action}`);
  }
  if (report.physicalAcceptanceRequired) {
    info('Physical acceptance remains explicit; setup never marks it complete from host evidence.');
  }
  if (!report.next) info('All recomputable setup evidence is complete. Re-run physical and live acceptance where documented.');
}

function setupCommand(args) {
  const operation = args.shift();
  try {
    if (['local', 'contributor', 'production', 'pin'].includes(operation)) {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      selectSetupTrack(operation);
      printSetupReport(setupReport(operation), json);
      return;
    }
    if (operation === 'status' || operation === '--resume') {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      const state = readSetupState();
      if (!state) fail('no setup journey is selected; run ./revival setup local|contributor|production|pin', 64);
      printSetupReport(setupReport(state.selectedTrack), json);
      return;
    }
    fail('usage: ./revival setup local|contributor|production|pin [--json] | status [--json] | --resume [--json]', 64);
  } catch (error) {
    fail(error.message);
  }
}

module.exports = { protectedFile, commandEvidence, setupReport, setupCommand };
