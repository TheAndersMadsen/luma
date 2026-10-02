'use strict';

const child = require('node:child_process');
const net = require('node:net');
const os = require('node:os');

const { resolveTool } = require('./authority');

const DUCKDNS_SUFFIX = '.duckdns.org';
// One plain-text echo of the address this server connects from. It is only
// ever compared with the default route's own address, never trusted alone.
const PUBLIC_IPV4_ECHO = 'https://api.ipify.org';
const REQUEST_TIMEOUT_MS = 15_000;

// A DuckDNS name is one DNS label: letters, digits and hyphens, and DuckDNS
// itself lowercases it. `NAME.duckdns.org` typed in full is the same name.
function duckDnsSubdomain(value) {
  let name = value.trim().toLowerCase();
  if (name.endsWith(DUCKDNS_SUFFIX)) name = name.slice(0, -DUCKDNS_SUFFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name) ? name : null;
}

function duckDnsDomain(subdomain) {
  return `${subdomain}${DUCKDNS_SUFFIX}`;
}

// Fetches a small text answer synchronously: the setup prompts read the
// terminal synchronously, so the request runs in a child Node process that
// reads its URL from a pipe (the DuckDNS URL carries the token, so it never
// enters argv) and answers with the status and the first 4 KiB of the body.
// The child reports a failure by its error code alone, never by the URL.
const FETCH_CHILD = `
  const url = require('node:fs').readFileSync(0, 'utf8').trim();
  fetch(url, { redirect: 'error', signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}) })
    .then(async (response) => {
      const body = (await response.text()).slice(0, 4096);
      process.stdout.write(JSON.stringify({ status: response.status, body }));
    })
    .catch((error) => {
      process.stderr.write(String(error?.cause?.code || error?.name || 'failed'));
      process.exit(1);
    });
`;

function fetchTextSync(url) {
  const result = child.spawnSync(process.execPath, ['-e', FETCH_CHILD], {
    input: `${url}\n`,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', LANG: 'C', LC_ALL: 'C' },
    timeout: REQUEST_TIMEOUT_MS + 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not be reached (${result.error?.code || result.stderr.trim() || 'failed'})`);
  }
  return JSON.parse(result.stdout);
}

// Points NAME.duckdns.org at this server. A VPS keeps its IPv4 for its
// lifetime, so setting the record once at setup is enough and the token is
// never stored: nothing on this server needs it again. The token travels only
// in the request URL, and no error below repeats it.
// DuckDNS answers `OK` or `KO` (https://www.duckdns.org/spec.jsp).
function registerDuckDns({ subdomain, token, ipv4, fetchText = fetchTextSync }) {
  const domain = duckDnsDomain(subdomain);
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]{8,}$/u.test(token)) {
    throw new Error(`the DuckDNS token for ${domain} is missing or malformed; copy it from the top of https://www.duckdns.org after signing in`);
  }
  const query = new URLSearchParams({ domains: subdomain, token, ip: ipv4, verbose: 'true' });
  let answer;
  try {
    answer = fetchText(`https://www.duckdns.org/update?${query}`);
  } catch (error) {
    throw new Error(`DuckDNS ${error.message}; check that this server can reach https://www.duckdns.org and try again`);
  }
  if (answer.status === 200 && /^OK\b/u.test(answer.body.trim())) return domain;
  throw new Error(
    `DuckDNS refused to point ${domain} at ${ipv4}: the token is wrong or ${subdomain} is not one of your DuckDNS ` +
    'domains. Sign in at https://www.duckdns.org, add the subdomain there if it is missing, copy the token shown at ' +
    'the top of that page, and run setup again.',
  );
}

// The IPv4 address of the interface that carries the default route: what the
// kernel would use to reach the internet. Private on a server behind NAT.
function defaultRouteAddress() {
  if (process.platform === 'linux') {
    const result = child.spawnSync(resolveTool('ip'), ['-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8' });
    const match = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/u.exec(result.stdout || '');
    if (!match) throw new Error('no default IPv4 route');
    return match[1];
  }
  if (process.platform === 'darwin') {
    const result = child.spawnSync(resolveTool('route'), ['-n', 'get', '1.1.1.1'], { encoding: 'utf8' });
    const match = /^\s*interface:\s*(\S+)/mu.exec(result.stdout || '');
    const address = match && (os.networkInterfaces()[match[1]] || []).find((entry) => entry.family === 'IPv4');
    if (!address) throw new Error('no default IPv4 route');
    return address.address;
  }
  throw new Error(`no route detection on ${process.platform}`);
}

// Detects the public IPv4 without trusting either source alone: the address
// of the default route, confirmed by one HTTPS echo of the address the
// internet sees. Only agreement yields an address. Anything else yields the
// reason, and the caller asks the owner instead.
function detectPublicIpv4({ routeAddress = defaultRouteAddress, fetchText = fetchTextSync } = {}) {
  let local;
  try {
    local = routeAddress();
  } catch (error) {
    return { address: null, reason: `the default route has no usable IPv4 address (${error.message})` };
  }
  let seen;
  try {
    const answer = fetchText(PUBLIC_IPV4_ECHO);
    seen = answer.status === 200 ? answer.body.trim() : '';
  } catch (error) {
    return { address: null, reason: `${PUBLIC_IPV4_ECHO} ${error.message}` };
  }
  if (net.isIP(seen) !== 4) return { address: null, reason: `${PUBLIC_IPV4_ECHO} did not answer with an IPv4 address` };
  if (seen !== local) {
    return {
      address: null,
      reason: `this server's own address ${local} differs from the address the internet sees (${seen}), ` +
        'so it is probably behind NAT; use the address that reaches this server from outside',
    };
  }
  return { address: seen, reason: null };
}

module.exports = {
  PUBLIC_IPV4_ECHO,
  defaultRouteAddress,
  detectPublicIpv4,
  duckDnsDomain,
  duckDnsSubdomain,
  fetchTextSync,
  registerDuckDns,
};
