import assert from "node:assert/strict";
import test from "node:test";

import { createActivationBundleJson } from "../src/app/admin/activationBundle.ts";

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
  }));

  assert.deepEqual(parsed, {
    device_id: "00aa11bb",
    certificate_pem: "leaf",
    private_key_pem: "private",
    ca_certificate_pem: "intermediate",
    root_certificate_pem: "root",
  });
  assert.equal(JSON.stringify(parsed).includes("secret-pin"), false);
});
