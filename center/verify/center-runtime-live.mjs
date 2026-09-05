// Actual production Center image + native Cosmos + isolated PostgreSQL/SFU.
// Authenticated sessions and cognition are synthetic. No real provider or device.
// Node 22 with Playwright available via NODE_PATH:
// COSMOS_TEST_DATABASE_URL=... node --experimental-strip-types center-runtime-live.mjs IMAGE SFU_JSON WEBRTC_DIR
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { cosmosTestEnvironment } = require("../../platform/cli/context.js");
const [image, inputPath, nativeDirectory, providerMode, ...extra] = process.argv.slice(2);
if (!image || !inputPath || !nativeDirectory) throw new Error("Supply Center image, isolated SFU JSON and verified WebRTC directory");
assert(extra.length === 0 && (providerMode === undefined || providerMode === "--openrouter-stdin"), "Optional provider mode is --openrouter-stdin");
let providerConfiguration;
if (providerMode) {
  const bytes = Buffer.alloc(16385); let size = 0;
  while (size < bytes.length) { const read = fs.readSync(0, bytes, size, bytes.length - size, null); if (!read) break; size += read; }
  assert(size > 0 && size <= 16384, "Bounded explicit provider configuration required on stdin");
  providerConfiguration = bytes.subarray(0, size);
  assert.equal(JSON.parse(providerConfiguration).provider, "openrouter-text");
}
const configured = JSON.parse(fs.readFileSync(inputPath, "utf8"));
assert.match(configured.url, /^ws:\/\/127\.0\.0\.1:[0-9]+(?:\/livekit)?$/u);
assert.equal(new URL(process.env.COSMOS_TEST_DATABASE_URL).hostname, "127.0.0.1");
const root = path.resolve(import.meta.dirname, "../..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-center-acceptance-"));
process.stdout.write(`Acceptance fixture: ${directory}\n`);
const container = `revival-center-acceptance-${crypto.randomUUID()}`;
const bootstrapPath = path.join(directory, "bootstrap.json");
const statusPath = path.join(directory, "status.json");
const input = path.join(directory, "input.json");
const logs = fs.openSync(path.join(directory, "native.log"), "w", 0o600);
const certificate = path.join(directory, "loopback.pem");
const privateKey = path.join(directory, "loopback.key");
const tls = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", privateKey, "-out", certificate], { stdio: "ignore" });
assert.equal(tls.status, 0, "Create an ephemeral loopback TLS certificate");
fs.chmodSync(privateKey, 0o600);
let child, browser, centerPort, page;
let stage = "native fixture startup";
const sockets = new Set();
const sfu = new URL(configured.url);
const diagnostics = [];
function recordStatus(request, status) {
  const pathname = new URL(request.url, "https://127.0.0.1").pathname;
  if (diagnostics.length < 128 && (pathname === "/api/runtime/room" || pathname.startsWith("/livekit/"))) {
    diagnostics.push({ path: pathname, status });
  }
}
const gateway = https.createServer({ key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) }, (request, response) => {
  if (request.headers.host !== `127.0.0.1:${gateway.address().port}`) { response.writeHead(400); response.end(); return; }
  const media = request.url.startsWith("/livekit");
  const port = media ? Number(sfu.port) : centerPort;
  if (!port) { response.writeHead(503); response.end(); return; }
  const upstream = http.request({ host: "127.0.0.1", port, method: request.method,
    path: media ? request.url.slice("/livekit".length) || "/" : request.url,
    headers: { ...request.headers, "x-forwarded-host": request.headers.host, "x-forwarded-proto": "https" },
  }, reply => { recordStatus(request, reply.statusCode); response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
gateway.on("upgrade", (request, socket, head) => {
  if (request.headers.host !== `127.0.0.1:${gateway.address().port}` || !request.url.startsWith("/livekit/")) { socket.destroy(); return; }
  const upstream = http.request({ host: "127.0.0.1", port: Number(sfu.port), path: request.url.slice("/livekit".length), headers: request.headers });
  upstream.on("upgrade", (response, remote, remoteHead) => {
    recordStatus(request, response.statusCode);
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(socket); socket.pipe(remote);
    remote.on("error", () => socket.destroy()); socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
  });
  upstream.on("response", response => { recordStatus(request, response.statusCode); response.resume(); socket.destroy(); });
  upstream.on("error", () => socket.destroy()); upstream.end();
});
function docker(args) {
  const result = spawnSync("docker", ["--context", "desktop-linux", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed; inspect fixture logs`);
  return result.stdout.trim();
}
async function until(read, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read(); if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined && child.exitCode !== 0) throw new Error("Native acceptance failed; inspect native.log");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Acceptance stage timed out");
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
try {
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${gateway.address().port}`;
  fs.writeFileSync(input, JSON.stringify({ ...configured, publicUrl: origin.replace("https:", "wss:") + "/livekit", bootstrapPath, statusPath }), { mode: 0o600 });
  child = spawn("cargo", ["test", "--locked", "-p", "cosmos", "browser_center_application_acceptance", "--", "--ignored", "--nocapture", "--test-threads=1"], {
    cwd: path.join(root, "cosmos"), detached: true, env: { ...cosmosTestEnvironment(), LK_CUSTOM_WEBRTC: path.resolve(nativeDirectory),
      COSMOS_TEST_DATABASE_URL: process.env.COSMOS_TEST_DATABASE_URL, COSMOS_CENTER_TEST_INPUT: input,
      ...(providerMode ? { COSMOS_CENTER_TEST_OPENROUTER_STDIN: "1" } : {}) }, stdio: ["pipe", logs, logs],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(providerConfiguration);
  fs.closeSync(logs);
  const native = await until(() => readJson(bootstrapPath), 300000);
  process.env.KEYCLOAK_BASE_URL = `http://host.docker.internal:${native.port}`;
  process.env.AUTH_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
  const { signSession, sealTokens, SESSION_COOKIE, TOKENS_COOKIE } = await import("../src/server/auth.ts");
  const environment = path.join(directory, "center.env");
  fs.writeFileSync(environment, [
    `KEYCLOAK_BASE_URL=${process.env.KEYCLOAK_BASE_URL}`, `AUTH_SESSION_SECRET=${process.env.AUTH_SESSION_SECRET}`,
    `COSMOS_WEBAPI_BASE_URL=http://host.docker.internal:${native.port}`, "REVIVAL_ENVIRONMENT=development",
  ].join("\n") + "\n", { mode: 0o600 });
  docker(["run", "--detach", "--rm", "--name", container, "--env-file", environment, "-p", "127.0.0.1::4000", image]);
  const binding = JSON.parse(docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "4000/tcp")}}', container]));
  centerPort = Number(binding[0].HostPort);
  await until(async () => fetch(`http://127.0.0.1:${centerPort}/api/version`).then(r => r.ok).catch(() => false), 30000);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  // Only this isolated context trusts the disposable loopback certificate.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  const session = await signSession({ sub: native.subject, email: "fixture@example.invalid", name: "Acceptance fixture", operator: false });
  const tokens = await sealTokens({ accessToken: native.bearer.slice("Bearer ".length), refreshToken: "fixture-unused", expiresAt: Math.floor(Date.now() / 1000) + 240 });
  await context.addCookies([{ name: SESSION_COOKIE, value: session, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: TOKENS_COOKIE, value: tokens, url: origin, httpOnly: true, sameSite: "Lax" }]);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  stage = "owner speech permission";
  await page.goto(`${origin}/settings/account/devices`);
  await page.getByRole("button", { name: "Speech provider permission", exact: true }).click();
  await page.getByLabel("Azure Speech region", { exact: true }).fill("westeurope");
  await page.getByRole("button", { name: "Allow shared reply text", exact: true }).click();
  await page.getByText("Cosmos confirmed permission to send shared reply text to Azure Speech.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Revoke speech permission", exact: true }).click();
  await page.getByText("Cosmos confirmed speech provider permission revoked.", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, "speech-permission.png"), fullPage: true });
  stage = "owner local voice permission";
  await page.getByRole("button", { name: "Local voice permission", exact: true }).click();
  await page.getByRole("button", { name: "Allow shared local voice requests", exact: true }).click();
  await page.getByText("Cosmos confirmed local voice permission for shared requests. Microphone integration remains in preview.", { exact: true }).waitFor();
  await page.getByText("Current voice privacy: Shared room.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Revoke local voice permission", exact: true }).click();
  await page.getByText("Cosmos confirmed local voice permission revoked.", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, "local-voice-permission.png"), fullPage: true });
  stage = "browser room admission and render";
  await page.goto(`${origin}/?assistant=open`);
  await page.getByRole("button", { name: "Approve this tab", exact: true }).click();
  await page.getByRole("button", { name: "Confirm shared display", exact: true }).click();
  await page.getByText("Ready for public text requests.", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Ask Cosmos", exact: true }).fill("Display a public text card containing exactly: Center acceptance card");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Cosmos display", { exact: true }).getByText("Center acceptance card", { exact: true }).waitFor();
  await until(() => readJson(statusPath)?.acknowledged, 10000);
  await page.screenshot({ path: path.join(directory, "rendered-card.png"), fullPage: true });
  stage = "durable render clear";
  await page.getByRole("button", { name: "Leave this tab", exact: true }).click();
  await page.getByLabel("Cosmos display", { exact: true }).waitFor({ state: "detached" });
  const result = await until(() => { const status = readJson(statusPath); return status?.complete ? status : null; }, 10000);
  assert.deepEqual(errors, [], "No browser runtime exceptions");
  const exit = await new Promise(resolve => child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve));
  assert.equal(exit, 0);
  process.stdout.write(`PASS: actual Center owner controls, Cosmos routing, SFU, DOM acknowledgment and durable clear; one ${providerMode ? "live OpenRouter" : "synthetic"} model call.\nArtifacts: ${directory}\n`);
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result) + "\n", { mode: 0o600 });
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, "failure.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, "failure.txt"), await page.locator("body").innerText().catch(() => "Page text unavailable"), { mode: 0o600 });
  }
  process.stderr.write(`FAIL: ${stage} (${error.name}).\nArtifacts: ${directory}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    // Cargo may own a running test binary; retire the fixture's whole process group.
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  spawnSync("docker", ["--context", "desktop-linux", "rm", "--force", container], { stdio: "ignore" });
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => gateway.close(resolve));
  fs.writeFileSync(path.join(directory, "transport-status.json"), JSON.stringify(diagnostics) + "\n", { mode: 0o600 });
  for (const file of [input, bootstrapPath, path.join(directory, "center.env"), certificate, privateKey]) fs.rmSync(file, { force: true });
}
