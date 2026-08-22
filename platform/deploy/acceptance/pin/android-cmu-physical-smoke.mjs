#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXPECTED_PIN_SERIAL_ENV,
  EXPECTED_PIXEL_SERIAL_ENV,
  exactDeviceTargetMatches,
  resolveExpectedDeviceSerial,
  validateDeviceSerial,
} from "./device-target-guard.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

export const CMU_PHYSICAL_CONTRACT = Object.freeze({
  pixelModel: "Pixel 10 Pro",
  pinModel: "Ai Pin",
  pixelSdk: "37",
  pinSdk: "32",
  packageName: "com.penumbraos.cmucompanion",
  versionName: "1.0",
  versionCode: 1,
  apkSha256: "82fa0c85068251001be9a08c6da5d7c5f07f25989bd97783b9c47b4cfe6a9913",
  sentinelPackage: "com.android.shell",
  sentinelTag: "penumbra_cmu_sentinel_v1",
  shellNotificationId: 2020,
  cancelTransaction: 8,
  adbCommandTimeoutMs: 15_000,
  cleanupTimeoutMs: 15_000,
});

export const ROLE_PREFLIGHT = Object.freeze({
  pixel: Object.freeze({
    role: "phone",
    companionRequired: true,
    companionPackage: CMU_PHYSICAL_CONTRACT.packageName,
  }),
  pin: Object.freeze({
    role: "pin",
    companionRequired: false,
    companionPackage: CMU_PHYSICAL_CONTRACT.packageName,
  }),
});

export const COMPANION_IDENTITY_CONTRACT = Object.freeze({
  packageName: CMU_PHYSICAL_CONTRACT.packageName,
  versionName: CMU_PHYSICAL_CONTRACT.versionName,
  versionCode: CMU_PHYSICAL_CONTRACT.versionCode,
  listenerClassName: "NotificationRelayListener",
});

export const ASSOCIATION_TRUST_CONTRACT = Object.freeze({
  companionPackageName: CMU_PHYSICAL_CONTRACT.packageName,
  evidenceVersion: "cmu-association-trust-v1",
  systemAssociationRequired: true,
  uniqueAssociationRequired: true,
  bondStoreRequired: true,
  associationBondPeerMatchRequired: true,
  ambiguousRejected: true,
  idMismatchRejected: true,
  storeUnavailableRejected: true,
  negationRejected: true,
});

export const RUN_CORRELATION_CONTRACT = Object.freeze({
  required: true,
  available: false,
  reason:
    "production CMU audit events do not expose a run-scoped sentinel identity",
});

export const TRANSPORT_RESET_CONTRACT = Object.freeze({
  companionPackageName: CMU_PHYSICAL_CONTRACT.packageName,
  gattServiceUuid: "7905f431-b5ce-4e99-a40f-4b1e122d00d0",
  currentStackRequired: true,
  connectionEventRequired: true,
  staleConnectionRejected: true,
  freshResetProofAvailable: false,
});

const IOS_REPEATABLE_OBSERVATIONS = Object.freeze([
  "stock_bluetooth_pair_and_connect",
  "eligible_add_reaches_catch_me_up",
  "notification_update_ordered",
  "notification_removal_ordered",
  "notification_deduplication_verified",
  "stock_presentation_observed",
  "stock_narration_observed",
  "stock_reconnect_observed",
]);

export const IOS_NON_REGRESSION_GATE = Object.freeze({
  scope: "human-only",
  automated: false,
  description:
    "capture the complete stock iOS ANCS baseline before Android testing, then repeat the same observations after Android testing",
  phases: Object.freeze([
    Object.freeze({
      id: "before_android_baseline",
      requiredObservations: IOS_REPEATABLE_OBSERVATIONS,
    }),
    Object.freeze({
      id: "after_android_revalidation",
      requiredObservations: IOS_REPEATABLE_OBSERVATIONS,
    }),
  ]),
  checklist: Object.freeze([
    "Before Android: verify stock Bluetooth pair, connect, and reconnect behavior",
    "Before Android: verify an eligible add reaches Catch Me Up through stock ANCS",
    "Before Android: verify notification update, removal, and deduplication behavior",
    "Before Android: verify stock presentation and narration behavior",
    "After Android: repeat stock Bluetooth pair, connect, and reconnect behavior",
    "After Android: repeat the eligible stock ANCS add observation",
    "After Android: repeat notification update, removal, and deduplication observations",
    "After Android: repeat stock presentation and narration observations and compare with baseline",
  ]),
});

export const DEDUP_SETTLE_CONTRACT = Object.freeze({
  quietWindowMs: 3_000,
  timeoutMs: 12_000,
  pollIntervalMs: 250,
});

export const INCOMPLETE_STATES = Object.freeze({
  updateNotObserved: "sentinel update transport evidence was not observed",
  dedupNotVerified: "sentinel deduplication could not be verified",
  summarizationNotObserved: "Pin summarization token was not observed",
  lifecycleNotOrdered: "sentinel lifecycle ordering was not fully verified",
  transportResetNotVerified: "BLE transport reset was not verified",
  cleanupIncomplete: "sentinel cleanup did not fully complete",
  runCorrelationUnavailable:
    "run-scoped sentinel correlation is unavailable in the production CMU audit contract",
  preStateNotClean: "synthetic sentinel was present before the run",
  postStateNotRestored: "synthetic sentinel state was not restored after the run",
});

const REQUIRED_ADD_EVENTS = Object.freeze([
  "eligible_notification_queued",
  "notification_source_dispatched",
  "notification_source_transmission_completed",
  "notification_attributes_requested",
  "data_source_dispatched",
  "data_source_transmission_completed",
]);
const REQUIRED_REMOVE_EVENTS = Object.freeze([
  "notification_source_dispatched",
  "notification_source_transmission_completed",
]);
const REQUIRED_UPDATE_EVENTS = Object.freeze([
  "eligible_notification_queued",
  "notification_source_dispatched",
  "notification_source_transmission_completed",
]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ADB_OPERATION = Object.freeze({
  rolePreflight: "role_preflight",
  deviceState: "device_state",
  deviceModel: "device_model",
  deviceSdk: "device_sdk",
  companionIdentity: "companion_identity",
  packagePath: "package_path",
  apkPull: "apk_pull",
  listenerGrant: "listener_grant",
  associationTrust: "association_trust",
  transportCurrent: "transport_current",
  visibleListener: "visible_listener",
  visiblePolicy: "visible_policy",
  liveGatt: "live_gatt",
  boundary: "boundary",
  pixelAudit: "pixel_audit",
  pinComposition: "pin_composition",
  sentinelAbsence: "sentinel_absence",
  sentinelCancel: "sentinel_cancel",
  sentinelPost: "sentinel_post",
});

class PrivacySafeCmuError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacySafeCmuError";
  }
}

function safeError(message) {
  return new PrivacySafeCmuError(message);
}

function usage() {
  return `Usage:
  android-cmu-physical-smoke.mjs --self-check
  android-cmu-physical-smoke.mjs --run \\
    --pixel-serial PIXEL_SERIAL --expected-pixel-serial PIXEL_SERIAL \\
    --pin-serial PIN_SERIAL --expected-pin-serial PIN_SERIAL \\
    --expect-apk-sha256 ${CMU_PHYSICAL_CONTRACT.apkSha256}

The expected serials may instead use ${EXPECTED_PIXEL_SERIAL_ENV} and
${EXPECTED_PIN_SERIAL_ENV}; each ADB target must still match exactly.

The live mode requires an already visible, user-approved companion policy with:
  relay enabled; broad all-eligible mode enabled; body relay disabled; no
  com.android.shell allowlist entry.

It never reads notification bodies, never lists PackageInstaller sessions, posts
one fixed synthetic notification, verifies content-free ANCS/composition markers,
and cancels the sentinel in a finally block. The shell source remaining absent
from the allowlist is what proves broad admission.

Two distinct physical devices are required: one Pixel (phone role) containing the
companion and one AI Pin (pin role) without it. The harness rejects identical
serials for both roles.

Role preflight verifies the Pixel carries the companion and the Pin does not.
Companion identity checks version name/code. Listener grant checks the exact
NotificationRelayListener component (subpackage listeners are rejected).
Association trust checks system association and bond presence with negation
rejection. Transport readiness verifies the exact current BLE GATT stack, but
does not claim a fresh reset event. Sentinel
lifecycle covers add, update, removal, dedup, and ordering with explicit
incomplete states for any unverified phase.

Physical lifecycle acceptance currently fails closed before posting the
sentinel because production CMU audit markers do not contain a run-scoped
sentinel identity. A time boundary alone cannot prove that add, update, dedup,
or removal events belong to this run.

iOS non-regression is a separate human gate (not automated by this tool).`;
}

export function parseCmuPhysicalArgs(argv, environment = process.env) {
  const result = {
    mode: null,
    pixelSerial: null,
    expectedPixelSerial: null,
    pinSerial: null,
    expectedPinSerial: null,
    expectedApkSha256: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run") result.mode = "run";
    else if (arg === "--self-check") result.mode = "self-check";
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--pixel-serial") result.pixelSerial = argv[++index];
    else if (arg === "--expected-pixel-serial") result.expectedPixelSerial = argv[++index];
    else if (arg === "--pin-serial") result.pinSerial = argv[++index];
    else if (arg === "--expected-pin-serial") result.expectedPinSerial = argv[++index];
    else if (arg === "--expect-apk-sha256") result.expectedApkSha256 = argv[++index];
    else throw safeError("unknown argument");
  }
  if (result.help) return result;
  if (result.mode === "self-check") {
    if (
      result.pixelSerial ||
      result.expectedPixelSerial ||
      result.pinSerial ||
      result.expectedPinSerial ||
      result.expectedApkSha256
    ) {
      throw new Error("--self-check cannot be combined with live arguments");
    }
    return result;
  }
  if (result.mode !== "run") throw new Error("choose exactly one of --run or --self-check");
  result.expectedPixelSerial = resolveExpectedDeviceSerial({
    cliValue: result.expectedPixelSerial,
    environment,
    environmentName: EXPECTED_PIXEL_SERIAL_ENV,
    label: "Pixel serial",
  });
  result.expectedPinSerial = resolveExpectedDeviceSerial({
    cliValue: result.expectedPinSerial,
    environment,
    environmentName: EXPECTED_PIN_SERIAL_ENV,
    label: "AI Pin serial",
  });
  validatePhysicalOptions(result);
  return result;
}

export function validatePhysicalOptions(options) {
  if (!options || typeof options !== "object") throw new Error("physical smoke options are required");
  if (!exactDeviceTargetMatches(options.pixelSerial, options.expectedPixelSerial)) {
    throw new Error("the exact operator-confirmed Pixel serial is required");
  }
  if (!exactDeviceTargetMatches(options.pinSerial, options.expectedPinSerial)) {
    throw new Error("the exact operator-confirmed AI Pin serial is required");
  }
  if (options.expectedApkSha256 !== CMU_PHYSICAL_CONTRACT.apkSha256) {
    throw new Error("the exact reviewed companion APK SHA-256 is required");
  }
  assertDistinctDeviceRoles(options.pixelSerial, options.pinSerial);
  return options;
}

export function assertDistinctDeviceRoles(pixelSerial, pinSerial) {
  if (!pixelSerial || !pinSerial) {
    throw new Error("both Pixel and AI Pin device serials are required");
  }
  if (pixelSerial === pinSerial) {
    throw new Error("Pixel and AI Pin must be two distinct verified physical devices");
  }
}

export function buildCancelArgs(tag = CMU_PHYSICAL_CONTRACT.sentinelTag) {
  if (!/^[a-z0-9_]+$/.test(tag)) throw new Error("invalid sentinel tag");
  return [
    "shell", "service", "call", "notification",
    String(CMU_PHYSICAL_CONTRACT.cancelTransaction),
    "s16", CMU_PHYSICAL_CONTRACT.sentinelPackage,
    "s16", CMU_PHYSICAL_CONTRACT.sentinelPackage,
    "s16", tag,
    "i32", String(CMU_PHYSICAL_CONTRACT.shellNotificationId),
    "i32", "0",
  ];
}

export function orderedEventsObserved(events, required) {
  let cursor = 0;
  for (const event of events) {
    if (event === required[cursor]) cursor += 1;
    if (cursor === required.length) return true;
  }
  return required.length === 0;
}

export function parseAuditEvents(output, boundary) {
  const lines = String(output).split(/\r?\n/);
  const markerPattern = new RegExp(
    `^I\\/PenumbraCmuSmoke\\([^)]*\\): boundary=${escapeRegExp(boundary)}$`,
  );
  const boundaryIndex = lines.findLastIndex((line) => markerPattern.test(line));
  if (boundaryIndex < 0) return [];
  return lines.slice(boundaryIndex + 1).flatMap((line) => {
    const match = line.match(/I\/PenumbraCmu\([^)]*\): event=([a-z0-9_]+)$/);
    return match ? [match[1]] : [];
  });
}

export function parsePinCompositionTokens(output, boundary) {
  const lines = String(output).split(/\r?\n/);
  const boundaryIndex = lines.findLastIndex((line) => line === `boundary=${boundary}`);
  if (boundaryIndex < 0) return [];
  return lines.slice(boundaryIndex + 1).filter((line) =>
    line === "categorize_notifications" || line === "encrypted_summarize_messages");
}

export function parseRolePreflightOutput(output, packageName) {
  const raw = String(output).trim();
  if (!raw) return { packagePresent: false };
  const lines = raw.split(/\r?\n/);
  const packagePresent = lines.some((line) => {
    const match = line.match(/^package:(\/[\x21-\x7e]+)=([a-zA-Z0-9._]+)$/);
    return match?.[2] === packageName;
  });
  return { packagePresent };
}

export function assertRolePreflight(role, packagePresent) {
  if (role.companionRequired && !packagePresent) {
    throw new Error(`${role.role} role requires companion package to be present`);
  }
  if (!role.companionRequired && packagePresent) {
    throw new Error(`${role.role} role must not contain the companion package`);
  }
}

export function parseCompanionIdentityOutput(output) {
  const lines = String(output).split(/\r?\n/);
  let versionName = null;
  let versionCode = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s+versionName=(.+)$/);
    if (nameMatch) versionName = nameMatch[1].trim();
    const codeMatch = line.match(/^\s+versionCode=(\d+)/);
    if (codeMatch) versionCode = Number(codeMatch[1]);
  }
  return { versionName, versionCode };
}

export function assertCompanionIdentityMatch(parsed) {
  if (parsed.versionName !== COMPANION_IDENTITY_CONTRACT.versionName) {
    throw new Error("companion version name does not match the reviewed contract");
  }
  if (parsed.versionCode !== COMPANION_IDENTITY_CONTRACT.versionCode) {
    throw new Error("companion version code does not match the reviewed contract");
  }
}

export function parseListenerGrantOutput(output) {
  const raw = String(output).trim();
  if (!raw || raw === "null") {
    return { granted: false, component: null, ambiguous: false };
  }
  const entries = raw.split(":");
  const packageName = COMPANION_IDENTITY_CONTRACT.packageName;
  const listenerClassName = COMPANION_IDENTITY_CONTRACT.listenerClassName;
  const exactTarget = `${packageName}/${packageName}.${listenerClassName}`;
  const shortTarget = `${packageName}/.${listenerClassName}`;
  const matches = entries
    .map((entry) => entry.trim())
    .filter((entry) => entry === exactTarget || entry === shortTarget);
  return {
    granted: matches.length === 1,
    component: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

export function assertListenerGrantExact(parsed) {
  const packageName = COMPANION_IDENTITY_CONTRACT.packageName;
  const listenerClassName = COMPANION_IDENTITY_CONTRACT.listenerClassName;
  const exactTarget = `${packageName}/${packageName}.${listenerClassName}`;
  const shortTarget = `${packageName}/.${listenerClassName}`;
  if (
    !parsed ||
    parsed.granted !== true ||
    parsed.ambiguous !== false ||
    (parsed.component !== exactTarget && parsed.component !== shortTarget)
  ) {
    throw safeError(
      "notification listener grant is not visibly enabled for exactly one relay component",
    );
  }
}

export function parseAssociationStatusOutput(output) {
  const expectedKeys = new Set([
    "association_store_readable",
    "association_package_exact",
    "association_unique",
    "association_peer_present",
    "bond_store_readable",
    "association_bond_peer_match",
  ]);
  const fields = new Map();
  let malformed = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-z_]+)=(true|false)$/);
    if (!match || !expectedKeys.has(match[1]) || fields.has(match[1])) {
      malformed = true;
      continue;
    }
    fields.set(match[1], match[2] === "true");
  }
  const evidenceComplete = !malformed && fields.size === expectedKeys.size;
  const associationStoreReadable = fields.get("association_store_readable") === true;
  const associationPackageExact = fields.get("association_package_exact") === true;
  const uniqueAssociation = fields.get("association_unique") === true;
  const associationPeerPresent = fields.get("association_peer_present") === true;
  const bondStoreReadable = fields.get("bond_store_readable") === true;
  const associationBondPeerMatch = fields.get("association_bond_peer_match") === true;
  return {
    evidenceComplete,
    associationStoreReadable,
    associationPackageExact,
    uniqueAssociation,
    associationPeerPresent,
    bondStoreReadable,
    associationBondPeerMatch,
    associationPresent:
      evidenceComplete &&
      associationStoreReadable &&
      associationPackageExact &&
      uniqueAssociation &&
      associationPeerPresent,
    bondPresent:
      evidenceComplete && bondStoreReadable && associationBondPeerMatch,
    readable:
      evidenceComplete && associationStoreReadable && bondStoreReadable,
  };
}

export function assertAssociationTrust(status) {
  if (!status?.evidenceComplete) {
    throw safeError("association evidence is incomplete or malformed");
  }
  if (!status.associationStoreReadable || !status.bondStoreReadable) {
    throw safeError("association or bond store is not readable");
  }
  if (!status.associationPackageExact) {
    throw safeError("exact companion system association is not present");
  }
  if (!status.uniqueAssociation) {
    throw safeError("companion system association is ambiguous");
  }
  if (!status.associationPresent) {
    throw safeError("exact companion system association is not present");
  }
  if (!status.associationPeerPresent || !status.associationBondPeerMatch || !status.bondPresent) {
    throw safeError("companion association does not match exactly one bonded peer");
  }
}

export function parseTransportResetOutput(output) {
  const expectedKeys = new Set([
    "transport_app_exact",
    "transport_service_exact",
    "transport_connection_current",
    "transport_stale",
  ]);
  const fields = new Map();
  let malformed = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-z_]+)=(true|false)$/);
    if (!match || !expectedKeys.has(match[1]) || fields.has(match[1])) {
      malformed = true;
      continue;
    }
    fields.set(match[1], match[2] === "true");
  }
  const evidenceComplete = !malformed && fields.size === expectedKeys.size;
  const appExact = fields.get("transport_app_exact") === true;
  const serviceExact = fields.get("transport_service_exact") === true;
  const connectionCurrent = fields.get("transport_connection_current") === true;
  const staleConnection = fields.get("transport_stale") !== false;
  return {
    evidenceComplete,
    appExact,
    serviceExact,
    connectionCurrent,
    connectionEvent:
      evidenceComplete && appExact && serviceExact && connectionCurrent,
    staleConnection,
  };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertTransportReset(parsed) {
  if (!parsed?.evidenceComplete) {
    throw safeError("BLE transport readiness: evidence is incomplete or malformed");
  }
  if (!parsed.appExact || !parsed.serviceExact || !parsed.connectionCurrent || !parsed.connectionEvent) {
    throw safeError("BLE transport readiness: exact current GATT stack was not observed");
  }
  if (parsed.staleConnection) {
    throw safeError("BLE transport readiness: connection appears stale or timed out");
  }
}

export function verifySentinelUpdateSequence(updateEvents) {
  return orderedEventsObserved(updateEvents, REQUIRED_UPDATE_EVENTS);
}

export function verifySentinelRemovalSequence(removeEvents) {
  return orderedEventsObserved(removeEvents, REQUIRED_REMOVE_EVENTS);
}

export function verifySentinelDeduplication(events) {
  const queueCount = events.filter((event) => event === "eligible_notification_queued").length;
  return queueCount === 1;
}

export function verifySentinelLifecycleOrdering(addEvents, updateEvents, removeEvents) {
  return (
    orderedEventsObserved(addEvents, REQUIRED_ADD_EVENTS) &&
    orderedEventsObserved(updateEvents, REQUIRED_UPDATE_EVENTS) &&
    orderedEventsObserved(removeEvents, REQUIRED_REMOVE_EVENTS)
  );
}

export function assertRunCorrelationAvailable(contract = RUN_CORRELATION_CONTRACT) {
  if (contract?.required !== true || contract?.available !== true) {
    throw safeError(INCOMPLETE_STATES.runCorrelationUnavailable);
  }
}

export function assertPhysicalAcceptanceContractsAvailable({
  runCorrelation = RUN_CORRELATION_CONTRACT,
  transport = TRANSPORT_RESET_CONTRACT,
} = {}) {
  assertRunCorrelationAvailable(runCorrelation);
  if (transport?.freshResetProofAvailable !== true) {
    throw safeError(INCOMPLETE_STATES.transportResetNotVerified);
  }
}

const REQUIRED_PHYSICAL_RESULT_GATES = Object.freeze([
  ["fresh_transport_reset", "transportFreshResetVerified"],
  ["pre_state_clean", "preStateAbsent"],
  ["add_sequence", "ancsAddSequenceVerified"],
  ["update_sequence", "ancsUpdateSequenceVerified"],
  ["deduplication", "sentinelDeduplicationVerified"],
  ["pin_categorization", "pinCategorizationVerified"],
  ["pin_summarization", "pinSummarizationObserved"],
  ["removal_sequence", "ancsRemovalObserved"],
  ["lifecycle_ordering", "sentinelLifecycleOrdered"],
  ["broad_unlisted_source", "broadUnlistedSourceVerified"],
  ["post_state_restored", "postStateRestored"],
]);

export function assertPhysicalSmokeComplete(result) {
  const failedGates = REQUIRED_PHYSICAL_RESULT_GATES
    .filter(([, property]) => result?.[property] !== true)
    .map(([name]) => name);
  if (
    result?.complete !== true ||
    !Array.isArray(result?.incompleteReasons) ||
    result.incompleteReasons.length > 0 ||
    failedGates.length > 0
  ) {
    const names = failedGates.length > 0 ? failedGates.join(",") : "incomplete_evidence";
    throw safeError(`physical smoke incomplete: ${names}`);
  }
  return result;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildPixelAuditArgs() {
  return [
    "shell", "logcat", "-b", "all", "-d", "-v", "brief",
    "-s", "PenumbraCmu:I", "PenumbraCmuSmoke:I", "*:S",
  ];
}

function buildPinCompositionProbeScript(boundary) {
  if (!/^[a-z0-9-]+$/.test(boundary)) throw safeError("invalid content-free boundary");
  const categorizeMarker =
    OPERATIONAL_MARKERS.categorize_notifications.value.replaceAll("'", "'\\''");
  const summarizeMarker =
    OPERATIONAL_MARKERS.encrypted_summarize_messages.value.replaceAll("'", "'\\''");
  return [
    `logcat -b all -d -v brief | `,
    `awk -v marker='boundary=${boundary}' `,
    `-v categorize='${categorizeMarker}' -v summarize='${summarizeMarker}' '`,
    `/PenumbraCmuSmoke/ && index($0,marker){seen=1; print marker; next} `,
    `seen && /PenumbraServer/ && index($0,categorize){print "categorize_notifications"} `,
    `seen && /PenumbraServer/ && index($0,summarize){print "encrypted_summarize_messages"}`,
    `'`,
  ].join("");
}

function buildRunAsPolicyShell() {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  const encoded = Buffer.from(buildVisiblePolicyProbeScript(), "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d | run-as ${packageName} sh`;
}

function buildSentinelPostArgs() {
  return [
    "shell", "cmd", "notification", "post",
    "--title", "CMU_SENTINEL",
    CMU_PHYSICAL_CONTRACT.sentinelTag,
    "CMU_SENTINEL",
  ];
}

export function assertHarnessAdbCommand(operation, args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw safeError("command arguments must be strings");
  }
  if (args[0] === "adb") {
    try {
      if (args[1] !== "-s") throw new Error("missing target selector");
      validateDeviceSerial(args[2], "ADB serial");
    } catch {
      throw safeError("an explicit ADB serial is required");
    }
  } else {
    throw safeError("only bounded ADB commands are supported");
  }
  const tail = args.slice(3);
  let allowed = false;
  switch (operation) {
    case ADB_OPERATION.rolePreflight:
      allowed = arraysEqual(tail, [
        "shell", "pm", "list", "packages", "-f", CMU_PHYSICAL_CONTRACT.packageName,
      ]);
      break;
    case ADB_OPERATION.deviceState:
      allowed = arraysEqual(tail, ["get-state"]);
      break;
    case ADB_OPERATION.deviceModel:
      allowed = arraysEqual(tail, ["shell", "getprop", "ro.product.model"]);
      break;
    case ADB_OPERATION.deviceSdk:
      allowed = arraysEqual(tail, ["shell", "getprop", "ro.build.version.sdk"]);
      break;
    case ADB_OPERATION.companionIdentity:
      allowed = arraysEqual(tail, ["shell", buildCompanionIdentityProbeScript()]);
      break;
    case ADB_OPERATION.packagePath:
      allowed = arraysEqual(tail, ["shell", "pm", "path", CMU_PHYSICAL_CONTRACT.packageName]);
      break;
    case ADB_OPERATION.apkPull:
      allowed =
        tail.length === 3 &&
        tail[0] === "pull" &&
        /^\/[\x21-\x7e]+\/base\.apk$/.test(tail[1]) &&
        /\/penumbra-cmu-smoke-[^/]+\/installed\.apk$/.test(tail[2]);
      break;
    case ADB_OPERATION.listenerGrant:
      allowed = arraysEqual(tail, [
        "shell", "settings", "get", "secure", "enabled_notification_listeners",
      ]);
      break;
    case ADB_OPERATION.associationTrust:
      allowed = arraysEqual(tail, ["shell", buildAssociationTrustProbeScript()]);
      break;
    case ADB_OPERATION.transportCurrent:
      allowed = arraysEqual(tail, ["shell", buildTransportCurrentProbeScript()]);
      break;
    case ADB_OPERATION.visibleListener:
      allowed = arraysEqual(tail, ["shell", buildVisibleListenerProbeScript()]);
      break;
    case ADB_OPERATION.visiblePolicy:
      allowed = arraysEqual(tail, ["shell", buildRunAsPolicyShell()]);
      break;
    case ADB_OPERATION.liveGatt:
      allowed = arraysEqual(tail, ["shell", buildLiveGattProbeScript()]);
      break;
    case ADB_OPERATION.boundary: {
      const boundary = tail.at(-1)?.match(/^boundary=([a-z0-9-]+)$/)?.[1];
      allowed = Boolean(boundary) && arraysEqual(tail, buildBoundaryArgs(boundary));
      break;
    }
    case ADB_OPERATION.pixelAudit:
      allowed = arraysEqual(tail, buildPixelAuditArgs());
      break;
    case ADB_OPERATION.pinComposition: {
      const boundary = tail[1]?.match(/marker='boundary=([a-z0-9-]+)'/)?.[1];
      allowed = Boolean(boundary) && arraysEqual(tail, [
        "shell", buildPinCompositionProbeScript(boundary),
      ]);
      break;
    }
    case ADB_OPERATION.sentinelAbsence:
      allowed = arraysEqual(tail, ["shell", buildSentinelAbsenceProbeScript()]);
      break;
    case ADB_OPERATION.sentinelCancel:
      allowed = arraysEqual(tail, buildCancelArgs());
      break;
    case ADB_OPERATION.sentinelPost:
      allowed = arraysEqual(tail, buildSentinelPostArgs());
      break;
    default:
      allowed = false;
  }
  if (!allowed) throw safeError("ADB command is outside the CMU harness allowlist");
  return true;
}

export function buildBoundedAdbSpawnOptions({
  input = undefined,
  timeoutMs = CMU_PHYSICAL_CONTRACT.adbCommandTimeoutMs,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw safeError("ADB command timeout is outside the allowed bound");
  }
  return {
    encoding: "utf8",
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  };
}

export function normalizeBoundedAdbResult(result, { allowFailure = false } = {}) {
  if (!result || typeof result !== "object") {
    throw safeError("ADB command returned no bounded result");
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    throw safeError("ADB command exceeded its bounded timeout");
  }
  if (result.error) {
    throw safeError("ADB command could not be started");
  }
  if (!Number.isInteger(result.status)) {
    throw safeError("ADB command did not return a valid status");
  }
  if (!allowFailure && result.status !== 0) {
    throw safeError("ADB command failed");
  }
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function runBoundedAdb(
  operation,
  args,
  { allowFailure = false, input = undefined, timeoutMs, spawn = spawnSync } = {},
) {
  assertHarnessAdbCommand(operation, ["adb", ...args]);
  let result;
  try {
    result = spawn("adb", args, buildBoundedAdbSpawnOptions({ input, timeoutMs }));
  } catch {
    throw safeError("ADB command could not be started");
  }
  return normalizeBoundedAdbResult(result, { allowFailure });
}

function adb(operation, serial, args, options) {
  return runBoundedAdb(operation, ["-s", serial, ...args], options);
}

function remotePredicate(operation, serial, script) {
  const result = adb(operation, serial, ["shell", script], { allowFailure: true });
  return result.status === 0;
}

function runAsPredicate(operation, serial, packageName, script) {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return remotePredicate(
    operation,
    serial,
    `printf '%s' '${encoded}' | base64 -d | run-as ${packageName} sh`,
  );
}

function requirePredicate(value, message) {
  if (!value) throw safeError(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyRolePreflight(serial, role) {
  const output = adb(
    ADB_OPERATION.rolePreflight,
    serial,
    ["shell", "pm", "list", "packages", "-f", role.companionPackage],
  ).stdout;
  const parsed = parseRolePreflightOutput(output, role.companionPackage);
  assertRolePreflight(role, parsed.packagePresent);
}

function verifyDevice(serial, expectedModel, expectedSdk) {
  requirePredicate(
    adb(ADB_OPERATION.deviceState, serial, ["get-state"]).stdout.trim() === "device",
    `${expectedModel} is not ADB-ready`,
  );
  requirePredicate(
    adb(
      ADB_OPERATION.deviceModel,
      serial,
      ["shell", "getprop", "ro.product.model"],
    ).stdout.trim() === expectedModel,
    `unexpected model for target device`,
  );
  requirePredicate(
    adb(
      ADB_OPERATION.deviceSdk,
      serial,
      ["shell", "getprop", "ro.build.version.sdk"],
    ).stdout.trim() === expectedSdk,
    `unexpected SDK for target device`,
  );
}

function buildCompanionIdentityProbeScript() {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  return [
    `dumpsys package ${packageName} 2>/dev/null | `,
    `awk '/^[[:space:]]+versionName=/{print} `,
    `/^[[:space:]]+versionCode=/{print}'`,
  ].join("");
}

function verifyCompanionIdentity(pixelSerial) {
  const output = adb(
    ADB_OPERATION.companionIdentity,
    pixelSerial,
    ["shell", buildCompanionIdentityProbeScript()],
  ).stdout;
  const parsed = parseCompanionIdentityOutput(output);
  assertCompanionIdentityMatch(parsed);
}

function verifyInstalledCompanion(pixelSerial, expectedSha) {
  const packagePathOutput = adb(
    ADB_OPERATION.packagePath,
    pixelSerial,
    ["shell", "pm", "path", CMU_PHYSICAL_CONTRACT.packageName],
  ).stdout.trim();
  const match = packagePathOutput.match(/^package:(\/[^\r\n]+\/base\.apk)$/);
  requirePredicate(Boolean(match), "companion base APK path is unavailable");
  const privateDir = mkdtempSync(join(tmpdir(), "penumbra-cmu-smoke-"));
  try {
    const localApk = join(privateDir, "installed.apk");
    adb(ADB_OPERATION.apkPull, pixelSerial, ["pull", match[1], localApk]);
    requirePredicate(sha256File(localApk) === expectedSha, "installed companion APK SHA-256 mismatch");
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}

function verifyListenerGrant(pixelSerial) {
  const output = adb(
    ADB_OPERATION.listenerGrant,
    pixelSerial,
    ["shell", "settings", "get", "secure", "enabled_notification_listeners"],
  ).stdout;
  const parsed = parseListenerGrantOutput(output);
  assertListenerGrantExact(parsed);
}

export function buildAssociationTrustProbeScript() {
  const packageName = ASSOCIATION_TRUST_CONTRACT.companionPackageName;
  return [
    `pkg='${packageName}'; `,
    `association_store_readable=false; association_package_exact=false; `,
    `association_unique=false; association_peer_present=false; `,
    `bond_store_readable=false; association_bond_peer_match=false; `,
    `bluetooth_dump=$(dumpsys bluetooth_manager 2>/dev/null); bluetooth_status=$?; `,
    `if [ "$bluetooth_status" -eq 0 ]; then bond_store_readable=true; fi; `,
    `user_id=$(am get-current-user 2>/dev/null); user_status=$?; `,
    `if [ "$user_status" -eq 0 ] && [ -n "$user_id" ]; then `,
    `association_dump=$(cmd companiondevice list "$user_id" 2>/dev/null); association_status=$?; `,
    `if [ "$association_status" -eq 0 ]; then association_store_readable=true; `,
    `association_count=$(printf '%s\\n' "$association_dump" | awk -F'|' -v pkg="$pkg" `,
    `'NF==3 { p=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", p); `,
    `if (p==pkg) count++ } END{print count+0}'); `,
    `peers=$(printf '%s\\n' "$association_dump" | awk -F'|' -v pkg="$pkg" `,
    `'NF==3 { p=$2; a=$3; gsub(/^[[:space:]]+|[[:space:]]+$/, "", p); `,
    `gsub(/^[[:space:]]+|[[:space:]]+$/, "", a); if (p==pkg) print a }'); `,
    `peer_count=$(printf '%s\\n' "$peers" | grep -Ec '^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$' || true); `,
    `if [ "$association_count" -gt 0 ]; then association_package_exact=true; fi; `,
    `if [ "$association_count" -eq 1 ]; then association_unique=true; fi; `,
    `if [ "$association_count" -eq 1 ] && [ "$peer_count" -eq 1 ]; then association_peer_present=true; `,
    `peer=$(printf '%s\\n' "$peers" | grep -E '^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$'); `,
    `if [ "$bond_store_readable" = true ] && printf '%s\\n' "$bluetooth_dump" | awk -v peer="$peer" `,
    `'BEGIN{in_bonds=0; found=0} /^Bonded devices:/{in_bonds=1; next} `,
    `in_bonds && /^[^[:space:]]/{in_bonds=0} in_bonds {address=$1; `,
    `if (toupper(address)==toupper(peer)) found=1} END{exit !found}'; `,
    `then association_bond_peer_match=true; fi; fi; fi; fi; `,
    `printf '%s\\n' `,
    `"association_store_readable=$association_store_readable" `,
    `"association_package_exact=$association_package_exact" `,
    `"association_unique=$association_unique" `,
    `"association_peer_present=$association_peer_present" `,
    `"bond_store_readable=$bond_store_readable" `,
    `"association_bond_peer_match=$association_bond_peer_match"`,
  ].join("");
}

function verifyAssociationTrust(pixelSerial) {
  const output = adb(
    ADB_OPERATION.associationTrust,
    pixelSerial,
    ["shell", buildAssociationTrustProbeScript()],
  ).stdout;
  const parsed = parseAssociationStatusOutput(output);
  assertAssociationTrust(parsed);
}

function buildTransportCurrentProbeScript() {
  return [
    `dumpsys bluetooth_manager 2>/dev/null | `,
    `awk 'BEGIN{a=0;s=0;c=0;stale=0;n=0} `,
    `/appName:[[:space:]]*${CMU_PHYSICAL_CONTRACT.packageName}$/{a=1;n=5;next} `,
    `n>0 && /Connection\\(/{c=1} n>0{n--} `,
    `/Service[[:space:]]+${TRANSPORT_RESET_CONTRACT.gattServiceUuid}$/{s=1} `,
    `/stale|timeout/{stale=1} `,
    `END{print "transport_app_exact=" (a?"true":"false"); `,
    `print "transport_service_exact=" (s?"true":"false"); `,
    `print "transport_connection_current=" (c?"true":"false"); `,
    `print "transport_stale=" (stale?"true":"false")}'`,
  ].join("");
}

function verifyTransportReset(pixelSerial) {
  const output = adb(
    ADB_OPERATION.transportCurrent,
    pixelSerial,
    ["shell", buildTransportCurrentProbeScript()],
  ).stdout;
  const parsed = parseTransportResetOutput(output);
  assertTransportReset(parsed);
}

export function buildVisiblePolicyProbeScript(
  settingsFile = "shared_prefs/cmu_relay_settings.xml",
) {
  if (settingsFile !== "shared_prefs/cmu_relay_settings.xml" && settingsFile !== "/dev/stdin") {
    throw safeError("invalid visible-policy settings source");
  }
  const readSettings = settingsFile === "/dev/stdin"
    ? `xml=$(cat) || exit 1; `
    : `f='${settingsFile}'; test -r "$f" || exit 1; xml=$(cat "$f") || exit 1; `;
  const sentinelPackage = CMU_PHYSICAL_CONTRACT.sentinelPackage;
  const exactBoolean = (name, value) => [
    `[ "$(printf '%s\\n' "$xml" | grep -Fo 'name="${name}"' | wc -l | tr -d ' ')" -eq 1 ] || exit 1; `,
    `printf '%s\\n' "$xml" | grep -Fq 'name="${name}" value="${value}"' || exit 1; `,
  ].join("");
  return [
    readSettings,
    exactBoolean("relay_enabled", "true"),
    exactBoolean("relay_all_eligible", "true"),
    exactBoolean("relay_bodies", "false"),
    `! printf '%s\\n' "$xml" | grep -Fq '<string>${sentinelPackage}</string>'`,
  ].join("");
}

function buildVisibleListenerProbeScript() {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  const listenerClassName = COMPANION_IDENTITY_CONTRACT.listenerClassName;
  const exactListener = `${packageName}/${packageName}.${listenerClassName}`;
  const shortListener = `${packageName}/.${listenerClassName}`;
  return [
    `settings get secure enabled_notification_listeners | tr ':' '\\n' | `,
    `awk -v exact='${exactListener}' -v short='${shortListener}' `,
    `'($0==exact || $0==short){count++} END{exit count != 1}'`,
  ].join("");
}

function verifyVisiblePolicy(pixelSerial) {
  const packageName = CMU_PHYSICAL_CONTRACT.packageName;
  const listenerReady = remotePredicate(
    ADB_OPERATION.visibleListener,
    pixelSerial,
    buildVisibleListenerProbeScript(),
  );
  requirePredicate(listenerReady, "notification-listener access is not visibly enabled");

  requirePredicate(
    runAsPredicate(
      ADB_OPERATION.visiblePolicy,
      pixelSerial,
      packageName,
      buildVisiblePolicyProbeScript(),
    ),
    "visible test policy must be relay on, broad mode on, bodies off, and com.android.shell unlisted",
  );
}

export function buildLiveGattProbeScript(
  source = "dumpsys bluetooth_manager 2>/dev/null",
) {
  if (source !== "dumpsys bluetooth_manager 2>/dev/null" && source !== "cat /dev/stdin") {
    throw safeError("invalid live-GATT probe source");
  }
  const sourceCommand = source === "cat /dev/stdin" ? "cat" : source;
  const packagePattern = escapeRegExp(CMU_PHYSICAL_CONTRACT.packageName);
  const servicePattern = escapeRegExp(TRANSPORT_RESET_CONTRACT.gattServiceUuid);
  return [
    `${sourceCommand} | `,
    `awk 'function finish_app(){if(block_app && block_connection && block_service && !block_stale){same_block=1}} `,
    `BEGIN{app=0;connection=0;service=0;same_block=0;advertising=0;app_lines=0;in_adv=0;adv_lines=0} `,
    `/^[[:space:]]*Ongoing advertising:[[:space:]]*$/{in_adv=1;adv_lines=32;next} `,
    `in_adv && /^[^[:space:]]/{in_adv=0;adv_lines=0} `,
    `in_adv && /^[[:space:]]*${packagePattern}([[:space:]]|$)/{advertising=1} `,
    `in_adv && adv_lines>0{adv_lines--;if(adv_lines==0){in_adv=0}} `,
    `/^[[:space:]]*appName:/{finish_app();block_app=0;block_connection=0;block_service=0;block_stale=0;app_lines=0} `,
    `/^[[:space:]]*appName:[[:space:]]*${packagePattern}[[:space:]]*$/{app=1;block_app=1;app_lines=8;next} `,
    `block_app && app_lines>0 && /^[[:space:]]*Connection\\(connected\\)[[:space:]]*$/{connection=1;block_connection=1} `,
    `block_app && app_lines>0 && /(Connection\\([^)]*(disconnected|stale|timeout)[^)]*\\)|stale|timeout)/{block_stale=1} `,
    `block_app && app_lines>0 && /^[[:space:]]*Service[[:space:]]+${servicePattern}[[:space:]]*$/{service=1;block_service=1} `,
    `block_app && app_lines>0{app_lines--;if(app_lines==0){finish_app();block_app=0}} `,
    `END{finish_app(); `,
    `print "gatt_app_exact=" (app?"true":"false"); `,
    `print "gatt_connection_correlated=" (connection?"true":"false"); `,
    `print "gatt_service_correlated=" (service?"true":"false"); `,
    `print "gatt_same_block_correlated=" (same_block?"true":"false"); `,
    `print "gatt_advertising_section_exact=" (advertising?"true":"false")}'`,
  ].join("");
}

export function parseLiveGattProbeOutput(output) {
  const expectedKeys = new Set([
    "gatt_app_exact",
    "gatt_connection_correlated",
    "gatt_service_correlated",
    "gatt_same_block_correlated",
    "gatt_advertising_section_exact",
  ]);
  const fields = new Map();
  let malformed = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-z_]+)=(true|false)$/);
    if (!match || !expectedKeys.has(match[1]) || fields.has(match[1])) {
      malformed = true;
      continue;
    }
    fields.set(match[1], match[2] === "true");
  }
  return {
    evidenceComplete: !malformed && fields.size === expectedKeys.size,
    appExact: fields.get("gatt_app_exact") === true,
    connectionCorrelated: fields.get("gatt_connection_correlated") === true,
    serviceCorrelated: fields.get("gatt_service_correlated") === true,
    sameBlockCorrelated: fields.get("gatt_same_block_correlated") === true,
    advertisingSectionExact: fields.get("gatt_advertising_section_exact") === true,
  };
}

export function assertLiveGattReady(parsed) {
  if (
    !parsed?.evidenceComplete ||
    !parsed.appExact ||
    !parsed.connectionCorrelated ||
    !parsed.serviceCorrelated ||
    !parsed.sameBlockCorrelated ||
    !parsed.advertisingSectionExact
  ) {
    throw safeError("live companion ANCS advertise/service/connection is not exactly correlated");
  }
}

function verifyLiveGatt(pixelSerial) {
  const output = adb(
    ADB_OPERATION.liveGatt,
    pixelSerial,
    ["shell", buildLiveGattProbeScript()],
  ).stdout;
  assertLiveGattReady(parseLiveGattProbeOutput(output));
}

export function buildBoundaryArgs(boundary) {
  if (!/^[a-z0-9-]+$/.test(boundary)) throw new Error("invalid content-free boundary");
  return ["shell", "log", "-p", "i", "-t", "PenumbraCmuSmoke", `boundary=${boundary}`];
}

function writeBoundary(serial, boundary) {
  adb(ADB_OPERATION.boundary, serial, buildBoundaryArgs(boundary));
}

function pixelAuditSince(pixelSerial, boundary) {
  const output = adb(
    ADB_OPERATION.pixelAudit,
    pixelSerial,
    buildPixelAuditArgs(),
  ).stdout;
  return parseAuditEvents(output, boundary);
}

function pinCompositionSince(pinSerial, boundary) {
  const output = adb(
    ADB_OPERATION.pinComposition,
    pinSerial,
    ["shell", buildPinCompositionProbeScript(boundary)],
  ).stdout;
  return parsePinCompositionTokens(output, boundary);
}

export function buildSentinelAbsenceProbeScript(
  tag = CMU_PHYSICAL_CONTRACT.sentinelTag,
) {
  if (!/^[a-z0-9_]+$/.test(tag)) throw safeError("invalid sentinel tag");
  return [
    `notification_keys=$(cmd notification list 2>/dev/null); command_status=$?; `,
    `[ "$command_status" -eq 0 ] || exit 2; `,
    `! printf '%s\\n' "$notification_keys" | grep -F '${tag}' >/dev/null`,
  ].join("");
}

function sentinelIsAbsent(pixelSerial) {
  return remotePredicate(
    ADB_OPERATION.sentinelAbsence,
    pixelSerial,
    buildSentinelAbsenceProbeScript(),
  );
}

function cancelSentinel(pixelSerial) {
  adb(ADB_OPERATION.sentinelCancel, pixelSerial, buildCancelArgs());
}

function sleep(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function waitUntil(timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    sleep(500);
  }
  return false;
}

export function waitForStableEventSnapshot({
  timeoutMs,
  quietMs,
  pollMs,
  readEvents,
  isReady,
  now = Date.now,
  pause = sleep,
}) {
  if (
    !Number.isInteger(timeoutMs) ||
    !Number.isInteger(quietMs) ||
    !Number.isInteger(pollMs) ||
    timeoutMs <= 0 ||
    quietMs <= 0 ||
    pollMs <= 0 ||
    quietMs >= timeoutMs ||
    typeof readEvents !== "function" ||
    typeof isReady !== "function" ||
    typeof now !== "function" ||
    typeof pause !== "function"
  ) {
    throw safeError("invalid bounded event-settle contract");
  }

  const deadline = now() + timeoutMs;
  let fingerprint = null;
  let stableSince = null;
  let snapshot = [];
  while (now() < deadline) {
    const observed = readEvents();
    if (!Array.isArray(observed) || observed.some((event) => typeof event !== "string")) {
      throw safeError("event-settle probe returned malformed evidence");
    }
    const current = [...observed];
    const currentFingerprint = JSON.stringify(current);
    const observedAt = now();
    if (currentFingerprint !== fingerprint) {
      fingerprint = currentFingerprint;
      stableSince = observedAt;
      snapshot = current;
    } else if (
      stableSince !== null &&
      isReady(snapshot) === true &&
      observedAt - stableSince >= quietMs
    ) {
      return snapshot;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    pause(Math.min(pollMs, remaining));
  }
  return null;
}

/**
 * Cleanup is deliberately dependency-injected so failure ordering is testable.
 * Cancellation and absence verification run even when boundary logging fails.
 * The overall cleanup is bounded by a timeout to prevent indefinite hangs.
 */
export function executeSentinelCleanup({
  preStateAbsent,
  posted,
  writeRemovalBoundary,
  cancel,
  waitForRemoval,
  sentinelAbsent,
  timeoutMs = CMU_PHYSICAL_CONTRACT.cleanupTimeoutMs,
}) {
  if (preStateAbsent !== true) {
    throw safeError(INCOMPLETE_STATES.preStateNotClean);
  }
  const errors = [];
  let removalObserved = false;
  let absent = false;
  const deadline = Date.now() + timeoutMs;

  try {
    writeRemovalBoundary();
  } catch (error) {
    errors.push(error);
  }
  try {
    cancel();
  } catch (error) {
    errors.push(error);
  }
  if (posted) {
    if (Date.now() < deadline) {
      try {
        removalObserved = Boolean(waitForRemoval());
      } catch (error) {
        errors.push(error);
      }
      if (!removalObserved) {
        if (Date.now() >= deadline) {
          errors.push(new Error("cleanup exceeded bounded timeout before removal could be verified"));
        } else {
          errors.push(new Error("posted synthetic sentinel did not produce ANCS removal transport evidence"));
        }
      }
    } else {
      errors.push(new Error("cleanup exceeded bounded timeout before removal could be verified"));
    }
  }
  if (Date.now() < deadline) {
    try {
      absent = Boolean(sentinelAbsent());
    } catch (error) {
      errors.push(error);
    }
    if (!absent) {
      if (Date.now() >= deadline) {
        errors.push(new Error("cleanup exceeded bounded timeout before absence could be verified"));
      } else {
        errors.push(new Error("synthetic sentinel cleanup was not observed on Pixel"));
      }
    }
  } else {
    errors.push(new Error("cleanup exceeded bounded timeout before absence could be verified"));
  }
  if (errors.length > 0) throw errors[0];
  return { removalObserved, sentinelAbsent: absent };
}

export function selfCheck() {
  const fixturePixelSerial = "fixture-pixel-serial";
  const fixturePinSerial = "fixture-pin-serial";
  assertHarnessAdbCommand(
    ADB_OPERATION.sentinelCancel,
    ["adb", "-s", fixturePixelSerial, ...buildCancelArgs()],
  );
  assertHarnessAdbCommand(
    ADB_OPERATION.sentinelPost,
    ["adb", "-s", fixturePixelSerial, ...buildSentinelPostArgs()],
  );
  requirePredicate(orderedEventsObserved(REQUIRED_ADD_EVENTS, REQUIRED_ADD_EVENTS), "add event contract is invalid");
  requirePredicate(orderedEventsObserved(REQUIRED_REMOVE_EVENTS, REQUIRED_REMOVE_EVENTS), "remove event contract is invalid");
  requirePredicate(orderedEventsObserved(REQUIRED_UPDATE_EVENTS, REQUIRED_UPDATE_EVENTS), "update event contract is invalid");

  // Validate distinct roles contract
  assertDistinctDeviceRoles(fixturePixelSerial, fixturePinSerial);
  requirePredicate(
    (() => { try { assertDistinctDeviceRoles(fixturePixelSerial, fixturePixelSerial); return false; } catch { return true; } })(),
    "distinct roles must reject identical serials",
  );

  // Validate role preflight contract
  assertRolePreflight(ROLE_PREFLIGHT.pixel, true);
  assertRolePreflight(ROLE_PREFLIGHT.pin, false);

  // Validate companion identity contract
  assertCompanionIdentityMatch({
    versionName: COMPANION_IDENTITY_CONTRACT.versionName,
    versionCode: COMPANION_IDENTITY_CONTRACT.versionCode,
  });

  // Validate listener grant parser — exact components only
  const exactGrant = `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  assertListenerGrantExact(parseListenerGrantOutput(exactGrant));
  const subpackageGrant = `${COMPANION_IDENTITY_CONTRACT.packageName}/${COMPANION_IDENTITY_CONTRACT.packageName}.subpackage.${COMPANION_IDENTITY_CONTRACT.listenerClassName}`;
  requirePredicate(
    !parseListenerGrantOutput(subpackageGrant).granted,
    "listener grant parser must reject subpackage listeners",
  );

  // Validate exact, content-free association-to-bond evidence.
  const goodAssociation = parseAssociationStatusOutput([
    "association_store_readable=true",
    "association_package_exact=true",
    "association_unique=true",
    "association_peer_present=true",
    "bond_store_readable=true",
    "association_bond_peer_match=true",
  ].join("\n"));
  assertAssociationTrust(goodAssociation);
  const negatedAssociation = parseAssociationStatusOutput("no association present");
  requirePredicate(
    !negatedAssociation.evidenceComplete && !negatedAssociation.associationPresent,
    "association parser must reject prose and negated forms",
  );

  // Validate transport reset contract
  requirePredicate(TRANSPORT_RESET_CONTRACT.currentStackRequired, "transport readiness must require the current stack");
  requirePredicate(TRANSPORT_RESET_CONTRACT.connectionEventRequired, "transport reset must require connection event");
  requirePredicate(TRANSPORT_RESET_CONTRACT.staleConnectionRejected, "transport reset must reject stale connections");
  requirePredicate(
    TRANSPORT_RESET_CONTRACT.freshResetProofAvailable === false,
    "self-check must not claim a fresh transport reset",
  );
  const goodTransport = parseTransportResetOutput([
    "transport_app_exact=true",
    "transport_service_exact=true",
    "transport_connection_current=true",
    "transport_stale=false",
  ].join("\n"));
  assertTransportReset(goodTransport);
  requirePredicate(
    (() => { try { assertTransportReset(parseTransportResetOutput("")); return false; } catch { return true; } })(),
    "transport reset must reject missing connection event",
  );

  // Validate sentinel lifecycle pure checks
  requirePredicate(verifySentinelUpdateSequence(REQUIRED_UPDATE_EVENTS), "update sequence contract is invalid");
  requirePredicate(verifySentinelRemovalSequence(REQUIRED_REMOVE_EVENTS), "removal sequence contract is invalid");
  requirePredicate(verifySentinelDeduplication(["eligible_notification_queued"]), "dedup contract is invalid");
  requirePredicate(
    verifySentinelLifecycleOrdering(REQUIRED_ADD_EVENTS, REQUIRED_UPDATE_EVENTS, REQUIRED_REMOVE_EVENTS),
    "lifecycle ordering contract is invalid",
  );
  requirePredicate(
    (() => { try { assertRunCorrelationAvailable(); return false; } catch { return true; } })(),
    "physical acceptance must fail closed without a production run-correlation contract",
  );

  return {
    protectedSessionsReferenced: false,
    notificationBodiesRead: false,
    sentinelPackage: CMU_PHYSICAL_CONTRACT.sentinelPackage,
    broadUnlistedSourceRequired: true,
    cleanupTransaction: CMU_PHYSICAL_CONTRACT.cancelTransaction,
    rolePreflightVerified: true,
    distinctRolesRequired: true,
    companionIdentityVerified: true,
    listenerGrantVerified: true,
    associationTrustVerified: true,
    transportCurrentStackContractVerified: true,
    transportFreshResetAutomated: false,
    sentinelLifecycleVerified: true,
    missingDedupEvidenceRejected: true,
    negationRejected: true,
    subpackageListenerRejected: true,
    runCorrelationAvailable: false,
    physicalAcceptancePossible: false,
    iosNonRegressionAutomated: false,
  };
}

export function runPhysicalSmoke(options) {
  validatePhysicalOptions(options);
  assertPhysicalAcceptanceContractsAvailable();
  const { pixelSerial, pinSerial, expectedApkSha256 } = options;
  const incompleteReasons = [INCOMPLETE_STATES.transportResetNotVerified];

  // Two distinct verified roles
  assertDistinctDeviceRoles(pixelSerial, pinSerial);
  verifyRolePreflight(pixelSerial, ROLE_PREFLIGHT.pixel);
  verifyRolePreflight(pinSerial, ROLE_PREFLIGHT.pin);

  // Device identity
  verifyDevice(pixelSerial, CMU_PHYSICAL_CONTRACT.pixelModel, CMU_PHYSICAL_CONTRACT.pixelSdk);
  verifyDevice(pinSerial, CMU_PHYSICAL_CONTRACT.pinModel, CMU_PHYSICAL_CONTRACT.pinSdk);

  // Exact companion identity and integrity
  verifyInstalledCompanion(pixelSerial, expectedApkSha256);
  verifyCompanionIdentity(pixelSerial);

  // Exact companion grant truth (exact listener component, subpackages rejected)
  verifyListenerGrant(pixelSerial);
  verifyVisiblePolicy(pixelSerial);

  // Association plus bond truth (negation rejected)
  verifyAssociationTrust(pixelSerial);

  // Exact current transport readiness. This does not prove a fresh reset.
  verifyTransportReset(pixelSerial);

  // Live GATT readiness
  verifyLiveGatt(pixelSerial);

  const addBoundary = `cmu-add-${randomUUID()}`;
  let posted = false;
  let preStateAbsent = false;
  let postStateAbsent = false;
  let addEvents = [];
  let updateEvents = [];
  let removeEvents = [];
  let pinTokens = [];
  let removalObserved = false;
  let updateObserved = false;
  let dedupVerified = false;
  preStateAbsent = sentinelIsAbsent(pixelSerial);
  requirePredicate(preStateAbsent, INCOMPLETE_STATES.preStateNotClean);
  try {
    writeBoundary(pixelSerial, addBoundary);
    writeBoundary(pinSerial, addBoundary);

    // Initial sentinel post (sanitized, content-free)
    adb(ADB_OPERATION.sentinelPost, pixelSerial, buildSentinelPostArgs());
    posted = true;
    const delivered = waitUntil(50_000, () => {
      addEvents = pixelAuditSince(pixelSerial, addBoundary);
      pinTokens = pinCompositionSince(pinSerial, addBoundary);
      return orderedEventsObserved(addEvents, REQUIRED_ADD_EVENTS) && pinTokens.includes("categorize_notifications");
    });
    requirePredicate(delivered, "synthetic sentinel did not reach ANCS plus Pin categorization within 50 seconds");

    const settledAddEvents = waitForStableEventSnapshot({
      timeoutMs: DEDUP_SETTLE_CONTRACT.timeoutMs,
      quietMs: DEDUP_SETTLE_CONTRACT.quietWindowMs,
      pollMs: DEDUP_SETTLE_CONTRACT.pollIntervalMs,
      readEvents: () => pixelAuditSince(pixelSerial, addBoundary),
      isReady: (events) => orderedEventsObserved(events, REQUIRED_ADD_EVENTS),
    });
    requirePredicate(
      settledAddEvents !== null,
      "correlated add audit did not reach a bounded quiet window before update",
    );
    addEvents = settledAddEvents;
    dedupVerified = verifySentinelDeduplication(addEvents);
    if (!dedupVerified) {
      incompleteReasons.push(INCOMPLETE_STATES.dedupNotVerified);
    }

    // Sentinel update: re-post same sentinel (same tag + ID = update in Android)
    const updateBoundary = `cmu-update-${randomUUID()}`;
    writeBoundary(pixelSerial, updateBoundary);
    adb(ADB_OPERATION.sentinelPost, pixelSerial, buildSentinelPostArgs());
    updateObserved = waitUntil(20_000, () => {
      updateEvents = pixelAuditSince(pixelSerial, updateBoundary);
      return verifySentinelUpdateSequence(updateEvents);
    });
    if (!updateObserved) {
      incompleteReasons.push(INCOMPLETE_STATES.updateNotObserved);
    }
  } finally {
    const removeBoundary = `cmu-remove-${randomUUID()}`;
    const cleanup = executeSentinelCleanup({
      preStateAbsent,
      posted,
      writeRemovalBoundary: () => writeBoundary(pixelSerial, removeBoundary),
      cancel: () => cancelSentinel(pixelSerial),
      waitForRemoval: () => waitUntil(10_000, () => {
        removeEvents = pixelAuditSince(pixelSerial, removeBoundary);
        return verifySentinelRemovalSequence(removeEvents);
      }),
      sentinelAbsent: () => sentinelIsAbsent(pixelSerial),
    });
    removalObserved = cleanup.removalObserved;
    postStateAbsent = cleanup.sentinelAbsent;
  }

  // Sentinel lifecycle ordering with actual remove events (not placeholder)
  const lifecycleOrdered = verifySentinelLifecycleOrdering(addEvents, updateEvents, removeEvents);
  if (!lifecycleOrdered) {
    incompleteReasons.push(INCOMPLETE_STATES.lifecycleNotOrdered);
  }

  const summarizationObserved = pinTokens.includes("encrypted_summarize_messages");
  if (!summarizationObserved) {
    incompleteReasons.push(INCOMPLETE_STATES.summarizationNotObserved);
  }

  // Broad unlisted source is proven by the sentinel being delivered from com.android.shell
  // (which is NOT in the allowlist) — verified by verifyVisiblePolicy plus successful delivery
  const broadAdmissionProven = orderedEventsObserved(addEvents, REQUIRED_ADD_EVENTS) && removalObserved;
  const postStateRestored = preStateAbsent && postStateAbsent;
  if (!postStateRestored) {
    incompleteReasons.push(INCOMPLETE_STATES.postStateNotRestored);
  }

  const result = {
    rolePreflightVerified: true,
    distinctRolesVerified: true,
    apkIdentityVerified: true,
    companionIdentityVerified: true,
    listenerGrantVerified: true,
    associationTrustVerified: true,
    transportCurrentStackVerified: true,
    transportFreshResetVerified: false,
    visiblePolicyVerified: true,
    preStateAbsent,
    ancsAddSequenceVerified: orderedEventsObserved(addEvents, REQUIRED_ADD_EVENTS),
    ancsUpdateSequenceVerified: updateObserved,
    sentinelDeduplicationVerified: dedupVerified,
    pinCategorizationVerified: pinTokens.includes("categorize_notifications"),
    pinSummarizationObserved: summarizationObserved,
    sentinelRemoved: postStateAbsent,
    ancsRemovalObserved: removalObserved,
    sentinelLifecycleOrdered: lifecycleOrdered,
    broadUnlistedSourceVerified: broadAdmissionProven,
    postStateRestored,
    temporaryAllowlistRemovalRequiredInVisibleUi: false,
    iosNonRegressionAutomated: false,
    incompleteReasons: incompleteReasons.length > 0 ? incompleteReasons : [],
    complete: incompleteReasons.length === 0,
  };

  return assertPhysicalSmokeComplete(result);
}

export function main(
  argv = process.argv.slice(2),
  {
    parseArgs = parseCmuPhysicalArgs,
    runPhysical = runPhysicalSmoke,
    runSelfCheck = selfCheck,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = args.mode === "self-check" ? runSelfCheck() : runPhysical(args);
    if (args.mode === "run") assertPhysicalSmokeComplete(result);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof PrivacySafeCmuError
      ? error.message
      : "operation failed; private diagnostic suppressed";
    stderr.write(`android-cmu-physical-smoke: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
