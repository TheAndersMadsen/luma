#!/bin/sh
set -eu

# Never resolve an executable through contributor PATH. Pin callers pass the
# already-audited source root and root-owned Node path; direct/test callers use
# the same fixed Node candidate and derive the root with shell parameter
# expansion plus the POSIX `pwd` builtin (no ambient dirname/readlink process).
PATH=/usr/bin:/bin
export PATH
case "$#" in
  0)
    script=$0
    case "$script" in
      /*) ;;
      *) script=$PWD/$script ;;
    esac
    script_directory=${script%/*}
    ROOT=$(CDPATH= cd -- "$script_directory/../../.." && pwd -P)
    NODE=/usr/bin/node
    ;;
  2)
    ROOT=$1
    NODE=$2
    ;;
  *)
    echo "source policy: expected no arguments or trusted ROOT NODE" >&2
    exit 1
    ;;
esac
case "$ROOT" in
  /*) ;;
  *) echo "source policy: root must be absolute" >&2; exit 1 ;;
esac
case "$ROOT" in
  /proc/self/fd/[0-9]*|/proc/[0-9]*/fd/[0-9]*)
    # The lane broker passes the already-held source descriptor and remains
    # alive through this scan and every Docker child. Canonicalizing it with
    # pwd -P would throw away that authority and reopen the mutable pathname.
    [ -d "$ROOT" ] || {
      echo "source policy: held source descriptor is unavailable" >&2
      exit 1
    }
    ;;
  *)
    ROOT=$(CDPATH= cd -- "$ROOT" && pwd -P)
    ;;
esac
case "$NODE" in
  /usr/bin/node|/proc/self/fd/[0-9]*|/proc/[0-9]*/fd/[0-9]*) ;;
  *) echo "source policy: trusted Node must be a held broker fd or /usr/bin/node" >&2; exit 1 ;;
esac
if [ ! -f "$NODE" ] || [ -L "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "source policy: trusted Node is unavailable" >&2
  exit 1
fi
cd "$ROOT"

# Packaging and the cheap changed-source gate deliberately share the exact
# filename, directory, symlink, secret, private-key, and machine-path detector.
# Generated directories are rejected rather than pruned so dist-center,
# test-runs, or a nested cache can never become a policy hiding place.
"$NODE" --input-type=module - "$ROOT" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const policy = await import(pathToFileURL(
  path.join(root, "platform", "deploy", "release.mjs"),
));
try {
  await policy.validateSourceTreePolicy({ root });
} catch (error) {
  console.error(`release source policy: ${error.message}`);
  process.exit(1);
}
NODE

# Captured/model-derived NLU fixtures belong only in the immutable external
# evidence baseline. Canonical tests generate their synthetic contract values
# in code, so this legacy source-tree fixture path must not return.
nlu_testdata_root="$ROOT/pin/runtime/core/src/nlu/testdata"
if [ -e "$nlu_testdata_root" ] || [ -L "$nlu_testdata_root" ]; then
  echo "forbidden NLU model-output fixture directory; keep evidence external" >&2
  exit 1
fi

"$NODE" - "$ROOT" <<'NODE'
const path = require("node:path");

const root = process.argv[2];
const {
  readStableRootedEntries,
} = require(path.join(root, "platform", "cli", "rooted-source.js"));
const contractsRoot = "pin/contracts";
const legacyName = "cosmos-golden";
const fixturesRoot = `${contractsRoot}/fixtures`;
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
  return file || ".";
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

function validateFixture(file, data) {
  if (path.extname(file) !== ".json") {
    fail(`${displayName(file)} must be a JSON fixture`);
  }

  let fixture;
  try {
    fixture = JSON.parse(data.toString("utf8"));
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

try {
  const collect = (inspect, expectedRoot = null) => {
    const batch = readStableRootedEntries(
      root,
      [contractsRoot],
      "fixture provenance policy",
      { walk: true, expectedRoot },
    );
    const contracts = batch.entries.find((entry) => entry.receipt.path === contractsRoot);
    if (!contracts || contracts.kind !== "directory") {
      fail("pin/contracts is missing");
    }
    if (contracts.names.includes(legacyName)) {
      fail("pin/contracts/cosmos-golden is forbidden; keep raw evidence outside the repository");
    }
    if (!contracts.names.includes("fixtures")) {
      fail("pin/contracts/fixtures is missing");
    }
    const fixtures = batch.entries.find((entry) => entry.receipt.path === fixturesRoot);
    if (!fixtures || fixtures.kind !== "directory") fail("pin/contracts/fixtures is missing");
    const state = { fixtureCount: 0 };
    for (const entry of batch.entries) {
      const sourcePath = entry.receipt.path;
      if (entry.kind === "file" && sourcePath.startsWith(`${fixturesRoot}/`)) {
        if (inspect) validateFixture(sourcePath, entry.data);
        state.fixtureCount += 1;
      }
    }
    return {
      receipts: batch.entries.map((entry) => entry.receipt),
      fixtureCount: state.fixtureCount,
      rootReceipt: batch.rootReceipt,
    };
  };
  const state = collect(true);
  if (state.fixtureCount === 0) fail("pin/contracts/fixtures must not be empty");
  const stable = collect(false, state.rootReceipt);
  if (JSON.stringify(state.receipts) !== JSON.stringify(stable.receipts)) {
    fail("fixture source manifest changed while applying provenance policy");
  }
} catch (error) {
  console.error(`fixture provenance policy: ${error.message}`);
  process.exit(1);
}
NODE

echo "source policy: ok"
