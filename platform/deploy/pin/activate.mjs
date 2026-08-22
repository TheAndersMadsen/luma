#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateDeviceSerial } from "../acceptance/pin/device-target-guard.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const PROVIDER_URI = "content://com.penumbraos.server.carryidentity";
const STAGING_URI = `${PROVIDER_URI}/attestation.json`;
const API_ENDPOINT = "https://api.carry.humane.cloud";
const ONBOARDING_ENDPOINT = "https://onboarding.carry.humane.cloud";
const DEVICE_ID_RE = /^[0-9a-f]+$/u;

// Exact certificate pinned by the installed runtime and hook. Host activation
// accepts no flag or environment override for this trust root.
export const CLONE_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBzzCCAXWgAwIBAgIUG0G9aHsMfyhLhDfspkqgDopmdXwwCgYIKoZIzj0EAwIw
PTEbMBkGA1UECgwSaHVtYW5lLWNhcnJ5LWNsb25lMR4wHAYDVQQDDBVDYXJyeSBD
bG9uZSBSb290IEVDIDEwHhcNMjYwODAxMTEzMTQ5WhcNMzYwNzI5MTEzMTQ5WjA9
MRswGQYDVQQKDBJodW1hbmUtY2FycnktY2xvbmUxHjAcBgNVBAMMFUNhcnJ5IENs
b25lIFJvb3QgRUMgMTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABM7QiKCUWid8
QLtJVzmr+bLLEvyRIrel6v+gpdY59d2DgmCo3Qv1f0eNPTHYvIw08Wr+gz7wI1pt
nRGPzfZZv4ujUzBRMB0GA1UdDgQWBBRk8MPuXmmegN70uNHAAz3ewVE5BzAfBgNV
HSMEGDAWgBRk8MPuXmmegN70uNHAAz3ewVE5BzAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0gAMEUCIHWX228mwwn7IACG3gFPYKpVMjlCh1z9cME+aMmIoFUI
AiEArCIbto59wRwtioqqBalsCroF8W5OjMCzqE3jlvN4w18=
-----END CERTIFICATE-----`;

export class PinActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinActivationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinActivationError(code, message);
}

function canonicalIpv4(value) {
  if (typeof value !== "string") fail("edge-invalid", "a canonical edge IPv4 address is required");
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255)
  ) {
    fail("edge-invalid", "a canonical edge IPv4 address is required");
  }
  return parts.join(".");
}

function requireSinglePem(source, label, kind) {
  const expression = new RegExp(
    `^-----BEGIN ${kind}-----\\r?\\n[0-9A-Za-z+/=\\r\\n]+-----END ${kind}-----\\r?\\n?$`,
    "u",
  );
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_CREDENTIAL_BYTES || !expression.test(source)) {
    fail("credential-invalid", `${label} must contain exactly one PEM ${kind} block`);
  }
}

function validNow(certificate, label, now = Date.now()) {
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || now < notBefore || now >= notAfter) {
    fail("credential-validity", `${label} is not currently valid`);
  }
}

function fingerprint(certificate) {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

function certificateCommonName(certificate) {
  const line = certificate.subject.split(/\r?\n/u).find((value) => value.startsWith("CN="));
  return line?.slice(3) ?? null;
}

function parseCredentialDocument(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("credential-invalid", "credential file is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("credential-invalid", "credential file must contain one JSON object");
  }
  for (const key of ["api_endpoint", "onboarding_endpoint", "edge_ipv4"]) {
    if (Object.hasOwn(value, key)) {
      fail("credential-invalid", `credential file must not choose ${key}; activation fixes its own endpoints`);
    }
  }
  for (const key of ["device_id", "certificate_pem", "private_key_pem", "ca_certificate_pem"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      fail("credential-invalid", `credential file is missing ${key}`);
    }
  }
  const deviceId = value.device_id.trim().toLowerCase();
  if (!DEVICE_ID_RE.test(deviceId)) fail("credential-invalid", "credential device_id must be hexadecimal");
  return Object.freeze({
    deviceId,
    certificatePem: value.certificate_pem,
    privateKeyPem: value.private_key_pem,
    caCertificatePem: value.ca_certificate_pem,
  });
}

/**
 * Full fixed-chain validation, parameterized only for isolated host tests.
 * Production calls validateActivationCredential(), whose root is not
 * caller-selectable.
 */
export function validateCredentialAgainstRoot(source, rootPem, options = {}) {
  const parsed = parseCredentialDocument(source);
  requireSinglePem(parsed.certificatePem, "device certificate", "CERTIFICATE");
  requireSinglePem(parsed.caCertificatePem, "attestation CA certificate", "CERTIFICATE");
  requireSinglePem(parsed.privateKeyPem, "device private key", "PRIVATE KEY");

  let root;
  let issuer;
  let leaf;
  let key;
  try {
    root = new X509Certificate(rootPem);
    issuer = new X509Certificate(parsed.caCertificatePem);
    leaf = new X509Certificate(parsed.certificatePem);
  } catch {
    fail("credential-invalid", "credential certificate chain is not valid X.509 PEM");
  }
  try {
    key = createPrivateKey(parsed.privateKeyPem);
  } catch {
    fail("credential-invalid", "credential private key is not usable PKCS#8 PEM");
  }

  validNow(root, "pinned clone root", options.now);
  validNow(issuer, "attestation CA certificate", options.now);
  validNow(leaf, "device certificate", options.now);
  if (!root.ca || !root.verify(root.publicKey)) {
    fail("credential-chain", "pinned clone root is not a self-signed CA");
  }
  if (!issuer.ca || !issuer.checkIssued(root) || !issuer.verify(root.publicKey)) {
    fail("credential-chain", "attestation CA does not chain to the pinned clone root");
  }
  if (leaf.ca || !leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
    fail("credential-chain", "device certificate does not chain to the attestation CA");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    fail("credential-invalid", "device private key must be EC P-256");
  }
  if (!leaf.checkPrivateKey(key)) {
    fail("credential-key-mismatch", "device certificate and private key do not match");
  }
  const expectedSubject = `V:01:D:${parsed.deviceId}:P:00000001`;
  if (certificateCommonName(leaf)?.toLowerCase() !== expectedSubject.toLowerCase()) {
    fail("credential-subject", "device certificate subject does not match credential device_id");
  }

  return Object.freeze({
    ...parsed,
    fingerprintSha256: fingerprint(leaf),
    subject: leaf.subject,
    validTo: leaf.validTo,
  });
}

export function validateActivationCredential(source, options = {}) {
  return validateCredentialAgainstRoot(source, CLONE_ROOT_PEM, options);
}

function requireCredentialFile(candidate) {
  const selected = resolve(candidate);
  let metadata;
  try {
    metadata = lstatSync(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("credential-missing", "credential file is missing");
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail("credential-invalid", "credential file must be a nonempty regular file, not a link");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    fail("credential-permissions", "credential file must have mode 0600");
  }
  if (metadata.size > MAX_CREDENTIAL_BYTES) {
    fail("credential-invalid", "credential file exceeds the 64 KiB provider limit");
  }
  return selected;
}

export function buildActivationEnvelope(credential, edgeIpv4) {
  return Object.freeze({
    api_endpoint: API_ENDPOINT,
    onboarding_endpoint: ONBOARDING_ENDPOINT,
    edge_ipv4: canonicalIpv4(edgeIpv4),
    device_id: credential.deviceId,
    certificate_pem: credential.certificatePem,
    private_key_pem: credential.privateKeyPem,
    ca_certificate_pem: credential.caCertificatePem,
  });
}

export function parseProviderBundle(output) {
  const text = String(output).trim();
  const match = /^Result: Bundle\[\{([\s\S]*)\}\]$/u.exec(text);
  if (!match) fail("provider-response", "Pin identity provider returned an unreadable response");
  const body = match[1];
  const read = (name, pattern) => {
    const field = new RegExp(`(?:^|,\\s*)${name}=(${pattern})(?=,\\s*|$)`, "u").exec(body);
    return field?.[1] ?? null;
  };
  return Object.freeze({
    ok: read("ok", "true|false") === "true",
    state: read("state", "[a-z_]+"),
    changed: read("changed", "true|false") === "true",
    managed: read("managed", "true|false") === "true",
    rollbackComplete: read("rollback_complete", "true|false") === "true",
    edgeIpv4: read("edge_ipv4", "[0-9.]+"),
    fingerprintSha256: read("fingerprint_sha256", "[0-9a-fA-F]{64}")?.toLowerCase() ?? null,
    apiEndpoint: read("api_endpoint", "https://api\\.carry\\.humane\\.cloud"),
    onboardingEndpoint: read("onboarding_endpoint", "https://onboarding\\.carry\\.humane\\.cloud"),
    identityPresent: read("present", "true|false") === "true",
    identityUsable: read("identity_usable", "true|false") === "true",
  });
}

function defaultRuntime() {
  return {
    environment: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    spawnSync,
    validateCredential: validateActivationCredential,
  };
}

function adb(runtime, serial, args, options = {}) {
  const result = runtime.spawnSync(runtime.environment.ADB ?? "adb", ["-s", serial, ...args], {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") fail("adb-missing", "adb is required for Pin activation");
  if (result.status !== 0) {
    // Never quote child output for the sensitive staging call: a hostile or
    // broken adb wrapper must not be able to reflect stdin into our error.
    fail("adb-failed", options.sensitive ? "Pin credential staging failed" : `adb ${args[0]} failed`);
  }
  return String(result.stdout ?? "");
}

export function ensureExactPinTarget(runtime, serial) {
  const selected = validateDeviceSerial(serial, "Pin serial");
  const reported = adb(runtime, selected, ["get-serialno"]).trim();
  if (reported !== selected) fail("serial-mismatch", "connected device did not report the exact requested Pin serial");
  return selected;
}

function hardwareId(runtime, serial) {
  const id = adb(runtime, serial, ["shell", "getprop", "ro.boot.deviceid"]).trim().toLowerCase();
  if (!DEVICE_ID_RE.test(id)) fail("device-id", "Pin hardware id is unavailable or invalid");
  return id;
}

export function readActivationStatus(runtime, serial) {
  const selected = ensureExactPinTarget(runtime, serial);
  return parseProviderBundle(adb(runtime, selected, [
    "shell", "content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATION_STATUS",
  ]));
}

function verifyActivePostcondition(status, expected) {
  if (
    !status.ok ||
    status.state !== "active" ||
    !status.managed ||
    !status.identityPresent ||
    !status.identityUsable ||
    status.edgeIpv4 !== expected.edgeIpv4 ||
    status.fingerprintSha256 !== expected.fingerprintSha256 ||
    status.apiEndpoint !== API_ENDPOINT ||
    status.onboardingEndpoint !== ONBOARDING_ENDPOINT
  ) {
    fail("postcondition", "Pin activation postconditions did not match the requested identity and edge");
  }
}

export function parseActivationArgs(args) {
  const values = [...args];
  let command = "activate";
  if (values[0] === "status") {
    command = values.shift();
  }
  let serial = null;
  let credentialFile = null;
  let edgeIpv4 = null;
  let confirm = false;
  while (values.length > 0) {
    const option = values.shift();
    if (option === "--serial" && serial === null && values.length > 0) serial = values.shift();
    else if (command === "activate" && option === "--credential-file" && credentialFile === null && values.length > 0) credentialFile = values.shift();
    else if (command === "activate" && option === "--edge-ipv4" && edgeIpv4 === null && values.length > 0) edgeIpv4 = values.shift();
    else if (command === "activate" && option === "--confirm" && !confirm) confirm = true;
    else fail("usage", command === "status"
      ? "usage: pin activate status --serial SERIAL"
      : "usage: pin activate --serial SERIAL --credential-file FILE --edge-ipv4 A.B.C.D [--confirm]");
  }
  if (!serial || (command === "status" && (credentialFile || edgeIpv4 || confirm))) {
    fail("usage", command === "status"
      ? "usage: pin activate status --serial SERIAL"
      : "usage: pin activate --serial SERIAL --credential-file FILE --edge-ipv4 A.B.C.D [--confirm]");
  }
  if (command === "activate" && (!credentialFile || !edgeIpv4)) {
    fail("usage", "usage: pin activate --serial SERIAL --credential-file FILE --edge-ipv4 A.B.C.D [--confirm]");
  }
  return Object.freeze({ command, serial: validateDeviceSerial(serial, "Pin serial"), credentialFile, edgeIpv4, confirm });
}

export function activatePin(options, runtime = defaultRuntime()) {
  const serial = ensureExactPinTarget(runtime, options.serial);
  const file = requireCredentialFile(options.credentialFile);
  let sourceBytes;
  let envelopeSource;
  try {
    sourceBytes = readFileSync(file);
    const credential = runtime.validateCredential(sourceBytes.toString("utf8"));
    const deviceId = hardwareId(runtime, serial);
    if (credential.deviceId !== deviceId) {
      fail("device-mismatch", "credential does not name the exact connected Pin");
    }
    const envelope = buildActivationEnvelope(credential, options.edgeIpv4);
    const before = parseProviderBundle(adb(runtime, serial, [
      "shell", "content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATION_STATUS",
    ]));
    runtime.out(
      `Plan: activate Pin ${serial} for edge ${envelope.edge_ipv4}.\n` +
      `  credential SHA-256: ${credential.fingerprintSha256}\n` +
      `  current state: ${before.state ?? "unknown"}\n` +
      "  endpoints: fixed stock Humane hostnames over HTTPS\n" +
      "No device change has been made. Re-run with --confirm to stage and activate.\n",
    );
    if (!options.confirm) return Object.freeze({ changed: false, before });

    envelopeSource = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    adb(
      runtime,
      serial,
      ["shell", "content", "write", "--uri", STAGING_URI],
      { input: envelopeSource, sensitive: true },
    );
    const activation = parseProviderBundle(adb(runtime, serial, [
      "shell", "content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATE",
    ]));
    if (!activation.ok || !["activated", "already_active"].includes(activation.state)) {
      fail("activation-rejected", `Pin rejected activation (${activation.state ?? "unknown"})`);
    }
    const after = parseProviderBundle(adb(runtime, serial, [
      "shell", "content", "call", "--uri", PROVIDER_URI, "--method", "ACTIVATION_STATUS",
    ]));
    verifyActivePostcondition(after, {
      edgeIpv4: envelope.edge_ipv4,
      fingerprintSha256: credential.fingerprintSha256,
    });
    runtime.out(`Activated Pin ${serial}; provider postconditions match.\n`);
    return Object.freeze({ changed: activation.changed, before, activation, after });
  } finally {
    sourceBytes?.fill(0);
    envelopeSource?.fill(0);
  }
}

export function main(args = process.argv.slice(2), runtime = defaultRuntime()) {
  const options = parseActivationArgs(args);
  if (options.command === "status") {
    const status = readActivationStatus(runtime, options.serial);
    runtime.out(
      `Pin ${options.serial}: ${status.state ?? "unknown"}` +
      `${status.edgeIpv4 ? `, edge ${status.edgeIpv4}` : ""}` +
      `${status.managed ? ", managed" : ""}\n`,
    );
    return status;
  }
  return activatePin(options, runtime);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = error instanceof PinActivationError && error.code === "usage" ? 64 : 1;
  }
}
