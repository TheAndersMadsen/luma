import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PkiToolError,
  deviceUserCaPaths,
  main,
  parsePkiArgs,
  pkiStatus,
  validateDeviceUserCaPair,
} from "../pki.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "revival-pki-test-"));
  const secrets = join(root, "secrets");
  const pki = join(secrets, "pki");
  mkdirSync(pki, { recursive: true, mode: 0o700 });
  chmodSync(secrets, 0o700);
  chmodSync(pki, 0o700);
  writeFileSync(join(pki, "duc-ca.crt"), "", { mode: 0o600 });
  writeFileSync(join(pki, "duc-ca.key"), "", { mode: 0o600 });
  return { root, secrets, pki };
}

function captureRuntime(secrets, environment = {}) {
  const stdout = [];
  const stderr = [];
  return {
    runtime: {
      environment: { ...process.env, ...environment, REVIVAL_SECRETS_DIR: secrets },
      out: (text) => stdout.push(String(text)),
      err: (text) => stderr.push(String(text)),
      spawnSync,
    },
    stdout,
    stderr,
    text: () => stdout.join("") + stderr.join(""),
  };
}

test("PKI grammar exposes DeviceUser status, import and init only", () => {
  assert.deepEqual(parsePkiArgs(["status"]), { command: "status", json: false });
  assert.deepEqual(parsePkiArgs(["status", "--json"]), { command: "status", json: true });
  assert.deepEqual(parsePkiArgs(["init", "device-user"]), {
    command: "init",
    confirm: false,
    certificate: null,
    key: null,
  });
  assert.throws(
    () => parsePkiArgs(["init", "attestation", "--confirm"]),
    /attestation CA initialization is deliberately unavailable/,
  );
  assert.throws(() => parsePkiArgs(["import", "device-user", "--cert", "a"]), /usage:/);
});

test("DeviceUser init plans without mutation, then creates a validated protected pair", () => {
  const fixture = fixtureRoot();
  const captured = captureRuntime(fixture.secrets);
  const paths = deviceUserCaPaths(captured.runtime.environment);

  const plan = main(["init", "device-user"], captured.runtime);
  assert.equal(plan.changed, false);
  assert.equal(lstatSync(paths.certificate).size, 0);
  assert.equal(lstatSync(paths.key).size, 0);
  assert.match(captured.text(), /No attestation CA will be created or changed/);

  const result = main(["init", "device-user", "--confirm"], captured.runtime);
  assert.equal(result.changed, true);
  assert.equal(lstatSync(paths.certificate).mode & 0o777, 0o600);
  assert.equal(lstatSync(paths.key).mode & 0o777, 0o600);
  const metadata = validateDeviceUserCaPair(
    readFileSync(paths.certificate, "utf8"),
    readFileSync(paths.key, "utf8"),
    { requireSelfSigned: true },
  );
  assert.equal(metadata.fingerprintSha256, result.metadata.fingerprintSha256);
  assert.match(metadata.subject, /CN=Carry Clone DeviceUser CA/u);
  assert.equal(pkiStatus(captured.runtime).state, "ready");
  const retained = [paths.certificate, paths.key].map((path) => {
    const metadata = lstatSync(path, { bigint: true });
    return {
      ino: metadata.ino,
      size: metadata.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
  assert.throws(
    () => main(["init", "device-user", "--confirm"], captured.runtime),
    (error) => error instanceof PkiToolError && error.code === "refuse-overwrite",
  );
  assert.deepEqual([paths.certificate, paths.key].map((path) => {
    const metadata = lstatSync(path, { bigint: true });
    return {
      ino: metadata.ino,
      size: metadata.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  }), retained, "refused reinitialization must preserve the exact existing Carry CA files");
});

test("import validates first, stays plan-only by default and refuses overwrite", () => {
  const source = fixtureRoot();
  const sourceRuntime = captureRuntime(source.secrets);
  main(["init", "device-user", "--confirm"], sourceRuntime.runtime);
  const sourcePaths = deviceUserCaPaths(sourceRuntime.runtime.environment);

  const target = fixtureRoot();
  const captured = captureRuntime(target.secrets);
  const targetPaths = deviceUserCaPaths(captured.runtime.environment);
  const args = [
    "import", "device-user",
    "--cert", sourcePaths.certificate,
    "--key", sourcePaths.key,
  ];
  assert.equal(main(args, captured.runtime).changed, false);
  assert.equal(lstatSync(targetPaths.certificate).size, 0);
  assert.equal(lstatSync(targetPaths.key).size, 0);

  assert.equal(main([...args, "--confirm"], captured.runtime).changed, true);
  assert.equal(pkiStatus(captured.runtime).valid, true);
  const retained = [targetPaths.certificate, targetPaths.key].map((path) => {
    const metadata = lstatSync(path, { bigint: true });
    return {
      ino: metadata.ino,
      size: metadata.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
  assert.throws(() => main([...args, "--confirm"], captured.runtime), /refusing to overwrite/);
  assert.deepEqual([targetPaths.certificate, targetPaths.key].map((path) => {
    const metadata = lstatSync(path, { bigint: true });
    return {
      ino: metadata.ino,
      size: metadata.size,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  }), retained, "refused reimport must preserve the exact existing Carry CA files");
});

test("protected import inputs reject permissive files and links", () => {
  const source = fixtureRoot();
  const generated = captureRuntime(source.secrets);
  main(["init", "device-user", "--confirm"], generated.runtime);
  const sourcePaths = deviceUserCaPaths(generated.runtime.environment);

  const target = fixtureRoot();
  const runtime = captureRuntime(target.secrets).runtime;
  chmodSync(sourcePaths.certificate, 0o644);
  assert.throws(
    () => main([
      "import", "device-user", "--cert", sourcePaths.certificate, "--key", sourcePaths.key,
    ], runtime),
    /mode 0600/,
  );

  chmodSync(sourcePaths.certificate, 0o600);
  const link = join(source.root, "linked-key");
  symlinkSync(sourcePaths.key, link);
  assert.throws(
    () => main([
      "import", "device-user", "--cert", sourcePaths.certificate, "--key", link,
    ], runtime),
    /regular file, not a link/,
  );
});

test("mismatched CA keys fail without leaking either private key", () => {
  const first = fixtureRoot();
  const second = fixtureRoot();
  const firstRuntime = captureRuntime(first.secrets);
  const secondRuntime = captureRuntime(second.secrets);
  main(["init", "device-user", "--confirm"], firstRuntime.runtime);
  main(["init", "device-user", "--confirm"], secondRuntime.runtime);
  const firstPaths = deviceUserCaPaths(firstRuntime.runtime.environment);
  const secondPaths = deviceUserCaPaths(secondRuntime.runtime.environment);
  const firstKey = readFileSync(firstPaths.key, "utf8");
  const secondKey = readFileSync(secondPaths.key, "utf8");

  assert.throws(
    () => validateDeviceUserCaPair(readFileSync(firstPaths.certificate, "utf8"), secondKey),
    /do not match/,
  );
  assert.doesNotMatch(firstRuntime.text() + secondRuntime.text(), /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(firstRuntime.text() + secondRuntime.text(), new RegExp(firstKey.slice(40, 72), "u"));
});

test("status JSON contains metadata, never PEM", () => {
  const fixture = fixtureRoot();
  const captured = captureRuntime(fixture.secrets);
  main(["init", "device-user", "--confirm"], captured.runtime);
  captured.stdout.length = 0;
  main(["status", "--json"], captured.runtime);
  const output = captured.text();
  assert.equal(JSON.parse(output).state, "ready");
  assert.doesNotMatch(output, /BEGIN (?:CERTIFICATE|PRIVATE KEY)/);
});
