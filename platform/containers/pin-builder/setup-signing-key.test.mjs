import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_ENV_NAMES,
  buildKeytoolArgs,
  generatePassword,
  parseCliArgs,
  renderEnvFile,
  shellSingleQuote,
} from "./setup-signing-key.mjs";

test("renderEnvFile writes the four literal signing values", () => {
  const values = {
    PIN_SIGNING_STORE_FILE: "/tmp/pin.keystore",
    PIN_SIGNING_STORE_PASSWORD: "store'pass",
    PIN_SIGNING_KEY_ALIAS: "pin-fork",
    PIN_SIGNING_KEY_PASSWORD: "store'pass",
  };
  const document = renderEnvFile(values);
  for (const name of REQUIRED_ENV_NAMES) assert.match(document, new RegExp(`export ${name}=`));
  assert.match(document, /store'\\''pass/u);
  assert.equal(document.endsWith("\n"), true);
});

test("renderEnvFile rejects partial, relative, or split-password input", () => {
  const base = {
    PIN_SIGNING_STORE_FILE: "/tmp/pin.keystore",
    PIN_SIGNING_STORE_PASSWORD: "one",
    PIN_SIGNING_KEY_ALIAS: "pin-fork",
    PIN_SIGNING_KEY_PASSWORD: "one",
  };
  assert.throws(() => renderEnvFile({ ...base, PIN_SIGNING_KEY_ALIAS: "" }), /non-blank/u);
  assert.throws(() => renderEnvFile({ ...base, PIN_SIGNING_STORE_FILE: "relative" }), /absolute/u);
  assert.throws(() => renderEnvFile({ ...base, PIN_SIGNING_KEY_PASSWORD: "two" }), /identical/u);
});

test("CLI parsing and keytool arguments stay small and predictable", () => {
  const options = parseCliArgs([
    "--keystore", "/tmp/pin.keystore",
    "--env-out", "/tmp/signing.env",
    "--alias", "operator",
    "--force",
  ]);
  assert.equal(options.force, true);
  assert.equal(options.alias, "operator");
  assert.deepEqual(buildKeytoolArgs(options).slice(0, 7), [
    "-genkeypair", "-keystore", "/tmp/pin.keystore", "-storetype", "PKCS12", "-alias", "operator",
  ]);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown option/u);
  assert.throws(() => parseCliArgs(["--alias", "bad alias"]), /unsafe/u);
});

test("password and shell helpers preserve entropy and quoting", () => {
  assert.ok(generatePassword().length >= 40);
  assert.equal(shellSingleQuote("a'b"), "'a'\\''b'");
  assert.throws(() => generatePassword(8), /entropy/u);
});
