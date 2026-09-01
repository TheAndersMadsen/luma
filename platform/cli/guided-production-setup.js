'use strict';

const fs = require('node:fs');
const net = require('node:net');

const {
  PRODUCTION_PROFILE_NAMES,
  validProductionDomain,
  validProductionEmail,
} = require('./production-setup');

const DEFAULT_PROFILES = Object.freeze(['pin', 'search', 'spotify']);

function terminalReadLine() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'setup production --guided requires an interactive terminal; use the explicit setup flags for automation',
    );
  }
  const buffer = Buffer.alloc(4096);
  const length = fs.readSync(process.stdin.fd, buffer, 0, buffer.length, null);
  if (length === 0) throw new Error('guided production setup ended before confirmation');
  return buffer.subarray(0, length).toString('utf8').replace(/[\r\n]+$/u, '');
}

function parseProfiles(value) {
  if (/^(?:none|no)$/iu.test(value.trim())) return [];
  const profiles = [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
  if (profiles.some((profile) => !PRODUCTION_PROFILE_NAMES.includes(profile))) return null;
  if (profiles.includes('spotify') && !profiles.includes('pin')) return null;
  return profiles.sort();
}

function guidedProductionArguments(current = {}, io = {}) {
  const readLine = io.readLine ?? terminalReadLine;
  const write = io.write ?? ((value) => process.stdout.write(value));

  function ask(stage, label, defaultValue, validate, error) {
    while (true) {
      write(`\n[${stage}/5] ${label}${defaultValue ? ` [${defaultValue}]` : ''}: `);
      const entered = readLine();
      const value = (entered.trim() || defaultValue).trim();
      if (validate(value)) return value;
      write(`\n${error}\n`);
    }
  }

  write('Ai Pin Revival guided production setup\n');
  write('This prepares the server only. It does not deploy or change a Pin.\n');

  const domainDefault = current.REVIVAL_PUBLIC_DOMAIN || (() => {
    try { return new URL(current.REVIVAL_PUBLIC_ORIGIN || '').hostname; } catch { return ''; }
  })();
  const domain = ask(1, 'Public Center domain', domainDefault, validProductionDomain,
    'Enter a public DNS name such as center.example.com.');
  const acmeEmail = ask(1, 'TLS certificate email', current.REVIVAL_ACME_EMAIL || '', validProductionEmail,
    'Enter a valid email address.');
  const operatorEmail = ask(2, 'First Center owner email', current.REVIVAL_FIRST_OPERATOR_EMAIL || '', validProductionEmail,
    'Enter a valid email address.');

  const configuredProfiles = (current.COMPOSE_PROFILES || '').split(',').map((item) => item.trim()).filter(Boolean);
  const profileDefault = (configuredProfiles.length > 0 ? configuredProfiles : DEFAULT_PROFILES).join(',');
  const profileText = ask(
    3,
    'Features (pin, search, spotify, observability; or none)',
    profileDefault,
    (value) => parseProfiles(value) !== null,
    'Use only pin, search, spotify, and observability. Spotify requires pin.',
  );
  const profiles = parseProfiles(profileText);
  if (profiles === null) throw new Error('guided production setup profile validation failed');

  const publicIpv4 = profiles.includes('pin')
    ? ask(4, 'Server public IPv4 for the Pin', current.REVIVAL_DEVICE_EDGE_IPV4 || '',
      (value) => net.isIP(value) === 4, 'Enter the public IPv4 address that reaches this server.')
    : '';

  write('\n[5/5] Review\n');
  write(`  Center: https://${domain}\n`);
  write(`  Certificate email: ${acmeEmail}\n`);
  write(`  First owner: ${operatorEmail}\n`);
  write(`  Features: ${profiles.join(', ') || 'none'}\n`);
  if (publicIpv4) write(`  Pin address: ${publicIpv4}\n`);
  write('  Next: doctor and dry-run; deployment remains a separate confirmed command.\n');
  write('\nWrite this production configuration? [y/N]: ');
  if (!/^(?:y|yes)$/iu.test(readLine().trim())) {
    throw new Error('guided production setup cancelled; no configuration was written');
  }
  write('\n');

  const args = [
    '--domain', domain,
    '--acme-email', acmeEmail,
    '--operator-email', operatorEmail,
  ];
  if (publicIpv4) args.push('--public-ip', publicIpv4);
  if (profiles.length === 0) args.push('--no-profiles');
  else for (const profile of profiles) args.push('--profile', profile);
  return args;
}

module.exports = {
  DEFAULT_PROFILES,
  guidedProductionArguments,
  parseProfiles,
};
