import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";


const { createActivationBundleJson } = await import(
  "../src/app/settings/pin/provision/activationBundle.ts"
);
const {
  buildActivationEnvelope,
  parseActivationStatus,
  provisionConnectedPin,
  RemoteAccessSetupError,
} = await import("../src/app/settings/pin/provision/browserActivation.ts");
const { PinApiError } = await import("../src/lib/pin-device/client.ts");

const BRIDGE_ENDPOINT_ID = "a".repeat(64);
const PIN_ENDPOINT_ID = "b".repeat(64);

function unassignedBridgeStatus() {
  return {
    configured: false,
    connected: false,
    local_endpoint_id: BRIDGE_ENDPOINT_ID,
    device_id: null,
    remote_endpoint_id: null,
  };
}

test("provisioning downloads one activation document with the complete certificate chain", () => {
  const parsed = JSON.parse(createActivationBundleJson({
    device_id: "00aa11bb",
    subject: "V:01:D:00aa11bb:P:00000001",
    certificate_pem: "leaf",
    private_key_pem: "private",
    ca_certificate_pem: "intermediate",
    root_certificate_pem: "root",
    onboarding: { endpoint: "https://onboarding.example", authority: "example" },
  }, "https://pin.example.test/device-status/v1/report"));

  assert.deepEqual(parsed, {
    device_id: "00aa11bb",
    certificate_pem: "leaf",
    private_key_pem: "private",
    ca_certificate_pem: "intermediate",
    root_certificate_pem: "root",
    device_status_endpoint: "https://pin.example.test/device-status/v1/report",
  });
});

test("browser activation builds the fixed Cosmos envelope", async () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
  const result = await buildActivationEnvelope({
    device_id: "00aa11bb",
    subject: "V:01:D:00aa11bb:P:00000001",
    certificate_pem: certificate,
    private_key_pem: "private",
    ca_certificate_pem: certificate,
    root_certificate_pem: certificate,
    onboarding: { endpoint: "https://onboarding.cosmos.humane.cloud", authority: "example" },
  }, "203.0.113.42", "https://center.example/device-status/v1/report");

  assert.equal(result.envelope.api_endpoint, "https://api.cosmos.humane.cloud");
  assert.equal(result.envelope.onboarding_endpoint, "https://onboarding.cosmos.humane.cloud");
  assert.equal(result.envelope.edge_ipv4, "203.0.113.42");
  assert.equal(result.envelope.root_certificate_der_b64, "AQID");
});

test("browser activation parses the Pin's verified postcondition", () => {
  const fingerprint = "a".repeat(64);
  const root = "b".repeat(64);
  const status = parseActivationStatus(
    `Result: Bundle[{ok=true, state=active, consistent=true, managed=true, remote_gate_enabled=true, target_matches=true, present=true, identity_usable=true, edge_ipv4=203.0.113.42, fingerprint_sha256=${fingerprint}, root_certificate_sha256=${root}, api_endpoint=https://api.cosmos.humane.cloud, onboarding_endpoint=https://onboarding.cosmos.humane.cloud, device_status_endpoint=https://center.example/device-status/v1/report}]`,
  );
  assert.equal(status.state, "active");
  assert.equal(status.identityUsable, true);
  assert.equal(status.fingerprintSha256, fingerprint);
  assert.equal(status.rootCertificateSha256, root);
});

test("provisioning prefers direct browser activation and keeps the file as a fallback", () => {
  const source = readFileSync(
    new URL("../src/app/settings/pin/provision/ProvisioningView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Connect this Pin to Cosmos/u);
  assert.match(source, /Create an activation file instead/u);
  assert.match(source, /provisionConnectedPin/u);
  assert.match(source, /isActivationBundle/u);
  assert.match(source, /maxLength=\{128\}/u);
  assert.doesNotMatch(source, /commands\.plan|commands\.confirm|Move .*0700/u);
  assert.doesNotMatch(source, /device\.crt|device\.key|Complete OPAQUE/u);
  assert.doesNotMatch(source, /in this repository/u);
});

test("direct activation keeps the pairing service's actionable failure message", () => {
  const source = readFileSync(
    new URL("../src/app/settings/pin/provision/ProvisioningView.tsx", import.meta.url),
    "utf8",
  );
  const pairDevice = /async pairDevice\(id\) \{([\s\S]*?)\n\s*\},\n\s*async issueBundle/u.exec(source)?.[1];
  assert.ok(pairDevice, "direct activation is missing its pairing operation");
  assert.match(pairDevice, /await response\.json\(\)\.catch/u);
  assert.match(pairDevice, /typeof .*error.*=== "string"/u);
  assert.doesNotMatch(
    pairDevice,
    /if \(!response\.ok\) \{\s*throw new Error\("Center could not pair this Pin with your account\."\);/u,
  );
});

test("successful direct activation refreshes every Guided Setup cache before reporting success", () => {
  const source = readFileSync(
    new URL("../src/app/settings/pin/provision/ProvisioningView.tsx", import.meta.url),
    "utf8",
  );
  const activatePin = /async function activatePin\(\) \{([\s\S]*?)\n  \}\n\n  if \(loadState/u.exec(source)?.[1];
  assert.ok(activatePin, "direct activation is missing its success handler");
  assert.match(source, /import \{ useQueryClient \} from "@tanstack\/react-query"/u);
  assert.match(source, /const queryClient = useQueryClient\(\)/u);
  assert.match(activatePin, /queryClient/u);
  assert.match(activatePin, /await Promise\.all/u);
  assert.match(activatePin, /queryKey: \["pin-setup"\]/u);
  assert.match(activatePin, /queryKey: \["paired-pins"\]/u);
  assert.match(activatePin, /queryKey: \["device-status"\]/u);
  assert.ok(
    activatePin.indexOf('queryKey: ["device-status"]')
      < activatePin.indexOf("This Pin is connected to Cosmos and paired with your account."),
    "Guided Setup caches must refresh before activation reports success",
  );
  assert.match(activatePin, /Return to Guided setup to finish setup on this Pin\./u);
});

test("the owner guide uses direct Center activation as the normal path", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = /### 3\. Activate and prove the device\n([\s\S]*?)(?=\n## )/u.exec(readme)?.[1];
  assert.ok(section, "README is missing the Pin activation section");
  assert.match(section, /Connect this Pin to Cosmos/u);
  assert.match(section, /activation file.*fallback/iu);
  assert.doesNotMatch(section, /create and download the\s+one-time activation document/iu);
  assert.doesNotMatch(section, /Disconnect the Pin in Center|pin activate status/iu);
});

test("direct activation does not mint a one-time key before device preflight", async () => {
  let issued = 0;
  const lockedSession = {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) {
        return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("sys.user.0.ce_available")) {
        return { stdout: "0\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  };

  await assert.rejects(
    provisionConnectedPin(
      lockedSession,
      {
        async updateSettings() { throw new Error("settings must not run before device preflight"); },
        async getIrohTicket() { throw new Error("ticket must not run before device preflight"); },
      },
      {
        async pairDevice() {
          throw new Error("pairing must not run before device preflight");
        },
        async issueBundle() {
          issued += 1;
          throw new Error("one-time key must not be minted");
        },
        async getBridgeStatus() {
          throw new Error("bridge status must not run before device preflight");
        },
        async pairBridge() {
          throw new Error("bridge pairing must not run before device preflight");
        },
      },
      "203.0.113.42",
      "https://center.example/device-status/v1/report",
    ),
    /Unlock the Pin/,
  );
  assert.equal(issued, 0);
});

test("direct activation pairs the account before minting a one-time key", async () => {
  const calls = [];
  const readySession = {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) {
        return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("sys.user.0.ce_available")) {
        return { stdout: "1\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("ACTIVATION_STATUS")) {
        return {
          stdout: "Result: Bundle[{ok=true, state=inactive, consistent=true, managed=false, remote_gate_enabled=false, target_matches=false, present=false, identity_usable=false}]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  };

  await assert.rejects(
    provisionConnectedPin(
      readySession,
      {
        async updateSettings() { throw new Error("settings must not run before account pairing"); },
        async getIrohTicket() { throw new Error("ticket must not run before account pairing"); },
      },
      {
        async pairDevice(id) {
          calls.push(`pair:${id}`);
          throw new Error("pairing failed");
        },
        async issueBundle(id) {
          calls.push(`issue:${id}`);
          throw new Error("one-time key must not be minted");
        },
        async getBridgeStatus() {
          calls.push("bridge-status");
          return unassignedBridgeStatus();
        },
        async pairBridge() {
          throw new Error("bridge pairing must not run before account pairing");
        },
      },
      "203.0.113.42",
      "https://center.example/device-status/v1/report",
    ),
    /pairing failed/,
  );
  assert.deepEqual(calls, ["pair:00aa11bb"]);
});

test("direct activation completes one exact preflight, pairing, issuance, install, and verification transaction", async () => {
  const calls = [];
  const certificate = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
  const fingerprint = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
  let statusReads = 0;
  const session = {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) {
        calls.push("device-id");
        return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("sys.user.0.ce_available")) {
        calls.push("unlocked");
        return { stdout: "1\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("ACTIVATE")) {
        calls.push("activate");
        return {
          stdout: "Result: Bundle[{ok=true, state=activated}]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("RESTART_RUNTIME")) {
        calls.push("restart-runtime");
        return {
          stdout: "Result: Bundle[{status=200, ok=true}]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("ACTIVATION_STATUS")) {
        statusReads += 1;
        calls.push(statusReads === 1 ? "status:preflight" : "status:verify");
        return statusReads === 1
          ? {
              stdout: "Result: Bundle[{ok=true, state=inactive, consistent=true, managed=false, remote_gate_enabled=false, target_matches=false, present=false, identity_usable=false}]\n",
              stderr: "",
              exitCode: 0,
            }
          : {
              stdout: `Result: Bundle[{ok=true, state=active, consistent=true, managed=true, remote_gate_enabled=true, target_matches=true, present=true, identity_usable=true, edge_ipv4=203.0.113.42, fingerprint_sha256=${fingerprint}, root_certificate_sha256=${fingerprint}, api_endpoint=https://api.cosmos.humane.cloud, onboarding_endpoint=https://onboarding.cosmos.humane.cloud, device_status_endpoint=https://center.example/device-status/v1/report}]\n`,
              stderr: "",
              exitCode: 0,
            };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
    async shellWithInput(command, body) {
      calls.push("stage");
      assert.deepEqual(command, [
        "content",
        "write",
        "--uri",
        "content://com.penumbraos.server.cosmosidentity/attestation.json",
      ]);
      const envelope = JSON.parse(await body.text());
      assert.equal(envelope.device_id, "00aa11bb");
      assert.equal(envelope.edge_ipv4, "203.0.113.42");
      assert.equal(envelope.private_key_pem, "private");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };

  const status = await provisionConnectedPin(
    session,
    {
      async updateSettings(settings) {
        calls.push("iroh-settings");
        assert.deepEqual(settings, {
          server: {
            iroh_remote_center_enabled: true,
            iroh_remote_center_allowed_peers: [BRIDGE_ENDPOINT_ID],
          },
        });
        return { server: {} };
      },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    {
      async pairDevice(id) {
        calls.push(`pair:${id}`);
      },
      async issueBundle(id) {
        calls.push(`issue:${id}`);
        return {
          device_id: id,
          subject: `V:01:D:${id}:P:00000001`,
          certificate_pem: certificate,
          private_key_pem: "private",
          ca_certificate_pem: certificate,
          root_certificate_pem: certificate,
          onboarding: {
            endpoint: "https://onboarding.cosmos.humane.cloud",
            authority: "example",
          },
        };
      },
      async getBridgeStatus() {
        calls.push("bridge-status");
        return unassignedBridgeStatus();
      },
      async pairBridge(input) {
        calls.push("pair-bridge");
        assert.deepEqual(input, {
          device_id: "00aa11bb",
          ticket: "endpoint-ticket",
          node_id: PIN_ENDPOINT_ID,
        });
        return {
          configured: true,
          connected: true,
          local_endpoint_id: BRIDGE_ENDPOINT_ID,
          device_id: "00aa11bb",
          remote_endpoint_id: PIN_ENDPOINT_ID,
        };
      },
    },
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  );

  assert.equal(status.state, "active");
  assert.deepEqual(calls, [
    "device-id",
    "unlocked",
    "status:preflight",
    "pair:00aa11bb",
    "issue:00aa11bb",
    "stage",
    "activate",
    "status:verify",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
  ]);
});

test("retry after identity activation resumes remote pairing without minting another key", async () => {
  const calls = [];
  const fingerprint = "c".repeat(64);
  const session = {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) {
        calls.push("device-id");
        return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("sys.user.0.ce_available")) {
        calls.push("unlocked");
        return { stdout: "1\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("ACTIVATION_STATUS")) {
        calls.push("status:active");
        return {
          stdout: `Result: Bundle[{ok=true, state=active, consistent=true, managed=true, remote_gate_enabled=true, target_matches=true, present=true, identity_usable=true, edge_ipv4=203.0.113.42, fingerprint_sha256=${fingerprint}, root_certificate_sha256=${fingerprint}, api_endpoint=https://api.cosmos.humane.cloud, onboarding_endpoint=https://onboarding.cosmos.humane.cloud, device_status_endpoint=https://center.example/device-status/v1/report}]\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("RESTART_RUNTIME")) {
        calls.push("restart-runtime");
        return {
          stdout: "Result: Bundle[{status=200, ok=true}]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
    async shellWithInput() {
      throw new Error("an active identity must not be replaced");
    },
  };

  const status = await provisionConnectedPin(
    session,
    {
      async updateSettings() {
        calls.push("iroh-settings");
        return { server: {} };
      },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    {
      async pairDevice(id) {
        calls.push(`pair:${id}`);
      },
      async issueBundle() {
        throw new Error("retry must not mint another one-time key");
      },
      async getBridgeStatus() {
        calls.push("bridge-status");
        return unassignedBridgeStatus();
      },
      async pairBridge() {
        calls.push("pair-bridge");
        return {
          configured: true,
          connected: true,
          local_endpoint_id: BRIDGE_ENDPOINT_ID,
          device_id: "00aa11bb",
          remote_endpoint_id: PIN_ENDPOINT_ID,
        };
      },
    },
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  );

  assert.equal(status.state, "active");
  assert.deepEqual(calls, [
    "device-id",
    "unlocked",
    "status:active",
    "pair:00aa11bb",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
  ]);
});

/** A Pin already active against this server, as a retry or a replaced Pin finds it. */
function activeSession(calls) {
  const fingerprint = "c".repeat(64);
  return {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      if (command.includes("sys.user.0.ce_available")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      if (command.includes("ACTIVATION_STATUS")) {
        calls.push("status:active");
        return {
          stdout: `Result: Bundle[{ok=true, state=active, consistent=true, managed=true, remote_gate_enabled=true, target_matches=true, present=true, identity_usable=true, edge_ipv4=203.0.113.42, fingerprint_sha256=${fingerprint}, root_certificate_sha256=${fingerprint}, api_endpoint=https://api.cosmos.humane.cloud, onboarding_endpoint=https://onboarding.cosmos.humane.cloud, device_status_endpoint=https://center.example/device-status/v1/report}]\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("RESTART_RUNTIME")) {
        calls.push("restart-runtime");
        return { stdout: "Result: Bundle[{status=200, ok=true}]\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
    async shellWithInput() {
      throw new Error("an active identity must not be replaced");
    },
  };
}

test("a remote link that cannot be read still leaves the Pin paired and activated", async () => {
  const calls = [];
  const failure = await provisionConnectedPin(
    activeSession(calls),
    {
      async updateSettings() { throw new Error("no remote settings without the bridge's endpoint"); },
      async getIrohTicket() { throw new Error("no ticket without the bridge's endpoint"); },
    },
    {
      async pairDevice(id) { calls.push(`pair:${id}`); },
      async issueBundle() { throw new Error("an active Pin needs no new key"); },
      async getBridgeStatus() {
        calls.push("bridge-status");
        throw new Error("Remote Pin access is unavailable.");
      },
      async pairBridge() { throw new Error("no bridge pairing without its status"); },
    },
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof RemoteAccessSetupError);
  assert.equal(failure.message, "This Pin is connected to Cosmos, but remote access could not be set up.");
  assert.equal(failure.reason.message, "Remote Pin access is unavailable.");
  assert.deepEqual(calls, ["status:active", "pair:00aa11bb", "bridge-status"]);
});

test("a Pin whose remote connector did not start says so, not 'Pin API 503'", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const calls = [];
  const failure = await provisionConnectedPin(
    activeSession(calls),
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        t.mock.timers.tick(15_000);
        throw new PinApiError(503, "");
      },
    },
    {
      async pairDevice(id) { calls.push(`pair:${id}`); },
      async issueBundle() { throw new Error("an active Pin needs no new key"); },
      async getBridgeStatus() { return unassignedBridgeStatus(); },
      async pairBridge() { throw new Error("no bridge pairing without a ticket"); },
    },
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof RemoteAccessSetupError);
  assert.equal(failure.reason.message, "Remote access is still starting on the Pin. Keep it connected and try again shortly.");
  assert.doesNotMatch(failure.reason.message, /Pin API/u);
  assert.deepEqual(calls, ["status:active", "pair:00aa11bb", "iroh-settings", "restart-runtime", "iroh-ticket"]);
});
