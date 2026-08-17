/*
 * The ADB authentication signer, moved behind Center's own origin.
 *
 * Connecting to a Pin over WebUSB means answering the device's ADB AUTH
 * challenge: the Pin sends a 20-byte token and expects it signed by a key whose
 * public half the device trusts. PenumbraOS holds that key and exposes a signing
 * endpoint (a Cloudflare Worker); the Setup SPA called it straight from the
 * browser at `install/device/adbAuth.ts`.
 *
 * Center cannot: `connect-src 'self'` in `next.config.mjs` is what keeps browser
 * JavaScript on the origin that holds the `carry_tokens` session cookie from
 * talking to third parties, and widening it to a third-party Worker to make one
 * call would weaken every page on the origin. So the call moves server-side and
 * the browser talks to `/api/pin/adb/sign`, same-origin. The CSP is untouched.
 *
 * What crosses this boundary is device auth material, so:
 *   - nothing here logs, stores or returns the token, the signature, or an
 *     upstream response body. Error messages carry a status code and nothing else;
 *   - the request is exactly one ADB token — 20 bytes, no more, no less — so the
 *     proxy cannot be used as a general-purpose relay to the signer;
 *   - the destination is configuration, never caller input, and is re-validated
 *     on every call (https, or http to loopback for local development, no
 *     credentials, no query, no fragment, no redirects followed).
 */

/** ADB's AUTH token is a fixed-width digest. The upstream signer rejects anything else. */
export const ADB_AUTH_TOKEN_BYTES = 20;

/** Read no more than this from the caller before deciding the body is not an ADB token. */
export const MAX_SIGNER_REQUEST_BYTES = 256;

/** A signature plus an ADB public key is ~1 KB; anything near this is not one. */
export const MAX_SIGNER_RESPONSE_BYTES = 32 * 1024;

/** Neither returned field is prose, and neither is anywhere near this long. */
export const MAX_SIGNED_FIELD_CHARS = 4096;

export const DEFAULT_ADB_SIGNER_URL = "https://adb.penumbraos.workers.dev";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 15_000;

export type AdbSignerErrorCode =
  | "signer_not_configured"
  | "invalid_token"
  | "signer_unreachable"
  | "signer_rejected"
  | "invalid_response"
  | "rate_limited";

/** Every failure is named and carries the status the route should answer with. */
export class AdbSignerError extends Error {
  readonly code: AdbSignerErrorCode;
  readonly status: number;

  constructor(code: AdbSignerErrorCode, status: number, message: string) {
    super(message);
    this.name = "AdbSignerError";
    this.code = code;
    this.status = status;
  }
}

export type AdbSignature = {
  /** Base64 signature over the token — the field name ADB's own protocol uses. */
  token: string;
  /** The signer's public key in ADB's `<base64> <comment>` form. */
  public_key: string;
};

/** Shaped so `process.env` itself satisfies it, while naming the two values that matter. */
export type SignerEnvironment = {
  readonly [name: string]: string | undefined;
  readonly REVIVAL_PIN_ADB_SIGNER_URL?: string;
  readonly REVIVAL_PIN_ADB_SIGNER_TIMEOUT_MS?: string;
};

/**
 * Resolve and validate the signing endpoint. Deployment configuration only —
 * a caller can never influence where this proxy sends bytes.
 */
export function signerEndpoint(environment: SignerEnvironment = process.env): string {
  const raw = (environment.REVIVAL_PIN_ADB_SIGNER_URL ?? DEFAULT_ADB_SIGNER_URL).trim();
  if (!raw) {
    throw new AdbSignerError(
      "signer_not_configured",
      503,
      "This deployment has no ADB signing service configured, so a Pin cannot be authorized over USB.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdbSignerError(
      "signer_not_configured",
      503,
      "REVIVAL_PIN_ADB_SIGNER_URL is not a valid URL, so this deployment cannot authorize a Pin over USB.",
    );
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const transportAllowed = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!transportAllowed || url.username || url.password || url.search || url.hash) {
    throw new AdbSignerError(
      "signer_not_configured",
      503,
      "REVIVAL_PIN_ADB_SIGNER_URL must be an https URL (or http on loopback) with no credentials, query or fragment.",
    );
  }
  return url.toString();
}

/** Bounded, so a signer that stops answering cannot pin a Center worker open. */
export function signerTimeoutMs(environment: SignerEnvironment = process.env): number {
  const configured = Number(environment.REVIVAL_PIN_ADB_SIGNER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(configured)));
}

/**
 * Read a body without trusting `content-length`, refusing as soon as the stream
 * passes `maximum` rather than buffering whatever arrives.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new AdbSignerError("invalid_token", 413, "The request body is too large to be an ADB token.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The one thing this proxy will forward. Exactly `ADB_AUTH_TOKEN_BYTES` — a
 * shorter or longer body is not an ADB challenge, and the signer would reject it
 * anyway, so it is refused here without a round trip.
 */
export function assertAdbAuthToken(token: Uint8Array): void {
  if (token.byteLength !== ADB_AUTH_TOKEN_BYTES) {
    throw new AdbSignerError(
      "invalid_token",
      400,
      `An ADB auth token is exactly ${ADB_AUTH_TOKEN_BYTES} bytes.`,
    );
  }
}

function boundedField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SIGNED_FIELD_CHARS) return null;
  // Control characters cannot appear in base64 or in an ADB key comment, and are
  // the shape a response-splitting or terminal-escape payload would take.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Accept only the two fields the ADB authenticator consumes, in the shapes it
 * can actually use, and drop everything else the signer may have said. The
 * browser therefore cannot be handed anything from the third party beyond a
 * base64 signature and a public key.
 */
export function parseSignerResponse(value: unknown): AdbSignature {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const signature = boundedField(record?.token)?.replace(/\s+/g, "") ?? null;
  const publicKey = boundedField(record?.public_key);

  if (
    !signature ||
    !publicKey ||
    signature.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
  ) {
    throw new AdbSignerError(
      "invalid_response",
      502,
      "The ADB signing service did not return a usable signature.",
    );
  }
  return { token: signature, public_key: publicKey };
}

/**
 * A small process-local budget. The proxy is session-gated, so this is not the
 * authorization boundary — it exists so one signed-in browser cannot turn Center
 * into a high-volume relay to a third party. A real ADB handshake needs one or
 * two signatures per connection attempt.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  maxTracked: number;
}) {
  const hits = new Map<string, number[]>();

  return function allow(key: string, now: number = Date.now()): boolean {
    const since = now - options.windowMs;
    const recent = (hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= options.max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);

    // Bound the map: drop entries whose whole window has elapsed, then the
    // oldest keys if a burst of distinct callers still leaves it oversized.
    if (hits.size > options.maxTracked) {
      for (const [entry, times] of hits) {
        if (times.length === 0 || times[times.length - 1] <= since) hits.delete(entry);
      }
      while (hits.size > options.maxTracked) {
        const oldest = hits.keys().next();
        if (oldest.done) break;
        hits.delete(oldest.value);
      }
    }
    return true;
  };
}

/**
 * Ask the signer to sign one ADB token.
 *
 * Nothing from the caller's request is forwarded except the 20 token bytes: no
 * headers, no cookies, no origin. `redirect: "error"` keeps a moved endpoint
 * from silently relaying the token somewhere else.
 */
export async function requestAdbSignature(
  token: Uint8Array,
  options: {
    endpoint?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    environment?: SignerEnvironment;
  } = {},
): Promise<AdbSignature> {
  assertAdbAuthToken(token);

  const environment = options.environment ?? process.env;
  const endpoint = options.endpoint ?? signerEndpoint(environment);
  const timeoutMs = options.timeoutMs ?? signerTimeoutMs(environment);
  const call = options.fetchImpl ?? fetch;

  // A fresh ArrayBuffer: `token` may be a view onto a larger read buffer, and
  // handing that straight to fetch would send the surrounding bytes too.
  const body = new ArrayBuffer(token.byteLength);
  new Uint8Array(body).set(token);

  let response: Response;
  try {
    response = await call(endpoint, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", accept: "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Deliberately no cause, no URL echo, no body: this path is reached with the
    // token in scope and must not be a place where it can leak into a log line.
    throw new AdbSignerError(
      "signer_unreachable",
      502,
      "The ADB signing service did not answer, so the Pin could not be authorized.",
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AdbSignerError(
      "signer_rejected",
      502,
      `The ADB signing service answered ${response.status}, so the Pin could not be authorized.`,
    );
  }

  const raw = await readBoundedBytes(response.body, MAX_SIGNER_RESPONSE_BYTES).catch(() => {
    throw new AdbSignerError(
      "invalid_response",
      502,
      "The ADB signing service returned more than a signature.",
    );
  });

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AdbSignerError(
      "invalid_response",
      502,
      "The ADB signing service did not return JSON.",
    );
  }
  return parseSignerResponse(decoded);
}
