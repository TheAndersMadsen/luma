import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { LIVENESS_PATH, READINESS_PATH, probeContract } from "./probes.mjs";

const MAX_AUTHORIZATION_BYTES = 1_024;
const MAX_SETTINGS_BODY_BYTES = 1_024;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const MAX_PIN_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_PIN_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PIN_QUERY_BYTES = 2 * 1024;
const PIN_REMOTE_PREFIX = "/api/pin-remote";
const STATUS_STATES = new Set([
  "disabled",
  "not_configured",
  "pairing",
  "ready",
  "error",
]);

const SEARCH_PATH = "/api/spotify/search";
const MAX_SEARCH_QUERY_BYTES = 512;
const MAX_SEARCH_QUERY_CHARACTERS = 80;
const MAX_SEARCH_ITEMS = 10;
const SEARCH_KINDS = new Set(["track"]);

/*
 * Every request shape this adapter will forward, and nothing else.
 *
 * `query` is on each entry rather than implied, because until search existed
 * the rule was simply "a URL containing ? is not a route" — one line in the
 * handler that covered all five entries. Search is the first path that needs a
 * query string, and stating the rule per route keeps the other four exactly as
 * strict as they were instead of loosening the check for all of them.
 */
const ROUTES = new Map([
  ["GET /api/spotify/status", { kind: "status", maxBodyBytes: 0, query: "forbidden" }],
  [
    "PUT /api/spotify/settings",
    { kind: "settings", maxBodyBytes: MAX_SETTINGS_BODY_BYTES, query: "forbidden" },
  ],
  ["POST /api/spotify/pairing/start", { kind: "status", maxBodyBytes: 0, query: "forbidden" }],
  ["POST /api/spotify/pairing/cancel", { kind: "status", maxBodyBytes: 0, query: "forbidden" }],
  ["DELETE /api/spotify/session", { kind: "disconnect", maxBodyBytes: 0, query: "forbidden" }],
  [`GET ${SEARCH_PATH}`, { kind: "search", maxBodyBytes: 0, query: "search" }],
]);

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

class UpstreamError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function jsonHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...jsonHeaders(),
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}

function sendBytes(response, status, body, contentType) {
  response.writeHead(status, {
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function authorizationHeaderCount(request) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") count += 1;
  }
  return count;
}

function bearerToken(request) {
  if (authorizationHeaderCount(request) !== 1) return null;
  const header = request.headers.authorization;
  if (
    typeof header !== "string" ||
    Buffer.byteLength(header, "utf8") > MAX_AUTHORIZATION_BYTES
  ) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

export function verifyBearerToken(request, expectedTokenDigest) {
  const token = bearerToken(request);
  if (!token) return false;
  const presentedDigest = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedTokenDigest);
}

async function readBoundedRequestBody(request, maximumBytes) {
  if (maximumBytes === 0 && request.headers["transfer-encoding"] !== undefined) {
    request.resume();
    throw new RequestError(413, "request_too_large");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      request.resume();
      throw new RequestError(400, "invalid_content_length");
    }
    if (Number(contentLength) > maximumBytes) {
      request.resume();
      throw new RequestError(413, "request_too_large");
    }
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      request.resume();
      throw new RequestError(413, "request_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function exactSettingsBody(body, contentType) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? "")) {
    throw new RequestError(415, "json_required");
  }

  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "invalid_settings");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["device_name", "enabled", "experimental_acknowledged"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new RequestError(400, "invalid_settings");
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.experimental_acknowledged !== "boolean" ||
    typeof value.device_name !== "string"
  ) {
    throw new RequestError(400, "invalid_settings");
  }

  const trimmedName = value.device_name.trim();
  if (
    trimmedName.length === 0 ||
    [...trimmedName].length > 48 ||
    /[\p{Cc}]/u.test(trimmedName)
  ) {
    throw new RequestError(400, "invalid_settings");
  }

  return Buffer.from(
    JSON.stringify({
      enabled: value.enabled,
      experimental_acknowledged: value.experimental_acknowledged,
      device_name: trimmedName,
    }),
    "utf8",
  );
}

async function readBoundedResponseBody(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new UpstreamError("response_too_large");
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new UpstreamError("response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function boundedString(value, maximumCharacters) {
  return typeof value === "string" &&
    [...value].length <= maximumCharacters &&
    !/[\p{Cc}]/u.test(value)
    ? value
    : undefined;
}

function projectStatus(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new UpstreamError("invalid_response");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UpstreamError("invalid_response");
  }

  const deviceName = boundedString(value.device_name, 48);
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.experimental_acknowledged !== "boolean" ||
    typeof value.engine_ready !== "boolean" ||
    !STATUS_STATES.has(value.state) ||
    deviceName === undefined
  ) {
    throw new UpstreamError("invalid_response");
  }

  const projected = {
    enabled: value.enabled,
    experimental_acknowledged: value.experimental_acknowledged,
    state: value.state,
    device_name: deviceName,
    engine_ready: value.engine_ready,
  };
  const username = boundedString(value.username, 128);
  if (username !== undefined) projected.username = username;
  if (Number.isSafeInteger(value.pairing_expires_at)) {
    projected.pairing_expires_at = value.pairing_expires_at;
  }
  const lastError = boundedString(value.last_error, 256);
  if (lastError !== undefined) projected.last_error = lastError;
  return projected;
}

/**
 * Rebuild the search query from scratch instead of forwarding the caller's.
 *
 * The Pin's `/api/spotify/search` reads `q` and `kind` out of a HashMap and
 * ignores everything else, so passing the raw string through would be
 * *functionally* fine — and would also make this adapter the one place in the
 * chain where an attacker-chosen query string reaches the device verbatim.
 * Parsing the two parameters, bounding them, and re-encoding them means the URL
 * that leaves here is built from values this function validated, and no third
 * parameter, repeated key, or encoded path segment can ride along.
 *
 * `kind` is checked against the one value the Pin's search actually implements
 * (`SpotifySearchKind` is the single-member union "track") so a future kind has
 * to be allowed here deliberately.
 */
function canonicalSearchPath(rawQuery) {
  if (Buffer.byteLength(rawQuery, "utf8") > MAX_SEARCH_QUERY_BYTES) {
    throw new RequestError(414, "invalid_search");
  }
  const params = new URLSearchParams(rawQuery);
  for (const key of params.keys()) {
    if (key !== "q" && key !== "kind") throw new RequestError(400, "invalid_search");
  }
  if (params.getAll("q").length !== 1 || params.getAll("kind").length > 1) {
    throw new RequestError(400, "invalid_search");
  }

  const query = params.get("q").trim();
  const kind = params.get("kind") ?? "track";
  if (
    query.length === 0 ||
    [...query].length > MAX_SEARCH_QUERY_CHARACTERS ||
    /[\p{Cc}]/u.test(query) ||
    !SEARCH_KINDS.has(kind)
  ) {
    throw new RequestError(400, "invalid_search");
  }
  return `${SEARCH_PATH}?${new URLSearchParams({ q: query, kind }).toString()}`;
}

/**
 * Allowlist the track fields Center renders; anything else the Pin sends is
 * dropped. Same posture as `projectStatus` — a new upstream field cannot become
 * a new field on Center's wire without being added here on purpose.
 */
/**
 * `boundedString` deliberately preserves whitespace — `projectStatus` uses it
 * for a device name the wearer typed. Track text is different: it is display
 * copy the Pin got from Spotify, and a value that is only whitespace is not a
 * title. Trimming here is what makes "non-empty" mean something.
 */
function trimmedBoundedString(value, maximumCharacters) {
  const bounded = boundedString(value, maximumCharacters);
  return bounded === undefined ? undefined : bounded.trim() || undefined;
}

function projectSearch(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new UpstreamError("invalid_response");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UpstreamError("invalid_response");
  }
  if (!Array.isArray(value.items)) throw new UpstreamError("invalid_response");

  const items = [];
  for (const candidate of value.items.slice(0, MAX_SEARCH_ITEMS)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const id = trimmedBoundedString(candidate.id, 128);
    const title = trimmedBoundedString(candidate.title, 200);
    if (!id || !title) continue;

    const projected = {
      id,
      title,
      artists: (Array.isArray(candidate.artists) ? candidate.artists : [])
        .slice(0, 8)
        .map((artist) => trimmedBoundedString(artist, 200))
        .filter((artist) => Boolean(artist)),
    };
    const album = trimmedBoundedString(candidate.album, 200);
    if (album) projected.album = album;
    if (Number.isSafeInteger(candidate.duration_ms) && candidate.duration_ms >= 0) {
      projected.duration_ms = candidate.duration_ms;
    }
    if (typeof candidate.explicit === "boolean") projected.explicit = candidate.explicit;
    items.push(projected);
  }
  return { items };
}

function safeUpstreamFailure(status) {
  if ([400, 401, 403, 404, 409, 422, 429].includes(status)) {
    return { status, code: "pin_rejected_spotify_request" };
  }
  return { status: 502, code: "pin_spotify_unavailable" };
}

async function withUpstream(fetchImpl, upstreamOrigin, path, options, timeoutMs, consume) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(`${upstreamOrigin}${path}`, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
    });
    return await consume(response);
  } catch (error) {
    if (timedOut) throw new UpstreamError("upstream_timeout");
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUpstream(fetchImpl, upstreamOrigin, timeoutMs) {
  try {
    return await withUpstream(
      fetchImpl,
      upstreamOrigin,
      "/api/spotify/status",
      { method: "GET", headers: { Accept: "application/json" } },
      timeoutMs,
      async (upstream) => {
        await upstream.body?.cancel();
        return upstream.status === 200;
      },
    );
  } catch {
    return false;
  }
}

function inNamespace(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The authenticated Center route may reach the wearer-facing Pin API through
 * this adapter. Maintenance namespaces stay absent here even though the
 * compatibility Iroh bridge could otherwise proxy most of `/api`: installing
 * software, reading logs, and changing cellular/eSIM/Wi-Fi state still require
 * the physical WebUSB session.
 */
function pinRemotePolicy(method, pathname, rawQuery, contentType, bodyBytes) {
  if (
    !pathname.startsWith("/api/") ||
    pathname.includes("//") ||
    pathname.includes("\\") ||
    /%(?:2f|5c|2e)/iu.test(pathname) ||
    Buffer.byteLength(rawQuery, "utf8") > MAX_PIN_QUERY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(rawQuery)
  ) {
    return false;
  }

  const exact = new Map([
    ["/api/health", new Set(["GET"])],
    ["/api/device", new Set(["GET"])],
    ["/api/settings", new Set(["GET", "PUT"])],
    ["/api/feature-flags", new Set(["GET", "PUT"])],
  ]);
  const namespaces = new Map([
    ["/api/memories", new Set(["GET", "DELETE"])],
    ["/api/conversations", new Set(["GET"])],
    ["/api/activity", new Set(["GET", "DELETE"])],
    ["/api/fitness", new Set(["GET", "POST", "DELETE"])],
    ["/api/contacts", new Set(["GET", "POST", "PUT", "DELETE"])],
    ["/api/codex", new Set(["GET", "POST"])],
    ["/api/spotify", new Set(["GET", "POST", "PUT", "DELETE"])],
  ]);

  const methods =
    exact.get(pathname) ??
    [...namespaces].find(([prefix]) => inNamespace(pathname, prefix))?.[1];
  if (!methods?.has(method)) return false;
  if (rawQuery && method !== "GET") return false;
  if ((method === "GET" || method === "DELETE") && bodyBytes !== 0) return false;
  if (bodyBytes > MAX_PIN_REQUEST_BODY_BYTES) return false;
  if (bodyBytes > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType ?? "")) {
    return false;
  }
  return true;
}

function pinRemoteTarget(pathname, rawQuery) {
  if (pathname !== PIN_REMOTE_PREFIX && !pathname.startsWith(`${PIN_REMOTE_PREFIX}/`)) {
    return null;
  }
  const targetPath = pathname.slice(PIN_REMOTE_PREFIX.length);
  if (!targetPath) throw new RequestError(404, "not_found");
  return `${targetPath}${rawQuery ? `?${rawQuery}` : ""}`;
}

async function proxyPinRemote(
  request,
  response,
  target,
  body,
  fetchImpl,
  upstreamOrigin,
  timeoutMs,
) {
  const headers = { Accept: "*/*" };
  if (body.length > 0) headers["Content-Type"] = request.headers["content-type"];

  let result;
  try {
    result = await withUpstream(
      fetchImpl,
      upstreamOrigin,
      target,
      {
        method: request.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      },
      timeoutMs,
      async (upstream) => ({
        status: upstream.status,
        contentType: upstream.headers.get("content-type"),
        body: await readBoundedResponseBody(upstream, MAX_PIN_RESPONSE_BODY_BYTES),
      }),
    );
  } catch (error) {
    const code = error instanceof UpstreamError ? error.code : "upstream_unavailable";
    sendJson(response, code === "upstream_timeout" ? 504 : 502, {
      error: code === "upstream_timeout" ? code : "pin_unavailable",
    });
    return;
  }

  // The bridge may include relay/dial detail in a 5xx body. Keep that on the
  // host and give Center one stable failure shape instead.
  if (result.status >= 500) {
    sendJson(response, 502, { error: "pin_unavailable" });
    return;
  }
  sendBytes(response, result.status, result.body, result.contentType);
}

async function proxy(
  request,
  response,
  route,
  upstreamPath,
  body,
  fetchImpl,
  upstreamOrigin,
  timeoutMs,
) {
  let upstreamBody;
  const headers = { Accept: "application/json" };
  if (route.kind === "settings") {
    upstreamBody = exactSettingsBody(body, request.headers["content-type"]);
    headers["Content-Type"] = "application/json";
  }

  let result;
  try {
    result = await withUpstream(
      fetchImpl,
      upstreamOrigin,
      upstreamPath,
      {
        method: request.method,
        headers,
        ...(upstreamBody ? { body: upstreamBody } : {}),
      },
      timeoutMs,
      async (upstream) => ({
        status: upstream.status,
        body: await readBoundedResponseBody(upstream, MAX_UPSTREAM_RESPONSE_BYTES),
      }),
    );
  } catch (error) {
    const code = error instanceof UpstreamError ? error.code : "upstream_unavailable";
    if (code === "upstream_timeout") {
      sendJson(response, 504, { error: code });
    } else if (code === "upstream_unavailable") {
      sendJson(response, 502, { error: code });
    } else {
      sendJson(response, 502, { error: "invalid_upstream_response" });
    }
    return;
  }

  if (result.status < 200 || result.status >= 300) {
    const failure = safeUpstreamFailure(result.status);
    sendJson(response, failure.status, { error: failure.code });
    return;
  }

  if (route.kind === "disconnect") {
    if (result.status !== 204) {
      sendJson(response, 502, { error: "invalid_upstream_response" });
      return;
    }
    sendNoContent(response);
    return;
  }

  if (result.status !== 200) {
    sendJson(response, 502, { error: "invalid_upstream_response" });
    return;
  }
  try {
    sendJson(
      response,
      200,
      route.kind === "search" ? projectSearch(result.body) : projectStatus(result.body),
    );
  } catch {
    sendJson(response, 502, { error: "invalid_upstream_response" });
  }
}

export function createAdapterServer(config, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      requestTimeout: Math.max(config.timeoutMs * 2, 10_000),
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    },
    async (request, response) => {
      try {
        if (request.url === LIVENESS_PATH && request.method === "GET") {
          const body = await readBoundedRequestBody(request, 0);
          if (body.length !== 0) throw new RequestError(413, "request_too_large");
          sendJson(response, 200, { adapter: "ready" });
          return;
        }

        if (request.url === READINESS_PATH && request.method === "GET") {
          const body = await readBoundedRequestBody(request, 0);
          if (body.length !== 0) throw new RequestError(413, "request_too_large");
          const upstreamReady = await checkUpstream(
            fetchImpl,
            config.upstreamOrigin,
            config.timeoutMs,
          );
          sendJson(response, upstreamReady ? 200 : 503, {
            adapter: "ready",
            upstream: upstreamReady ? "ready" : "unavailable",
          });
          return;
        }

        if (typeof request.url !== "string") throw new RequestError(404, "not_found");
        const separator = request.url.indexOf("?");
        const pathname = separator === -1 ? request.url : request.url.slice(0, separator);
        const rawQuery = separator === -1 ? "" : request.url.slice(separator + 1);

        const pinTarget = pinRemoteTarget(pathname, rawQuery);
        if (pinTarget !== null) {
          if (!verifyBearerToken(request, config.expectedTokenDigest)) {
            response.setHeader("WWW-Authenticate", 'Bearer realm="pin-adapter"');
            throw new RequestError(401, "unauthorized");
          }
          const declaredLength = Number(request.headers["content-length"] ?? "0");
          if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
            throw new RequestError(400, "invalid_content_length");
          }
          if (declaredLength > MAX_PIN_REQUEST_BODY_BYTES) {
            request.resume();
            throw new RequestError(413, "request_too_large");
          }
          if (
            !pinRemotePolicy(
              request.method,
              pinTarget.split("?", 1)[0],
              rawQuery,
              request.headers["content-type"],
              declaredLength,
            )
          ) {
            throw new RequestError(404, "not_found");
          }
          const body = await readBoundedRequestBody(request, MAX_PIN_REQUEST_BODY_BYTES);
          if (
            !pinRemotePolicy(
              request.method,
              pinTarget.split("?", 1)[0],
              rawQuery,
              request.headers["content-type"],
              body.length,
            )
          ) {
            throw new RequestError(404, "not_found");
          }
          await proxyPinRemote(
            request,
            response,
            pinTarget,
            body,
            fetchImpl,
            config.upstreamOrigin,
            config.timeoutMs,
          );
          return;
        }

        const route = ROUTES.get(`${request.method} ${pathname}`);
        if (!route) throw new RequestError(404, "not_found");
        // A query string on a route that does not take one is not a variant of
        // that route; it is a different request, and it stays a 404 exactly as
        // it did when the check was unconditional.
        if (route.query !== "search" && rawQuery !== "") {
          throw new RequestError(404, "not_found");
        }
        if (!verifyBearerToken(request, config.expectedTokenDigest)) {
          response.setHeader("WWW-Authenticate", 'Bearer realm="spotify-adapter"');
          throw new RequestError(401, "unauthorized");
        }

        // After authentication, so an unauthenticated caller cannot use the
        // validation responses to probe what a valid search looks like.
        const upstreamPath =
          route.query === "search" ? canonicalSearchPath(rawQuery) : pathname;
        const body = await readBoundedRequestBody(request, route.maxBodyBytes);
        await proxy(
          request,
          response,
          route,
          upstreamPath,
          body,
          fetchImpl,
          config.upstreamOrigin,
          config.timeoutMs,
        );
      } catch (error) {
        if (response.headersSent) {
          response.end();
          return;
        }
        if (error instanceof RequestError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        sendJson(response, 500, { error: "adapter_error" });
      }
    },
  );
  server.maxHeadersCount = 32;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

export const adapterContract = Object.freeze({
  probes: probeContract,
  routes: [...ROUTES.keys()],
  maxSettingsBodyBytes: MAX_SETTINGS_BODY_BYTES,
  maxUpstreamResponseBytes: MAX_UPSTREAM_RESPONSE_BYTES,
  maxSearchQueryCharacters: MAX_SEARCH_QUERY_CHARACTERS,
  maxSearchItems: MAX_SEARCH_ITEMS,
  searchKinds: [...SEARCH_KINDS],
  pinRemotePrefix: PIN_REMOTE_PREFIX,
  maxPinRequestBodyBytes: MAX_PIN_REQUEST_BODY_BYTES,
  maxPinResponseBodyBytes: MAX_PIN_RESPONSE_BODY_BYTES,
});
