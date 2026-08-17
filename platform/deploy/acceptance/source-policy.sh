#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
cd "$ROOT"

# `find -P` does not traverse the machine-local source symlinks.
bad_paths=$(find -P "$ROOT" \
  \( -path "$ROOT/private" -o -path "$ROOT/state" -o \
     -name node_modules -o -name .next -o -name target -o -name build -o -name .gradle \) -prune -o \
  -type f \( \
  -iname '*.apk' -o -iname '*.apks' -o -iname '*.aab' -o -iname '*.xapk' -o \
  -iname '*.img' -o -iname '*.mbn' -o -iname '*.elf' -o \
  -iname '*.jks' -o -iname '*.keystore' -o -iname '*.p12' -o -iname '*.pfx' -o \
  -iname '*.pem' -o -iname '*.key' -o -iname '*.pcap' -o -iname '*.pcapng' -o \
  -iname '*.har' \
\) -print)

secret_files=$(find -P "$ROOT" \
  \( -path "$ROOT/private" -o -path "$ROOT/state" -o \
     -name node_modules -o -name .next -o -name target -o -name build -o -name .gradle \) -prune -o \
  -type f \( -name '.env' -o -name '.env.*' -o -name '.npmrc' \) \
  ! -name '.env.example' -print)

if [ -n "$bad_paths" ]; then
  echo "forbidden binary, key, firmware, or capture artifact:" >&2
  echo "$bad_paths" >&2
  exit 1
fi

if [ -n "$secret_files" ]; then
  echo "forbidden environment or credential file:" >&2
  echo "$secret_files" >&2
  exit 1
fi

bad_dirs=$(find -P "$ROOT" \
  \( -path "$ROOT/private" -o -path "$ROOT/state" -o \
     -name node_modules -o -name .next -o -name target -o -name build -o -name .gradle \) -prune -o \
  -type d \( \
  -name firmware -o -name decompile-workspace -o -name raw-captures -o \
  -name packet-captures -o -name private-keys -o -name device-identity -o \
  -name wearer-data -o -name production-state \
\) -print)

if [ -n "$bad_dirs" ]; then
  echo "forbidden private/proprietary directory:" >&2
  echo "$bad_dirs" >&2
  exit 1
fi

# Captured/model-derived NLU fixtures belong only in the immutable external
# evidence baseline. Canonical tests generate their synthetic contract values
# in code, so this legacy source-tree fixture path must not return.
nlu_testdata_root="$ROOT/pin/runtime/core/src/nlu/testdata"
if [ -e "$nlu_testdata_root" ] || [ -L "$nlu_testdata_root" ]; then
  echo "forbidden NLU model-output fixture directory; keep evidence external" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "fixture provenance policy: node is required" >&2
  exit 1
fi

node - "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const contractsRoot = path.join(root, "pin", "contracts");
const legacyRoot = path.join(contractsRoot, "carry-golden");
const fixturesRoot = path.join(contractsRoot, "fixtures");
const allowedProvenance = new Set(["synthetic", "clean-room-interface"]);
const allowedEvidence = new Set(["observed", "derived", "implemented", "unknown"]);
const textBearingKeys = new Set([
  "answer",
  "input",
  "normalized",
  "prompt",
  "raw",
  "response",
  "transcript",
  "utterance",
]);
const forbiddenLegacyKeys = new Set(["_scrubbing", "_source"]);

function fail(message) {
  throw new Error(message);
}

function displayName(file) {
  return path.relative(root, file) || ".";
}

function inspectValue(value, file, state) {
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, file, state);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenLegacyKeys.has(key)) {
      fail(`${displayName(file)} uses forbidden legacy provenance key ${key}`);
    }
    if (textBearingKeys.has(key)) state.hasTextBearingField = true;
    inspectValue(child, file, state);
  }
}

function validateFixture(file) {
  if (path.extname(file) !== ".json") {
    fail(`${displayName(file)} must be a JSON fixture`);
  }

  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${displayName(file)} is not valid JSON`);
  }

  if (fixture === null || Array.isArray(fixture) || typeof fixture !== "object") {
    fail(`${displayName(file)} must contain a top-level object`);
  }
  if (fixture.schema_version !== 1) {
    fail(`${displayName(file)} must declare schema_version 1`);
  }
  if (!allowedProvenance.has(fixture.provenance)) {
    fail(`${displayName(file)} has unsupported or missing provenance`);
  }
  if (!allowedEvidence.has(fixture.evidence)) {
    fail(`${displayName(file)} has unsupported or missing evidence label`);
  }

  const state = { hasTextBearingField: false };
  inspectValue(fixture, file, state);
  if (state.hasTextBearingField && fixture.provenance !== "synthetic") {
    fail(`${displayName(file)} has text-bearing fields without synthetic provenance`);
  }
  if (fixture.provenance === "synthetic" && fixture.evidence !== "implemented") {
    fail(`${displayName(file)} synthetic fixtures must use implemented evidence`);
  }
}

function visit(directory, state) {
  for (const name of fs.readdirSync(directory).sort()) {
    const entry = path.join(directory, name);
    const metadata = fs.lstatSync(entry);
    if (metadata.isSymbolicLink()) {
      fail(`${displayName(entry)} must not be a symbolic link`);
    }
    if (metadata.isDirectory()) {
      visit(entry, state);
    } else if (metadata.isFile()) {
      validateFixture(entry);
      state.fixtureCount += 1;
    } else {
      fail(`${displayName(entry)} must be a regular file or directory`);
    }
  }
}

try {
  if (fs.existsSync(legacyRoot)) {
    fail("pin/contracts/carry-golden is forbidden; keep raw evidence outside the repository");
  }
  if (!fs.existsSync(fixturesRoot) || !fs.lstatSync(fixturesRoot).isDirectory()) {
    fail("pin/contracts/fixtures is missing");
  }
  const state = { fixtureCount: 0 };
  visit(fixturesRoot, state);
  if (state.fixtureCount === 0) fail("pin/contracts/fixtures must not be empty");
} catch (error) {
  console.error(`fixture provenance policy: ${error.message}`);
  process.exit(1);
}
NODE

if command -v rg >/dev/null 2>&1; then
  # Ripgrep does not follow symlinks unless --follow is supplied.
  if rg -l --hidden \
    --glob '!private/**' \
    --glob '!state/**' \
    --glob '!**/node_modules/**' \
    --glob '!**/.next/**' \
    --glob '!**/target/**' \
    --glob '!**/build/**' \
    --glob '!**/.gradle/**' \
    --glob '!platform/deploy/acceptance/source-policy.sh' \
    --glob '!.git/**' \
    -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,}' . >/dev/null; then
    echo "high-confidence credential material detected" >&2
    exit 1
  fi
else
  echo "warning: rg unavailable; high-confidence content scan skipped" >&2
fi

echo "source policy: ok"
