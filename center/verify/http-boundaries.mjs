#!/usr/bin/env -S bun --no-env-file
// Real HTTP through a built Center, using a disposable Cosmos fixture and synthetic cookies.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { operatorEnvironment, resolveTool } = require("../../platform/cli/context.js");
const [image, output] = process.argv.slice(2);
assert.ok(image && output && process.argv.length === 4,
  "usage: bun center/verify/http-boundaries.mjs IMAGE EXTERNAL_REPORT.json");
const reportPath = path.resolve(output);
const root = path.resolve(import.meta.dirname, "../..");
assert.ok(!reportPath.startsWith(`${root}${path.sep}`), "evidence belongs outside the checkout");

process.env.AUTH_SESSION_SECRET = randomBytes(32).toString("hex");
process.env.KEYCLOAK_BASE_URL = "http://cosmos-fixture:8000";
const auth = await import("../src/server/auth.ts");
const cookie = [
  `${auth.SESSION_COOKIE}=${await auth.signSession({ sub: "synthetic-wearer", email: "wearer@example.test", name: "Synthetic Wearer", operator: false })}`,
  `${auth.TOKENS_COOKIE}=${await auth.sealTokens({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Math.floor(Date.now() / 1000) + 3600 })}`,
].join("; ");

const environment = { ...operatorEnvironment(), AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET };
const docker = resolveTool("docker");
const run = (...args) => execFileSync(docker, args, { encoding: "utf8", env: environment, timeout: 30000 }).trim();
const network = `luma-boundaries-${randomUUID()}`;
const fixture = `${network}-cosmos`;
const center = `${network}-center`;
const report = { image, imageId: run("image", "inspect", image, "--format", "{{.Id}}"), checks: [] };

function fixtureServer() {
  let mode = "ok";
  let requests = [];
  let payload;
  const note = { uuid: "synthetic-note", createdAt: 1725000000, modifiedAt: 1725000100,
    hasLocation: false, sealed: false, title: "Weekend", text: "Not wearer data." };
  Bun.serve({ hostname: "0.0.0.0", port: 8000, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__control") {
      const control = await request.json();
      mode = control.mode;
      payload = control.payload;
      requests = [];
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__requests") return Response.json(requests);
    const body = request.method === "POST" ? await request.json() : undefined;
    const authenticated = request.headers.get("authorization") === "Bearer synthetic-access";
    requests.push({ path: url.pathname + url.search, method: request.method, authenticated, body });
    if (!authenticated) return new Response(null, { status: 401 });
    if (mode === "payload") return Response.json(payload);
    if (/^status-\d+$/.test(mode)) return new Response("Synthetic refusal", { status: Number(mode.slice(7)) });
    if (mode === "invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
    if (request.method === "DELETE") return Response.json(mode === "invalid-delete" ? {} : { deleted: false });
    if (url.pathname === "/capture/memories") return Response.json({
      photos: [], notes: [], aiSessions: mode === "partial" ? null : [], playTrackEvents: [], phoneCalls: [], health: [],
    });
    if (url.pathname === "/capture/notes") return Response.json({
      content: [note], number: Number(url.searchParams.get("page")), size: Number(url.searchParams.get("size")),
      totalElements: 340, totalPages: 6, first: false, last: false, numberOfElements: 1, empty: false,
    });
    if (url.pathname.startsWith("/capture/note/")) return Response.json({ ...note, ...body });
    if (url.pathname === "/account-service/profile") return Response.json({ ...body, hasSecureBioData: false });
    if (url.pathname.endsWith("/feedback")) return Response.json({ vote: body.vote });
    return new Response(null, { status: 404 });
  } });
}

try {
  run("network", "create", network);
  run("run", "--detach", "--rm", "--name", fixture, "--network", network, "--network-alias", "cosmos-fixture",
    "--publish", "127.0.0.1::8000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--entrypoint", "bun", image, "--no-env-file", "-e", `(${fixtureServer.toString()})()`);
  run("run", "--detach", "--rm", "--name", center, "--network", network, "--publish", "127.0.0.1::4000",
    "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/app/center/.next/cache:uid=1000,gid=1000,mode=0700",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "256", "--memory", "1g",
    "--env", "AUTH_SESSION_SECRET", "--env", "KEYCLOAK_BASE_URL=http://cosmos-fixture:8000",
    "--env", "COSMOS_WEBAPI_BASE_URL=http://cosmos-fixture:8000", "--env", "LUMA_ENVIRONMENT=production", image);
  const origin = `http://127.0.0.1:${run("port", center, "4000/tcp").split(":").at(-1)}`;
  const control = `http://127.0.0.1:${run("port", fixture, "8000/tcp").split(":").at(-1)}`;
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      if ((await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    assert.ok(Date.now() < deadline, "Center did not become ready");
    await new Promise((done) => setTimeout(done, 100));
  }
  const mode = async (value, payload) => {
    const response = await fetch(`${control}/__control`, { method: "POST", body: JSON.stringify({ mode: value, payload }) });
    assert.equal(response.status, 200);
  };
  const observed = () => fetch(`${control}/__requests`).then((response) => response.json());
  const request = (route, { method = "GET", body, headers = {} } = {}) => fetch(`${origin}${route}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
    headers: { cookie, origin, "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(10000),
  });
  const check = (name) => report.checks.push(name);

  await mode("ok");
  let response = await request("/api/capture/notes?page=2&size=60&query=Milk");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-data-state"), "live");
  let body = await response.json();
  assert.equal(body.totalElements, 340);
  assert.equal(body.number, 2);
  assert.equal(body.content[0].text, "Not wearer data.");
  assert.deepEqual(await observed(), [{ path: "/capture/notes?page=2&size=60&query=Milk", method: "GET", authenticated: true }]);
  check("notes preserve pagination, search, data, and wearer bearer over HTTP");

  response = await request("/api/capture/note/create", { method: "POST", body: { text: "Keep My Casing", title: "Weekend" } });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.note.text, "Keep My Casing");
  check("note creation returns exactly the stored content");

  for (const [upstream, expected] of [[404, 404], [413, 413], [500, 502], [401, 401]]) {
    await mode(`status-${upstream}`);
    response = await request("/api/capture/note/synthetic-note", { method: "POST", body: { text: "Edit" } });
    assert.equal(response.status, expected);
    body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.tooLong, upstream === 413 ? true : undefined);
    assert.equal(body.reauthenticate, upstream === 401 ? true : undefined);
    assert.equal(body.refusal, undefined, "internal refusal reasons stay off the wire");
    check(`note refusal ${upstream} remains HTTP ${expected}`);
  }
  await mode("status-404");
  response = await request("/api/capture/note/synthetic-note");
  assert.equal(response.headers.get("x-data-state"), "live");
  assert.equal(await response.json(), null);
  check("missing note differs from an unread note");

  for (const [upstream, expected] of [[400, 400], [413, 413], [500, 502]]) {
    await mode(`status-${upstream}`);
    response = await request("/api/account/details", { method: "POST", body: { preferredName: "Ada", pronunciation: "" } });
    assert.equal(response.status, expected);
    assert.equal((await response.json()).ok, false);
    check(`account refusal ${upstream} remains HTTP ${expected}`);
  }
  await mode("status-404");
  response = await request("/api/notable-events/mydata/synthetic-event/feedback", { method: "POST", body: { vote: "up" } });
  assert.equal(response.status, 404);
  check("feedback on a missing event remains a 404");

  await mode("status-409");
  response = await request("/api/devices/pair", { method: "POST", body: { device_id: "abcdef12" } });
  assert.equal(response.status, 409);
  check("pairing conflicts remain a 409");
  response = await request("/api/settings/privacy/account", { method: "DELETE", body: { confirm: "DELETE" } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).deleted, false);
  check("a blocked Pin still prevents account deletion");

  await mode("partial");
  response = await request("/api/capture/memories");
  body = await response.json();
  assert.equal(response.headers.get("x-data-state"), "degraded");
  assert.equal(body.provenance.aiMic.state, "degraded");
  assert.equal(body.provenance.notes.state, "live");
  assert.deepEqual(body.notes, []);
  check("partial dashboard outage preserves each part's provenance");

  await mode("invalid-json");
  response = await request("/api/capture/note/create", { method: "POST", body: { text: "Edit" } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).ok, false);
  check("invalid upstream JSON cannot report a saved note");

  await mode("invalid-delete");
  response = await request("/api/capture/notes", { method: "DELETE" });
  assert.equal(response.status, 502);
  body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.deleted, false);
  check("an unconfirmed delete cannot report success");

  await mode("ok");
  response = await request("/api/capture/note/create", { method: "POST", body: { text: "Edit" }, headers: { origin: "https://other.example.test" } });
  assert.equal(response.status, 403);
  assert.deepEqual(await observed(), []);
  check("cross-site writes stop before Cosmos");
  response = await request("/api/capture/notes", { headers: { cookie: "" } });
  assert.equal(response.status, 401);
  assert.deepEqual(await observed(), []);
  check("anonymous reads stop before Cosmos");

  const malformed = [
    { name: "note save", route: "/api/capture/note/create", method: "POST", input: { text: "Edit" }, payload: {}, status: 502 },
    { name: "note read", route: "/api/capture/note/synthetic-note", payload: { uuid: 42 }, state: "degraded" },
    { name: "note page", route: "/api/capture/notes", payload: { content: [], totalElements: "340" }, state: "degraded" },
    { name: "profile write", route: "/api/account/details", method: "POST", input: { preferredName: "Ada", pronunciation: "" }, payload: { preferredName: "Ada", pronunciation: "", hasSecureBioData: "false" }, status: 502 },
    { name: "food preferences write", route: "/api/account/food-preferences", method: "POST", input: { restrictions: [] }, payload: { restrictions: [], dailyIntakeGoals: "bad" }, status: 502 },
    { name: "passcode write", route: "/api/account/passcode", method: "PUT", input: { passcode: "4821" }, payload: { set: "true" }, status: 502 },
    { name: "event vote", route: "/api/notable-events/mydata/synthetic-event/feedback", method: "POST", input: { vote: "up" }, payload: { vote: "unrecognized" }, status: 502 },
    { name: "event page", route: "/api/notable-events/mydata?domain=AI_MIC", payload: { content: [null] }, state: "degraded" },
    { name: "capture page", route: "/api/capture/captures", payload: { content: [null] }, state: "degraded" },
    { name: "pairing", route: "/api/devices/pair", method: "POST", input: { device_id: "abcdef12" }, payload: { deviceId: "abcdef12", paired: "true" }, status: 502 },
  ];
  const failures = [];
  for (const sample of malformed) {
    await mode("payload", sample.payload);
    response = await request(sample.route, { method: sample.method, body: sample.input });
    try {
      if (sample.status) assert.equal(response.status, sample.status);
      if (sample.state) assert.equal(response.headers.get("x-data-state"), sample.state);
      const text = await response.text();
      assert.ok(!text.includes('"ok":true'), "malformed responses never report success");
      check(`${sample.name} rejects malformed success payloads`);
    } catch (error) {
      failures.push(`${sample.name}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, [], "every successful response must satisfy its contract");

  const pageOf = (content) => ({ content, number: 0, size: 50, totalElements: content.length,
    totalPages: content.length ? 1 : 0, first: true, last: true, numberOfElements: content.length, empty: content.length === 0 });
  const sealedNote = { uuid: "sealed-note", createdAt: 1725000000, hasLocation: false, sealed: true };
  await mode("payload", { ...pageOf([sealedNote]), pageable: { offset: 0 }, futureField: "additive" });
  response = await request("/api/capture/notes");
  body = await response.json();
  assert.equal(response.headers.get("x-data-state"), "live");
  assert.equal(body.content[0].sealed, true);
  assert.deepEqual(body.pageable, { offset: 0 });
  check("sealed notes and additive pagination metadata remain readable");

  for (const domain of ["AI_MIC", "MUSIC", "CALL", "TRANSLATION"]) {
    await mode("payload", pageOf([{ uuid: "stock-event", userCreatedAt: "", data: { eventData: {}, sealed: true } }]));
    response = await request(`/api/notable-events/mydata?domain=${domain}`);
    assert.equal(response.headers.get("x-data-state"), "live");
    assert.equal((await response.json()).content[0].data.sealed, true);
    check(`${domain} preserves incomplete sealed stock events`);
  }

  await mode("payload", { photos: [], notes: [{ uuid: "visible-note", userCreatedAt: "", data: { note: { title: null, text: "Healthy slot" } } }],
    aiSessions: [{ uuid: 42 }], playTrackEvents: [], phoneCalls: [], health: [] });
  response = await request("/api/capture/memories");
  body = await response.json();
  assert.equal(body.provenance.aiMic.state, "degraded");
  assert.equal(body.provenance.notes.state, "live");
  assert.equal(body.notes[0].data.note.text, "Healthy slot");
  check("a malformed dashboard slot preserves healthy content");

  await mode("payload", { uuid: 42, text: "private-sentinel-do-not-echo" });
  response = await request("/api/capture/note/create", { method: "POST", body: { text: "Edit" } });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private-sentinel-do-not-echo|ZodError|invalid_type/);
  check("validation failures expose neither rejected content nor schema diagnostics");

  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  for (const name of [center, fixture]) spawnSync(docker, ["rm", "--force", name], { env: environment, stdio: "ignore", timeout: 10000 });
  spawnSync(docker, ["network", "rm", network], { env: environment, stdio: "ignore", timeout: 10000 });
}
console.log(`Passed ${report.checks.length} HTTP checks. Evidence: ${reportPath}`);
