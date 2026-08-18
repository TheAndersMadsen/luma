#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../..");
const MAX_PEM_BYTES = 64 * 1024;
const DEVICE_USER_SUBJECT = "/O=Humane/OU=DeviceUser/CN=Cosmos Clone DeviceUser CA";

export class PkiToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PkiToolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PkiToolError(code, message);
}

function defaultSecretsDirectory(environment = process.env) {
  const config = resolve(
    environment.REVIVAL_CONFIG_DIR ??
      join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-pin-revival"),
  );
  return resolve(
    environment.REVIVAL_SECRETS_DIR ??
      (environment.REVIVAL_CONFIG_DIR ? join(config, "secrets") : join(config, "secrets")),
  );
}

export function deviceUserCaPaths(environment = process.env) {
  const root = join(defaultSecretsDirectory(environment), "pki");
  return Object.freeze({
    root,
    certificate: join(root, "duc-ca.crt"),
    key: join(root, "duc-ca.key"),
  });
}

function canonicalCandidate(candidate) {
  let existing = resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      const metadata = lstatSync(existing);
      if (metadata.isSymbolicLink()) {
        fail("unsafe-path", `refusing a symbolic link in a protected path: ${existing}`);
      }
      return join(existing, ...suffix);
    } catch (error) {
      if (error instanceof PkiToolError) throw error;
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

function pathIsWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function requireExternalPath(candidate, label) {
  const selected = canonicalCandidate(candidate);
  const source = canonicalCandidate(SOURCE_ROOT);
  if (pathIsWithin(source, selected)) {
    fail("source-boundary", `${label} must live outside the source tree`);
  }
}

export function requireProtectedInput(candidate, label) {
  const selected = resolve(candidate);
  let metadata;
  try {
    metadata = lstatSync(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail("input-invalid", `${label} must be a nonempty regular file, not a link`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    fail("input-permissions", `${label} must have mode 0600`);
  }
  if (metadata.size > MAX_PEM_BYTES) {
    fail("input-invalid", `${label} exceeds the 64 KiB limit`);
  }
  return selected;
}

function requireSinglePem(source, label, kind) {
  if (Buffer.byteLength(source, "utf8") > MAX_PEM_BYTES) {
    fail("pem-invalid", `${label} exceeds the 64 KiB limit`);
  }
  const expression = new RegExp(
    `^-----BEGIN ${kind}-----\\r?\\n[0-9A-Za-z+/=\\r\\n]+-----END ${kind}-----\\r?\\n?$`,
    "u",
  );
  if (!expression.test(source)) {
    fail("pem-invalid", `${label} must contain exactly one PEM ${kind} block`);
  }
}

function checkValidity(certificate, label, now = Date.now()) {
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || now < notBefore || now >= notAfter) {
    fail("certificate-validity", `${label} is not currently valid`);
  }
}

function normalizedFingerprint(certificate) {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

/**
 * Validate the exact certificate/key contract Cosmos accepts: one current CA
 * certificate and its EC P-256 PKCS#8 private key. No private bytes are ever
 * returned in the result or included in an error.
 */
export function validateDeviceUserCaPair(certificatePem, privateKeyPem, options = {}) {
  requireSinglePem(certificatePem, "DeviceUser CA certificate", "CERTIFICATE");
  requireSinglePem(privateKeyPem, "DeviceUser CA private key", "PRIVATE KEY");

  let certificate;
  let key;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    fail("certificate-invalid", "DeviceUser CA certificate is not valid X.509 PEM");
  }
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    fail("key-invalid", "DeviceUser CA private key is not usable PKCS#8 PEM");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    fail("key-invalid", "DeviceUser CA private key must be EC P-256");
  }
  if (!certificate.ca) {
    fail("certificate-constraints", "DeviceUser certificate must have the CA basic constraint");
  }
  checkValidity(certificate, "DeviceUser CA certificate", options.now);
  if (!certificate.checkPrivateKey(key)) {
    fail("key-mismatch", "DeviceUser CA certificate and private key do not match");
  }
  if (options.requireSelfSigned && !certificate.verify(certificate.publicKey)) {
    fail("certificate-chain", "generated DeviceUser CA certificate is not self-signed");
  }

  return Object.freeze({
    subject: certificate.subject,
    issuer: certificate.issuer,
    fingerprintSha256: normalizedFingerprint(certificate),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    selfSigned: certificate.verify(certificate.publicKey),
  });
}

function inspectDestination(path, label) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("destination-invalid", `${label} must be a regular file, not a link`);
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      fail("destination-permissions", `${label} must have mode 0600`);
    }
    return Object.freeze({ exists: true, empty: metadata.size === 0, size: metadata.size });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false, empty: true, size: 0 });
    throw error;
  }
}

function requireDestinationDirectory(paths) {
  requireExternalPath(paths.root, "DeviceUser PKI directory");
  let metadata;
  try {
    metadata = lstatSync(paths.root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("destination-missing", `DeviceUser PKI directory is missing; run revival init first: ${paths.root}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("destination-invalid", "DeviceUser PKI directory must be a real directory");
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail("destination-permissions", "DeviceUser PKI directory must not be accessible by group or other users");
  }
}

function requireReplaceableDestinations(paths) {
  requireDestinationDirectory(paths);
  const certificate = inspectDestination(paths.certificate, "DeviceUser CA certificate destination");
  const key = inspectDestination(paths.key, "DeviceUser CA key destination");
  if (!certificate.empty || !key.empty) {
    fail("refuse-overwrite", "refusing to overwrite an existing DeviceUser CA");
  }
  return Object.freeze({ certificate, key });
}

function safeRemoveStaging(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // The primary error remains more actionable than cleanup failure.
  }
}

function commitPair(paths, certificateSource, keySource) {
  requireReplaceableDestinations(paths);
  chmodSync(certificateSource, 0o600);
  chmodSync(keySource, 0o600);
  // The final immediate check narrows the race between planning and commit.
  requireReplaceableDestinations(paths);
  renameSync(keySource, paths.key);
  try {
    renameSync(certificateSource, paths.certificate);
  } catch (error) {
    // Roll back only the key this call just installed; never leave a half pair.
    try {
      rmSync(paths.key, { force: true });
      writeFileSync(paths.key, "", { flag: "wx", mode: 0o600 });
    } catch {
      // Status reports the incomplete pair explicitly if rollback itself fails.
    }
    throw error;
  }
}

function defaultRuntime() {
  return {
    environment: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    spawnSync,
  };
}

function runOpenSsl(runtime, args) {
  const result = runtime.spawnSync(runtime.environment.OPENSSL ?? "openssl", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") fail("openssl-missing", "OpenSSL is required for DeviceUser CA generation");
  if (result.status !== 0) fail("openssl-failed", "OpenSSL could not generate the DeviceUser CA");
}

function planText(action, paths, metadata = null) {
  const details = metadata
    ? `\n  subject: ${metadata.subject}\n  SHA-256: ${metadata.fingerprintSha256}`
    : "";
  return (
    `Plan: ${action} the DeviceUser CA only.\n` +
    `  certificate: ${paths.certificate}\n` +
    `  private key: ${paths.key}${details}\n` +
    "No attestation CA will be created or changed. Re-run with --confirm to commit.\n"
  );
}

export function parsePkiArgs(args) {
  const values = [...args];
  const command = values.shift();
  if (command === "status") {
    let json = false;
    for (const value of values) {
      if (value === "--json" && !json) json = true;
      else fail("usage", "usage: pki status [--json]");
    }
    return Object.freeze({ command, json });
  }
  if (command !== "init" && command !== "import") {
    fail("usage", "usage: pki status [--json] | init device-user [--confirm] | import device-user --cert FILE --key FILE [--confirm]");
  }
  if (values.shift() !== "device-user") {
    fail("usage", `${command} supports only device-user; attestation CA initialization is deliberately unavailable`);
  }
  let confirm = false;
  let certificate = null;
  let key = null;
  while (values.length > 0) {
    const option = values.shift();
    if (option === "--confirm" && !confirm) confirm = true;
    else if (command === "import" && option === "--cert" && certificate === null && values.length > 0) {
      certificate = values.shift();
    } else if (command === "import" && option === "--key" && key === null && values.length > 0) {
      key = values.shift();
    } else {
      fail("usage", command === "init"
        ? "usage: pki init device-user [--confirm]"
        : "usage: pki import device-user --cert FILE --key FILE [--confirm]");
    }
  }
  if (command === "import" && (!certificate || !key)) {
    fail("usage", "usage: pki import device-user --cert FILE --key FILE [--confirm]");
  }
  return Object.freeze({ command, confirm, certificate, key });
}

export function pkiStatus(runtime = defaultRuntime()) {
  const paths = deviceUserCaPaths(runtime.environment);
  const certificate = inspectDestination(paths.certificate, "DeviceUser CA certificate");
  const key = inspectDestination(paths.key, "DeviceUser CA key");
  if (!certificate.exists || !key.exists || certificate.empty || key.empty) {
    return Object.freeze({
      configured: false,
      valid: false,
      state: certificate.empty && key.empty ? "unconfigured" : "incomplete",
      certificatePath: paths.certificate,
      keyPath: paths.key,
    });
  }
  let keyBytes;
  try {
    keyBytes = readFileSync(paths.key);
    const metadata = validateDeviceUserCaPair(readFileSync(paths.certificate, "utf8"), keyBytes.toString("utf8"));
    return Object.freeze({
      configured: true,
      valid: true,
      state: "ready",
      certificatePath: paths.certificate,
      keyPath: paths.key,
      ...metadata,
    });
  } catch (error) {
    if (!(error instanceof PkiToolError)) throw error;
    return Object.freeze({
      configured: true,
      valid: false,
      state: "invalid",
      certificatePath: paths.certificate,
      keyPath: paths.key,
      error: error.message,
    });
  } finally {
    keyBytes?.fill(0);
  }
}

function importDeviceUserCa(options, runtime) {
  const paths = deviceUserCaPaths(runtime.environment);
  requireReplaceableDestinations(paths);
  const certificatePath = requireProtectedInput(options.certificate, "DeviceUser CA certificate input");
  const keyPath = requireProtectedInput(options.key, "DeviceUser CA private key input");
  let keyBytes;
  const certificatePem = readFileSync(certificatePath, "utf8");
  try {
    keyBytes = readFileSync(keyPath);
    const metadata = validateDeviceUserCaPair(certificatePem, keyBytes.toString("utf8"));
    runtime.out(planText("import", paths, metadata));
    if (!options.confirm) return Object.freeze({ changed: false, metadata });

    const staging = mkdtempSync(join(paths.root, ".device-user-import-"));
    const stagedCertificate = join(staging, "duc-ca.crt");
    const stagedKey = join(staging, "duc-ca.key");
    try {
      writeFileSync(stagedCertificate, certificatePem, { flag: "wx", mode: 0o600 });
      writeFileSync(stagedKey, keyBytes, { flag: "wx", mode: 0o600 });
      commitPair(paths, stagedCertificate, stagedKey);
    } finally {
      safeRemoveStaging(staging);
    }
    runtime.out("Installed the DeviceUser CA. Back it up off-host before enrollment.\n");
    return Object.freeze({ changed: true, metadata });
  } finally {
    keyBytes?.fill(0);
  }
}

function initDeviceUserCa(options, runtime) {
  const paths = deviceUserCaPaths(runtime.environment);
  requireReplaceableDestinations(paths);
  runtime.out(planText("create", paths));
  if (!options.confirm) return Object.freeze({ changed: false });

  const staging = mkdtempSync(join(paths.root, ".device-user-init-"));
  const stagedCertificate = join(staging, "duc-ca.crt");
  const stagedKey = join(staging, "duc-ca.key");
  let generatedKey;
  try {
    runOpenSsl(runtime, [
      "genpkey",
      "-algorithm", "EC",
      "-pkeyopt", "ec_paramgen_curve:P-256",
      "-out", stagedKey,
    ]);
    chmodSync(stagedKey, 0o600);
    runOpenSsl(runtime, [
      "req",
      "-x509",
      "-new",
      "-key", stagedKey,
      "-out", stagedCertificate,
      "-days", "3650",
      "-sha256",
      "-subj", DEVICE_USER_SUBJECT,
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign,digitalSignature",
      "-addext", "subjectKeyIdentifier=hash",
      "-addext", "authorityKeyIdentifier=keyid:always",
    ]);
    chmodSync(stagedCertificate, 0o600);
    generatedKey = readFileSync(stagedKey);
    const metadata = validateDeviceUserCaPair(
      readFileSync(stagedCertificate, "utf8"),
      generatedKey.toString("utf8"),
      { requireSelfSigned: true },
    );
    commitPair(paths, stagedCertificate, stagedKey);
    runtime.out(
      `Created DeviceUser CA ${metadata.fingerprintSha256}. Back it up off-host before enrollment.\n`,
    );
    return Object.freeze({ changed: true, metadata });
  } finally {
    generatedKey?.fill(0);
    safeRemoveStaging(staging);
  }
}

export function main(args = process.argv.slice(2), runtime = defaultRuntime()) {
  const options = parsePkiArgs(args);
  if (options.command === "status") {
    const status = pkiStatus(runtime);
    if (options.json) runtime.out(`${JSON.stringify(status, null, 2)}\n`);
    else if (status.valid) {
      runtime.out(`DeviceUser CA: ready (${status.fingerprintSha256})\n`);
    } else {
      runtime.out(`DeviceUser CA: ${status.state}${status.error ? ` (${status.error})` : ""}\n`);
    }
    return status;
  }
  if (options.command === "import") return importDeviceUserCa(options, runtime);
  return initDeviceUserCa(options, runtime);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = error instanceof PkiToolError && error.code === "usage" ? 64 : 1;
  }
}
