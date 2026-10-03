'use strict';

const fs = require('node:fs');
const net = require('node:net');

const {
  PRODUCTION_PROFILE_NAMES,
  reservedExampleEmail,
  validProductionDomain,
  validProductionEmail,
} = require('./production-setup');
const { detectPublicIpv4, duckDnsDomain, duckDnsSubdomain, registerDuckDns } = require('./public-network');
const { interactiveTerminal, readHiddenTerminalLine, readTerminalLine } = require('./terminal');
const { isUpdateSourceOrigin } = require('../distribution/release-descriptor.mjs');

const DEFAULT_PROFILES = Object.freeze(['pin', 'search', 'spotify']);
const ENDED = 'guided production setup ended before confirmation';

function requireTerminal() {
  if (!interactiveTerminal()) {
    throw new Error(
      'setup production --guided requires an interactive terminal; use the explicit setup flags for automation',
    );
  }
}

function terminalReadLine() {
  requireTerminal();
  return readTerminalLine(ENDED);
}

// The DuckDNS token is typed with echo off, like `config set --stdin`.
function terminalReadHiddenLine(prompt) {
  requireTerminal();
  return readHiddenTerminalLine(prompt, ENDED);
}

function parseProfiles(value) {
  if (/^(?:none|no)$/iu.test(value.trim())) return [];
  const profiles = [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
  if (profiles.some((profile) => !PRODUCTION_PROFILE_NAMES.includes(profile))) return null;
  if (profiles.includes('spotify') && !profiles.includes('pin')) return null;
  return profiles.sort();
}

function guidedProductionArguments(current = {}, io = {}, options = {}) {
  const readLine = io.readLine ?? terminalReadLine;
  const readHiddenLine = io.readHiddenLine ?? terminalReadHiddenLine;
  const write = io.write ?? ((value) => process.stdout.write(value));
  // Tests inject the network. Production uses the module's own detection.
  const network = {
    ...(io.fetchText ? { fetchText: io.fetchText } : {}),
    ...(io.routeAddress ? { routeAddress: io.routeAddress } : {}),
  };

  // Seven numbered questions and the review. The numbering stays the same
  // when the Pin questions are skipped. Follow-up questions (DuckDNS, the Pin
  // archive) are indented under the question that asks for them.
  const stages = 8;
  const needsPinArchive = options.pinReleaseStaged === false;

  function ask(stage, label, defaultValue, validate, error) {
    while (true) {
      write(`\n${stage ? `[${stage}/${stages}] ` : '  '}${label}${defaultValue ? ` [${defaultValue}]` : ''}: `);
      const entered = readLine();
      const value = (entered.trim() || defaultValue).trim();
      if (validate(value)) return value;
      write(`\n${error}\n`);
    }
  }

  // Detected once, for the DuckDNS record and the Pin address prompt. A
  // failed detection leaves those prompts without a default and says why.
  let detected;
  function publicIpv4Default() {
    if (current.LUMA_DEVICE_EDGE_IPV4) return current.LUMA_DEVICE_EDGE_IPV4;
    detected ??= detectPublicIpv4(network);
    if (detected.reason) write(`\n  Could not detect this server's public IPv4: ${detected.reason}.\n`);
    return detected.address || '';
  }
  function askPublicIpv4(stage, label) {
    const answer = ask(stage, label, publicIpv4Default(),
      (value) => net.isIP(value) === 4, 'Enter the public IPv4 address that reaches this server.');
    // The address the owner confirmed is the one every later prompt offers.
    detected = { address: answer, reason: null };
    return answer;
  }

  write('Luma guided production setup\n');
  write('This prepares the server only. It does not deploy or change a Pin.\n');
  write('No physical Pin is needed. Configure Center and services now; connect your one Pin later.\n');

  const domainDefault = current.LUMA_PUBLIC_DOMAIN || (() => {
    try { return new URL(current.LUMA_PUBLIC_ORIGIN || '').hostname; } catch { return ''; }
  })();
  // DNS names are case-insensitive and registrars often show capitals. Setup
  // stores the lowercase form, as the flag path does. Without a domain of
  // their own, the owner gets a free NAME.duckdns.org pointed at this server.
  let domain = ask(1, 'Public Center domain (blank or "duckdns" for a free DuckDNS name)', domainDefault,
    (value) => value === '' || value === 'duckdns' || validProductionDomain(value.toLowerCase()),
    'Enter a public DNS name such as center.example.com, or "duckdns" for a free one.').toLowerCase();
  if (domain === '' || domain === 'duckdns') {
    write('\n  DuckDNS gives you NAME.duckdns.org for free: sign in at https://www.duckdns.org, add a subdomain, ' +
      'and keep the token shown at the top of that page ready.\n');
    const subdomain = duckDnsSubdomain(ask(0, 'DuckDNS subdomain (NAME in NAME.duckdns.org)', '',
      (value) => duckDnsSubdomain(value) !== null,
      'Use letters, digits and hyphens only, such as my-center.'));
    const ipv4 = askPublicIpv4(0, `Server public IPv4 for ${duckDnsDomain(subdomain)}`);
    const token = readHiddenLine('\n  DuckDNS token (not shown, not stored): ');
    domain = registerDuckDns({ subdomain, token, ipv4, ...network });
    write(`\n  ${domain} now points at ${ipv4}.\n`);
  }
  const acmeEmail = ask(2, 'TLS certificate email', current.LUMA_ACME_EMAIL || '',
    (value) => validProductionEmail(value) && !reservedExampleEmail(value),
    'Enter a real email address. Let\'s Encrypt refuses example.com, example.net, and example.org.');
  const operatorEmail = ask(3, 'First Center owner email', current.LUMA_FIRST_OPERATOR_EMAIL || '', validProductionEmail,
    'Enter a valid email address.');

  const configuredProfiles = (current.COMPOSE_PROFILES || '').split(',').map((item) => item.trim()).filter(Boolean);
  const profileDefault = (Object.hasOwn(current, 'COMPOSE_PROFILES') ? configuredProfiles : DEFAULT_PROFILES).join(',') || 'none';
  const profileText = ask(
    4,
    'Features (pin, search, spotify, observability; or none)',
    profileDefault,
    (value) => parseProfiles(value) !== null,
    'Use only pin, search, spotify, and observability. Spotify requires pin.',
  );
  const profiles = parseProfiles(profileText);
  if (profiles === null) throw new Error('guided production setup profile validation failed');

  const publicIpv4 = profiles.includes('pin') ? askPublicIpv4(5, 'Server public IPv4 for the Pin') : '';
  if (!profiles.includes('pin')) {
    write(`\n[5/${stages}] Pin feature is off; no Pin address or archive is needed.\n`);
  }

  const pinArchive = needsPinArchive && profiles.includes('pin')
    ? ask(0, 'Path to this release\'s Pin archive (README "Get Luma")', '',
      (value) => value === '' || (fs.existsSync(value) && fs.statSync(value).isFile()),
      'Enter the path to this release\'s luma-pin-*.tar.gz file, or press Enter to continue without one.')
    : '';

  // Where the server asks for newer releases and whether it installs them
  // itself. The saved answer is the default, then the Center the installer
  // came from (bootstrap passes it), then the release's own update source.
  const updateSource = ask(6, 'Where should this server check for updates?',
    current.LUMA_UPDATE_SOURCE || options.updateSource || '',
    (value) => value === '' || isUpdateSourceOrigin(value.replace(/\/$/u, '')),
    'Enter the https address of a Luma Center, such as https://center.example.com.').replace(/\/$/u, '');
  const automatic = current.LUMA_AUTO_UPDATES !== 'off';
  let autoUpdates;
  while (!autoUpdates) {
    write(`\n[7/${stages}] Install updates automatically at night? [${automatic ? 'Y/n' : 'y/N'}]: `);
    const answer = readLine().trim();
    if (answer === '') autoUpdates = automatic ? 'on' : 'off';
    else if (/^(?:y|yes)$/iu.test(answer)) autoUpdates = 'on';
    else if (/^(?:n|no)$/iu.test(answer)) autoUpdates = 'off';
    else write('\nAnswer y or n.\n');
  }

  write(`\n[${stages}/${stages}] Review\n`);
  write(`  Center: https://${domain}\n`);
  write(`  Certificate email: ${acmeEmail}\n`);
  write(`  First owner: ${operatorEmail}\n`);
  write(`  Features: ${profiles.join(', ') || 'none'}\n`);
  if (publicIpv4) write(`  Pin address: ${publicIpv4}\n`);
  write(`  Updates: ${updateSource ? `from ${updateSource}` : 'no update source'}, ` +
    `${autoUpdates === 'on' ? 'installed automatically at night' : 'installed by you'}\n`);
  if (needsPinArchive && profiles.includes('pin')) {
    write(`  Pin release archive: ${pinArchive ||
      'none; setup downloads the signed release from GitHub, or stops asking for the file'}\n`);
  }
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
  if (pinArchive) args.push('--pin-release-archive', pinArchive);
  if (updateSource) args.push('--update-source', updateSource);
  args.push('--auto-updates', autoUpdates);
  return args;
}

module.exports = {
  DEFAULT_PROFILES,
  guidedProductionArguments,
  parseProfiles,
};
