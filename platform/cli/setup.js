'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ENV_FILE,
  fail,
  info,
} = require('./context');
const { operatorContract } = require('./command-spec');
const {
  readSetupState,
  selectSetupTrack,
} = require('./setup-state');

const ROOT = path.resolve(__dirname, '..', '..');
const HOSTED_VPS_CANDIDATE_TOOL = path.join(ROOT, 'platform', 'deploy', 'hosted-vps-candidate.mjs');
const HOSTED_PIN_ARTIFACT_TOOL = path.join(ROOT, 'platform', 'deploy', 'hosted-pin-artifact.mjs');
const ARTIFACT_TOOL_TIMEOUT_MILLISECONDS = 100 * 60 * 1000;

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
    return { complete: protectedFile(ENV_FILE), evidence: 'external runtime configuration' };
  }
  if (commandId === 'doctor.local') {
    return {
      complete: false,
      evidence: 'run the doctor directly; setup does not execute Docker',
    };
  }
  if (commandId === 'stack.up' || commandId === 'stack.status') {
    return { complete: false, evidence: 'live stack verification is explicit' };
  }
  if (commandId === 'pin.doctor') {
    return {
      complete: false,
      evidence: 'run the Pin doctor directly; setup does not inspect a device',
    };
  }
  if (commandId.startsWith('pin.release.')) {
    return { complete: false, evidence: 'run the release command directly' };
  }
  if (commandId === 'pki.import' || commandId === 'pki.init') {
    return { complete: false, evidence: 'run PKI validation directly' };
  }
  if (commandId === 'config.check') {
    return { complete: false, evidence: 'run the configuration check directly' };
  }
  if (commandId === 'version') {
    return { complete: true, evidence: 'stamped release descriptor' };
  }
  // Setup is a guide, not deployment authority. Mutable checks and physical
  // acceptance are deliberately rerun by their owning commands.
  return { complete: false, evidence: 'run this command directly' };
}

function artifactToolEnvironment() {
  const environment = {
    HOME: path.isAbsolute(process.env.HOME || '') ? process.env.HOME : '/nonexistent',
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
  };
  for (const name of [
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'REVIVAL_CONFIG_DIR', 'REVIVAL_SECRETS_DIR', 'REVIVAL_DATA_DIR', 'REVIVAL_BACKUP_DIR',
    'REVIVAL_BUILD_DIR', 'REVIVAL_STATE_DIR', 'REVIVAL_PIN_RELEASE_OUTPUT_DIR',
  ]) {
    if (typeof process.env[name] === 'string' && !process.env[name].includes('\0')) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function runArtifactTool(tool, command, args) {
  const jsonCount = args.filter((argument) => argument === '--json').length;
  if (jsonCount > 1) throw new Error('hosted artifact operation accepts --json at most once');
  const toolArgs = args.filter((argument) => argument !== '--json');
  const result = spawnSync(process.execPath, [tool, command, ...toolArgs, '--json'], {
    cwd: ROOT,
    env: artifactToolEnvironment(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: ARTIFACT_TOOL_TIMEOUT_MILLISECONDS,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw new Error(`hosted artifact operation could not run: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) {
    throw new Error((result.stderr || 'hosted artifact operation failed').trim());
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('hosted artifact operation returned invalid JSON'); }
  if (result.stdout !== `${canonical(parsed)}\n` || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('hosted artifact operation returned ambiguous non-canonical evidence');
  }
  return Object.freeze({ parsed: Object.freeze(parsed), stdout: result.stdout, json: jsonCount === 1 });
}

function exactFields(value, fields) {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function validateVpsImportResult(result) {
  if (
    !exactFields(result, [
      'ok', 'candidateId', 'releaseId', 'candidateRoot', 'evidenceRoot',
      'runnerInvocationUri', 'sourceDigest',
    ]) || result.ok !== true || !/^[0-9a-f]{64}$/u.test(result.candidateId) ||
    !/^[0-9a-f]{64}$/u.test(result.releaseId) || !/^[0-9a-f]{40}$/u.test(result.sourceDigest) ||
    !path.isAbsolute(result.candidateRoot || '') || !path.isAbsolute(result.evidenceRoot || '') ||
    !/^https:\/\/github\.com\/TheAndersMadsen\/ai-pin-revival\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(result.runnerInvocationUri || '')
  ) throw new Error('hosted VPS import returned an unsupported success record');
}

function validatePinImportResult(result) {
  if (
    !exactFields(result, [
      'ok', 'schema', 'version', 'releaseRoot', 'releaseId', 'versionName', 'versionCode',
      'manifestSha256', 'requestSha256', 'releaseBundleSha256', 'runnerInvocationUri',
    ]) || result.ok !== true || result.schema !== 'revival.hosted-pin-release-import' || result.version !== 1 ||
    !path.isAbsolute(result.releaseRoot || '') || !/^[0-9a-f]{64}$/u.test(result.releaseId) ||
    !Number.isSafeInteger(result.versionCode) || result.versionCode <= 0 ||
    typeof result.versionName !== 'string' || result.versionName.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(result.manifestSha256) || !/^[0-9a-f]{64}$/u.test(result.requestSha256) ||
    !/^[0-9a-f]{64}$/u.test(result.releaseBundleSha256) ||
    !/^https:\/\/github\.com\/TheAndersMadsen\/ai-pin-revival\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(result.runnerInvocationUri || '')
  ) throw new Error('hosted Pin import returned an unsupported success record');
}

function printArtifactResult(operation, kind, execution) {
  if (execution.json) {
    process.stdout.write(execution.stdout);
    return;
  }
  const result = execution.parsed;
  if (kind === 'vps-candidate' || kind === 'vps') {
    info(`${operation} passed: candidate=${result.candidateId} release=${result.releaseId}`);
  } else {
    info(`${operation} passed: ${result.versionName} ${result.releaseId}`);
  }
}

function setupArtifactCommand(operation, args) {
  const kind = args.shift();
  if (operation === 'import' && kind === 'vps-candidate') {
    const execution = runArtifactTool(HOSTED_VPS_CANDIDATE_TOOL, 'import', args);
    validateVpsImportResult(execution.parsed);
    printArtifactResult(operation, kind, execution);
    return;
  }
  if (operation === 'import' && kind === 'pin-release') {
    const execution = runArtifactTool(HOSTED_PIN_ARTIFACT_TOOL, 'import', args);
    validatePinImportResult(execution.parsed);
    printArtifactResult(operation, kind, execution);
    return;
  }
  if (operation === 'artifacts' && kind === 'vps') {
    const execution = runArtifactTool(HOSTED_VPS_CANDIDATE_TOOL, 'status', args);
    printArtifactResult(operation, kind, execution);
    return null;
  }
  if (operation === 'artifacts' && kind === 'pin') {
    const execution = runArtifactTool(HOSTED_PIN_ARTIFACT_TOOL, 'status', args);
    printArtifactResult(operation, kind, execution);
    return null;
  }
  fail(
    'usage: ./revival setup import vps-candidate --handoff-root DIR [--data-dir DIR] [--json] |\n' +
    '       ./revival setup import pin-release --release-root DIR [--data-dir DIR] [--json] |\n' +
    '       ./revival setup artifacts vps|pin [--data-dir DIR] [--json]',
    64,
  );
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
  return Object.freeze({
    schemaVersion: 2,
    selectedTrack,
    label: journey.label,
    steps,
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
    const marker = { complete: 'PASS', required: 'DO' }[step.status];
    info(`${marker.padEnd(4)} ${step.title}`);
    if (step.status === 'required') info(`     action: ${step.action}`);
  }
  if (report.physicalAcceptanceRequired) {
    info('Physical acceptance remains explicit; setup never marks it complete from host evidence.');
  }
  info('This checklist does not infer completion of live or physical actions; their owning commands report results.');
}

function setupCommand(args) {
  const operation = args.shift();
  try {
    if (['local', 'contributor', 'production', 'pin'].includes(operation)) {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      selectSetupTrack(operation);
      printSetupReport(setupReport(operation), json);
      return null;
    }
    if (operation === 'status' || operation === '--resume') {
      const json = parseJsonOnly(args, `./revival setup ${operation} [--json]`);
      const state = readSetupState();
      if (!state) fail('no setup journey is selected; run ./revival setup local|contributor|production|pin', 64);
      printSetupReport(setupReport(state.selectedTrack), json);
      return null;
    }
    if (operation === 'import' || operation === 'artifacts') {
      setupArtifactCommand(operation, args);
      return;
    }
    fail('usage: ./revival setup local|contributor|production|pin [--json] | status [--json] | --resume [--json] | import ... | artifacts ...', 64);
  } catch (error) {
    fail(error.message);
  }
}

module.exports = { protectedFile, commandEvidence, setupReport, setupCommand };
