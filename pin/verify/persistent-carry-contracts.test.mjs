import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PIN = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, PIN), "utf8");

const paths = Object.freeze({
  activation: "runtime/android/src/main/kotlin/com/penumbraos/server/CosmosActivationTransaction.kt",
  provider: "runtime/android/src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt",
  manifest: "runtime/android/src/main/AndroidManifest.xml",
  reporter: "runtime/android/src/main/kotlin/com/penumbraos/server/DeviceStatusReporter.kt",
  transport: "hook/payload/src/main/kotlin/com/penumbraos/hook/CosmosRemoteTransport.kt",
  onboarding: "hook/payload/src/main/kotlin/com/penumbraos/hook/CosmosOnboardingAutomation.kt",
});

const EXPECTED_ROOT_FINGERPRINT =
  "7F:82:FB:F9:4A:37:03:79:ED:23:8F:B0:C9:D2:E2:D1:33:16:D6:71:97:FA:BA:29:48:C0:E3:D9:2A:C3:45:8B";

function embeddedPem(source) {
  const match = /CLONE_ROOT_PEM\s*=\s*"""(-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)"""/u.exec(source);
  assert.ok(match, "the pinned clone root PEM disappeared");
  return match[1];
}

test("logical Cosmos activation reads only the pre-rename persisted Pin namespace", async () => {
  const [activation, transport, onboarding] = await Promise.all([
    read(paths.activation),
    read(paths.transport),
    read(paths.onboarding),
  ]);

  for (const literal of [
    "penumbra_carry_remote_mode",
    "penumbra_carry_edge_ipv4",
    "penumbra_carry_attestation_bundle_b64",
    "penumbra_carry_device_attestation_v1",
  ]) {
    assert.ok(activation.includes(`\"${literal}\"`), literal);
    assert.ok(transport.includes(`\"${literal}\"`), literal);
  }
  assert.ok(onboarding.includes('"penumbra_carry_onboarding_pincode"'));

  for (const source of [activation, transport, onboarding]) {
    assert.doesNotMatch(source, /"penumbra_cosmos_/u);
  }
});

test("provider and manifest keep the deployed content authority and key alias", async () => {
  const [provider, manifest] = await Promise.all([
    read(paths.provider),
    read(paths.manifest),
  ]);
  assert.ok(provider.includes('const val AUTHORITY = "com.penumbraos.server.carryidentity"'));
  assert.ok(manifest.includes('android:authorities="com.penumbraos.server.carryidentity"'));
  assert.ok(provider.includes("CosmosActivationContract.ATTESTATION_KEY_ALIAS"));
  assert.doesNotMatch(provider, /com\.penumbraos\.server\.cosmosidentity/u);
  assert.doesNotMatch(manifest, /com\.penumbraos\.server\.cosmosidentity/u);
});

test("API, onboarding, connectivity, and status keep their Carry wire authorities", async () => {
  const [activation, transport, reporter] = await Promise.all([
    read(paths.activation),
    read(paths.transport),
    read(paths.reporter),
  ]);
  for (const host of ["api.carry.humane.cloud", "onboarding.carry.humane.cloud"]) {
    assert.ok(activation.includes(`\"${host}\"`), host);
    assert.ok(transport.includes(`\"${host}`), host);
  }
  for (const host of [
    "connectivity-check.carry.humane.cloud",
    "n.carry.humane.cloud",
  ]) {
    assert.ok(transport.includes(`\"${host}\"`), host);
  }
  assert.ok(reporter.includes("https://carry-api.andersmadsen.dk/device-status/v1/report"));
  assert.doesNotMatch(`${activation}\n${transport}\n${reporter}`, /(?:^|[.])cosmos\.humane\.cloud|cosmos-api\.andersmadsen\.dk/u);
});

test("both Pin consumers pin the unchanged Carry root documented for operators", async () => {
  const [transport, provider, readme] = await Promise.all([
    read(paths.transport),
    read(paths.provider),
    read("README.md"),
  ]);
  const transportPem = embeddedPem(transport);
  const providerPem = embeddedPem(provider);
  assert.equal(transportPem, providerPem, "Hook and Server trust different roots");

  const root = new X509Certificate(transportPem);
  assert.match(root.subject, /O=humane-carry-clone/u);
  assert.match(root.subject, /CN=Carry Clone Root EC 1/u);
  assert.equal(root.subject, root.issuer);
  assert.equal(root.fingerprint256, EXPECTED_ROOT_FINGERPRINT);
  assert.ok(readme.includes("O=humane-carry-clone, CN=Carry Clone Root EC 1"));
  assert.ok(readme.includes(EXPECTED_ROOT_FINGERPRINT));
});
