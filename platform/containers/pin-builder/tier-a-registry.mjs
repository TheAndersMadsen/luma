#!/usr/bin/env node

/**
 * Deterministic Tier-A contract generator.
 *
 * Authored inputs:
 * - contracts/tier-a/registry.json
 * - contracts/tier-a/native-actions.tsv
 * - protobuf sources below runtime/core/proto (canonical RPC/message spelling)
 *
 * Generated outputs are checked in so Rust, Kotlin, Node, shell, and manifest
 * consumers can migrate independently without acquiring a build-time
 * dependency on Node.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../pin",
);

export const GENERATED_OUTPUT_PATHS = Object.freeze({
  rust: "runtime/core/src/tier_a.rs",
  kotlin:
    "contracts/stock-aibus/src/main/kotlin/com/penumbraos/stockaibus/contract/TierASymbols.kt",
  node: "platform/deploy/acceptance/pin/tier-a-symbols.mjs",
  // The browser installer's copy. It used to be `setup/src/generated/…`, inside
  // the standalone Setup SPA; the installer is part of Center now, so the
  // generator writes where the consumer actually is. Same bytes, new address.
  typescript: "center/src/lib/pin-install/generated/tier-a-symbols.ts",
  json: "contracts/tier-a/tier-a-symbols.json",
  manifestPlaceholders: "contracts/tier-a/manifest-placeholders.properties",
  nativeActionsDocumentation: "contracts/tier-a/native-actions.tsv",
  stockNativeActionsIndex: "contracts/tier-a/stock-native-actions.tsv",
});

const REGISTRY_PATH = "contracts/tier-a/registry.json";
const NATIVE_ACTIONS_PATH = "contracts/tier-a/native-actions.tsv";
const EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH =
  "contracts/tier-a/external-operational-marker-evidence.tsv";
// Optional operator-owned test evidence. It is excluded from canonical source
// releases; index-only validation remains functional when it is absent.
const STOCK_EVIDENCE_ROOT = "decompile-workspace/decompiled";
const STOCK_ACTION_PATH_PATTERN =
  /^ironman\/sources\/[A-Za-z0-9_./$-]+\.java$/;

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
const PACKAGE_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const BINDER_DESCRIPTOR_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const ACTION_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

function fail(message) {
  throw new Error(`Tier-A registry: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${label} has invalid value ${JSON.stringify(value)}`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function assertUnique(entries, key, label) {
  const seen = new Map();
  for (const [index, entry] of entries.entries()) {
    const value = entry[key];
    if (seen.has(value)) {
      fail(
        `duplicate ${label} ${JSON.stringify(value)} at indexes ${seen.get(value)} and ${index}`,
      );
    }
    seen.set(value, index);
  }
}

function sortedValues(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameSet(actual, expected, label) {
  const actualSorted = sortedValues(new Set(actual));
  const expectedSorted = sortedValues(new Set(expected));
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    const actualSet = new Set(actualSorted);
    const expectedSet = new Set(expectedSorted);
    const missing = expectedSorted.filter((value) => !actualSet.has(value));
    const extra = actualSorted.filter((value) => !expectedSet.has(value));
    fail(
      `${label} differ (missing: ${missing.join(", ") || "none"}; extra: ${
        extra.join(", ") || "none"
      })`,
    );
  }
}

function resolveWorkspaceAwarePath(root, relativePath, label) {
  requireString(relativePath, label);
  if (path.isAbsolute(relativePath)) fail(`${label} must be repository-relative`);
  const normalized = path.normalize(relativePath);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    fail(`${label} must not escape the repository`);
  }
  // `root` is the `pin` boundary, because that is where the authored inputs and
  // most generated outputs live. Two consumers sit outside it and are named by
  // their workspace-relative path instead: the acceptance harness under
  // `platform/`, and the browser installer under `center/`. Both are still
  // resolved against the workspace root and still checked for escape below, so
  // this widens which sibling component may be written to, not where.
  const workspaceRelative =
    normalized.startsWith(`platform${path.sep}`) || normalized.startsWith(`center${path.sep}`);
  const boundary = workspaceRelative ? path.resolve(root, "..") : path.resolve(root);
  const absolute = path.resolve(boundary, normalized);
  const rootPrefix = `${boundary}${path.sep}`;
  if (!absolute.startsWith(rootPrefix)) fail(`${label} must remain inside the repository`);
  return absolute;
}

function resolveRepositoryFile(root, relativePath, label) {
  const absolute = resolveWorkspaceAwarePath(root, relativePath, label);
  if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label} does not exist: ${relativePath}`);
  }
  return absolute;
}

function readRepositoryFile(root, relativePath, label = relativePath) {
  return fs.readFileSync(resolveRepositoryFile(root, relativePath, label), "utf8");
}

function stripProtoComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function matchingBrace(source, openingIndex, label) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail(`${label} has an unclosed block`);
}

export function parseProtoSource(source, label = "proto source") {
  if (typeof source !== "string") fail(`${label} must be text`);
  const clean = stripProtoComments(source);
  const packageMatch = /\bpackage\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/.exec(clean);
  if (!packageMatch) fail(`${label} has no package declaration`);

  const messages = new Set(
    [...clean.matchAll(/\bmessage\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map(
      (match) => match[1],
    ),
  );
  const services = new Map();
  const servicePattern = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  for (const match of clean.matchAll(servicePattern)) {
    const service = match[1];
    if (services.has(service)) fail(`${label} declares service ${service} twice`);
    const openingIndex = match.index + match[0].lastIndexOf("{");
    const closingIndex = matchingBrace(clean, openingIndex, label);
    const body = clean.slice(openingIndex + 1, closingIndex);
    const methods = new Set(
      [...body.matchAll(/\brpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
        (rpcMatch) => rpcMatch[1],
      ),
    );
    services.set(service, methods);
  }

  return Object.freeze({
    packageName: packageMatch[1],
    messages,
    services,
  });
}

export function parseNativeActionsTsv(source) {
  if (typeof source !== "string") fail("native action ledger must be text");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const expectedHeader = [
    "action",
    "experience",
    "enabled_in_keyguard",
    "stock_role",
    "penumbra_route",
    "safety_boundary",
    "evidence",
    "note",
    "stock_evidence",
  ];
  const header = (lines.shift() ?? "").split("\t");
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    fail(`native action ledger header must be ${expectedHeader.join("\\t")}`);
  }

  const rows = lines.map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== expectedHeader.length) {
      fail(`native action ledger row ${index + 2} must have ${expectedHeader.length} columns`);
    }
    const row = Object.fromEntries(
      expectedHeader.map((column, columnIndex) => [column, columns[columnIndex]]),
    );
    requireString(row.action, `native action row ${index + 2} action`, ACTION_PATTERN);
    requireString(row.experience, `native action ${row.action} experience`);
    if (!["true", "false"].includes(row.enabled_in_keyguard)) {
      fail(`native action ${row.action} enabled_in_keyguard must be true or false`);
    }
    for (const column of expectedHeader.slice(3)) {
      requireString(row[column], `native action ${row.action} ${column}`);
    }
    validateNativeActionStockEvidencePath(
      row.stock_evidence,
      `native action ${row.action} stock_evidence`,
    );
    return Object.freeze(row);
  });
  if (rows.length === 0) fail("native action ledger must not be empty");
  assertUnique(rows, "action", "native action");
  assertUnique(rows, "stock_evidence", "native action stock evidence path");
  return Object.freeze(rows);
}

export function parseExternalOperationalMarkerEvidenceTsv(source) {
  if (typeof source !== "string") {
    fail("external operational marker evidence must be text");
  }
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const expectedHeader = [
    "marker_name",
    "source_owner",
    "source_component",
    "evidence_kind",
    "value_sha256",
    "note",
  ];
  const header = (lines.shift() ?? "").split("\t");
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    fail(
      `external operational marker evidence header must be ${expectedHeader.join("\\t")}`,
    );
  }

  const rows = lines.map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== expectedHeader.length) {
      fail(
        `external operational marker evidence row ${index + 2} must have ${expectedHeader.length} columns`,
      );
    }
    const row = Object.fromEntries(
      expectedHeader.map((column, columnIndex) => [column, columns[columnIndex]]),
    );
    requireString(
      row.marker_name,
      `external operational marker evidence row ${index + 2} marker_name`,
      NAME_PATTERN,
    );
    if (row.source_owner !== "stock") {
      fail(
        `external operational marker evidence ${row.marker_name} source_owner must be stock`,
      );
    }
    requireString(
      row.source_component,
      `external operational marker evidence ${row.marker_name} source_component`,
    );
    if (row.evidence_kind !== "external-contract-hash") {
      fail(
        `external operational marker evidence ${row.marker_name} evidence_kind must be external-contract-hash`,
      );
    }
    requireString(
      row.value_sha256,
      `external operational marker evidence ${row.marker_name} value_sha256`,
      /^[0-9a-f]{64}$/,
    );
    requireString(
      row.note,
      `external operational marker evidence ${row.marker_name} note`,
    );
    return Object.freeze(row);
  });
  if (rows.length === 0) {
    fail("external operational marker evidence must not be empty");
  }
  assertUnique(rows, "marker_name", "external operational marker evidence name");
  return Object.freeze(rows);
}

export function validateNativeActionStockEvidencePath(
  evidencePath,
  label = "native action stock evidence path",
) {
  requireString(evidencePath, label);
  if (
    path.isAbsolute(evidencePath) ||
    evidencePath.includes("\\") ||
    path.posix.normalize(evidencePath) !== evidencePath ||
    evidencePath.split("/").includes("..") ||
    !STOCK_ACTION_PATH_PATTERN.test(evidencePath)
  ) {
    fail(
      `${label} must be a normalized Java path below ironman/sources: ${JSON.stringify(
        evidencePath,
      )}`,
    );
  }
  return evidencePath;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateNativeActionStockSource(
  action,
  source,
  evidencePath = "stock action source",
) {
  requireString(action, "stock action name", ACTION_PATTERN);
  if (typeof source !== "string") fail(`${evidencePath} must be text`);

  const annotations = [
    ...source.matchAll(/@Action\s*\(([\s\S]*?)\)/g),
  ];
  for (const annotation of annotations) {
    const assignment =
      /\bnameForModel\s*=\s*("(?:\\.|[^"\\])*"|[A-Za-z_$][A-Za-z0-9_$.]*)/.exec(
        annotation[1],
      );
    if (!assignment) continue;
    const expression = assignment[1];
    let kind = null;
    if (expression === JSON.stringify(action)) {
      kind = "literal";
    } else if (!expression.startsWith('"')) {
      const expressionParts = expression.split(".");
      const constantName = expressionParts.at(-1);
      const ownerName =
        expressionParts.length > 1 ? expressionParts.at(-2) : null;
      const declaration = new RegExp(
        `\\b(?:public\\s+|protected\\s+|private\\s+)?static\\s+final\\s+String\\s+${escapeRegExp(
          constantName,
        )}\\s*=\\s*"${escapeRegExp(action)}"\\s*;`,
      );
      const ownerIsLocal =
        ownerName === null ||
        new RegExp(
          `\\b(?:class|interface|enum)\\s+${escapeRegExp(ownerName)}\\b`,
        ).test(source);
      if (ownerIsLocal && declaration.test(source)) kind = "constant";
    }
    if (kind === null) continue;

    const experience =
      /\bexperience\s*=\s*HumanePackageManager\.ExperienceIdentifierKey\.([A-Z][A-Z0-9_]*)/.exec(
        annotation[1],
      )?.[1] ?? null;
    const enabledInKeyguard =
      /\benabledInKeyguard\s*=\s*(true|false)\b/.exec(annotation[1])?.[1] ??
      null;
    if (experience === null || enabledInKeyguard === null) {
      fail(
        `${evidencePath} has incomplete @Action metadata for ${JSON.stringify(
          action,
        )}`,
      );
    }
    return Object.freeze({
      kind,
      expression,
      experience,
      enabledInKeyguard,
    });
  }

  fail(
    `${evidencePath} does not pin @Action nameForModel to ${JSON.stringify(
      action,
    )}`,
  );
}

export function validateNativeActionStockEvidence(
  nativeActions,
  {
    root = REPOSITORY_ROOT,
    requireLive = false,
  } = {},
) {
  requireArray(nativeActions, "native action stock evidence rows");
  for (const [index, rawAction] of nativeActions.entries()) {
    const action = requireRecord(
      rawAction,
      `native action stock evidence row ${index}`,
    );
    requireString(
      action.action,
      `native action stock evidence row ${index} action`,
      ACTION_PATTERN,
    );
    validateNativeActionStockEvidencePath(
      action.stock_evidence,
      `native action ${action.action} stock_evidence`,
    );
  }
  assertUnique(nativeActions, "action", "native action stock evidence action");
  assertUnique(
    nativeActions,
    "stock_evidence",
    "native action stock evidence path",
  );

  const evidenceRoot = path.resolve(root, STOCK_EVIDENCE_ROOT);
  if (!fs.statSync(evidenceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    if (requireLive) {
      fail(
        `live native action stock evidence is unavailable: ${STOCK_EVIDENCE_ROOT}`,
      );
    }
    return Object.freeze({
      mode: "index-only",
      actions: nativeActions.length,
      literalProofs: 0,
      constantProofs: 0,
    });
  }

  let literalProofs = 0;
  let constantProofs = 0;
  for (const action of nativeActions) {
    const absolute = path.resolve(evidenceRoot, action.stock_evidence);
    const evidenceRootPrefix = `${evidenceRoot}${path.sep}`;
    if (!absolute.startsWith(evidenceRootPrefix)) {
      fail(`native action ${action.action} stock evidence escapes its root`);
    }
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      fail(
        `native action ${action.action} stock evidence does not resolve: ${action.stock_evidence}`,
      );
    }
    const proof = validateNativeActionStockSource(
      action.action,
      fs.readFileSync(absolute, "utf8"),
      action.stock_evidence,
    );
    if (
      proof.experience !== action.experience ||
      proof.enabledInKeyguard !== action.enabled_in_keyguard
    ) {
      fail(
        `native action ${action.action} metadata differs from ${action.stock_evidence}: ` +
          `ledger ${action.experience}/${action.enabled_in_keyguard}, stock ` +
          `${proof.experience}/${proof.enabledInKeyguard}`,
      );
    }
    if (proof.kind === "constant") {
      constantProofs += 1;
    } else {
      literalProofs += 1;
    }
  }

  return Object.freeze({
    mode: "live",
    actions: nativeActions.length,
    literalProofs,
    constantProofs,
  });
}

function validateNamedValues(entries, label, valuePattern = null) {
  requireArray(entries, label);
  for (const [index, rawEntry] of entries.entries()) {
    const entry = requireRecord(rawEntry, `${label}[${index}]`);
    requireString(entry.name, `${label}[${index}].name`, NAME_PATTERN);
    requireString(entry.value, `${label}[${index}].value`, valuePattern);
  }
  assertUnique(entries, "name", `${label} name`);
  assertUnique(entries, "value", `${label} value`);
}

function toUpperSnake(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function toPascalCase(value) {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function sortByName(entries) {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function protoDefinition(root, cache, relativePath) {
  if (!cache.has(relativePath)) {
    const source = readRepositoryFile(root, relativePath, `proto ${relativePath}`);
    cache.set(relativePath, parseProtoSource(source, relativePath));
  }
  return cache.get(relativePath);
}

export function operationalMarkerEmitterReference(marker, emitterPath) {
  const identifier = toUpperSnake(marker.name);
  if (emitterPath.endsWith(".rs")) {
    return `operational_markers::${identifier}`;
  }
  if (emitterPath.endsWith(".kt")) {
    return `TierASymbols.OperationalMarkers.${identifier}`;
  }
  if (/\.[cm]?[jt]sx?$/.test(emitterPath)) {
    return `OPERATIONAL_MARKERS.${marker.name}.value`;
  }
  fail(`unsupported operational marker emitter language: ${emitterPath}`);
}

export function resolveTierARegistry(
  registry,
  {
    root = REPOSITORY_ROOT,
    nativeActionsSource = readRepositoryFile(root, NATIVE_ACTIONS_PATH),
    externalOperationalMarkerEvidenceSource = readRepositoryFile(
      root,
      EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH,
    ),
    requireGeneratedEmitterReferences = false,
  } = {},
) {
  requireRecord(registry, "root");
  if (registry.schemaVersion !== 1) fail("schemaVersion must be 1");

  validateNamedValues(registry.packages, "packages", PACKAGE_PATTERN);
  for (const [index, entry] of registry.packages.entries()) {
    if (entry.owner !== "stock") fail(`packages[${index}].owner must be stock`);
  }
  const packageSets = requireRecord(registry.packageSets, "packageSets");
  const packageNames = new Set(registry.packages.map((entry) => entry.name));
  for (const [setName, rawMembers] of Object.entries(packageSets)) {
    requireString(setName, "packageSets name", NAME_PATTERN);
    const members = requireArray(rawMembers, `packageSets.${setName}`);
    if (members.length === 0) fail(`packageSets.${setName} must not be empty`);
    for (const [index, member] of members.entries()) {
      requireString(member, `packageSets.${setName}[${index}]`, NAME_PATTERN);
      if (!packageNames.has(member)) {
        fail(`packageSets.${setName} references unknown package ${member}`);
      }
    }
    assertUnique(
      members.map((value) => ({ value })),
      "value",
      `packageSets.${setName} member`,
    );
  }

  const binderProtocols = requireArray(registry.binderProtocols, "binderProtocols");
  for (const [protocolIndex, rawProtocol] of binderProtocols.entries()) {
    const protocol = requireRecord(
      rawProtocol,
      `binderProtocols[${protocolIndex}]`,
    );
    requireString(
      protocol.name,
      `binderProtocols[${protocolIndex}].name`,
      NAME_PATTERN,
    );
    requireString(
      protocol.descriptor,
      `binderProtocols[${protocolIndex}].descriptor`,
      BINDER_DESCRIPTOR_PATTERN,
    );
    if (!["stock", "penumbra"].includes(protocol.owner)) {
      fail(`binderProtocols[${protocolIndex}].owner must be stock or penumbra`);
    }
    const transactions = requireArray(
      protocol.transactions,
      `binderProtocols[${protocolIndex}].transactions`,
    );
    if (transactions.length === 0) {
      fail(`binder protocol ${protocol.name} must declare transactions`);
    }
    for (const [transactionIndex, rawTransaction] of transactions.entries()) {
      const transaction = requireRecord(
        rawTransaction,
        `binder protocol ${protocol.name} transaction ${transactionIndex}`,
      );
      requireString(
        transaction.name,
        `binder protocol ${protocol.name} transaction name`,
        NAME_PATTERN,
      );
      requireString(
        transaction.wireName,
        `binder protocol ${protocol.name} transaction ${transaction.name} wireName`,
      );
      requireInteger(
        transaction.code,
        `binder protocol ${protocol.name} transaction ${transaction.name} code`,
      );
    }
    assertUnique(transactions, "name", `${protocol.name} transaction name`);
    assertUnique(transactions, "wireName", `${protocol.name} transaction wire name`);
    assertUnique(transactions, "code", `${protocol.name} transaction code`);
  }
  assertUnique(binderProtocols, "name", "binder protocol name");
  assertUnique(binderProtocols, "descriptor", "binder descriptor");

  const protoCache = new Map();
  const rpcPaths = requireArray(registry.rpcPaths, "rpcPaths").map(
    (rawEntry, index) => {
      const entry = requireRecord(rawEntry, `rpcPaths[${index}]`);
      requireString(entry.name, `rpcPaths[${index}].name`, NAME_PATTERN);
      requireString(entry.proto, `rpcPaths[${index}].proto`);
      requireString(entry.service, `rpcPaths[${index}].service`);
      requireString(entry.method, `rpcPaths[${index}].method`);
      const definition = protoDefinition(root, protoCache, entry.proto);
      const methods = definition.services.get(entry.service);
      if (!methods) {
        fail(`${entry.proto} does not declare service ${entry.service}`);
      }
      if (!methods.has(entry.method)) {
        fail(`${definition.packageName}.${entry.service} does not declare RPC ${entry.method}`);
      }
      const serviceFqn = `${definition.packageName}.${entry.service}`;
      return Object.freeze({
        ...entry,
        serviceFqn,
        path: `/${serviceFqn}/${entry.method}`,
      });
    },
  );
  assertUnique(rpcPaths, "name", "RPC export name");
  assertUnique(rpcPaths, "path", "RPC FQN path");
  for (const requiredName of [
    "aibus_understand",
    "aibus_encrypted_understand",
    "aibus_encrypted_loading_message",
  ]) {
    if (!rpcPaths.some((entry) => entry.name === requiredName)) {
      fail(`required physical-tool RPC ${requiredName} is missing`);
    }
  }

  const descriptorProtoKids = requireArray(registry.protoKids, "protoKids").map(
    (rawEntry, index) => {
      const entry = requireRecord(rawEntry, `protoKids[${index}]`);
      requireString(entry.name, `protoKids[${index}].name`, NAME_PATTERN);
      requireString(entry.proto, `protoKids[${index}].proto`);
      requireString(entry.message, `protoKids[${index}].message`);
      const definition = protoDefinition(root, protoCache, entry.proto);
      if (!definition.messages.has(entry.message)) {
        fail(`${entry.proto} does not declare message ${entry.message}`);
      }
      return Object.freeze({
        ...entry,
        value: `${definition.packageName}.${entry.message}`,
      });
    },
  );
  const externalProtoKids = requireArray(
    registry.externalProtoKids,
    "externalProtoKids",
  ).map((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `externalProtoKids[${index}]`);
    requireString(entry.name, `externalProtoKids[${index}].name`, NAME_PATTERN);
    requireString(
      entry.value,
      `externalProtoKids[${index}].value`,
      PACKAGE_PATTERN,
    );
    if (!["external", "unverified"].includes(entry.status)) {
      fail(`externalProtoKids[${index}].status must be external or unverified`);
    }
    resolveRepositoryFile(
      root,
      entry.evidence,
      `externalProtoKids[${index}].evidence`,
    );
    requireString(entry.reason, `externalProtoKids[${index}].reason`);
    return Object.freeze({ ...entry });
  });
  const protoKids = [...descriptorProtoKids, ...externalProtoKids];
  assertUnique(protoKids, "name", "proto KID export name");
  assertUnique(protoKids, "value", "proto KID");
  for (const requiredName of [
    "loading_message_request",
    "loading_message_response",
  ]) {
    if (!protoKids.some((entry) => entry.name === requiredName)) {
      fail(`required physical-tool KID ${requiredName} is missing`);
    }
  }

  const featureFlags = requireRecord(registry.featureFlags, "featureFlags");
  validateNamedValues(featureFlags.cloud, "featureFlags.cloud", FEATURE_KEY_PATTERN);
  validateNamedValues(
    featureFlags.settingsGlobal,
    "featureFlags.settingsGlobal",
    FEATURE_KEY_PATTERN,
  );
  validateNamedValues(
    featureFlags.penumbraSettingsGlobal,
    "featureFlags.penumbraSettingsGlobal",
    FEATURE_KEY_PATTERN,
  );
  validateNamedValues(registry.wireSentinels, "wireSentinels");
  for (const [index, sentinel] of registry.wireSentinels.entries()) {
    requireString(sentinel.owner, `wireSentinels[${index}].owner`);
    requireString(sentinel.note, `wireSentinels[${index}].note`);
  }
  if (protoKids.some((entry) => entry.value === "plaintext")) {
    fail("plaintext must remain a wire sentinel, not a protobuf KID");
  }

  const operationalMarkers = requireArray(
    registry.operationalMarkers,
    "operationalMarkers",
  );
  const externalOperationalMarkerEvidence =
    parseExternalOperationalMarkerEvidenceTsv(
      externalOperationalMarkerEvidenceSource,
    );
  const externalOperationalMarkerEvidenceByName = new Map(
    externalOperationalMarkerEvidence.map((entry) => [
      entry.marker_name,
      entry,
    ]),
  );
  for (const [index, rawMarker] of operationalMarkers.entries()) {
    const marker = requireRecord(rawMarker, `operationalMarkers[${index}]`);
    requireString(marker.name, `operationalMarkers[${index}].name`, NAME_PATTERN);
    requireString(marker.value, `operationalMarkers[${index}].value`);
    const fields = requireArray(
      marker.fields,
      `operationalMarkers[${index}].fields`,
    );
    for (const [fieldIndex, field] of fields.entries()) {
      requireString(
        field,
        `operationalMarkers[${index}].fields[${fieldIndex}]`,
        FIELD_PATTERN,
      );
    }
    assertUnique(
      fields.map((value) => ({ value })),
      "value",
      `${marker.name} marker field`,
    );
    if (!["live", "external", "unverified"].includes(marker.status)) {
      fail(
        `operational marker ${marker.name} status must be live, external, or unverified`,
      );
    }
    const consumers = requireArray(
      marker.consumers,
      `operational marker ${marker.name} consumers`,
    );
    if (consumers.length === 0) {
      fail(`operational marker ${marker.name} must declare a consumer`);
    }
    for (const [consumerIndex, consumer] of consumers.entries()) {
      resolveRepositoryFile(
        root,
        consumer,
        `operational marker ${marker.name} consumer ${consumerIndex}`,
      );
    }
    assertUnique(
      consumers.map((value) => ({ value })),
      "value",
      `${marker.name} marker consumer`,
    );
    if (marker.status === "live") {
      if (typeof marker.emitter !== "string") {
        fail(`live operational marker ${marker.name} must declare an emitter`);
      }
      const emitterSource = readRepositoryFile(
        root,
        marker.emitter,
        `operational marker ${marker.name} emitter`,
      );
      const generatedReference = operationalMarkerEmitterReference(
        marker,
        marker.emitter,
      );
      const hasGeneratedReference = emitterSource.includes(generatedReference);
      const hasLegacyLiteral = emitterSource.includes(marker.value);
      if (
        !hasGeneratedReference &&
        (requireGeneratedEmitterReferences || !hasLegacyLiteral)
      ) {
        fail(
          `live operational marker ${marker.name} emitter ${marker.emitter} must reference ${generatedReference}`,
        );
      }
      if ("reason" in marker) {
        fail(`live operational marker ${marker.name} must not carry an unverified reason`);
      }
      if ("evidence" in marker) {
        fail(`live operational marker ${marker.name} must not carry external evidence`);
      }
    } else if (marker.status === "external") {
      if (marker.emitter !== null) {
        fail(`external operational marker ${marker.name} must have a null emitter`);
      }
      if (marker.evidence !== EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH) {
        fail(
          `external operational marker ${marker.name} evidence must be ${EXTERNAL_OPERATIONAL_MARKER_EVIDENCE_PATH}`,
        );
      }
      resolveRepositoryFile(
        root,
        marker.evidence,
        `external operational marker ${marker.name} evidence`,
      );
      requireString(
        marker.reason,
        `external operational marker ${marker.name} reason`,
      );
      const evidence = externalOperationalMarkerEvidenceByName.get(marker.name);
      if (evidence === undefined) {
        fail(`external operational marker ${marker.name} has no hash evidence row`);
      }
      const valueSha256 = createHash("sha256")
        .update(marker.value)
        .digest("hex");
      if (valueSha256 !== evidence.value_sha256) {
        fail(
          `external operational marker ${marker.name} value does not match its hash evidence`,
        );
      }
    } else {
      if (marker.emitter !== null) {
        fail(`unverified operational marker ${marker.name} must have a null emitter`);
      }
      requireString(marker.reason, `unverified operational marker ${marker.name} reason`);
      if ("evidence" in marker) {
        fail(`unverified operational marker ${marker.name} must not carry external evidence`);
      }
    }
  }
  assertUnique(operationalMarkers, "name", "operational marker name");
  assertUnique(operationalMarkers, "value", "operational marker value");
  assertSameSet(
    externalOperationalMarkerEvidence.map((entry) => entry.marker_name),
    operationalMarkers
      .filter((marker) => marker.status === "external")
      .map((marker) => marker.name),
    "external operational marker evidence names",
  );

  const nativeActions = parseNativeActionsTsv(nativeActionsSource).map((row) =>
    Object.freeze({
      ...row,
      name: toUpperSnake(row.action),
    }),
  );
  assertUnique(nativeActions, "name", "native action generated identifier");

  return Object.freeze({
    schemaVersion: 1,
    packages: Object.freeze(sortByName(registry.packages)),
    packageSets: Object.freeze(
      Object.fromEntries(
        Object.entries(packageSets)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, members]) => [name, Object.freeze([...members])]),
      ),
    ),
    binderProtocols: Object.freeze(
      sortByName(binderProtocols).map((protocol) =>
        Object.freeze({
          ...protocol,
          transactions: Object.freeze(
            [...protocol.transactions].sort(
              (left, right) => left.code - right.code,
            ),
          ),
        }),
      ),
    ),
    rpcPaths: Object.freeze(sortByName(rpcPaths)),
    protoKids: Object.freeze(sortByName(protoKids)),
    featureFlags: Object.freeze({
      cloud: Object.freeze(sortByName(featureFlags.cloud)),
      settingsGlobal: Object.freeze(sortByName(featureFlags.settingsGlobal)),
      penumbraSettingsGlobal: Object.freeze(
        sortByName(featureFlags.penumbraSettingsGlobal),
      ),
    }),
    wireSentinels: Object.freeze(sortByName(registry.wireSentinels)),
    operationalMarkers: Object.freeze(sortByName(operationalMarkers)),
    nativeActions: Object.freeze([...nativeActions]),
  });
}

export function loadAndResolveTierARegistry({
  root = REPOSITORY_ROOT,
  requireGeneratedEmitterReferences = false,
} = {}) {
  const registry = JSON.parse(readRepositoryFile(root, REGISTRY_PATH));
  return resolveTierARegistry(registry, {
    root,
    requireGeneratedEmitterReferences,
  });
}

function decodeEscapedString(value) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      decoded += value[index];
      continue;
    }
    index += 1;
    if (index >= value.length) {
      decoded += "\\";
      break;
    }
    const escape = value[index];
    const simple = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
      "'": "'",
      "`": "`",
    };
    if (Object.hasOwn(simple, escape)) {
      decoded += simple[escape];
      continue;
    }
    if (escape === "x" && /^[0-9A-Fa-f]{2}/.test(value.slice(index + 1))) {
      decoded += String.fromCodePoint(
        Number.parseInt(value.slice(index + 1, index + 3), 16),
      );
      index += 2;
      continue;
    }
    if (escape === "u" && value[index + 1] === "{") {
      const closing = value.indexOf("}", index + 2);
      const digits = closing < 0 ? "" : value.slice(index + 2, closing);
      if (/^[0-9A-Fa-f]{1,6}$/.test(digits)) {
        decoded += String.fromCodePoint(Number.parseInt(digits, 16));
        index = closing;
        continue;
      }
    }
    if (escape === "u" && /^[0-9A-Fa-f]{4}/.test(value.slice(index + 1))) {
      decoded += String.fromCodePoint(
        Number.parseInt(value.slice(index + 1, index + 5), 16),
      );
      index += 4;
      continue;
    }
    // Unknown language-specific escapes retain their semantic character. This
    // is sufficient for exact Tier-A symbols, whose escapes are ASCII/Unicode.
    decoded += escape;
  }
  return decoded;
}

function rustLifetimeEnd(source, index) {
  if (source[index] !== "'" || !/[A-Za-z_]/.test(source[index + 1] ?? "")) {
    return null;
  }
  let end = index + 2;
  while (/[A-Za-z0-9_]/.test(source[end] ?? "")) end += 1;
  // `'x'` is a character literal. A Rust lifetime or loop label has no
  // matching quote after its identifier (`'static`, `'a`, `'label:`).
  return source[end] === "'" ? null : end;
}

function isLineCommentStart(source, index, marker) {
  if (!source.startsWith(marker, index)) return false;
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return source.slice(lineStart, index).trim().length === 0;
}

export function extractDecodedStringLiterals(
  source,
  { sourcePath = "" } = {},
) {
  if (typeof source !== "string") fail("literal scanner source must be text");
  const literals = [];
  const isRust = sourcePath.endsWith(".rs");
  const isShell = sourcePath.endsWith(".sh");
  const isXml = sourcePath.endsWith(".xml");
  const isJavaScriptLike = /\.[cm]?[jt]sx?$/.test(sourcePath);
  let index = 0;
  let line = 1;
  while (index < source.length) {
    if (source[index] === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (isShell && isLineCommentStart(source, index, "#")) {
      const newline = source.indexOf("\n", index + 1);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (isXml && source.startsWith("<!--", index)) {
      const closing = source.indexOf("-->", index + 4);
      const end = closing < 0 ? source.length : closing + 3;
      line += source.slice(index, end).split("\n").length - 1;
      index = end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const closing = source.indexOf("*/", index + 2);
      const end = closing < 0 ? source.length : closing + 2;
      line += source.slice(index, end).split("\n").length - 1;
      index = end;
      continue;
    }
    if (isJavaScriptLike && source[index] === "/") {
      const regexEnd = javascriptRegexLiteralEnd(source, index);
      if (regexEnd !== null) {
        index = regexEnd;
        continue;
      }
    }

    const rustRaw = /^r(#{0,8})"/.exec(source.slice(index));
    if (rustRaw) {
      const hashes = rustRaw[1];
      const contentStart = index + rustRaw[0].length;
      const terminator = `"${hashes}`;
      const closing = source.indexOf(terminator, contentStart);
      const contentEnd = closing < 0 ? source.length : closing;
      const end = closing < 0 ? source.length : closing + terminator.length;
      const value = source.slice(contentStart, contentEnd);
      literals.push({ value, line, start: index, end });
      line += source.slice(index, end).split("\n").length - 1;
      index = end;
      continue;
    }

    if (source.startsWith('"""', index)) {
      const contentStart = index + 3;
      const closing = source.indexOf('"""', contentStart);
      const contentEnd = closing < 0 ? source.length : closing;
      const end = closing < 0 ? source.length : closing + 3;
      const value = source.slice(contentStart, contentEnd);
      literals.push({ value, line, start: index, end });
      line += source.slice(index, end).split("\n").length - 1;
      index = end;
      continue;
    }

    const quote = source[index];
    const lifetimeEnd = isRust ? rustLifetimeEnd(source, index) : null;
    if (lifetimeEnd !== null) {
      index = lifetimeEnd;
      continue;
    }
    if (!['"', "'", "`"].includes(quote)) {
      index += 1;
      continue;
    }
    const start = index;
    const startLine = line;
    index += 1;
    let raw = "";
    while (index < source.length) {
      const character = source[index];
      if (character === quote) {
        index += 1;
        break;
      }
      if (character === "\\" && index + 1 < source.length) {
        raw += character + source[index + 1];
        index += 2;
        continue;
      }
      if (character === "\n") line += 1;
      raw += character;
      index += 1;
    }
    literals.push({
      value: decodeEscapedString(raw),
      line: startLine,
      start,
      end: index,
    });
  }
  return literals;
}

function javascriptRegexLiteralEnd(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
  const prefix = source.slice(Math.max(0, previous - 16), previous + 1);
  const canStart =
    previous < 0 ||
    "=(:,!&|?;{}[]".includes(source[previous]) ||
    /\b(?:return|case|throw|yield|await)\s*$/.test(prefix);
  if (!canStart) return null;

  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") return null;
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "[") {
      inClass = true;
      cursor += 1;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      cursor += 1;
      continue;
    }
    if (character === "/" && !inClass) {
      cursor += 1;
      while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return null;
}

function extractShellEmbeddedDoubleQuotedLiterals(source) {
  const literals = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    if (source[index] === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (isLineCommentStart(source, index, "#")) {
      const newline = source.indexOf("\n", index + 1);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (source[index] !== '"') {
      if (source[index] === "\\" && index + 1 < source.length) index += 1;
      index += 1;
      continue;
    }
    const start = index;
    const startLine = line;
    index += 1;
    let raw = "";
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        break;
      }
      if (character === "\\" && index + 1 < source.length) {
        raw += character + source[index + 1];
        index += 2;
        continue;
      }
      if (character === "\n") line += 1;
      raw += character;
      index += 1;
    }
    literals.push({
      value: decodeEscapedString(raw),
      line: startLine,
      start,
      end: index,
    });
  }
  return literals;
}

function tierALiteralIndex(registry) {
  const index = new Map();
  const add = (value, domain, name) => {
    const entries = index.get(value) ?? [];
    entries.push({ domain, name });
    index.set(value, entries);
  };
  for (const entry of registry.packages) add(entry.value, "package", entry.name);
  for (const entry of registry.rpcPaths) add(entry.path, "rpc_path", entry.name);
  for (const entry of registry.protoKids) add(entry.value, "proto_kid", entry.name);
  for (const entry of registry.wireSentinels) {
    add(entry.value, "wire_sentinel", entry.name);
  }
  for (const protocol of registry.binderProtocols) {
    add(protocol.descriptor, "binder_descriptor", protocol.name);
    for (const transaction of protocol.transactions) {
      add(
        transaction.wireName,
        "binder_wire_name",
        `${protocol.name}.${transaction.name}`,
      );
    }
  }
  for (const [plane, entries] of Object.entries(registry.featureFlags)) {
    for (const entry of entries) {
      add(entry.value, "feature_flag", `${plane}.${entry.name}`);
    }
  }
  for (const marker of registry.operationalMarkers) {
    add(marker.value, "operational_marker", marker.name);
  }
  for (const action of registry.nativeActions) {
    add(action.action, "native_action", action.name);
  }
  return index;
}

const ACTION_CONTEXT =
  /\b(?:action|actions|native|intent|dispatch|terminal|tool|mutation|excluded|allowed|expected|physical)\b/i;
const BINDER_CONTEXT =
  /\b(?:binder|transaction|transact|descriptor|protocol|wire[_ ]?name)\b/i;
const AMBIGUOUS_FEATURE_KEY_CONTEXT =
  /\b(?:(?:feature\s+)?flag\s+key|feature\s+key|settings\s+global|(?:feature|flag)\s+(?:assignment|override|lookup)|effective\s+(?:feature|flag|key|value|lookup))\b/i;
const FEATURE_KEY_SINK_CONTEXT = /\.key\s*(?:={2,3}|!={1,2})/i;
const ENVELOPE_CONTEXT =
  /\b(?:kid|encryption|encrypted|envelope|cipher|protector)\b/i;
const REFLECTION_CLASS_CONTEXT =
  /\b(?:loadClass|Class\s*\.\s*forName)\s*\(/;

function domainRejectsLiteral(entry, value, context) {
  const normalizedContext = context.replaceAll("_", " ");
  switch (entry.domain) {
    case "native_action":
      return ACTION_CONTEXT.test(normalizedContext);
    case "binder_wire_name":
      return BINDER_CONTEXT.test(normalizedContext);
    case "wire_sentinel":
      return ENVELOPE_CONTEXT.test(normalizedContext);
    case "proto_kid":
      // Protobuf KIDs often happen to equal generated Java class FQCNs. A
      // reflection sink is class identity, not envelope identity; keep that
      // exception explicit while rejecting the same value in a KID sink.
      return !REFLECTION_CLASS_CONTEXT.test(context);
    case "feature_flag":
      // Underscored values are unambiguously authored keys. Short values such
      // as "tickle" are also ordinary user language, so reject those only in
      // a key/override/effective-lookup shaped context.
      return (
        value.includes("_") ||
        AMBIGUOUS_FEATURE_KEY_CONTEXT.test(normalizedContext) ||
        FEATURE_KEY_SINK_CONTEXT.test(context)
      );
    default:
      return true;
  }
}

/**
 * Find authored Tier-A string values in Rust/Kotlin/Node/TypeScript sources.
 *
 * Callers choose the production producer files. Generated bindings, authored
 * registry inputs, docs, and tests must not be passed. Ambiguous action/UI
 * words (notably "Settings") are rejected only in an action-shaped context.
 */
export function scanTierARawLiterals({ registry, sources }) {
  if (!registry?.nativeActions) fail("literal scanner requires a resolved registry");
  requireArray(sources, "literal scanner sources");
  const valueIndex = tierALiteralIndex(registry);
  const violations = [];
  for (const [sourceIndex, rawSource] of sources.entries()) {
    const source = requireRecord(rawSource, `literal scanner sources[${sourceIndex}]`);
    requireString(source.path, `literal scanner sources[${sourceIndex}].path`);
    if (typeof source.contents !== "string") {
      fail(`literal scanner source ${source.path} contents must be text`);
    }
    const literals = extractDecodedStringLiterals(source.contents, {
      sourcePath: source.path,
    });
    if (source.path.endsWith(".sh")) {
      const knownSpans = new Set(
        literals.map((literal) => `${literal.start}:${literal.end}`),
      );
      for (const literal of extractShellEmbeddedDoubleQuotedLiterals(
        source.contents,
      )) {
        const span = `${literal.start}:${literal.end}`;
        if (!knownSpans.has(span)) literals.push(literal);
      }
    }
    for (const literal of literals) {
      const matches = valueIndex.get(literal.value);
      if (!matches) continue;
      const windowStart = Math.max(0, literal.start - 180);
      const windowEnd = Math.min(source.contents.length, literal.end + 180);
      const before = source.contents.slice(windowStart, literal.start);
      const after = source.contents.slice(literal.end, windowEnd);
      const context = `${before} ${after}`;
      const rejected = matches.filter((entry) =>
        domainRejectsLiteral(entry, literal.value, context),
      );
      if (rejected.length === 0) continue;
      violations.push(
        Object.freeze({
          path: source.path,
          line: literal.line,
          value: literal.value,
          symbols: Object.freeze(
            rejected.map((entry) => `${entry.domain}:${entry.name}`),
          ),
        }),
      );
    }
  }
  return Object.freeze(violations);
}

export function scanTierAProductionFiles({
  registry,
  files,
  root = REPOSITORY_ROOT,
}) {
  return scanTierARawLiterals({
    registry,
    sources: requireArray(files, "literal scanner files").map((relativePath) => ({
      path: relativePath,
      contents: readRepositoryFile(
        root,
        relativePath,
        `literal scanner file ${relativePath}`,
      ),
    })),
  });
}

function rustString(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}"`;
}

function kotlinString(value) {
  return rustString(value).replaceAll("$", "\\$");
}

function rustStringConst(identifier, value, indent = "    ") {
  const oneLine = `${indent}pub const ${identifier}: &str = ${rustString(value)};`;
  if (oneLine.length <= 100) return [oneLine];
  return [
    `${indent}pub const ${identifier}: &str =`,
    `${indent}    ${rustString(value)};`,
  ];
}

function rustStringArray(identifier, values, indent = "    ") {
  const oneLine =
    `${indent}pub const ${identifier}: &[&str] = &[${values.join(", ")}];`;
  if (oneLine.length <= 100) return [oneLine];
  return [
    `${indent}pub const ${identifier}: &[&str] = &[`,
    ...values.map((value) => `${indent}    ${value},`),
    `${indent}];`,
  ];
}

function renderRustStringModule(
  name,
  entries,
  valueKey = "value",
  baseIndent = "",
) {
  const memberIndent = `${baseIndent}    `;
  const lines = [`${baseIndent}pub mod ${name} {`];
  for (const entry of entries) {
    lines.push(
      ...rustStringConst(
        toUpperSnake(entry.name),
        entry[valueKey],
        memberIndent,
      ),
    );
  }
  lines.push(
    "",
    ...rustStringArray(
      "ALL",
      entries.map((entry) => toUpperSnake(entry.name)),
      memberIndent,
    ),
    `${baseIndent}}`,
  );
  return lines;
}

function renderRust(registry) {
  const lines = [
    "//! @generated by platform/containers/pin-builder/tier-a-registry.mjs. Do not edit.",
    "//! Authored sources: contracts/tier-a/registry.json, contracts/tier-a/native-actions.tsv,",
    "//! and the referenced runtime/core/proto files.",
    "",
    "#![allow(dead_code)]",
    "",
    ...renderRustStringModule("packages", registry.packages),
    "",
    ...renderRustStringModule("rpc_paths", registry.rpcPaths, "path"),
    "",
    ...renderRustStringModule("proto_kids", registry.protoKids),
    "",
    ...renderRustStringModule("wire_sentinels", registry.wireSentinels),
    "",
    "pub mod binder {",
  ];
  for (const protocol of registry.binderProtocols) {
    lines.push(`    pub mod ${protocol.name} {`);
    lines.push(...rustStringConst("DESCRIPTOR", protocol.descriptor, "        "));
    for (const transaction of protocol.transactions) {
      const identifier = toUpperSnake(transaction.name);
      lines.push(
        `        pub const TRANSACTION_${identifier}: i32 = ${transaction.code};`,
        ...rustStringConst(
          `WIRE_NAME_${identifier}`,
          transaction.wireName,
          "        ",
        ),
      );
    }
    lines.push("    }", "");
  }
  lines.pop();
  lines.push("}", "");
  lines.push("pub mod feature_flags {");
  lines.push(
    ...renderRustStringModule(
      "cloud",
      registry.featureFlags.cloud,
      "value",
      "    ",
    ),
    "",
    ...renderRustStringModule(
      "settings_global",
      registry.featureFlags.settingsGlobal,
      "value",
      "    ",
    ),
    "",
    ...renderRustStringModule(
      "penumbra_settings_global",
      registry.featureFlags.penumbraSettingsGlobal,
      "value",
      "    ",
    ),
    "}",
    "",
    "pub mod operational_markers {",
  );
  for (const marker of registry.operationalMarkers) {
    lines.push(...rustStringConst(toUpperSnake(marker.name), marker.value));
  }
  lines.push(
    "",
    ...rustStringArray(
      "LIVE",
      registry.operationalMarkers
        .filter((entry) => entry.status === "live")
        .map((marker) => toUpperSnake(marker.name)),
    ),
    "",
    ...rustStringArray(
      "EXTERNAL",
      registry.operationalMarkers
        .filter((entry) => entry.status === "external")
        .map((marker) => toUpperSnake(marker.name)),
    ),
    "",
    ...rustStringArray(
      "UNVERIFIED",
      registry.operationalMarkers
        .filter((entry) => entry.status === "unverified")
        .map((marker) => toUpperSnake(marker.name)),
    ),
    "}",
    "",
    "pub mod native_actions {",
  );
  for (const action of registry.nativeActions) {
    lines.push(...rustStringConst(action.name, action.action));
  }
  lines.push(
    "",
    ...rustStringArray(
      "ALL",
      registry.nativeActions.map((action) => action.name),
    ),
    "}",
  );
  return `${lines.join("\n")}\n`;
}

function renderKotlinStringObject(name, entries, valueKey = "value", indent = "    ") {
  const lines = [`${indent}object ${name} {`];
  for (const entry of entries) {
    lines.push(
      `${indent}    const val ${toUpperSnake(entry.name)} = ${kotlinString(entry[valueKey])}`,
    );
  }
  lines.push("", `${indent}    val ALL: Set<String> = setOf(`);
  for (const entry of entries) {
    lines.push(`${indent}        ${toUpperSnake(entry.name)},`);
  }
  lines.push(`${indent}    )`, `${indent}}`);
  return lines;
}

function renderKotlin(registry) {
  const lines = [
    '@file:Suppress("unused")',
    "",
    "package com.penumbraos.stockaibus.contract",
    "",
    "/** @generated by platform/containers/pin-builder/tier-a-registry.mjs. Do not edit. */",
    "object TierASymbols {",
    ...renderKotlinStringObject("Packages", registry.packages),
    "",
    ...renderKotlinStringObject("RpcPaths", registry.rpcPaths, "path"),
    "",
    ...renderKotlinStringObject("ProtoKids", registry.protoKids),
    "",
    ...renderKotlinStringObject("WireSentinels", registry.wireSentinels),
    "",
    "    object Binder {",
  ];
  for (const protocol of registry.binderProtocols) {
    lines.push(`        object ${toPascalCase(protocol.name)} {`);
    lines.push(
      `            const val DESCRIPTOR = ${kotlinString(protocol.descriptor)}`,
    );
    for (const transaction of protocol.transactions) {
      const identifier = toUpperSnake(transaction.name);
      lines.push(
        `            const val TRANSACTION_${identifier} = ${transaction.code}`,
        `            const val WIRE_NAME_${identifier} = ${kotlinString(transaction.wireName)}`,
      );
    }
    lines.push("        }", "");
  }
  lines.push(
    "    }",
    "",
    "    object FeatureFlags {",
    ...renderKotlinStringObject(
      "Cloud",
      registry.featureFlags.cloud,
      "value",
      "        ",
    ),
    "",
    ...renderKotlinStringObject(
      "SettingsGlobal",
      registry.featureFlags.settingsGlobal,
      "value",
      "        ",
    ),
    "",
    ...renderKotlinStringObject(
      "PenumbraSettingsGlobal",
      registry.featureFlags.penumbraSettingsGlobal,
      "value",
      "        ",
    ),
    "    }",
    "",
    "    object OperationalMarkers {",
  );
  for (const marker of registry.operationalMarkers) {
    lines.push(
      `        const val ${toUpperSnake(marker.name)} = ${kotlinString(marker.value)}`,
    );
  }
  lines.push("", "        val LIVE: Set<String> = setOf(");
  for (const marker of registry.operationalMarkers.filter(
    (entry) => entry.status === "live",
  )) {
    lines.push(`            ${toUpperSnake(marker.name)},`);
  }
  lines.push("        )", "", "        val EXTERNAL: Set<String> = setOf(");
  for (const marker of registry.operationalMarkers.filter(
    (entry) => entry.status === "external",
  )) {
    lines.push(`            ${toUpperSnake(marker.name)},`);
  }
  lines.push("        )", "", "        val UNVERIFIED: Set<String> = setOf(");
  for (const marker of registry.operationalMarkers.filter(
    (entry) => entry.status === "unverified",
  )) {
    lines.push(`            ${toUpperSnake(marker.name)},`);
  }
  lines.push("        )", "    }", "", "    object NativeActions {");
  for (const action of registry.nativeActions) {
    lines.push(
      `        const val ${action.name} = ${kotlinString(action.action)}`,
    );
  }
  lines.push("", "        val ALL: Set<String> = setOf(");
  for (const action of registry.nativeActions) {
    lines.push(`            ${action.name},`);
  }
  lines.push("        )", "    }", "}", "");
  return `${lines.join("\n")}\n`;
}

function objectFrom(entries, value) {
  return Object.fromEntries(entries.map((entry) => [entry.name, value(entry)]));
}

function serializableRegistry(registry) {
  const packageValues = objectFrom(registry.packages, (entry) => entry.value);
  return {
    packages: objectFrom(registry.packages, (entry) => entry.value),
    packageSets: Object.fromEntries(
      Object.entries(registry.packageSets).map(([name, members]) => [
        name,
        members.map((member) => packageValues[member]),
      ]),
    ),
    rpcPaths: objectFrom(registry.rpcPaths, (entry) => entry.path),
    protoKids: objectFrom(registry.protoKids, (entry) => entry.value),
    wireSentinels: objectFrom(registry.wireSentinels, (entry) => entry.value),
    binderProtocols: objectFrom(registry.binderProtocols, (protocol) => ({
      owner: protocol.owner,
      descriptor: protocol.descriptor,
      transactions: objectFrom(protocol.transactions, (transaction) => ({
        code: transaction.code,
        wireName: transaction.wireName,
      })),
    })),
    featureFlags: {
      cloud: objectFrom(registry.featureFlags.cloud, (entry) => entry.value),
      settingsGlobal: objectFrom(
        registry.featureFlags.settingsGlobal,
        (entry) => entry.value,
      ),
      penumbraSettingsGlobal: objectFrom(
        registry.featureFlags.penumbraSettingsGlobal,
        (entry) => entry.value,
      ),
    },
    operationalMarkers: objectFrom(registry.operationalMarkers, (marker) => ({
      value: marker.value,
      fields: marker.fields,
      status: marker.status,
    })),
    nativeActions: Object.fromEntries(
      registry.nativeActions.map((action) => [action.name, action.action]),
    ),
  };
}

function renderNode(registry) {
  const nodeRegistry = serializableRegistry(registry);
  return `// @generated by platform/containers/pin-builder/tier-a-registry.mjs. Do not edit.
// Authored sources: contracts/tier-a/registry.json, contracts/tier-a/native-actions.tsv,
// and the referenced runtime/core/proto files.

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const TIER_A_SYMBOLS = deepFreeze(${JSON.stringify(nodeRegistry, null, 2)});

export const PACKAGES = TIER_A_SYMBOLS.packages;
export const PACKAGE_SETS = TIER_A_SYMBOLS.packageSets;
export const RPC_PATHS = TIER_A_SYMBOLS.rpcPaths;
export const PROTO_KIDS = TIER_A_SYMBOLS.protoKids;
export const WIRE_SENTINELS = TIER_A_SYMBOLS.wireSentinels;
export const BINDER_PROTOCOLS = TIER_A_SYMBOLS.binderProtocols;
export const FEATURE_FLAGS = TIER_A_SYMBOLS.featureFlags;
export const OPERATIONAL_MARKERS = TIER_A_SYMBOLS.operationalMarkers;
export const NATIVE_ACTIONS = TIER_A_SYMBOLS.nativeActions;
`;
}

function renderTypeScript(registry) {
  return `// @generated by platform/containers/pin-builder/tier-a-registry.mjs. Do not edit.
// Authored sources: contracts/tier-a/registry.json, contracts/tier-a/native-actions.tsv,
// and the referenced runtime/core/proto files.

export const TIER_A_SYMBOLS = ${JSON.stringify(serializableRegistry(registry), null, 2)} as const;

export const PACKAGES = TIER_A_SYMBOLS.packages;
export const PACKAGE_SETS = TIER_A_SYMBOLS.packageSets;
export const RPC_PATHS = TIER_A_SYMBOLS.rpcPaths;
export const PROTO_KIDS = TIER_A_SYMBOLS.protoKids;
export const WIRE_SENTINELS = TIER_A_SYMBOLS.wireSentinels;
export const BINDER_PROTOCOLS = TIER_A_SYMBOLS.binderProtocols;
export const FEATURE_FLAGS = TIER_A_SYMBOLS.featureFlags;
export const OPERATIONAL_MARKERS = TIER_A_SYMBOLS.operationalMarkers;
export const NATIVE_ACTIONS = TIER_A_SYMBOLS.nativeActions;

export type NativeAction = (typeof NATIVE_ACTIONS)[keyof typeof NATIVE_ACTIONS];
`;
}

function renderJson(registry) {
  return `${JSON.stringify(serializableRegistry(registry), null, 2)}\n`;
}

function renderManifestPlaceholders(registry) {
  const packageValues = Object.fromEntries(
    registry.packages.map((entry) => [entry.name, entry.value]),
  );
  const lines = [
    "# @generated by platform/containers/pin-builder/tier-a-registry.mjs. Do not edit.",
    "# Loaded by Android modules and passed to manifestPlaceholders.",
  ];
  for (const entry of registry.packages) {
    lines.push(`tierAPackage${toPascalCase(entry.name)}=${entry.value}`);
  }
  for (const [name, members] of Object.entries(registry.packageSets)) {
    lines.push(
      `tierAPackageSet${toPascalCase(name)}=${members
        .map((member) => packageValues[member])
        .join(",")}`,
    );
  }
  lines.push(
    `tierAHookTargets=${registry.packageSets.hook_targets
      .map((member) => packageValues[member])
      .join(",")}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderNativeActionsDocumentation(registry) {
  const columns = [
    "action",
    "experience",
    "enabled_in_keyguard",
    "stock_role",
    "penumbra_route",
    "safety_boundary",
    "evidence",
    "note",
    "stock_evidence",
  ];
  return `${[
    columns.join("\t"),
    ...registry.nativeActions.map((action) =>
      columns.map((column) => action[column]).join("\t"),
    ),
  ].join("\n")}\n`;
}

function renderStockNativeActionsIndex(registry) {
  return `${[
    "action_name\tevidence_path",
    ...registry.nativeActions.map(
      (action) => `${action.action}\t${action.stock_evidence}`,
    ),
  ].join("\n")}\n`;
}

export function generateTierAOutputs(registry) {
  const resolved = registry?.nativeActions
    ? registry
    : resolveTierARegistry(registry);
  return Object.freeze({
    [GENERATED_OUTPUT_PATHS.rust]: renderRust(resolved),
    [GENERATED_OUTPUT_PATHS.kotlin]: renderKotlin(resolved),
    [GENERATED_OUTPUT_PATHS.node]: renderNode(resolved),
    [GENERATED_OUTPUT_PATHS.typescript]: renderTypeScript(resolved),
    [GENERATED_OUTPUT_PATHS.json]: renderJson(resolved),
    [GENERATED_OUTPUT_PATHS.manifestPlaceholders]:
      renderManifestPlaceholders(resolved),
    [GENERATED_OUTPUT_PATHS.nativeActionsDocumentation]:
      renderNativeActionsDocumentation(resolved),
    [GENERATED_OUTPUT_PATHS.stockNativeActionsIndex]:
      renderStockNativeActionsIndex(resolved),
  });
}

export function writeTierAOutputs(
  outputs,
  { root = REPOSITORY_ROOT } = {},
) {
  for (const [relativePath, contents] of Object.entries(outputs)) {
    const absolute = resolveWorkspaceAwarePath(root, relativePath, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, "utf8");
  }
}

export function checkTierAOutputs(
  outputs,
  { root = REPOSITORY_ROOT } = {},
) {
  const drift = [];
  for (const [relativePath, expected] of Object.entries(outputs)) {
    const absolute = resolveWorkspaceAwarePath(root, relativePath, relativePath);
    const actual = fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()
      ? fs.readFileSync(absolute, "utf8")
      : null;
    if (actual !== expected) drift.push(relativePath);
  }
  if (drift.length > 0) {
    fail(
      `generated output drift in ${drift.join(", ")}; run node platform/containers/pin-builder/tier-a-registry.mjs --write`,
    );
  }
  return true;
}

export function runTierARegistryCli(
  argv = process.argv.slice(2),
  { root = REPOSITORY_ROOT, stdout = process.stdout } = {},
) {
  if (
    argv.length !== 1 ||
    !["--write", "--check", "--help"].includes(argv[0])
  ) {
    fail("usage: node platform/containers/pin-builder/tier-a-registry.mjs --write|--check");
  }
  if (argv[0] === "--help") {
    stdout.write("Usage: node platform/containers/pin-builder/tier-a-registry.mjs --write|--check\n");
    return;
  }
  const registry = loadAndResolveTierARegistry({
    root,
    requireGeneratedEmitterReferences: argv[0] === "--check",
  });
  const stockEvidence = validateNativeActionStockEvidence(
    registry.nativeActions,
    { root },
  );
  const outputs = generateTierAOutputs(registry);
  if (argv[0] === "--write") {
    writeTierAOutputs(outputs, { root });
  } else {
    checkTierAOutputs(outputs, { root });
  }
  stdout.write(
    `Tier-A registry ${argv[0] === "--write" ? "generated" : "verified"}: ` +
      `${registry.nativeActions.length} native actions, ${registry.rpcPaths.length} RPC paths, ` +
      `${registry.protoKids.length} proto KIDs, ${registry.operationalMarkers.length} markers, ` +
      `stock evidence ${stockEvidence.mode}` +
      (stockEvidence.mode === "live"
        ? ` (${stockEvidence.literalProofs} literal + ${stockEvidence.constantProofs} constant)`
        : "") +
      "\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runTierARegistryCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
