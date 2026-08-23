'use strict';

const fs = require('node:fs');

const { ENV_FILE, fail, info } = require('./context');
const { operatorContract } = require('./command-spec');
const { readSetupState, selectSetupTrack } = require('./setup-state');

function protectedFile(file, requireContent = true) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o777) === 0o600 &&
    (!requireContent || stat.size > 0);
}

function commandEvidence(commandId, selectedTrack) {
  if (['setup.local', 'setup.contributor', 'setup.production', 'setup.pin'].includes(commandId)) {
    return { complete: commandId === `setup.${selectedTrack}`, evidence: 'journey selection' };
  }
  if (commandId === 'init') {
    return { complete: protectedFile(ENV_FILE), evidence: 'runtime configuration' };
  }
  if (commandId === 'version') return { complete: true, evidence: 'version descriptor' };
  return { complete: false, evidence: 'run this command directly' };
}

function normalizeCommand(command) {
  const usage = command.usage.replace(/ \[options\]$/, '');
  return usage.startsWith('revival ') ? `./${usage}` : usage;
}

function setupReport(selectedTrack) {
  const contract = operatorContract();
  const journey = contract.journeys.find((candidate) => candidate.id === selectedTrack);
  if (!journey) throw new Error(`operator contract has no ${selectedTrack} journey`);
  const commands = new Map(contract.commands.map((command) => [command.id, command]));
  const steps = journey.steps.map((step) => {
    const command = commands.get(step.commandId);
    if (!command) throw new Error(`operator contract journey references unknown command ${step.commandId}`);
    const evidence = commandEvidence(step.commandId, selectedTrack);
    return Object.freeze({
      id: step.id,
      title: step.title,
      status: evidence.complete ? 'complete' : 'required',
      evidence: evidence.evidence,
      action: normalizeCommand(command),
      verification: step.verification,
    });
  });
  return Object.freeze({ schemaVersion: 2, selectedTrack, label: journey.label, steps });
}

function parseJsonOnly(args, usage) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--json') return true;
  fail(`usage: ${usage}`, 64);
}

function printSetupReport(report, json) {
  if (json) return info(JSON.stringify(report));
  info(`${report.label} (${report.selectedTrack})`);
  for (const step of report.steps) {
    const marker = step.status === 'complete' ? 'PASS' : 'DO';
    info(`${marker.padEnd(4)} ${step.title}`);
    if (step.status === 'required') info(`     action: ${step.action}`);
  }
}

function setupCommand(args) {
  const operation = args.shift();
  try {
    if (['local', 'contributor', 'production', 'pin'].includes(operation)) {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      selectSetupTrack(operation);
      return printSetupReport(setupReport(operation), json);
    }
    if (operation === 'status' || operation === '--resume') {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      const state = readSetupState();
      if (!state) fail('no setup journey is selected; run ./revival setup local|contributor|production|pin', 64);
      return printSetupReport(setupReport(state.selectedTrack), json);
    }
    fail('usage: ./revival setup local|contributor|production|pin [--json] | status [--json] | --resume [--json]', 64);
  } catch (error) {
    fail(error.message);
  }
}

module.exports = { protectedFile, commandEvidence, setupReport, setupCommand };
