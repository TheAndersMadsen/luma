// A throwaway release signing key for the acceptance tests, made with the
// installed cosign (the same binary `./luma release publish` uses). A machine
// without cosign skips only the steps that need a real signature, and says so;
// no test passes on a signature it did not check.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { releaseSigningArguments } from "../../distribution/release-proof.mjs";

const CANDIDATES = process.platform === "darwin"
  ? ["/opt/homebrew/bin/cosign", "/usr/local/bin/cosign"]
  : ["/usr/bin/cosign", "/usr/local/bin/cosign"];
export const FIXTURE_PASSWORD = "fixture-release-key-password";

export function installedCosign() {
  return CANDIDATES.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

// Prints why a signing step was not exercised, once per test file. Returns
// null so the caller skips only that step.
let explained = false;
export function cosignOrExplain(step) {
  const cosign = installedCosign();
  if (!cosign && !explained) {
    explained = true;
    process.stdout.write(`# cosign is not installed at ${CANDIDATES.join(" or ")}: ${step} is not exercised on this machine\n`);
  }
  return cosign;
}

function runCosign(cosign, args, { cwd, env = {} } = {}) {
  const result = spawnSync(cosign, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COSIGN_PASSWORD: FIXTURE_PASSWORD, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`cosign ${args[0]} failed: ${result.stderr}${result.stdout}`);
  return result;
}

// cosign.key and cosign.pub in `directory`, protected by FIXTURE_PASSWORD.
export function throwawayKeyPair(cosign, directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  runCosign(cosign, ["generate-key-pair", "--output-key-prefix", "cosign"], { cwd: directory });
  return Object.freeze({
    privateKey: path.join(directory, "cosign.key"),
    publicKey: path.join(directory, "cosign.pub"),
  });
}

// The maintainer's signing command, as release-proof.mjs defines it.
export function signChecksums(cosign, { privateKey, checksums, signature }) {
  runCosign(cosign, releaseSigningArguments({ privateKey, checksums, signature }));
}
