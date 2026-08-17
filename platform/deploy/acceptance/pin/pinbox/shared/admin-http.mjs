// shared/admin-http.mjs — admin HTTP over adb (curl -K stdin config, token
// never in argv). Owns its OWN allowlist because this package needs the log +
// activity + dev-dispatch endpoints the release smoke deliberately excludes.
// All paths are allowlisted so a typo cannot reach an arbitrary endpoint.

import { requireSerial, runAdb } from "./adb.mjs";

export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

export const PROBE_API_PATHS = new Set([
  "/api/logs/server",
  "/api/logs/logcat",
  "/api/activity/prompts",
  "/api/activity/music",
  "/api/dev/stock-action-test",
]);

const HTTP_STATUS_MARKER = "\n__PENUMBRA_PROBE_HTTP__:";

// A query string is not a different endpoint. Matching the allowlist against
// the WHOLE request string refused every real call probe makes — every one of
// them is parameterised (`/api/activity/prompts?limit=100`,
// `/api/logs/server?lines=4000`) — so probe silently lost its independent
// activity cross-check AND its only fallback evidence source when the logcat
// window is empty. Measured: 235 run dirs on disk, zero server.log files, and
// `activityBeforeError: "refusing a non-allowlisted endpoint:
// /api/activity/prompts?limit=100"` in every summary.json.
//
// The allowlist itself is NOT widened. Only the match now ignores the query —
// and because the query is no longer covered by the exact-match check, it gets
// its own charset guard: the full path is interpolated into a quoted curl
// config line, so a `"`, a newline, or whitespace would be a config-injection.
const SAFE_QUERY_CHARS = /^[A-Za-z0-9_.~!*'()\-=&%+,:@/]*$/;

export function assertAllowlistedPath(requestPath) {
  if (typeof requestPath !== "string" || requestPath.length === 0) {
    throw new Error("refusing a non-allowlisted endpoint: (empty)");
  }
  if (requestPath.includes("#")) {
    throw new Error(`refusing a non-allowlisted endpoint: ${requestPath}`);
  }
  const queryStart = requestPath.indexOf("?");
  const basePath = queryStart < 0 ? requestPath : requestPath.slice(0, queryStart);
  const query = queryStart < 0 ? "" : requestPath.slice(queryStart + 1);
  if (!PROBE_API_PATHS.has(basePath)) {
    throw new Error(`refusing a non-allowlisted endpoint: ${basePath}`);
  }
  if (!SAFE_QUERY_CHARS.test(query)) {
    throw new Error(`refusing an unsafe query string on ${basePath}`);
  }
  return basePath;
}

function probeCurlConfig(method, path, token, maxSeconds, { hasDataFile = false } = {}) {
  assertAllowlistedPath(path);
  const lines = [
    `url = "http://127.0.0.1:8080${path}"`,
    `request = "${method}"`,
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/json"',
    'header = "User-Agent: pinbox/1"',
    "silent",
    "show-error",
    "connect-timeout = 5",
    `max-time = ${Math.max(1, Math.min(60, Math.floor(maxSeconds)))}`,
    'noproxy = "*"',
    'proto = "=http"',
    'write-out = "\\n__PENUMBRA_PROBE_HTTP__:%{http_code}\\n"',
  ];
  if (hasDataFile) lines.push('data-binary = "@/data/local/tmp/pinbox-body.json"');
  return Buffer.from([...lines, ""].join("\n"), "utf8");
}

// Core transport. GET has no body (stdin carries the curl config). POST stages
// the body at a fixed device path (never argv) and cleans up after.
async function deviceRequest(options, token, method, path, { maxSeconds = 30, body = null, spawn } = {}) {
  requireSerial(options);
  let hasDataFile = false;
  if (body !== null) {
    if (method !== "POST") throw new Error("a body requires POST");
    hasDataFile = true;
    await runAdb(options, ["push", "/dev/stdin", "/data/local/tmp/pinbox-body.json"], {
      input: Buffer.isBuffer(body) ? body : Buffer.from(body),
      timeoutMs: 10_000, maxStdoutBytes: 1_024,
    }, "the dispatch body could not be staged on the device", spawn);
  }
  const output = await runAdb(
    options,
    ["shell", "exec curl -q -K -"],
    {
      input: probeCurlConfig(method, path, token, maxSeconds, { hasDataFile }),
      timeoutMs: maxSeconds * 1000 + 10_000,
      maxStdoutBytes: 8 * 1024 * 1024,
    },
    "the device admin request failed",
    spawn,
  );
  if (hasDataFile) {
    await runAdb(options, ["shell", "rm", "-f", "/data/local/tmp/pinbox-body.json"], {
      timeoutMs: 5_000, maxStdoutBytes: 1_024,
    }, "the staged dispatch body could not be removed", spawn).catch(() => {});
  }
  const marker = Buffer.from(HTTP_STATUS_MARKER, "utf8");
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("the device admin response had no HTTP status");
  const statusText = output.subarray(markerIndex + marker.length).toString("ascii").trim();
  if (!/^[0-9]{3}$/.test(statusText)) throw new Error("the device admin response had an invalid HTTP status");
  const bodyBytes = output.subarray(0, markerIndex);
  if (bodyBytes.length > MAX_HTTP_BODY_BYTES) throw new Error("a device admin response was too large");
  return { status: Number(statusText), body: bodyBytes };
}

export async function deviceTextGet(options, token, path, { maxSeconds = 30, spawn } = {}) {
  const { status, body } = await deviceRequest(options, token, "GET", path, { maxSeconds, spawn });
  if (status !== 200) throw new Error(`GET ${path} returned HTTP ${status}`);
  return body;
}

export async function deviceJsonGet(options, token, path, { maxSeconds = 30, spawn } = {}) {
  const { status, body } = await deviceRequest(options, token, "GET", path, { maxSeconds, spawn });
  if (status !== 200) throw new Error(`GET ${path} returned HTTP ${status}`);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`GET ${path} returned a non-JSON body`);
  }
}

export async function deviceJsonPost(options, token, path, payload, { maxSeconds = 30, spawn } = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const { status, body: resp } = await deviceRequest(options, token, "POST", path, { maxSeconds, body, spawn });
  if (status !== 200) throw new Error(`POST ${path} returned HTTP ${status}`);
  try {
    return JSON.parse(resp.toString("utf8"));
  } catch {
    return { raw: resp.toString("utf8") };
  }
}
