'use strict';

const fs = require('node:fs');

const {
  ENV_FILE,
  authoritativeCompletion,
  atomicWrite,
  fail,
  info,
  isInsideDirectory,
  parseEnvFile,
  SECRETS_DIR,
  validateRuntime,
} = require('./context');
const { operatorContract } = require('./command-spec');

const GROUPS = Object.freeze(['local', 'production', 'provider', 'pin']);

function settingsRegistry() {
  const settings = operatorContract().settings;
  const byName = new Map();
  for (const setting of settings) {
    byName.set(setting.name, setting);
    for (const alias of setting.aliases) byName.set(alias, setting);
  }
  return { settings, byName };
}

function resolveSetting(name) {
  const setting = settingsRegistry().byName.get(name);
  if (!setting) throw new Error(`unsupported setting: ${name}`);
  return setting;
}

function requireRuntimeFile() {
  if (!isInsideDirectory(ENV_FILE, SECRETS_DIR)) {
    throw new Error(`REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR: ${ENV_FILE}`);
  }
  if (!fs.existsSync(ENV_FILE)) throw new Error(`runtime configuration is missing; run ./revival init: ${ENV_FILE}`);
  const stat = fs.lstatSync(ENV_FILE);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`runtime configuration must be a regular mode-0600 file: ${ENV_FILE}`);
  }
}

function settingValue(values, setting) {
  if (Object.hasOwn(values, setting.name) && values[setting.name] !== '') return values[setting.name];
  for (const alias of setting.aliases) {
    if (Object.hasOwn(values, alias) && values[alias] !== '') return values[alias];
  }
  return '';
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
  const { json } = parseGroupAndJson(args, './revival config path [--json]', { allowGroup: false });
  if (json) info(JSON.stringify({ path: ENV_FILE }));
  else info(ENV_FILE);
}

function configList(args) {
  const { group, json } = parseGroupAndJson(args, './revival config list [--group GROUP] [--json]');
  const rows = settingsRegistry().settings
    .filter((setting) => group === null || setting.group === group)
    .map((setting) => ({
      name: setting.name,
      group: setting.group,
      sensitivity: setting.sensitivity,
      home: setting.home,
      aliases: setting.aliases,
    }));
  if (json) info(JSON.stringify({ settings: rows }));
  else {
    for (const row of rows) {
      const aliases = row.aliases.length ? ` aliases=${row.aliases.join(',')}` : '';
      info(`${row.name}\t${row.group}\t${row.sensitivity}\t${row.home}${aliases}`);
    }
  }
}

function configTemplate(args) {
  const { group, json } = parseGroupAndJson(args, './revival config template [--group GROUP]', { allowJson: false });
  if (json) fail('usage: ./revival config template [--group GROUP]', 64);
  const rows = settingsRegistry().settings
    .filter((setting) => setting.sensitivity !== 'secret' && (group === null || setting.group === group));
  info('# Generated from contracts/operator-setup.json. Secret settings are deliberately omitted.');
  for (const setting of rows) info(`${setting.name}=`);
}

function configGet(args) {
  const name = args.shift();
  if (!name || name.startsWith('-')) fail('usage: ./revival config get NAME [--json]', 64);
  const { json } = parseGroupAndJson(args, './revival config get NAME [--json]', {
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

function stdinValue() {
  const source = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 64 * 1024) throw new Error('configuration value exceeds 64 KiB');
  return source.replace(/\r?\n$/, '');
}

function validateEnvValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('configuration values must be a single line without NUL bytes');
  }
  return value;
}

function replaceSetting(contents, setting, value) {
  const names = new Set([setting.name, ...setting.aliases]);
  const lines = contents.split(/\r?\n/);
  let replaced = false;
  const output = [];
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (!match || !names.has(match[1])) {
      output.push(line);
      continue;
    }
    if (!replaced) {
      output.push(`${setting.name}=${value}`);
      replaced = true;
    }
    // Drop duplicate compatibility aliases so the edited value is unambiguous.
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
    fail('usage: ./revival config set NAME VALUE | ./revival config set NAME --stdin', 64);
  }
  try {
    const setting = resolveSetting(name);
    let value;
    if (args.length === 1 && args[0] === '--stdin') value = stdinValue();
    else if (args.length === 1 && setting.sensitivity !== 'secret') value = args[0];
    else if (setting.sensitivity === 'secret') {
      fail(`secret setting ${setting.name} accepts input only through --stdin`, 64);
    } else {
      fail('usage: ./revival config set NAME VALUE | ./revival config set NAME --stdin', 64);
    }
    validateEnvValue(value);
    requireRuntimeFile();
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
    checks.push({ id: 'runtime-file', status: 'FAIL', message: error.message, fix: './revival init' });
  }
  if (values) {
    for (const setting of settingsRegistry().settings) {
      const canonical = values[setting.name] || '';
      for (const alias of setting.aliases) {
        const compatible = values[alias] || '';
        if (canonical && compatible && canonical !== compatible) {
          checks.push({
            id: `alias-${setting.name}`,
            status: 'FAIL',
            message: `${setting.name} and compatibility alias ${alias} disagree.`,
            fix: `./revival config set ${setting.name} ${setting.sensitivity === 'secret' ? '--stdin' : 'VALUE'}`,
          });
        }
      }
    }
    const selected = (name) => settingValue(values, resolveSetting(name));
    if (selected('REVIVAL_REMOTE_TTS_ENABLED') === 'true') {
      for (const required of ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION']) {
        if (!selected(required)) checks.push({
          id: `dependency-${required}`,
          status: 'FAIL',
          message: `${required} is required when remote TTS is enabled.`,
          fix: `./revival config set ${required} ${resolveSetting(required).sensitivity === 'secret' ? '--stdin' : 'VALUE'}`,
        });
      }
    }
    if (selected('REVIVAL_SPOTIFY_ADAPTER_URL') && !selected('REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE')) {
      checks.push({
        id: 'dependency-spotify-token',
        status: 'FAIL',
        message: 'REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE is required when the Spotify adapter URL is set.',
        fix: './revival config set REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE --stdin',
      });
    }
    try {
      validateRuntime();
      checks.push({ id: 'runtime-contract', status: 'PASS', message: 'Runtime values satisfy the complete local configuration contract.' });
    } catch (error) {
      checks.push({
        id: 'runtime-contract',
        status: 'FAIL',
        message: error.message,
        fix: 'Update only the named settings with ./revival config set, then rerun ./revival config check.',
      });
    }
  }
  if (!checks.some((check) => check.status === 'FAIL')) {
    checks.push({ id: 'contract-settings', status: 'PASS', message: 'Contract-backed aliases and dependencies are coherent.' });
  }
  const next = checks.find((check) => check.status === 'FAIL')?.fix || './revival doctor';
  return { schemaVersion: 1, ok: !checks.some((check) => check.status === 'FAIL'), checks, next };
}

function configCheck(args) {
  const { json } = parseGroupAndJson(args, './revival config check [--json]', {
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
  else if (operation === 'check') {
    const report = configCheck(args);
    return report.ok ? authoritativeCompletion('config.check', 'configuration-validated') : null;
  }
  else if (operation === 'list') configList(args);
  else if (operation === 'template') configTemplate(args);
  else fail('usage: ./revival config path|get|set|check|list|template ...', 64);
  return null;
}

module.exports = {
  settingsRegistry,
  resolveSetting,
  replaceSetting,
  configCheckReport,
  configCommand,
};
