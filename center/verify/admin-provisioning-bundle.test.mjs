import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";


const { createActivationBundleJson } = await import(
  "../src/app/settings/pin/provision/activationBundle.ts"
);
const {
  buildActivationEnvelope,
  EnrollmentIncompleteError,
  OnboardingLaunchError,
  parseActivationStatus,
  provisionConnectedPin,
  reenrollConnectedPin,
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
  const pairDevice = /async pairDevice\(id[^)]*\) \{([\s\S]*?)\n\s*\},\n\s*async issueBundle/u.exec(source)?.[1];
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
  const activatePin = /async function runActivation\(([\s\S]*?)\n  \}\n\n  function activatePin/u.exec(source)?.[1];
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
        hasDeviceReported() {
          throw new Error("reporting must not be consulted before device preflight");
        },
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
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        return { stdout: "null\n", stderr: "", exitCode: 0 };
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
        hasDeviceReported: async () => true,
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
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        calls.push("duc-flag");
        return { stdout: "null\n", stderr: "", exitCode: 0 };
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
      hasDeviceReported: async () => true,
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
    "duc-flag",
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
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        calls.push("duc-flag");
        return { stdout: "null\n", stderr: "", exitCode: 0 };
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
      hasDeviceReported: async () => true,
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
    "duc-flag",
    "pair:00aa11bb",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
  ]);
});

/** A Pin already active against this server, as a retry or a replaced Pin finds it. */
function activeSession(calls, ducFlag = "null") {
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
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        calls.push("duc-flag");
        return { stdout: `${ducFlag}\n`, stderr: "", exitCode: 0 };
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
      hasDeviceReported: async () => true,
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
  assert.deepEqual(calls, ["status:active", "duc-flag", "pair:00aa11bb", "bridge-status"]);
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
      hasDeviceReported: async () => true,
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
  assert.deepEqual(calls, ["status:active", "duc-flag", "pair:00aa11bb", "iroh-settings", "restart-runtime", "iroh-ticket"]);
});

test("a Pin that finished its original setup but never reported to this server stops before pairing or issuance", async () => {
  const calls = [];
  const session = {
    async shell(command) {
      if (command.includes("ro.boot.deviceid")) {
        return { stdout: "00aa11bb\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("sys.user.0.ce_available")) {
        return { stdout: "1\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("ACTIVATION_STATUS")) {
        calls.push("status:preflight");
        return {
          stdout: "Result: Bundle[{ok=true, state=inactive, consistent=true, managed=false, remote_gate_enabled=false, target_matches=false, present=false, identity_usable=false}]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        calls.push("duc-flag");
        return { stdout: "1\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  };

  const failure = await provisionConnectedPin(
    session,
    {
      async updateSettings() { throw new Error("no remote settings before pairing"); },
      async getIrohTicket() { throw new Error("no ticket before pairing"); },
    },
    {
      hasDeviceReported: async () => {
        calls.push("reported");
        return false;
      },
      async pairDevice() { calls.push("pair:00aa11bb"); },
      async issueBundle() { calls.push("issue:00aa11bb"); },
      async getBridgeStatus() { calls.push("bridge-status"); return unassignedBridgeStatus(); },
      async pairBridge() { calls.push("pair-bridge"); },
    },
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof EnrollmentIncompleteError);
  assert.equal(
    failure.message,
    "This server hasn't issued this Pin its credential yet. Run this Pin's original setup to connect it.",
  );
  assert.equal(failure.status.state, "inactive");
  assert.deepEqual(calls, ["status:preflight", "duc-flag", "reported"]);
});

test("a provisioned Pin that has reported to this server keeps its silent fast path", async () => {
  const calls = [];
  const status = await provisionConnectedPin(
    activeSession(calls, "1"),
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    {
      hasDeviceReported: async () => {
        calls.push("reported");
        return true;
      },
      async pairDevice(id) { calls.push(`pair:${id}`); },
      async issueBundle() { throw new Error("an active Pin needs no new key"); },
      async getBridgeStatus() { calls.push("bridge-status"); return unassignedBridgeStatus(); },
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
    "status:active",
    "duc-flag",
    "reported",
    "pair:00aa11bb",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
  ]);
});

test("re-enrollment of an active Pin whose flag is already 0 activates without re-offering itself", async () => {
  const calls = [];
  const session = reenrollSession(calls, { initialFlag: "0" });
  const status = await reenrollConnectedPin(
    session,
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  );
  assert.equal(status.state, "active");
  assert.ok(calls.includes("activate"));
  assert.equal(calls.at(-1), "am-start");
});

/**
 * A re-enrollment target: active (so it must be deactivated first), with the
 * stock `DUC_PROVISIONED` flag armed until the re-arm writes it back. The
 * activation phases are tracked so each `ACTIVATION_STATUS` answer matches the
 * step that asks: 1 the re-enrollment preflight, 2 the delegated provisioning
 * preflight after deactivation and re-arm, 3 the post-activation verification.
 */
function reenrollSession(
  calls,
  { rollbackComplete = true, readback = null, amStartExitCode = 0, initialFlag = "1", overrideReadback = null } = {},
) {
  // The SHA-256 of the DER behind the "AQID" certificate the operations below
  // issue: the post-activation verification compares it against the envelope.
  const fingerprint = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
  const verified = `Result: Bundle[{ok=true, state=active, consistent=true, managed=true, remote_gate_enabled=true, target_matches=true, present=true, identity_usable=true, edge_ipv4=203.0.113.42, fingerprint_sha256=${fingerprint}, root_certificate_sha256=${fingerprint}, api_endpoint=https://api.cosmos.humane.cloud, onboarding_endpoint=https://onboarding.cosmos.humane.cloud, device_status_endpoint=https://center.example/device-status/v1/report}]\n`;
  let phase = 1;
  let flagArmed = initialFlag === "1";
  let overrideSet = false;
  return {
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
        calls.push(`status:${phase}`);
        if (phase === 3) return { stdout: verified, stderr: "", exitCode: 0 };
        if (phase === 2) {
          return {
            stdout: "Result: Bundle[{ok=true, state=inactive, consistent=true, managed=false, remote_gate_enabled=false, target_matches=false, present=false, identity_usable=false}]\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: verified, stderr: "", exitCode: 0 };
      }
      if (command.includes("DEACTIVATE")) {
        calls.push("deactivate");
        phase = 2;
        return {
          stdout: `Result: Bundle[{ok=true, state=deactivated, rollback_complete=${rollbackComplete}}]\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("CLEAR")) {
        calls.push("clear");
        return { stdout: "Result: Bundle[{ok=true, state=cleared, rollback_complete=true}]\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("humane_allow_oobe_after_provisioned")) {
        if (command[1] === "put") {
          assert.deepEqual(command, ["settings", "put", "global", "humane_allow_oobe_after_provisioned", "1"]);
          calls.push("oobe-put");
          overrideSet = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        calls.push("oobe-read");
        return { stdout: `${overrideReadback ?? (overrideSet ? "1" : "null")}\n`, stderr: "", exitCode: 0 };
      }
      if (command[0] === "am" && command[1] === "force-stop") {
        assert.deepEqual(command, ["am", "force-stop", "humane.experience.onboarding"]);
        calls.push("force-stop");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command[0] === "settings" && command[1] === "put") {
        calls.push("flag-put");
        flagArmed = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("humane.settings.global.DUC_PROVISIONED")) {
        calls.push("flag-read");
        return { stdout: `${readback ?? (flagArmed ? "1" : "0")}\n`, stderr: "", exitCode: 0 };
      }
      if (command.includes("ACTIVATE")) {
        calls.push("activate");
        phase = 3;
        return { stdout: "Result: Bundle[{ok=true, state=activated}]\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("RESTART_RUNTIME")) {
        calls.push("restart-runtime");
        return { stdout: "Result: Bundle[{status=200, ok=true}]\n", stderr: "", exitCode: 0 };
      }
      if (command[0] === "am") {
        calls.push("am-start");
        return { stdout: "Starting: Intent\n", stderr: "", exitCode: amStartExitCode };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
    async shellWithInput(command) {
      calls.push("stage");
      assert.deepEqual(command, [
        "content",
        "write",
        "--uri",
        "content://com.penumbraos.server.cosmosidentity/attestation.json",
      ]);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function reenrollOperations(calls) {
  return {
    hasDeviceReported: async () => {
      calls.push("reported");
      return false;
    },
    async pairDevice(id) { calls.push(`pair:${id}`); },
    async issueBundle(id) {
      calls.push(`issue:${id}`);
      return {
        device_id: id,
        subject: `V:01:D:${id}:P:00000001`,
        certificate_pem: "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
        private_key_pem: "private",
        ca_certificate_pem: "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
        root_certificate_pem: "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
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
  };
}

test("re-enrollment deactivates, re-arms the stock ceremony, activates, then launches it, in that order", async () => {
  const calls = [];
  const status = await reenrollConnectedPin(
    reenrollSession(calls),
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  );

  assert.equal(status.state, "active");
  assert.deepEqual(calls, [
    "device-id",
    "unlocked",
    "status:1",
    "flag-read",
    "deactivate",
    "clear",
    "flag-put",
    "flag-read",
    "device-id",
    "unlocked",
    "status:2",
    "flag-read",
    "pair:00aa11bb",
    "issue:00aa11bb",
    "stage",
    "activate",
    "status:3",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
    "oobe-put",
    "oobe-read",
    "force-stop",
    "am-start",
  ]);
});

test("an incomplete deactivation rollback refuses re-enrollment before any write", async () => {
  const calls = [];
  const failure = await reenrollConnectedPin(
    reenrollSession(calls, { rollbackComplete: false }),
    {
      async updateSettings() { throw new Error("no remote settings after a refused rollback"); },
      async getIrohTicket() { throw new Error("no ticket after a refused rollback"); },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof Error);
  assert.equal(
    failure.message,
    "This Pin could not restore its previous settings. Nothing was changed; try again.",
  );
  assert.deepEqual(calls, ["device-id", "unlocked", "status:1", "flag-read", "deactivate"]);
});

test("a failed flag readback refuses re-enrollment before activation", async () => {
  const calls = [];
  const failure = await reenrollConnectedPin(
    reenrollSession(calls, { readback: "1" }),
    {
      async updateSettings() { throw new Error("no remote settings without a re-armed flag"); },
      async getIrohTicket() { throw new Error("no ticket without a re-armed flag"); },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof Error);
  assert.equal(
    failure.message,
    "Center couldn't re-arm this Pin's original setup. Nothing was changed; try again.",
  );
  assert.deepEqual(calls, [
    "device-id",
    "unlocked",
    "status:1",
    "flag-read",
    "deactivate",
    "clear",
    "flag-put",
    "flag-read",
  ]);
});

test("a failed ceremony launch reports OnboardingLaunchError after activation succeeded", async () => {
  const calls = [];
  const failure = await reenrollConnectedPin(
    reenrollSession(calls, { amStartExitCode: 1 }),
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof OnboardingLaunchError);
  assert.equal(
    failure.message,
    "This Pin is connected to your server, but its setup screen didn't open. Restart the Pin and finish setup in Guided setup.",
  );
  assert.equal(failure.status.state, "active");
  assert.deepEqual(calls, [
    "device-id",
    "unlocked",
    "status:1",
    "flag-read",
    "deactivate",
    "clear",
    "flag-put",
    "flag-read",
    "device-id",
    "unlocked",
    "status:2",
    "flag-read",
    "pair:00aa11bb",
    "issue:00aa11bb",
    "stage",
    "activate",
    "status:3",
    "bridge-status",
    "iroh-settings",
    "restart-runtime",
    "iroh-ticket",
    "pair-bridge",
    "oobe-put",
    "oobe-read",
    "force-stop",
    "am-start",
  ]);
});

test("an override that does not read back reports OnboardingLaunchError without launching the skipped flow", async () => {
  const calls = [];
  const failure = await reenrollConnectedPin(
    reenrollSession(calls, { overrideReadback: "null" }),
    {
      async updateSettings() { calls.push("iroh-settings"); return { server: {} }; },
      async getIrohTicket() {
        calls.push("iroh-ticket");
        return { ticket: "endpoint-ticket", node_id: PIN_ENDPOINT_ID };
      },
    },
    reenrollOperations(calls),
    "203.0.113.42",
    "https://center.example/device-status/v1/report",
  ).catch((error) => error);

  assert.ok(failure instanceof OnboardingLaunchError);
  assert.equal(failure.status.state, "active");
  assert.deepEqual(calls.slice(-3), ["pair-bridge", "oobe-put", "oobe-read"]);
});
