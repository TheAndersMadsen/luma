import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  createActivationBundleJson,
} from "../src/app/settings/pin/provision/activationBundle.ts";
import {
  buildActivationEnvelope,
  parseActivationStatus,
} from "../src/app/settings/pin/provision/browserActivation.ts";

test("provisioning downloads one activation document with the complete certificate chain", () => {
  const parsed = JSON.parse(createActivationBundleJson({
    device_id: "00aa11bb",
    subject: "V:01:D:00aa11bb:P:00000001",
    certificate_pem: "leaf",
    private_key_pem: "private",
    ca_certificate_pem: "intermediate",
    root_certificate_pem: "root",
    pincode: "secret-pin",
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
  assert.equal(JSON.stringify(parsed).includes("secret-pin"), false);
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
    pincode: "secret-pin",
    onboarding: { endpoint: "https://onboarding.cosmos.humane.cloud", authority: "example" },
  }, "203.0.113.42", "https://center.example/device-status/v1/report");

  assert.equal(result.envelope.api_endpoint, "https://api.cosmos.humane.cloud");
  assert.equal(result.envelope.onboarding_endpoint, "https://onboarding.cosmos.humane.cloud");
  assert.equal(result.envelope.edge_ipv4, "203.0.113.42");
  assert.equal(result.envelope.root_certificate_der_b64, "AQID");
  assert.equal(JSON.stringify(result.envelope).includes("secret-pin"), false);
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
  assert.match(source, /activateConnectedPin/u);
  assert.match(source, /isActivationBundle/u);
  assert.match(source, /maxLength=\{128\}/u);
  assert.doesNotMatch(source, /commands\.plan|commands\.confirm|Move .*0700/u);
  assert.doesNotMatch(source, /device\.crt|device\.key|Complete OPAQUE/u);
  assert.doesNotMatch(source, /in this repository/u);
});
