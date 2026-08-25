import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  activationCommands,
  createActivationBundleJson,
} from "../src/app/settings/pin/provision/activationBundle.ts";

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

test("provisioning gives one-file plan, confirm, and status commands", () => {
  const commands = activationCommands("00aa11bb", "203.0.113.42");
  assert.equal(commands.credentialFile, "cosmos-activation-00aa11bb.json");
  assert.equal(commands.credentialPath, "~/.config/ai-pin-revival/cosmos-activation-00aa11bb.json");
  assert.equal(
    commands.plan,
    "./revival pin activate --serial PIN_SERIAL --credential-file ~/.config/ai-pin-revival/cosmos-activation-00aa11bb.json --edge-ipv4 203.0.113.42",
  );
  assert.equal(commands.confirm, `${commands.plan} --confirm`);
  assert.equal(commands.status, "./revival pin activate status --serial PIN_SERIAL");
});

test("provisioning copy keeps the one-time PIN separate and removes split PEM instructions", () => {
  const source = readFileSync(
    new URL("../src/app/settings/pin/provision/ProvisioningView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /private key is shown only once; keep the enrollment PIN separate/u);
  assert.match(source, /isActivationBundle/u);
  assert.match(source, /maxLength=\{128\}/u);
  assert.match(source, /commands\.plan/u);
  assert.match(source, /commands\.confirm/u);
  assert.doesNotMatch(source, /device\.crt|device\.key|Complete OPAQUE/u);
  assert.doesNotMatch(source, /in this repository/u);
});
