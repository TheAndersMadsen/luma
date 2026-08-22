import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLONE_ROOT_PEM,
  PinActivationError,
  activatePin,
  buildActivationEnvelope,
  parseActivationArgs,
  parseProviderBundle,
  validateActivationCredential,
  validateCredentialAgainstRoot,
} from "../pin/activate.mjs";

const SERIAL = "1H4MPA42230112";
const DEVICE_ID = "2c2a00010000abcd";
const FINGERPRINT = "ab".repeat(32);
const SECRET_MARKER = "fixture-private-key-must-never-reach-argv";

function openssl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function chainFixture() {
  const root = mkdtempSync(join(tmpdir(), "revival-activation-chain-"));
  const paths = Object.fromEntries(
    ["rootKey", "rootCert", "issuerKey", "issuerCsr", "issuerCert", "leafKey", "leafCsr", "leafCert", "issuerExt", "leafExt"]
      .map((name) => [name, join(root, name)]),
  );
  writeFileSync(paths.issuerExt, "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\n", { mode: 0o600 });
  writeFileSync(paths.leafExt, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n", { mode: 0o600 });

  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", paths.rootKey]);
  openssl(["req", "-x509", "-new", "-key", paths.rootKey, "-out", paths.rootCert, "-days", "3650", "-sha256", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign,digitalSignature"]);
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", paths.issuerKey]);
  openssl(["req", "-new", "-key", paths.issuerKey, "-out", paths.issuerCsr, "-subj", "/CN=Test Attestation CA"]);
  openssl(["x509", "-req", "-in", paths.issuerCsr, "-CA", paths.rootCert, "-CAkey", paths.rootKey, "-CAcreateserial", "-out", paths.issuerCert, "-days", "1000", "-sha256", "-extfile", paths.issuerExt]);
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", paths.leafKey]);
  openssl(["req", "-new", "-key", paths.leafKey, "-out", paths.leafCsr, "-subj", `/CN=V:01:D:${DEVICE_ID}:P:00000001`]);
  openssl(["x509", "-req", "-in", paths.leafCsr, "-CA", paths.issuerCert, "-CAkey", paths.issuerKey, "-CAcreateserial", "-out", paths.leafCert, "-days", "365", "-sha256", "-extfile", paths.leafExt]);
  for (const path of Object.values(paths)) chmodSync(path, 0o600);

  const document = {
    device_id: DEVICE_ID,
    certificate_pem: readFileSync(paths.leafCert, "utf8"),
    private_key_pem: readFileSync(paths.leafKey, "utf8"),
    ca_certificate_pem: readFileSync(paths.issuerCert, "utf8"),
  };
  return { root, paths, document, rootPem: readFileSync(paths.rootCert, "utf8") };
}

function credentialFile(document) {
  const root = mkdtempSync(join(tmpdir(), "revival-activation-credential-"));
  const file = join(root, "credential.json");
  writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function providerStatus(state = "inactive") {
  if (state === "inactive") {
    return "Result: Bundle[{ok=true, state=inactive, managed=false, present=false, identity_usable=false}]\n";
  }
  return `Result: Bundle[{ok=true, state=active, managed=true, edge_ipv4=203.0.113.9, present=true, identity_usable=true, fingerprint_sha256=${FINGERPRINT}, api_endpoint=https://api.carry.humane.cloud, onboarding_endpoint=https://onboarding.carry.humane.cloud}]\n`;
}

function fakeRuntime({ reportedSerial = SERIAL } = {}) {
  const calls = [];
  const output = [];
  let statusCalls = 0;
  const runtime = {
    environment: { ADB: "adb-fixture" },
    out: (text) => output.push(String(text)),
    err: () => {},
    validateCredential: () => ({
      deviceId: DEVICE_ID,
      certificatePem: "certificate-public-fixture",
      privateKeyPem: SECRET_MARKER,
      caCertificatePem: "issuer-public-fixture",
      fingerprintSha256: FINGERPRINT,
      subject: `CN=V:01:D:${DEVICE_ID}:P:00000001`,
    }),
    spawnSync: (command, args, options = {}) => {
      const input = options.input === undefined ? null : Buffer.from(options.input).toString("utf8");
      calls.push({ command, args: [...args], input });
      if (args.at(-1) === "get-serialno") return { status: 0, stdout: `${reportedSerial}\n`, stderr: "" };
      if (args.at(-1) === "ro.boot.deviceid") return { status: 0, stdout: `${DEVICE_ID}\n`, stderr: "" };
      if (args.includes("ACTIVATION_STATUS")) {
        statusCalls += 1;
        return { status: 0, stdout: providerStatus(statusCalls > 1 ? "active" : "inactive"), stderr: "" };
      }
      if (args.includes("ACTIVATE")) {
        return { status: 0, stdout: "Result: Bundle[{ok=true, state=activated, changed=true, managed=true, rollback_complete=true}]\n", stderr: "" };
      }
      if (args.includes("write")) return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected adb fixture call: ${args.join(" ")}`);
    },
  };
  return { runtime, calls, output, text: () => output.join("") };
}

test("activation grammar requires an exact serial and protected credential path", () => {
  assert.deepEqual(parseActivationArgs(["status", "--serial", SERIAL]), {
    command: "status",
    serial: SERIAL,
    credentialFile: null,
    edgeIpv4: null,
    confirm: false,
  });
  assert.equal(parseActivationArgs([
    "--serial", SERIAL,
    "--credential-file", "/private/credential.json",
    "--edge-ipv4", "203.0.113.9",
  ]).confirm, false);
  assert.throws(() => parseActivationArgs(["status"]), /--serial SERIAL/);
  assert.throws(() => parseActivationArgs([
    "--serial", "device;reboot", "--credential-file", "x", "--edge-ipv4", "1.2.3.4",
  ]), /valid Pin serial/);
});

test("provider response parser accepts only the bounded activation fields", () => {
  const parsed = parseProviderBundle(providerStatus("active"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state, "active");
  assert.equal(parsed.edgeIpv4, "203.0.113.9");
  assert.equal(parsed.fingerprintSha256, FINGERPRINT);
  assert.throws(() => parseProviderBundle("ok=true"), /unreadable response/);
});

test("credential validator proves the full leaf -> issuer -> selected root chain", () => {
  const fixture = chainFixture();
  const source = JSON.stringify(fixture.document);
  const credential = validateCredentialAgainstRoot(source, fixture.rootPem);
  assert.equal(credential.deviceId, DEVICE_ID);
  assert.match(credential.fingerprintSha256, /^[0-9a-f]{64}$/u);

  assert.throws(
    () => validateActivationCredential(source),
    /does not chain to the pinned clone root/,
    "the production root must not be caller-selected",
  );
  assert.doesNotThrow(() => new (awaitImportX509())(CLONE_ROOT_PEM));
});

test("host activation pins the same clone root as both installed device paths", () => {
  const sources = [
    readFileSync(new URL("../../../pin/runtime/android/src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt", import.meta.url), "utf8"),
    readFileSync(new URL("../../../pin/hook/payload/src/main/kotlin/com/penumbraos/hook/CosmosRemoteTransport.kt", import.meta.url), "utf8"),
  ];
  for (const source of sources) {
    const match = /CLONE_ROOT_PEM = """([\s\S]*?)"""/u.exec(source);
    assert.ok(match, "device path must keep an explicit pinned root");
    assert.equal(match[1], CLONE_ROOT_PEM);
  }

  const certificate = new X509Certificate(CLONE_ROOT_PEM);
  assert.equal(Buffer.byteLength(CLONE_ROOT_PEM), 687);
  assert.equal(
    createHash("sha256").update(CLONE_ROOT_PEM).digest("hex"),
    "e1fe74c7c960f070264933deed138cadc1c0d1cd3d833297422119599353b2b9",
  );
  assert.equal(
    createHash("sha256").update(`${CLONE_ROOT_PEM}\n`).digest("hex"),
    "1b947b4e4dae58dc5f8aac1863723eb0eaa313da993e2b8ec7abed38727e22ed",
  );
  assert.equal(
    certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    "7f82fbf94a370379ed238fb0c9d2e2d13316d67197faba2948c0e3d92ac3458b",
  );
  assert.equal(certificate.subject, "O=humane-carry-clone\nCN=Carry Clone Root EC 1");
});

function awaitImportX509() {
  // Keep the production-root parse assertion synchronous and dependency-free.
  return globalThis.process.getBuiltinModule("node:crypto").X509Certificate;
}

test("credential validator rejects endpoint injection and a wrong certificate subject", () => {
  const fixture = chainFixture();
  assert.throws(
    () => validateCredentialAgainstRoot(JSON.stringify({
      ...fixture.document,
      api_endpoint: "https://attacker.invalid",
    }), fixture.rootPem),
    /must not choose api_endpoint/,
  );
  assert.throws(
    () => validateCredentialAgainstRoot(JSON.stringify({
      ...fixture.document,
      device_id: "ffffffffffffffff",
    }), fixture.rootPem),
    /subject does not match/,
  );
});

test("plan mode reads target state but performs no provider write", () => {
  const file = credentialFile({ fixture: true });
  const fake = fakeRuntime();
  const result = activatePin({
    serial: SERIAL,
    credentialFile: file,
    edgeIpv4: "203.0.113.9",
    confirm: false,
  }, fake.runtime);
  assert.equal(result.changed, false);
  assert.equal(fake.calls.some((call) => call.args.includes("write")), false);
  assert.equal(fake.calls.some((call) => call.args.includes("ACTIVATE")), false);
  assert.match(fake.text(), /No device change has been made/);
  assert.doesNotMatch(fake.text(), new RegExp(SECRET_MARKER, "u"));
});

test("credential input must be a regular non-symlink file at mode 0600", () => {
  const file = credentialFile({ fixture: true });
  chmodSync(file, 0o644);
  const permissive = fakeRuntime();
  assert.throws(
    () => activatePin({ serial: SERIAL, credentialFile: file, edgeIpv4: "203.0.113.9", confirm: false }, permissive.runtime),
    /mode 0600/,
  );

  chmodSync(file, 0o600);
  const link = `${file}.link`;
  symlinkSync(file, link);
  const linked = fakeRuntime();
  assert.throws(
    () => activatePin({ serial: SERIAL, credentialFile: link, edgeIpv4: "203.0.113.9", confirm: false }, linked.runtime),
    /regular file, not a link/,
  );
});

test("confirmed activation streams the envelope on stdin and verifies postconditions", () => {
  const file = credentialFile({ fixture: true });
  const fake = fakeRuntime();
  const result = activatePin({
    serial: SERIAL,
    credentialFile: file,
    edgeIpv4: "203.0.113.9",
    confirm: true,
  }, fake.runtime);
  assert.equal(result.changed, true);
  const write = fake.calls.find((call) => call.args.includes("write"));
  assert.ok(write);
  assert.equal(write.args.some((value) => value.includes(SECRET_MARKER)), false);
  assert.equal(write.args.some((value) => value.endsWith(".json") && !value.startsWith("content://")), false);
  const envelope = JSON.parse(write.input);
  assert.equal(envelope.private_key_pem, SECRET_MARKER);
  assert.equal(envelope.api_endpoint, "https://api.carry.humane.cloud");
  assert.equal(envelope.onboarding_endpoint, "https://onboarding.carry.humane.cloud");
  assert.equal(envelope.edge_ipv4, "203.0.113.9");
  assert.equal(fake.calls.some((call) => call.args.includes("push")), false);
  assert.doesNotMatch(fake.text(), new RegExp(SECRET_MARKER, "u"));
});

test("exact target mismatch fails before credential staging", () => {
  const file = credentialFile({ fixture: true });
  const fake = fakeRuntime({ reportedSerial: "another-device" });
  assert.throws(
    () => activatePin({
      serial: SERIAL,
      credentialFile: file,
      edgeIpv4: "203.0.113.9",
      confirm: true,
    }, fake.runtime),
    (error) => error instanceof PinActivationError && error.code === "serial-mismatch",
  );
  assert.equal(fake.calls.length, 1);
});

test("activation envelope rejects noncanonical IPv4 and fixes both endpoints", () => {
  const credential = {
    deviceId: DEVICE_ID,
    certificatePem: "cert",
    privateKeyPem: "key",
    caCertificatePem: "ca",
  };
  assert.throws(() => buildActivationEnvelope(credential, "203.000.113.9"), /canonical edge IPv4/);
  const envelope = buildActivationEnvelope(credential, "203.0.113.9");
  assert.equal(envelope.api_endpoint, "https://api.carry.humane.cloud");
  assert.equal(envelope.onboarding_endpoint, "https://onboarding.carry.humane.cloud");
});
