import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GENERATED_OUTPUT_PATHS,
  REPOSITORY_ROOT,
  checkTierAOutputs,
  generateTierAOutputs,
  loadAndResolveTierARegistry,
  parseExternalOperationalMarkerEvidenceTsv,
  parseNativeActionsTsv,
  resolveTierARegistry,
  scanTierARawLiterals,
  validateNativeActionStockEvidence,
  validateNativeActionStockSource,
  writeTierAOutputs,
} from "./tier-a-registry.mjs";
import {
  BINDER_PROTOCOLS,
  FEATURE_FLAGS,
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
  PACKAGES,
  PROTO_KIDS,
  RPC_PATHS,
  TIER_A_SYMBOLS,
  WIRE_SENTINELS,
} from "../../deploy/acceptance/pin/tier-a-symbols.mjs";

const REGISTRY_PATH = path.join(
  REPOSITORY_ROOT,
  "contracts/tier-a/registry.json",
);
const NATIVE_ACTIONS_PATH = path.join(
  REPOSITORY_ROOT,
  "contracts/tier-a/native-actions.tsv",
);
const EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH = path.join(
  REPOSITORY_ROOT,
  "contracts/tier-a/external-operational-marker-evidence.tsv",
);

function rawRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

test("registry resolves every canonical input and generated bindings are current", () => {
  const resolved = loadAndResolveTierARegistry();
  assert.deepEqual(Object.keys(PACKAGES).sort(), [
    "bort",
    "bort_ota",
    "dialer",
    "esim_lpa",
    "food",
    "ironman",
    "krypto",
    "memfault_usage_reporter",
    "messages",
    "metric_reporter",
    "music",
    "onboarding",
    "ota",
    "photography",
    "settings",
    "system_navigation",
    "tickle",
    "voice_tts",
  ]);
  assert.equal(resolved.packages.length, Object.keys(PACKAGES).length);
  assert.equal(resolved.nativeActions.length, 138);
  assert.equal(resolved.featureFlags.cloud.length, 20);
  assert.equal(resolved.featureFlags.settingsGlobal.length, 6);
  assert.ok(resolved.protoKids.length >= 40);
  assert.equal(resolved.operationalMarkers.length, 38);

  const first = generateTierAOutputs(resolved);
  const second = generateTierAOutputs(loadAndResolveTierARegistry());
  assert.deepEqual(second, first, "generation must be byte-for-byte deterministic");
  for (const [relativePath, contents] of Object.entries(first)) {
    assert.ok(contents.endsWith("\n"), `${relativePath} must end with a newline`);
    assert.ok(
      !contents.endsWith("\n\n"),
      `${relativePath} must not end with a redundant blank line`,
    );
  }
  assert.equal(checkTierAOutputs(first), true);
});

test("native actions are consumed from the complete evidence TSV", () => {
  const rows = parseNativeActionsTsv(
    fs.readFileSync(NATIVE_ACTIONS_PATH, "utf8"),
  );
  assert.equal(rows.length, 138);
  assert.equal(rows[0].action, "AcceptCall");
  assert.equal(rows.at(-1).action, "WorldClock");
  assert.equal(new Set(rows.map((row) => row.action)).size, rows.length);
  assert.equal(
    rows.find((row) => row.action === "ExplainFailure").stock_evidence,
    "ironman/sources/humaneinternal/system/intent/actions/ai_mic/ExplainFailureAction.java",
  );
  assert.equal(NATIVE_ACTIONS.GET_BATTERY_LEVEL, "GetBatteryLevel");
  assert.equal(NATIVE_ACTIONS.SETTINGS, "Settings");
});

test("constant-backed stock action names resolve without weakening exact metadata", () => {
  const proof = validateNativeActionStockSource(
    "ExplainFailure",
    `
      @Action(
        enabledInKeyguard = true,
        experience = HumanePackageManager.ExperienceIdentifierKey.ANSWERS,
        nameForModel = ExplainFailureAction.EXPLAIN_FAILURE
      )
      public class ExplainFailureAction {
        public static final String EXPLAIN_FAILURE = "ExplainFailure";
      }
    `,
    "ExplainFailureAction.java",
  );
  assert.deepEqual(proof, {
    kind: "constant",
    expression: "ExplainFailureAction.EXPLAIN_FAILURE",
    experience: "ANSWERS",
    enabledInKeyguard: "true",
  });

  assert.throws(
    () =>
      validateNativeActionStockSource(
        "InventedFailure",
        `
          @Action(
            enabledInKeyguard = true,
            experience = HumanePackageManager.ExperienceIdentifierKey.ANSWERS,
            nameForModel = ExplainFailureAction.EXPLAIN_FAILURE
          )
          public class ExplainFailureAction {
            public static final String EXPLAIN_FAILURE = "ExplainFailure";
          }
        `,
        "ExplainFailureAction.java",
    ),
    /does not pin @Action nameForModel to "InventedFailure"/,
  );
  assert.throws(
    () =>
      validateNativeActionStockSource(
        "ExplainFailure",
        `
          @Action(
            enabledInKeyguard = true,
            experience = HumanePackageManager.ExperienceIdentifierKey.ANSWERS,
            nameForModel = ForeignAction.EXPLAIN_FAILURE
          )
          public class ExplainFailureAction {
            public static final String EXPLAIN_FAILURE = "ExplainFailure";
          }
        `,
        "ExplainFailureAction.java",
      ),
    /does not pin @Action nameForModel to "ExplainFailure"/,
  );
});

test("duplicate authored names are rejected before generation", () => {
  const registry = rawRegistry();
  registry.packages.push({
    ...registry.packages[0],
    value: "humane.example.duplicate_name",
  });
  assert.throws(
    () => resolveTierARegistry(registry),
    /duplicate packages name "ironman"/,
  );
});

test("RPC identity is service FQN plus method, never the bare method", () => {
  const resolved = loadAndResolveTierARegistry();
  const uploadPaths = resolved.rpcPaths
    .filter((entry) => entry.method === "UploadFile")
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(uploadPaths, [
    "/humane.aibus.AIBusService/UploadFile",
    "/humane.capture.CaptureService/UploadFile",
  ]);
  assert.equal(RPC_PATHS.aibus_understand, "/humane.aibus.AIBusService/Understand");
  assert.equal(
    RPC_PATHS.aibus_encrypted_loading_message,
    "/humane.aibus.AIBusService/EncryptedLoadingMessage",
  );

  const registry = rawRegistry();
  registry.rpcPaths.push({
    ...registry.rpcPaths.find((entry) => entry.name === "capture_upload_file"),
    name: "capture_upload_file_alias",
  });
  assert.throws(
    () => resolveTierARegistry(registry),
    /duplicate RPC FQN path "\/humane\.capture\.CaptureService\/UploadFile"/,
  );
});

test("Binder transaction codes are unique per descriptor namespace", () => {
  const resolved = loadAndResolveTierARegistry();
  const aiBus = resolved.binderProtocols.find(
    (protocol) => protocol.name === "ai_bus_bridge",
  );
  const observer = resolved.binderProtocols.find(
    (protocol) => protocol.name === "stream_observer",
  );
  assert.equal(aiBus.transactions[0].code, 1);
  assert.equal(observer.transactions[0].code, 1);
  assert.notEqual(aiBus.descriptor, observer.descriptor);
  assert.equal(BINDER_PROTOCOLS.ai_bus_bridge.transactions.analyze_image.code, 1);
  assert.equal(BINDER_PROTOCOLS.stream_observer.transactions.on_next.code, 1);

  const registry = rawRegistry();
  registry.binderProtocols[0].transactions.push({
    name: "duplicate_code",
    wireName: "duplicateCode",
    code: 1,
  });
  assert.throws(
    () => resolveTierARegistry(registry),
    /duplicate ai_bus_bridge transaction code 1/,
  );
});

test("feature storage planes and non-proto sentinels stay distinct", () => {
  assert.equal(FEATURE_FLAGS.cloud.cmu_ultra_enabled, "cmu_ultra_enabled");
  assert.equal(
    FEATURE_FLAGS.settingsGlobal.cmu_ultra_enabled,
    "humane_cmu_ultra_enabled",
  );
  assert.notEqual(
    FEATURE_FLAGS.cloud.cmu_ultra_enabled,
    FEATURE_FLAGS.settingsGlobal.cmu_ultra_enabled,
  );
  assert.equal(
    FEATURE_FLAGS.penumbraSettingsGlobal.weather_celsius,
    "penumbra_weather_celsius",
  );
  assert.equal(WIRE_SENTINELS.plaintext_envelope, "plaintext");
  assert.equal(Object.values(PROTO_KIDS).includes("plaintext"), false);
});

test("live markers resolve to emitters while orphan parsers stay explicit", () => {
  assert.equal(OPERATIONAL_MARKERS.tool_executed.status, "live");
  assert.equal(OPERATIONAL_MARKERS.agentic_physical_trace.status, "live");
  assert.equal(
    OPERATIONAL_MARKERS.narration_start_without_hand_tracking.status,
    "unverified",
  );
  assert.equal(
    OPERATIONAL_MARKERS.stock_run_final_observation.status,
    "external",
  );
  assert.equal(
    OPERATIONAL_MARKERS.stock_run_final_message.status,
    "external",
  );
  assert.deepEqual(OPERATIONAL_MARKERS.tool_executed.fields, [
    "correlation",
    "tool",
    "ok",
    "reason",
  ]);
  assert.ok(Object.isFrozen(TIER_A_SYMBOLS));
  assert.ok(Object.isFrozen(OPERATIONAL_MARKERS.tool_executed.fields));
});

test("external stock markers are hash-pinned without copying stock source", () => {
  const evidence = parseExternalOperationalMarkerEvidenceTsv(
    fs.readFileSync(EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH, "utf8"),
  );
  assert.deepEqual(
    evidence.map((entry) => entry.marker_name),
    ["stock_run_final_message", "stock_run_final_observation"],
  );
  assert.ok(evidence.every((entry) => entry.source_owner === "stock"));
  assert.ok(
    evidence.every((entry) => entry.evidence_kind === "external-contract-hash"),
  );

  const registry = rawRegistry();
  registry.operationalMarkers.find(
    (entry) => entry.name === "stock_run_final_observation",
  ).value += " changed";
  assert.throws(
    () => resolveTierARegistry(registry),
    /stock_run_final_observation value does not match its hash evidence/,
  );
});

test("marker liveness requires the generated binding in the real emitter", () => {
  assert.doesNotThrow(() =>
    loadAndResolveTierARegistry({ requireGeneratedEmitterReferences: true }),
  );

  const registry = rawRegistry();
  const marker = registry.operationalMarkers.find(
    (entry) => entry.name === "tool_executed",
  );
  marker.emitter = "platform/deploy/acceptance/pin/tool-coverage.test.mjs";
  assert.throws(
    () =>
      resolveTierARegistry(registry, {
        requireGeneratedEmitterReferences: true,
      }),
    /tool_executed emitter platform\/deploy\/acceptance\/pin\/tool-coverage\.test\.mjs must reference OPERATIONAL_MARKERS\.tool_executed\.value/,
    "a parser containing the legacy literal must not satisfy emitter liveness",
  );
});

test("raw literal scanner is domain-aware across Rust, Kotlin, Node, and TypeScript", () => {
  const registry = loadAndResolveTierARegistry();
  const violations = scanTierARawLiterals({
    registry,
    sources: [
      {
        path: "fixture.rs",
        contents: 'const NATIVE_ACTION: &str = "GetBatteryLevel";\n',
      },
      {
        path: "fixture.kt",
        contents:
          'const val TARGET_PACKAGE = "\\u0068umane.experience.music"\n',
      },
      {
        path: "fixture.mjs",
        contents:
          'const rpcPath = "/humane.aibus.AIBusService/Understand";\n',
      },
      {
        path: "fixture.ts",
        contents:
          'const navItem = { label: "Settings", href: "/settings" };\n',
      },
      {
        path: "utterance.rs",
        contents: `if features.tickle_enabled
    && matches!(
        strict_exact_feature_command(&request.utterance).as_deref(),
        Some("tickle" | "tickle my fancy")
    )
{}`,
      },
      {
        path: "feature-key.ts",
        contents: 'const FEATURE_FLAG_KEY = "tickle";\n',
      },
      {
        path: "lifetime.rs",
        contents:
          "fn f<T: Send + 'static>() {\n" +
          '    let kid = "humane.aibus.CanTranslateRequest";\n' +
          "}\n",
      },
      {
        path: "embedded-jq.sh",
        contents: "jq -e '.flags[] | select(.key == \"tickle\")' response.json\n",
      },
      {
        path: "regex-before-literal.mjs",
        contents:
          'const version = /version\\s+"([^"]+)"/.exec(text);\n' +
          'const rpcPath = "/humane.aibus.AIBusService/Understand";\n',
      },
      {
        path: "reflection.kt",
        contents:
          'val contactClass = classLoader.loadClass("humane.contacts.Contact")\n',
      },
      {
        path: "contact-kid.kt",
        contents: 'if (kid == "humane.contacts.Contact") return\n',
      },
    ],
  });
  assert.deepEqual(
    violations.map(({ path, value }) => [path, value]),
    [
      ["fixture.rs", "GetBatteryLevel"],
      ["fixture.kt", "humane.experience.music"],
      ["fixture.mjs", "/humane.aibus.AIBusService/Understand"],
      ["feature-key.ts", "tickle"],
      ["lifetime.rs", "humane.aibus.CanTranslateRequest"],
      ["embedded-jq.sh", "tickle"],
      ["regex-before-literal.mjs", "/humane.aibus.AIBusService/Understand"],
      ["contact-kid.kt", "humane.contacts.Contact"],
    ],
    "ambiguous words are rejected only in contract-shaped contexts across supported syntaxes",
  );
});

test("output check detects one-byte generated drift", () => {
  const temporaryWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "penumbra-tier-a-drift-"),
  );
  const temporaryRoot = path.join(temporaryWorkspace, "pin");
  fs.mkdirSync(temporaryRoot);
  try {
    const outputs = generateTierAOutputs(loadAndResolveTierARegistry());
    writeTierAOutputs(outputs, { root: temporaryRoot });
    assert.equal(checkTierAOutputs(outputs, { root: temporaryRoot }), true);

    const rustOutput = path.join(
      temporaryRoot,
      GENERATED_OUTPUT_PATHS.rust,
    );
    fs.appendFileSync(rustOutput, " ", "utf8");
    assert.throws(
      () => checkTierAOutputs(outputs, { root: temporaryRoot }),
      /generated output drift in runtime\/core\/src\/tier_a\.rs/,
    );
  } finally {
    fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});

test("clean clones verify the generated 138-row stock path index without proprietary input", () => {
  const temporaryWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "penumbra-tier-a-clean-clone-"),
  );
  const temporaryRoot = path.join(temporaryWorkspace, "pin");
  fs.mkdirSync(temporaryRoot);
  try {
    const resolved = loadAndResolveTierARegistry();
    const outputs = generateTierAOutputs(resolved);
    writeTierAOutputs(outputs, { root: temporaryRoot });

    assert.equal(
      fs.existsSync(
        path.join(temporaryRoot, "decompile-workspace/decompiled"),
      ),
      false,
    );
    const indexLines = fs
      .readFileSync(
        path.join(
          temporaryRoot,
          GENERATED_OUTPUT_PATHS.stockNativeActionsIndex,
        ),
        "utf8",
      )
      .trimEnd()
      .split("\n");
    assert.equal(indexLines[0], "action_name\tevidence_path");
    assert.equal(indexLines.length, 139);
    assert.equal(
      indexLines.find((line) => line.startsWith("ExplainFailure\t")),
      "ExplainFailure\tironman/sources/humaneinternal/system/intent/actions/ai_mic/ExplainFailureAction.java",
    );
    assert.deepEqual(
      validateNativeActionStockEvidence(resolved.nativeActions, {
        root: temporaryRoot,
      }),
      {
        mode: "index-only",
        actions: 138,
        literalProofs: 0,
        constantProofs: 0,
      },
    );
    assert.throws(
      () =>
        validateNativeActionStockEvidence(
          resolved.nativeActions.map((action) =>
            action.action === "AcceptCall"
              ? { ...action, stock_evidence: "../AcceptCallAction.java" }
              : action,
          ),
          { root: temporaryRoot },
        ),
      /must be a normalized Java path below ironman\/sources/,
    );
    assert.equal(checkTierAOutputs(outputs, { root: temporaryRoot }), true);
  } finally {
    fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});
