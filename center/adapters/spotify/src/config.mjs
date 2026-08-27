import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";

const DEFAULT_PORT = 18_081;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_FILE = "/run/secrets/spotify_adapter_token";
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 15_000;
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 512;
const ALLOWED_UPSTREAM_ORIGINS = new Set([
  "http://127.0.0.1:18080",
  "http://center-iroh-bridge:18080",
]);

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");
LOOPBACK_ADDRESSES.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function parseInteger(name, rawValue, defaultValue, minimum, maximum) {
  const value = rawValue === undefined || rawValue === "" ? defaultValue : rawValue;
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be a base-10 integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isLoopback(address) {
  return LOOPBACK_ADDRESSES.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

function parseBindAddress(rawValue) {
  const address = rawValue?.trim();
  if (!address) {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS is required");
  }
  if (isIP(address) === 0) {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS must be a literal IP address");
  }
  if (isLoopback(address)) {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS must not be a loopback address");
  }
  return address;
}

function parseUpstreamOrigin(rawValue) {
  const value = rawValue?.trim();
  if (!value) {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN must be an HTTP origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin ||
    !ALLOWED_UPSTREAM_ORIGINS.has(url.origin)
  ) {
    throw new Error("REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN must be an exact HTTP origin");
  }
  return url.origin;
}

export function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function readTokenDigest(tokenFile, readFile) {
  let raw;
  try {
    raw = readFile(tokenFile);
  } catch {
    throw new Error("Spotify adapter bearer token file could not be read");
  }

  // Docker/Kubernetes secret files commonly contain one final newline. No
  // other whitespace is valid in this private bearer credential. Hash bytes
  // directly, then overwrite the temporary buffer rather than retaining the
  // plaintext token in application configuration.
  const secret = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let end = secret.length;
  if (end > 0 && secret[end - 1] === 0x0a) end -= 1;
  if (end > 0 && secret[end - 1] === 0x0d) end -= 1;
  const token = secret.subarray(0, end);
  const valid =
    token.length >= MIN_TOKEN_BYTES &&
    token.length <= MAX_TOKEN_BYTES &&
    token.every((byte) => byte >= 0x21 && byte <= 0x7e);
  if (!valid) {
    secret.fill(0);
    throw new Error(
      `Spotify adapter bearer token must be ${MIN_TOKEN_BYTES}-${MAX_TOKEN_BYTES} visible ASCII bytes`,
    );
  }
  const digest = createHash("sha256").update(token).digest();
  secret.fill(0);
  return digest;
}

export function loadConfig(env = process.env, readFile = readFileSync) {
  const bindAddress = parseBindAddress(env.REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS);
  const upstreamOrigin = parseUpstreamOrigin(
    env.REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN,
  );
  const port = parseInteger(
    "REVIVAL_SPOTIFY_ADAPTER_PORT",
    env.REVIVAL_SPOTIFY_ADAPTER_PORT,
    DEFAULT_PORT,
    1,
    65_535,
  );
  const timeoutMs = parseInteger(
    "REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS",
    env.REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const tokenFile =
    env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE;
  const expectedTokenDigest = readTokenDigest(tokenFile, readFile);

  return Object.freeze({
    bindAddress,
    upstreamOrigin,
    port,
    timeoutMs,
    expectedTokenDigest,
  });
}

export const configBounds = Object.freeze({
  defaultPort: DEFAULT_PORT,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  minTimeoutMs: MIN_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  minTokenBytes: MIN_TOKEN_BYTES,
  maxTokenBytes: MAX_TOKEN_BYTES,
});
