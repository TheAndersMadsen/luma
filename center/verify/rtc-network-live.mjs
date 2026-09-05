// Opt-in raw SDK network acceptance. No Cosmos enrollment, cognition or media.
// Node 22, Playwright via NODE_PATH; exact-room participant tokens on stdin:
// node rtc-network-live.mjs wss://center.example.com/livekit udp|tcp|turn-udp
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export function validateNetworkProbe(value, expectedUrl, now = Math.floor(Date.now() / 1000)) {
  const url = new URL(expectedUrl);
  assert(url.protocol === "wss:" || (url.protocol === "ws:" && url.hostname === "127.0.0.1"), "Expected explicit TLS or loopback SFU");
  assert(!url.username && !url.password && !url.search && !url.hash && !expectedUrl.endsWith("/"), "Invalid SFU coordinate");
  assert(value?.url === expectedUrl && /^revival-acceptance-[0-9a-f-]{36}$/u.test(value.room), "Expected an isolated synthetic room");
  assert(Object.keys(value).every(key => ["url", "room", "serverIp", "participants", "ports"].includes(key)), "Unexpected probe configuration");
  assert(isIP(value.serverIp) === 4, "Explicit expected server IPv4 required");
  const [first, second] = value.serverIp.split(".").map(Number);
  const restricted = first === 0 || first === 10 || first === 127 || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  assert(!restricted || (url.hostname === "127.0.0.1" && value.serverIp === "127.0.0.1"), "Public acceptance requires a public server address");
  if (value.ports !== undefined) {
    assert(url.hostname === "127.0.0.1" && Object.keys(value.ports).sort().join(",") === "tcp,udp" && Object.values(value.ports).every(port => Number.isInteger(port) && port > 1024 && port <= 65535), "Port overrides are restricted to isolated loopback fixtures");
  }
  assert(Array.isArray(value.participants) && value.participants.length === 2, "Exactly two synthetic participants required");
  for (const [index, participant] of value.participants.entries()) {
    assert(Object.keys(participant).sort().join(",") === "identity,token", "Unexpected participant configuration");
    assert(participant.identity === `${value.room}-${index}`, "Unexpected synthetic identity");
    assert(typeof participant.token === "string" && participant.token.length < 8192, "Bounded participant token required");
    const parts = participant.token.split(".");
    assert(parts.length === 3, "Expected JWT");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    assert(claims.sub === participant.identity && typeof claims.iss === "string", "Wrong participant binding");
    assert(Number.isInteger(claims.nbf) && Number.isInteger(claims.exp) && claims.nbf <= now && claims.nbf >= now - 30 && claims.exp > now + 30 && claims.exp <= now + 300 && claims.exp - claims.nbf <= 330, "Fresh short-lived token required");
    const grant = claims.video;
    assert(grant?.room === value.room && grant.roomJoin === true && grant.canPublish === false && grant.canSubscribe === false && grant.canPublishData === true, "Data-only exact-room grant required");
    assert(Object.keys(grant).every(key => ["room", "roomJoin", "canPublish", "canSubscribe", "canPublishData"].includes(key)), "Unexpected participant authority");
    assert(Object.keys(claims).every(key => ["iss", "sub", "nbf", "iat", "exp", "video"].includes(key)), "Unexpected token authority");
  }
  // Decoding checks scope only. The SFU must still verify the signature.
  return value;
}

export function selectedTransport(records, mode, serverIp, ports = { udp: 7882, tcp: 7881 }) {
  const byId = new Map(records.map(record => [record.id, record]));
  const transports = records.filter(record => record.type === "transport" && record.selectedCandidatePairId);
  if (transports.length !== 1) throw new Error("Expected one selected DTLS transport per peer connection");
  const transport = transports[0];
  const pair = byId.get(transport.selectedCandidatePairId);
  const local = byId.get(pair?.localCandidateId);
  const remote = byId.get(pair?.remoteCandidateId);
  if (transport.dtlsState !== "connected" || pair?.state !== "succeeded" || pair.nominated !== true || !local || !remote) throw new Error("No committed selected candidate pair");
  if (!serverIp || remote.address !== serverIp) throw new Error("Selected candidate does not name the expected server");
  const protocol = mode === "tcp" ? "tcp" : "udp";
  if (local.protocol !== protocol || remote.protocol !== protocol) throw new Error("Selected protocol differs from requested path");
  if (mode === "turn-udp") {
    if (local.candidateType !== "relay" || local.relayProtocol !== "udp") throw new Error("TURN UDP was not selected");
  } else if (local.candidateType === "relay" || remote.candidateType === "relay" || remote.port !== ports[mode]) {
    throw new Error("Expected direct server candidate");
  }
  if (![transport.bytesSent, transport.bytesReceived].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Missing transport byte counters");
  return { pairId: pair.id, protocol, relay: local.candidateType === "relay", remotePort: remote.port,
    sent: transport.bytesSent, received: transport.bytesReceived };
}

async function browserProbe({ configuration, mode, selectSource }) {
  const { Room, RoomEvent, setLogLevel } = await import("/sdk.mjs");
  setLogLevel("silent");
  const select = (0, eval)(`(${selectSource})`);
  const rooms = configuration.participants.map(() => new Room());
  const method = "revival.acceptance.echo.v1";
  const expected = "synthetic transport probe";
  const until = async (read, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await read(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Network acceptance timeout");
  };
  const connect = (room, index) => room.connect(configuration.url, configuration.participants[index].token, {
    autoSubscribe: false, maxRetries: 0, peerConnectionTimeout: 15000,
    ...(mode === "turn-udp" ? { rtcConfig: { iceTransportPolicy: "relay" } } : {}),
  });
  const snapshot = async () => {
    const result = [];
    for (const [index, room] of rooms.entries()) {
      // These diagnostics are internal to the pinned 2.22.2 SDK, never product APIs.
      const manager = room.engine.pcManager;
      for (const name of ["publisher", "subscriber"]) {
        const stats = await manager?.[name]?.getStats();
        if (!stats) continue;
        result.push({ participant: index, connection: name, ...select([...stats.values()], mode, configuration.serverIp, configuration.ports) });
      }
    }
    if (result.length < 2 || !result.some(item => item.participant === 0) || !result.some(item => item.participant === 1)) throw new Error("Missing peer connection evidence");
    return result;
  };
  let stage = "connect";
  try {
    for (const [index, room] of rooms.entries()) {
      room.registerRpcMethod(method, async call => {
        if (call.callerIdentity !== configuration.participants[1 - index].identity || call.payload !== expected) throw new Error("Unexpected caller or payload");
        return expected;
      });
    }
    await Promise.all(rooms.map(connect));
    if (mode === "tcp") {
      stage = "force-tcp-reconnect";
      for (const room of rooms) {
        let reconnecting = false, reconnected = false;
        room.once(RoomEvent.Reconnecting, () => { reconnecting = true; });
        room.once(RoomEvent.Reconnected, () => { reconnected = true; });
        // Participant-scoped SDK test operation; never used by Cosmos clients.
        await room.simulateScenario("force-tcp");
        await until(() => reconnecting && reconnected, 30000);
      }
    }
    stage = "participant-attribution";
    await until(() => rooms.every((room, index) => room.remoteParticipants.size === 1 && room.remoteParticipants.has(configuration.participants[1 - index].identity)));
    if (mode === "turn-udp") {
      stage = "server-turn-route";
      for (const room of rooms) {
        const servers = room.engine.latestJoinResponse?.iceServers;
        const urls = servers?.flatMap(server => server.urls) ?? [];
        const turn = urls.filter(url => /^turns?:/u.test(url));
        if (turn.length === 0 || !turn.every(url => url === `turn:${configuration.serverIp}:3478?transport=udp`)) throw new Error("Expected server-issued TURN UDP route");
      }
    }
    const roundtrip = async () => {
      for (const [index, room] of rooms.entries()) {
        const result = await room.localParticipant.performRpc({ destinationIdentity: configuration.participants[1 - index].identity, method, payload: expected, responseTimeout: 5000 });
        if (result !== expected) throw new Error("Wrong RPC result");
      }
    };
    stage = "first-rpc";
    await roundtrip();
    stage = "selected-candidate-evidence";
    const before = await snapshot();
    stage = "fresh-rpc";
    await roundtrip();
    stage = "increasing-byte-counters";
    const after = await until(async () => {
      const current = await snapshot();
      return current.length === before.length && current.every((item, index) => {
        const previous = before[index];
        return item.participant === previous.participant && item.connection === previous.connection && item.pairId === previous.pairId && item.sent > previous.sent && item.received > previous.received;
      }) ? current : null;
    }, 5000);
    return { ok: true, scope: "browser-data-transport", mode, bidirectionalRpc: true, transports: after.map(({ pairId, ...item }) => item) };
  } catch {
    return { ok: false, mode, stage };
  } finally {
    const disconnected = await Promise.allSettled(rooms.map(room => room.disconnect()));
    if (disconnected.some(result => result.status !== "fulfilled")) throw new Error("Participant disconnect failed");
  }
}

async function main() {
  const [url, mode, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && ["udp", "tcp", "turn-udp"].includes(mode), "Supply exact SFU URL and udp, tcp or turn-udp");
  const bytes = Buffer.alloc(16385); let size = 0;
  while (size < bytes.length) { const count = fs.readSync(0, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
  assert(size > 0 && size <= 16384, "Bounded participant configuration required on stdin");
  const configuration = validateNetworkProbe(JSON.parse(bytes.subarray(0, size).toString("utf8")), url);
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  const sdkPath = require.resolve("livekit-client").replace(/livekit-client\.umd\.js$/u, "livekit-client.esm.mjs");
  assert(sdkPath.endsWith("livekit-client.esm.mjs"), "Pinned SDK distribution required");
  const sdkMetadata = JSON.parse(fs.readFileSync(new URL("../package.json", pathToFileURL(sdkPath)), "utf8"));
  assert.equal(sdkMetadata.version, "2.22.2");
  const server = http.createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) { response.writeHead(400); response.end(); return; }
    if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end("<!doctype html><title>Synthetic RTC network acceptance</title>"); }
    else if (request.url === "/sdk.mjs") { response.setHeader("content-type", "text/javascript"); fs.createReadStream(sdkPath).pipe(response); }
    else { response.writeHead(404); response.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await Promise.race([
      page.evaluate(browserProbe, { configuration, mode, selectSource: selectedTransport.toString() }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Network acceptance deadline")), 120000); timer.unref(); }),
    ]);
    process.stdout.write(`${JSON.stringify({ sdk: "2.22.2", ...result })}\n`);
    if (result.ok !== true) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("RTC network acceptance failed; no credentials or raw SDK diagnostics emitted.\n"); process.exitCode = 1; });
}
