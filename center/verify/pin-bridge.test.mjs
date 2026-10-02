import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isRemotePinRequest,
  isUsbOnlyPinPath,
  pairPinBridge,
  PinBridgeError,
  pinBridgeRequest,
  pinBridgeStatusForSession,
  requireOwnedPairedPin,
} from "../src/server/pinBridge.ts";

const localEndpoint = "a".repeat(64);
const remoteEndpoint = "b".repeat(64);
const deviceId = "2c2a00010000abcd";
const session = { sub: "wearer-subject", email: "", name: "", operator: false };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function status({ configured = true, connected = true } = {}) {
  return {
    schema_version: 1,
    local_endpoint_id: localEndpoint,
    configured,
    device_id: configured ? deviceId : null,
    remote_endpoint_id: configured ? remoteEndpoint : null,
    connected: configured ? connected : false,
    generation: 1,
    protocol: "penumbra-remote-center-v1",
  };
}

async function configuredEnvironment(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "luma-pin-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  const token = "control-token-".repeat(4);
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const before = { ...process.env };
  process.env.LUMA_PIN_BRIDGE_URL = "http://pin-bridge.test:18080";
  process.env.LUMA_PIN_BRIDGE_TOKEN_FILE = tokenFile;
  process.env.COSMOS_WEBAPI_BASE_URL = "http://cosmos.test:8081";
  process.env.COSMOS_ADMIN_TOKEN = "cosmos-admin-token-that-is-long-enough";
  t.after(() => {
    process.env = before;
  });
  return token;
}

test("an unassigned bridge reports its stable endpoint without inventing a Pin", async (t) => {
  const token = await configuredEnvironment(t);
  const value = await pinBridgeStatusForSession(session, async (url, init) => {
    assert.equal(String(url), "http://pin-bridge.test:18080/__control/status");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
    return json(status({ configured: false }));
  });
  assert.equal(value.configured, false);
  assert.equal(value.localEndpointId, localEndpoint);
  assert.equal(value.deviceId, null);
  assert.equal(value.connected, false);
});

test("ownership is derived from the bridge assignment and Cosmos roster", async (t) => {
  await configuredEnvironment(t);
  const fetchMock = async (url) => String(url).includes("/__control/status")
    ? json(status())
    : json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] });
  const assignment = await requireOwnedPairedPin(session, fetchMock);
  assert.equal(assignment.ownerSub, session.sub);
  assert.equal(assignment.deviceId, deviceId);
  await assert.rejects(
    () => requireOwnedPairedPin({ ...session, sub: "another-wearer" }, fetchMock),
    (error) => error instanceof PinBridgeError && error.code === "wrong_owner" && error.status === 403,
  );
});

test("pairing accepts only this wearer's rostered Pin and verifies the live tunnel", async (t) => {
  const token = await configuredEnvironment(t);
  const ticket = "endpoint-ticket-value";
  const calls = [];
  let statusReads = 0;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, init });
    if (target.endsWith("/__control/status")) {
      statusReads += 1;
      return json(status(statusReads === 1
        ? { configured: false }
        : { configured: true, connected: true }));
    }
    if (target.endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] });
    }
    if (target.endsWith("/__control/pair")) {
      assert.equal(init.method, "PUT");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
      assert.deepEqual(JSON.parse(String(init.body)), { device_id: deviceId, ticket });
      return json(status({ configured: true, connected: false }));
    }
    if (target.endsWith("/api/health")) return json({ ok: true });
    return json({}, 404);
  };

  const assignment = await pairPinBridge(session, {
    deviceId,
    ticket,
    nodeId: remoteEndpoint,
  }, fetchMock);
  assert.equal(assignment.connected, true);
  assert.equal(assignment.deviceId, deviceId);
  assert.equal(JSON.stringify(assignment).includes(ticket), false);
  assert.equal(calls.filter(({ target }) => target.endsWith("/__control/pair")).length, 1);
  assert.equal(calls.filter(({ target }) => target.endsWith("/api/health")).length, 1);
});

test("pairing cannot target another wearer's device", async (t) => {
  await configuredEnvironment(t);
  let pairWrites = 0;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/__control/status")) return json(status({ configured: false }));
    if (target.endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ device_id: deviceId, account_sub: "another-wearer" }] });
    }
    if (init.method === "PUT") pairWrites += 1;
    return json({}, 500);
  };
  await assert.rejects(
    () => pairPinBridge(session, {
      deviceId,
      ticket: "endpoint-ticket-value",
      nodeId: remoteEndpoint,
    }, fetchMock),
    (error) => error instanceof PinBridgeError && error.code === "wrong_owner" && error.status === 403,
  );
  assert.equal(pairWrites, 0);
});

test("malformed bridge status is rejected without exposing control data", async (t) => {
  await configuredEnvironment(t);
  await assert.rejects(
    () => pinBridgeStatusForSession(session, async () => json({
      ...status({ configured: false }),
      ticket: "must-not-be-accepted",
    })),
    (error) => error instanceof PinBridgeError && error.code === "invalid_response",
  );
});

test("bridge status is streamed within its byte limit and rejects noncanonical identifiers", async (t) => {
  await configuredEnvironment(t);
  let cancelled = false;
  await assert.rejects(
    () => pinBridgeStatusForSession(session, async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(33 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }))),
    (error) => error instanceof PinBridgeError && error.code === "invalid_response",
  );
  assert.equal(cancelled, true);

  await assert.rejects(
    () => pinBridgeStatusForSession(session, async () => json({
      ...status({ configured: false }),
      local_endpoint_id: localEndpoint.toUpperCase(),
    })),
    (error) => error instanceof PinBridgeError && error.code === "invalid_response",
  );
});

test("caller abort reasons survive bridge status and roster requests", async (t) => {
  await configuredEnvironment(t);
  const reason = new DOMException("caller deadline", "TimeoutError");
  const signal = AbortSignal.abort(reason);
  await assert.rejects(
    () => requireOwnedPairedPin(session, async (url) => String(url).endsWith("/__control/status")
      ? json(status())
      : json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] }), signal),
    (error) => error === reason,
  );
});

test("repeating an already connected assignment verifies without rewriting it", async (t) => {
  await configuredEnvironment(t);
  let pairWrites = 0;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/__control/status")) return json(status());
    if (target.endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] });
    }
    if (target.endsWith("/__control/pair")) {
      pairWrites += 1;
      return json({}, 500);
    }
    if (target.endsWith("/api/health")) return json({ ok: true });
    return json({}, 404);
  };
  const assignment = await pairPinBridge(session, {
    deviceId,
    ticket: "replacement-ticket-that-must-not-be-written",
    nodeId: remoteEndpoint,
  }, fetchMock);
  assert.equal(assignment.connected, true);
  assert.equal(pairWrites, 0);
});

test("the public bridge route authenticates, binds mutations to origin, and never projects secrets", async () => {
  const route = await readFile(
    new URL("../src/app/api/pin/bridge/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /requireWearerRequest\(\)/u);
  assert.match(route, /export async function PUT\(request: Request\)[\s\S]*isSameOriginRequest\(request\)/u);
  const projection = /function response\(status: PinBridgeStatus\) \{([\s\S]*?)\n\}/u.exec(route)?.[1];
  assert.ok(projection, "bridge response projection is missing");
  assert.match(projection, /configured: status\.configured/u);
  assert.match(projection, /remote_endpoint_id: status\.remoteEndpointId/u);
  assert.doesNotMatch(projection, /ticket|token|authorization/iu);
});

test("the remote link carries exactly the bridge's reviewed routes, method by method", async (t) => {
  await configuredEnvironment(t);
  // pin/bridge `reviewed_route_allowed`, browser-facing part.
  for (const [method, path] of [
    ["GET", "/api/health"],
    ["GET", "/api/device"],
    ["GET", "/api/feature-flags"],
    ["GET", "/api/spotify/status"],
    ["GET", "/api/spotify/search?q=blue"],
    ["PUT", "/api/spotify/settings"],
    ["POST", "/api/spotify/pairing/start"],
    ["POST", "/api/spotify/pairing/cancel"],
    ["DELETE", "/api/spotify/session"],
  ]) {
    assert.equal(isRemotePinRequest(method, path), true, `${method} ${path}`);
  }
  // Device-local, but the bridge and the Pin refuse them remotely: USB only.
  for (const [method, path] of [
    ["GET", "/api/events"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
    ["GET", "/api/setup/acceptance"],
    ["PUT", "/api/feature-flags"],
    ["GET", "/api/fitness/sessions/1"],
    ["GET", "/api/iroh/ticket"],
    ["DELETE", "/api/health"],
  ]) {
    assert.equal(isRemotePinRequest(method, path), false, `${method} ${path}`);
    assert.equal(isUsbOnlyPinPath(path), true, path);
  }
  // Cloud data and anything else is neither.
  for (const path of [
    "/api/memories",
    "/api/contacts/client-reset",
    "/api/activity/music?limit=20",
    "/api/conversations/4",
    "/api/healthz",
    "/api/health/../memories",
    "/__control/status",
  ]) {
    assert.equal(isRemotePinRequest("GET", path), false, path);
    assert.equal(isUsbOnlyPinPath(path), false, path);
  }

  const reached = [];
  const fetchMock = async (url) => {
    reached.push(String(url));
    return json({ ok: true });
  };
  await pinBridgeRequest("/api/health", {}, fetchMock);
  assert.throws(
    () => pinBridgeRequest("/api/memories", {}, fetchMock),
    (error) => error instanceof PinBridgeError,
  );
  assert.throws(
    () => pinBridgeRequest("/api/settings", { method: "PUT" }, fetchMock),
    (error) => error instanceof PinBridgeError,
  );
  assert.deepEqual(reached, ["http://pin-bridge.test:18080/api/health"]);
});

const replacementPin = "2c2a00010000bbbb";
const replacementEndpoint = "c".repeat(64);

/** The bridge still names `deviceId`. The roster lists only `pairings`. */
function staleAssignment(pairings, events) {
  let statusReads = 0;
  return async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/__control/status")) {
      statusReads += 1;
      events.push("status");
      return json(statusReads === 1 || !events.includes("pair")
        ? status({ configured: true, connected: false })
        : {
            ...status(),
            device_id: replacementPin,
            remote_endpoint_id: replacementEndpoint,
            generation: 2,
          });
    }
    if (target.endsWith("/demo-api/admin/devices")) return json({ pairings });
    if (target.endsWith("/__control/pair")) {
      events.push("pair");
      assert.equal(init.method, "PUT");
      return json({
        ...status({ configured: true, connected: false }),
        device_id: replacementPin,
        remote_endpoint_id: replacementEndpoint,
        generation: 2,
      });
    }
    if (target.endsWith("/api/health")) return json({ ok: true });
    return json({}, 404);
  };
}

test("a released Pin's assignment reads as unassigned, with the bridge endpoint still readable", async (t) => {
  await configuredEnvironment(t);
  const events = [];
  const value = await pinBridgeStatusForSession(
    session,
    staleAssignment([{ device_id: replacementPin, account_sub: session.sub }], events),
  );
  assert.equal(value.configured, false);
  assert.equal(value.deviceId, null);
  assert.equal(value.remoteEndpointId, null);
  assert.equal(value.connected, false);
  assert.equal(value.localEndpointId, localEndpoint);
});

test("a replacement Pin takes over an assignment that names a released Pin", async (t) => {
  await configuredEnvironment(t);
  const events = [];
  const assignment = await pairPinBridge(
    session,
    { deviceId: replacementPin, ticket: "endpoint-ticket-value", nodeId: replacementEndpoint },
    staleAssignment([{ device_id: replacementPin, account_sub: session.sub }], events),
  );
  assert.equal(assignment.deviceId, replacementPin);
  assert.equal(assignment.connected, true);
  assert.equal(events.filter((event) => event === "pair").length, 1);
});

test("a different Pin cannot take the link from one the roster still lists", async (t) => {
  await configuredEnvironment(t);
  const events = [];
  const fetchMock = staleAssignment([
    { device_id: deviceId, account_sub: session.sub },
    { device_id: replacementPin, account_sub: session.sub },
  ], events);
  await assert.rejects(
    () => pairPinBridge(
      session,
      { deviceId: replacementPin, ticket: "endpoint-ticket-value", nodeId: replacementEndpoint },
      fetchMock,
    ),
    (error) => error instanceof PinBridgeError && error.code === "pin_binding_invalid" && error.status === 409,
  );
  assert.equal(events.includes("pair"), false);
});

test("an assignment whose Pin belongs to another account is still refused", async (t) => {
  await configuredEnvironment(t);
  const events = [];
  const fetchMock = staleAssignment([
    { device_id: deviceId, account_sub: "another-wearer" },
    { device_id: replacementPin, account_sub: session.sub },
  ], events);
  await assert.rejects(
    () => pinBridgeStatusForSession(session, fetchMock),
    (error) => error instanceof PinBridgeError && error.code === "wrong_owner",
  );
  await assert.rejects(
    () => pairPinBridge(
      session,
      { deviceId: replacementPin, ticket: "endpoint-ticket-value", nodeId: replacementEndpoint },
      fetchMock,
    ),
    (error) => error instanceof PinBridgeError && error.code === "wrong_owner" && error.status === 403,
  );
  assert.equal(events.includes("pair"), false);
});

test("a server without remote access says so instead of reporting an outage", async (t) => {
  await configuredEnvironment(t);
  delete process.env.LUMA_PIN_BRIDGE_URL;
  const roster = async () => json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] });
  for (const read of [requireOwnedPairedPin, pinBridgeStatusForSession]) {
    await assert.rejects(
      () => read(session, roster),
      (error) => error instanceof PinBridgeError && error.code === "bridge_not_configured",
      read.name,
    );
  }
});

test("a bridge that refuses Center's control token is misconfigured, not unavailable", async (t) => {
  await configuredEnvironment(t);
  for (const refusal of [401, 403]) {
    const fetchMock = async (url) => String(url).includes("/__control/")
      ? new Response("", { status: refusal })
      : json({ pairings: [{ device_id: deviceId, account_sub: session.sub }] });
    await assert.rejects(
      () => pinBridgeStatusForSession(session, fetchMock),
      (error) => error instanceof PinBridgeError && error.code === "bridge_misconfigured" && error.status === 503,
      String(refusal),
    );
    await assert.rejects(
      () => requireOwnedPairedPin(session, fetchMock),
      (error) => error instanceof PinBridgeError && error.code === "bridge_misconfigured",
      String(refusal),
    );
  }
  // An outage is still an outage.
  await assert.rejects(
    () => pinBridgeStatusForSession(session, async () => new Response("", { status: 502 })),
    (error) => error instanceof PinBridgeError && error.code === "bridge_unavailable",
  );
});
