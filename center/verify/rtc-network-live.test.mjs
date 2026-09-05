import assert from "node:assert/strict";
import test from "node:test";
import { selectedTransport, validateNetworkProbe } from "./rtc-network-live.mjs";

const room = "revival-acceptance-2c633d06-c424-41c5-9f43-83c29e59a8b7";
const url = "wss://center.example.test/livekit";
const serverIp = "203.0.113.10";
function configuration(change = value => value) {
  return { room, url, serverIp, participants: [0, 1].map(index => {
    const identity = `${room}-${index}`;
    const claims = change({ iss: "test", sub: identity, nbf: 995, exp: 1200,
      video: { room, roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: true } });
    return { identity, token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` };
  }) };
}
test("network probe accepts only fresh data-only synthetic room credentials", () => {
  assert.equal(validateNetworkProbe(configuration(), url, 1000).room, room);
  for (const change of [
    value => ({ ...value, exp: 2000 }),
    value => ({ ...value, nbf: 900 }),
    value => ({ ...value, sub: "real-user" }),
    value => ({ ...value, video: { ...value.video, room: "real-room" } }),
    value => ({ ...value, video: { ...value.video, canPublish: true } }),
    value => ({ ...value, video: { ...value.video, roomAdmin: true } }),
    value => ({ ...value, roomConfig: { agents: [{ agentName: "runtime" }] } }),
  ]) assert.throws(() => validateNetworkProbe(configuration(change), url, 1000));
  assert.throws(() => validateNetworkProbe(configuration(), "wss://other.example/livekit", 1000));
  assert.throws(() => validateNetworkProbe({ ...configuration(), serverIp: "192.168.1.2" }, url, 1000));
  assert.throws(() => validateNetworkProbe({ ...configuration(), secret: "must-not-reach-browser" }, url, 1000));
  const extra = configuration(); extra.participants[0].secret = "must-not-reach-browser";
  assert.throws(() => validateNetworkProbe(extra, url, 1000));
});
function stats() {
  return [
    { id: "transport", type: "transport", selectedCandidatePairId: "selected", dtlsState: "connected", bytesSent: 100, bytesReceived: 200 },
    { id: "selected", type: "candidate-pair", localCandidateId: "local", remoteCandidateId: "remote", state: "succeeded", nominated: true },
    { id: "local", type: "local-candidate", protocol: "udp", candidateType: "host", usernameFragment: "must-not-appear" },
    { id: "remote", type: "remote-candidate", protocol: "udp", candidateType: "host", port: 7882, address: serverIp },
    { id: "unselected", type: "candidate-pair", state: "succeeded", nominated: true },
  ];
}
test("network evidence follows the selected transport and exports bounded facts", () => {
  const result = selectedTransport(stats(), "udp", serverIp);
  assert.deepEqual(result, { pairId: "selected", protocol: "udp", relay: false, remotePort: 7882, sent: 100, received: 200 });
  assert(!JSON.stringify(result).includes("must-not-appear"));
  for (const mutate of [
    value => { value[0].selectedCandidatePairId = "missing"; },
    value => { value[0].dtlsState = "connecting"; },
    value => { value[1].nominated = false; },
    value => { value[2].candidateType = "relay"; },
    value => { value[3].port = 50000; },
    value => { value[3].address = "192.168.1.2"; },
  ]) { const value = stats(); mutate(value); assert.throws(() => selectedTransport(value, "udp", serverIp)); }
});
test("TCP and relay paths require their actual candidate evidence", () => {
  const tcp = stats();
  tcp[2].protocol = tcp[3].protocol = "tcp"; tcp[3].port = 7881;
  assert.equal(selectedTransport(tcp, "tcp", serverIp).protocol, "tcp");
  assert.throws(() => selectedTransport(stats(), "tcp", serverIp));
  const relay = stats(); relay[2].candidateType = "relay"; relay[2].relayProtocol = "udp";
  assert.equal(selectedTransport(relay, "turn-udp", serverIp).relay, true);
  relay[2].relayProtocol = "tcp";
  assert.throws(() => selectedTransport(relay, "turn-udp", serverIp));
});
