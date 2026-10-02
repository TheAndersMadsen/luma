'use strict';

const fs = require('node:fs');

const {
  ENV_FILE,
  atomicWrite,
  fail,
  info,
  isInsideDirectory,
  parseEnvFile,
  SECRETS_DIR,
  validateRuntime,
} = require('./context');
const { OPERATOR_SETUP_NEXT, isOperatorRelease, operatorContract } = require('./command-spec');
const {
  hasProductionSetupMarker,
  TRAEFIK_EXTRA_FILE,
  validateProductionArtifacts,
  validateTraefikExtra,
} = require('./production-setup');
const { secretFromStdin } = require('./terminal');

const GROUPS = Object.freeze(['local', 'production', 'provider', 'pin']);

function settingsRegistry() {
  const settings = operatorContract().settings;
  const byName = new Map(settings.map((setting) => [setting.name, setting]));
  return { settings, byName };
}

function resolveSetting(name) {
  const setting = settingsRegistry().byName.get(name);
  if (!setting) throw new Error(`unsupported setting: ${name}; ./luma config list names every supported setting`);
  return setting;
}

// The command that creates the runtime configuration: an operator release has
// only production setup, a checkout initializes a local one.
function firstSetupCommand() {
  return isOperatorRelease() ? OPERATOR_SETUP_NEXT : './luma init';
}

function requireRuntimeFile() {
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`LUMA_ENV_FILE must be inside LUMA_SECRETS_DIR: ${ENV_FILE}`);
  }
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`runtime configuration is missing (${ENV_FILE}); create it with ${firstSetupCommand()}, ` +
      'or point this shell at the one this server uses with LUMA_CONFIG_DIR and LUMA_DATA_DIR (README "Configuration")');
  }
  const stat = fs.lstatSync(ENV_FILE);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`runtime configuration must be a regular mode-0600 file: ${ENV_FILE}`);
  }
}

function settingValue(values, setting) {
  return values[setting.name] || '';
}

function parseGroupAndJson(args, usage, { allowGroup = true, allowJson = true } = {}) {
  let group = null;
  let json = false;
  while (args.length > 0) {
    const option = args.shift();
    if (allowJson && option === '--json' && !json) json = true;
    else if (allowGroup && option === '--group' && group === null && args.length > 0) group = args.shift();
    else fail(`usage: ${usage}`, 64);
  }
  if (group !== null && !GROUPS.includes(group)) fail(`--group must be one of: ${GROUPS.join(', ')}`, 64);
  return { group, json };
}

function configPath(args) {
  const { json } = parseGroupAndJson(args, './luma config path [--json]', { allowGroup: false });
  if (json) info(JSON.stringify({ path: ENV_FILE }));
  else info(ENV_FILE);
}

function configList(args) {
  const { group, json } = parseGroupAndJson(args, './luma config list [--group GROUP] [--json]');
  const rows = settingsRegistry().settings
    .filter((setting) => group === null || setting.group === group)
    .map((setting) => ({
      name: setting.name,
      group: setting.group,
      sensitivity: setting.sensitivity,
      home: setting.home,
    }));
  // Whether each setting has a value, never the value itself.
  let values = null;
  try {
    requireRuntimeFile();
    values = parseEnvFile(ENV_FILE);
  } catch {
    // Before setup there is no runtime configuration to report on.
  }
  if (values) for (const row of rows) row.state = values[row.name] ? 'set' : 'unset';
  if (json) info(JSON.stringify({ settings: rows }));
  else {
    info(`NAME\tGROUP\tSENSITIVITY\tHOME${values ? '\tSTATE' : ''}`);
    for (const row of rows) {
      info(`${row.name}\t${row.group}\t${row.sensitivity}\t${row.home}${values ? `\t${row.state}` : ''}`);
    }
  }
}

function configTemplate(args) {
  const { group, json } = parseGroupAndJson(args, './luma config template [--group GROUP]', { allowJson: false });
  if (json) fail('usage: ./luma config template [--group GROUP]', 64);
  const rows = settingsRegistry().settings
    .filter((setting) => setting.sensitivity !== 'secret' && (group === null || setting.group === group));
  info('# Generated from contracts/operator-setup.json. Secret settings are deliberately omitted.');
  for (const setting of rows) info(`${setting.name}=`);
}

function configGet(args) {
  const name = args.shift();
  if (!name || name.startsWith('-')) fail('usage: ./luma config get NAME [--json]', 64);
  const { json } = parseGroupAndJson(args, './luma config get NAME [--json]', {
    allowGroup: false,
  });
  try {
    requireRuntimeFile();
    const setting = resolveSetting(name);
    const value = settingValue(parseEnvFile(ENV_FILE), setting);
    if (setting.sensitivity === 'secret') {
      const state = value ? 'set' : 'unset';
      if (json) info(JSON.stringify({ name: setting.name, sensitivity: 'secret', state }));
      else info(`${setting.name}=${state}`);
      return;
    }
    if (json) info(JSON.stringify({ name: setting.name, sensitivity: setting.sensitivity, value }));
    else info(`${setting.name}=${value}`);
  } catch (error) {
    fail(error.message);
  }
}

function validateEnvValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('configuration values must be a single line without NUL bytes');
  }
  return value;
}

function replaceSetting(contents, setting, value) {
  const lines = contents.split(/\r?\n/);
  let replaced = false;
  const output = [];
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (!match || match[1] !== setting.name) {
      output.push(line);
      continue;
    }
    if (!replaced) {
      output.push(`${setting.name}=${value}`);
      replaced = true;
    }
  }
  if (!replaced) {
    while (output.length > 0 && output[output.length - 1] === '') output.pop();
    output.push(`${setting.name}=${value}`, '');
  }
  return output.join('\n');
}

function configSet(args) {
  const name = args.shift();
  if (!name || name.startsWith('-')) {
    fail('usage: ./luma config set NAME VALUE | ./luma config set NAME --stdin', 64);
  }
  try {
    const setting = resolveSetting(name);
    // Before any prompt, so nobody types a secret that cannot be saved.
    requireRuntimeFile();
    let value;
    if (args.length === 1 && args[0] === '--stdin') value = secretFromStdin(setting.name);
    else if (args.length === 1 && setting.sensitivity !== 'secret') value = args[0];
    else if (setting.sensitivity === 'secret') {
      fail(`secret setting ${setting.name} accepts input only through --stdin`, 64);
    } else {
      fail('usage: ./luma config set NAME VALUE | ./luma config set NAME --stdin', 64);
    }
    validateEnvValue(value);
    const contents = fs.readFileSync(ENV_FILE, 'utf8');
    atomicWrite(ENV_FILE, replaceSetting(contents, setting, value));
    const state = value === '' ? 'unset' : 'set';
    info(`updated ${setting.name} (${state}); value not printed`);
  } catch (error) {
    fail(error.message);
  }
}

function configCheckReport() {
  const checks = [];
  let values = null;
  try {
    requireRuntimeFile();
    values = parseEnvFile(ENV_FILE);
    checks.push({ id: 'runtime-file', status: 'PASS', message: 'Runtime configuration is a regular mode-0600 external file.' });
  } catch (error) {
    checks.push({ id: 'runtime-file', status: 'FAIL', message: error.message, fix: firstSetupCommand() });
  }
  const production = values ? hasProductionSetupMarker(values) : isOperatorRelease();
  if (values) {
    try {
      validateRuntime({ production });
      checks.push({
        id: 'runtime-contract',
        status: 'PASS',
        message: `Runtime values satisfy the complete ${production ? 'production' : 'local'} configuration contract.`,
      });
    } catch (error) {
      checks.push({
        id: 'runtime-contract',
        status: 'FAIL',
        message: error.message,
        fix: 'Update only the named settings with ./luma config set, then rerun ./luma config check.',
      });
    }
    if (production && !checks.some((check) => check.id === 'runtime-contract' && check.status === 'FAIL')) {
      try {
        validateProductionArtifacts(values, { ownerExtras: false });
        checks.push({ id: 'production-artifacts', status: 'PASS', message: 'Production-generated configuration and artifacts are complete.' });
      } catch (error) {
        checks.push({
          id: 'production-artifacts',
          status: 'FAIL',
          message: error.message,
          fix: './luma setup production',
        });
      }
      // The owner writes these. Setup never does, so rerunning it fixes nothing.
      const extras = validateTraefikExtra(values);
      checks.push(extras.length ? {
        id: 'owner-traefik-extras',
        status: 'FAIL',
        message: `owner Traefik extras are not ready:\n- ${extras.join('\n- ')}`,
        fix: `Correct what each problem names in the owner file ${TRAEFIK_EXTRA_FILE}, its traefik-extra-certs ` +
          'directory, or LUMA_TRAEFIK_EXTRA_NETWORKS (./luma config set), then apply it with ./luma deploy production --confirm',
      } : {
        id: 'owner-traefik-extras',
        status: 'PASS',
        message: 'Owner Traefik extras are valid or absent.',
      });
    }
  }
  if (!checks.some((check) => check.status === 'FAIL')) {
    checks.push({ id: 'contract-settings', status: 'PASS', message: 'Contract-backed settings and dependencies are coherent.' });
  }
  const next = checks.find((check) => check.status === 'FAIL')?.fix ||
    (production ? './luma doctor production' : './luma doctor');
  return { schemaVersion: 1, ok: !checks.some((check) => check.status === 'FAIL'), checks, next };
}

function configCheck(args) {
  const { json } = parseGroupAndJson(args, './luma config check [--json]', {
    allowGroup: false,
  });
  const report = configCheckReport();
  if (json) info(JSON.stringify(report));
  else {
    for (const check of report.checks) {
      info(`${check.status} ${check.message}`);
      if (check.fix) info(`     fix: ${check.fix}`);
    }
    info(`NEXT ${report.next}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

function configCommand(args) {
  const operation = args.shift();
  if (operation === 'path') configPath(args);
  else if (operation === 'get') configGet(args);
  else if (operation === 'set') configSet(args);
  else if (operation === 'check') configCheck(args);
  else if (operation === 'list') configList(args);
  else if (operation === 'template') configTemplate(args);
  else fail('usage: ./luma config path|get|set|check|list|template ...', 64);
  return null;
}

module.exports = {
  configCommand,
};
