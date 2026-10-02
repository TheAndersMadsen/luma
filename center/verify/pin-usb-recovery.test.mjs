import assert from "node:assert/strict";
import test from "node:test";

const { UsbAdbHttpTransport } = await import("../src/lib/pin-device/usbTransport.ts");
const { PinClient } = await import("../src/lib/pin-device/client.ts");
const { enableRemoteAccess } = await import("../src/app/settings/pin/provision/browserActivation.ts");

// Exercise the real HTTP encoder, response reader, client, and remote setup.
// The fixture replaces only the physical ADB socket and Center's remote peer.
function deviceFixture({ unavailable = false, ticketFailures = 0, ticketStatus = 503 } = {}) {
  const evidence = { starts: 0, restarts: 0, writes: [], closed: 0, opens: 0 };
  let listening = !unavailable;
  let recoverable = true;
  const session = {
    connectionInfo: { serial: "fixture-pin", name: "Ai Pin" },
    async shell(command) {
      if (command.includes("START")) {
        evidence.starts++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        listening = recoverable;
      } else if (command.includes("RESTART_RUNTIME")) {
        evidence.restarts++;
        listening = true;
      } else {
        throw new Error(`Unexpected maintenance command: ${command.join(" ")}`);
      }
      return { stdout: "Result: Bundle[{status=200, ok=true}]", stderr: "", exitCode: 0 };
    },
    async openBridgeSocket() {
      evidence.opens++;
      if (!listening) throw new Error("Socket open failed");
      let incoming;
      return {
        readable: new ReadableStream({ start(controller) { incoming = controller; } }),
        writable: new WritableStream({
          write(bytes) {
            const request = new TextDecoder().decode(bytes);
            evidence.writes.push(request);
            let status = 200;
            let body = { ok: true };
            if (request.startsWith("GET /api/iroh/ticket ")) {
              if (ticketFailures-- > 0) {
                status = ticketStatus;
                body = { error: "not ready" };
              } else body = { ticket: "fixture-ticket", node_id: "b".repeat(64) };
            }
            const json = JSON.stringify(body);
            incoming.enqueue(new TextEncoder().encode(`HTTP/1.1 ${status} Response\r\nContent-Length: ${json.length}\r\nContent-Type: application/json\r\n\r\n${json}`));
            incoming.close();
          },
        }),
        async close() { evidence.closed++; },
      };
    },
  };
  return { session, evidence, breakPermanently() { recoverable = false; listening = false; } };
}

async function clientFor(fixture) {
  return new PinClient(await UsbAdbHttpTransport.fromSession(fixture.session, undefined, { startMaintenanceService: false }));
}

test("a stopped USB service recovers before one settings write, sharing startup with concurrent health probes", async () => {
  const fixture = deviceFixture({ unavailable: true });
  const client = await clientFor(fixture);
  await Promise.all([client.health(), client.updateSettings({ server: { iroh_remote_center_enabled: true } })]);
  assert.equal(fixture.evidence.starts, 1);
  assert.equal(fixture.evidence.restarts, 0);
  assert.equal(fixture.evidence.writes.filter((request) => request.startsWith("PUT ")).length, 1);
  assert.equal(fixture.evidence.closed, 2);
});

test("an unavailable USB service gives recovery advice without claiming an outdated APK", async () => {
  const fixture = deviceFixture();
  fixture.breakPermanently();
  const client = await clientFor(fixture);
  await assert.rejects(client.health(), (error) => {
    assert.equal(error.name, "UsbBridgeUnavailableError");
    assert.match(error.message, /connected and unlocked/u);
    assert.doesNotMatch(error.message, /APK|localabstract|Socket open failed/u);
    return true;
  });
  assert.equal(fixture.evidence.starts, 1);
  assert.equal(fixture.evidence.writes.length, 0);
});

test("an aborted USB probe opens no socket and starts no maintenance", async () => {
  const fixture = deviceFixture({ unavailable: true });
  const client = await clientFor(fixture);
  await assert.rejects(client.health(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(fixture.evidence.starts, 0);
  assert.equal(fixture.evidence.opens, 0);
});

test("USB recovery does not replay an HTTP write whose response was lost", async () => {
  const fixture = deviceFixture();
  let writes = 0;
  fixture.session.openBridgeSocket = async () => ({
    readable: new ReadableStream({ start(controller) { controller.close(); } }),
    writable: new WritableStream({ write() { writes++; } }),
    async close() {},
  });
  const client = await clientFor(fixture);
  await assert.rejects(client.updateSettings({ server: { iroh_remote_center_enabled: true } }));
  assert.equal(writes, 1);
  assert.equal(fixture.evidence.starts, 0);
});

const bridge = { configured: false, connected: false, local_endpoint_id: "a".repeat(64), device_id: null, remote_endpoint_id: null };

test("remote setup waits for its connector without repeating the settings write or runtime restart", async () => {
  const fixture = deviceFixture({ ticketFailures: 2 });
  const client = await clientFor(fixture);
  let pairings = 0;
  await enableRemoteAccess(fixture.session, client, {
    async getBridgeStatus() { return bridge; },
    async pairBridge(input) {
      pairings++;
      assert.equal(input.ticket, "fixture-ticket");
      return { ...bridge, configured: true, connected: true, device_id: input.device_id, remote_endpoint_id: input.node_id };
    },
  }, "00aa11bb");
  assert.equal(pairings, 1);
  assert.equal(fixture.evidence.restarts, 1);
  assert.equal(fixture.evidence.writes.filter((r) => r.startsWith("PUT ")).length, 1);
  assert.equal(fixture.evidence.writes.filter((r) => r.startsWith("GET /api/iroh/ticket ")).length, 3);
});

test("remote setup does not retry authorization failures", async () => {
  const fixture = deviceFixture({ ticketFailures: 1, ticketStatus: 403 });
  await assert.rejects(enableRemoteAccess(fixture.session, await clientFor(fixture), {
    async getBridgeStatus() { return bridge; },
    async pairBridge() { throw new Error("must not pair"); },
  }, "00aa11bb"), (error) => error.status === 403);
  assert.equal(fixture.evidence.writes.filter((r) => r.startsWith("GET /api/iroh/ticket ")).length, 1);
});
