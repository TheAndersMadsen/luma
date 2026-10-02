#!/usr/bin/env -S bun --no-env-file

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const REMOTE_CENTER_CONTRACT = Object.freeze({
  schemaVersion: 1,
  maxEvents: 256,
  maxInputBytes: 64 * 1024,
  streamTimeoutMs: 1_000,
  backoffBaseMs: 100,
  backoffMaxMs: 400,
  backoffProofDelaysMs: Object.freeze([100, 200, 400, 400]),
  endpoints: Object.freeze(["pin", "mac"]),
  restartNodes: Object.freeze(["pin", "vps", "mac"]),
  networks: Object.freeze(["wifi_primary", "wifi_secondary", "cellular"]),
  routes: Object.freeze({
    allowed: "center_rpc",
    forbidden: "forbidden_admin",
  }),
});

export const REQUIRED_EVIDENCE = Object.freeze([
  "default_off",
  "outbound_only",
  "unrelated_network_roundtrip",
  "pin_restart_recovered",
  "vps_restart_recovered",
  "mac_restart_recovered",
  "wifi_cellular_handoff_recovered",
  "bounded_backoff",
  "stale_generation_rejected",
  "hung_stream_detected_despite_health",
  "replay_rejected",
  "revoked_session_rejected",
  "forbidden_route_unreachable",
  "relay_outage_independent",
  "exact_cleanup",
]);

const REPORT_SCHEMA = "remote-center-acceptance/v1";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENDPOINTS = new Set(REMOTE_CENTER_CONTRACT.endpoints);
const RESTART_NODES = new Set(REMOTE_CENTER_CONTRACT.restartNodes);
const NETWORKS = new Set(REMOTE_CENTER_CONTRACT.networks);
const DIRECTIONS = new Set(["outbound", "inbound"]);
const ROUTES = new Set(Object.values(REMOTE_CENTER_CONTRACT.routes));
const VIOLATION_CODES = new Set([
  "cleanup_repeated",
  "cleanup_with_incomplete_recovery",
  "cleanup_with_incomplete_work",
  "default_probe_late",
  "event_after_cleanup",
  "generation_mismatch",
  "inbound_transport_attempt",
  "invalid_input",
  "pending_work_interrupted",
  "request_authority_invalid",
  "rejection_observation_invalid",
  "rejection_observation_missing",
  "retry_timing_invalid",
  "roundtrip_sequence_invalid",
  "state_transition_invalid",
  "unexpected_stale_event",
]);

const EVENT_KEYS = Object.freeze({
  snapshot_defaults: Object.freeze([]),
  probe_inbound: Object.freeze(["node", "route", "direction"]),
  enable: Object.freeze([]),
  connect_failure: Object.freeze([
    "node",
    "node_generation",
    "relay_generation",
    "direction",
  ]),
  advance: Object.freeze(["ms"]),
  retry: Object.freeze(["node", "node_generation", "relay_generation"]),
  connect: Object.freeze([
    "node",
    "node_generation",
    "relay_generation",
    "direction",
  ]),
  stream_activity: Object.freeze([
    "node",
    "node_generation",
    "relay_generation",
  ]),
  health: Object.freeze([
    "node",
    "node_generation",
    "relay_generation",
    "healthy",
  ]),
  liveness_check: Object.freeze(["node", "node_generation", "relay_generation"]),
  issue_session: Object.freeze(["session"]),
  request_start: Object.freeze([
    "request",
    "session",
    "nonce",
    "route",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  request_forward: Object.freeze([
    "request",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  response_start: Object.freeze([
    "request",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  response_complete: Object.freeze([
    "request",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  probe_replay: Object.freeze([
    "session",
    "nonce",
    "route",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  revoke_session: Object.freeze(["session"]),
  probe_revoked: Object.freeze([
    "session",
    "nonce",
    "route",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  probe_forbidden_route: Object.freeze([
    "session",
    "nonce",
    "route",
    "pin_generation",
    "mac_generation",
    "relay_generation",
  ]),
  probe_result: Object.freeze(["probe", "outcome", "forwarded", "side_effects"]),
  restart: Object.freeze(["node"]),
  handoff: Object.freeze(["node", "network"]),
  relay_down: Object.freeze([]),
  local_probe: Object.freeze([]),
  relay_up: Object.freeze([]),
  cleanup: Object.freeze([]),
});

export class RemoteCenterInputError extends Error {
  constructor() {
    super("invalid synthetic evidence");
    this.name = "RemoteCenterInputError";
  }
}

function invalidInput() {
  throw new RemoteCenterInputError();
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactStringKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const wanted = ["type", ...expected].sort();
  return keys.length === wanted.length && keys.sort().every((key, index) => key === wanted[index]);
}

function isGeneration(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 32;
}

function isSyntheticId(value, prefix, maximum) {
  if (typeof value !== "string") return false;
  const match = new RegExp(`^${prefix}([1-9]|[12][0-9]|3[0-2])$`).exec(value);
  return match !== null && Number(match[1]) <= maximum;
}

function validateGenerationFields(event, fields) {
  return fields.every((field) => isGeneration(event[field]));
}

export function validateSyntheticEvent(event) {
  if (!isPlainRecord(event) || typeof event.type !== "string") invalidInput();
  const shape = EVENT_KEYS[event.type];
  if (shape === undefined || !exactStringKeys(event, shape)) invalidInput();

  switch (event.type) {
    case "probe_inbound":
      if (!ENDPOINTS.has(event.node) || !ROUTES.has(event.route) || !DIRECTIONS.has(event.direction)) {
        invalidInput();
      }
      break;
    case "connect_failure":
    case "connect":
      if (
        !ENDPOINTS.has(event.node) ||
        !validateGenerationFields(event, ["node_generation", "relay_generation"]) ||
        !DIRECTIONS.has(event.direction)
      ) {
        invalidInput();
      }
      break;
    case "retry":
    case "stream_activity":
      if (
        !ENDPOINTS.has(event.node) ||
        !validateGenerationFields(event, ["node_generation", "relay_generation"])
      ) {
        invalidInput();
      }
      break;
    case "health":
      if (
        !ENDPOINTS.has(event.node) ||
        !validateGenerationFields(event, ["node_generation", "relay_generation"]) ||
        typeof event.healthy !== "boolean"
      ) {
        invalidInput();
      }
      break;
    case "liveness_check":
      if (
        !ENDPOINTS.has(event.node) ||
        !validateGenerationFields(event, ["node_generation", "relay_generation"])
      ) {
        invalidInput();
      }
      break;
    case "advance":
      if (!Number.isSafeInteger(event.ms) || event.ms < 1 || event.ms > 10_000) invalidInput();
      break;
    case "issue_session":
    case "revoke_session":
      if (!isSyntheticId(event.session, "s", 16)) invalidInput();
      break;
    case "request_start":
      if (
        !isSyntheticId(event.request, "r", 32) ||
        !isSyntheticId(event.session, "s", 16) ||
        !isSyntheticId(event.nonce, "n", 32) ||
        !ROUTES.has(event.route) ||
        !validateGenerationFields(event, [
          "pin_generation",
          "mac_generation",
          "relay_generation",
        ])
      ) {
        invalidInput();
      }
      break;
    case "request_forward":
    case "response_start":
    case "response_complete":
      if (
        !isSyntheticId(event.request, "r", 32) ||
        !validateGenerationFields(event, [
          "pin_generation",
          "mac_generation",
          "relay_generation",
        ])
      ) {
        invalidInput();
      }
      break;
    case "probe_replay":
    case "probe_revoked":
    case "probe_forbidden_route":
      if (
        !isSyntheticId(event.session, "s", 16) ||
        !isSyntheticId(event.nonce, "n", 32) ||
        !ROUTES.has(event.route) ||
        !validateGenerationFields(event, [
          "pin_generation",
          "mac_generation",
          "relay_generation",
        ])
      ) {
        invalidInput();
      }
      break;
    case "probe_result":
      if (
        !["replay", "revoked", "forbidden_route"].includes(event.probe) ||
        !["rejected", "accepted"].includes(event.outcome) ||
        typeof event.forwarded !== "boolean" ||
        typeof event.side_effects !== "boolean"
      ) {
        invalidInput();
      }
      break;
    case "restart":
      if (!RESTART_NODES.has(event.node)) invalidInput();
      break;
    case "handoff":
      if (!ENDPOINTS.has(event.node) || !NETWORKS.has(event.network)) invalidInput();
      break;
    default:
      break;
  }
  return event;
}

export function validateSyntheticEvents(events) {
  if (!Array.isArray(events) || events.length > REMOTE_CENTER_CONTRACT.maxEvents) invalidInput();
  for (const event of events) validateSyntheticEvent(event);
  return events;
}

export function parseSyntheticEventDocument(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array || typeof input === "string"
      ? Buffer.from(input)
      : null;
  if (bytes === null || bytes.length > REMOTE_CENTER_CONTRACT.maxInputBytes) invalidInput();

  let text;
  let document;
  try {
    text = UTF8.decode(bytes);
    document = JSON.parse(text);
  } catch {
    invalidInput();
  }
  if (!isPlainRecord(document)) invalidInput();
  const keys = Reflect.ownKeys(document);
  if (
    keys.length !== 2 ||
    !keys.includes("schema_version") ||
    !keys.includes("events") ||
    document.schema_version !== REMOTE_CENTER_CONTRACT.schemaVersion
  ) {
    invalidInput();
  }
  return validateSyntheticEvents(document.events);
}

function emptyEvidence() {
  return Object.fromEntries(REQUIRED_EVIDENCE.map((key) => [key, false]));
}

function emptyCleanup() {
  return {
    performed: false,
    remote_disabled: false,
    connections_closed: false,
    retry_timers_cancelled: false,
    pending_requests_cleared: false,
    sessions_revoked: false,
    ephemeral_authority_cleared: false,
    recovery_state_cleared: false,
    synthetic_network_restored: false,
    relay_baseline_restored: false,
    resources_closed_exactly_once: false,
    inbound_listeners_absent: false,
  };
}

function invalidReport() {
  return {
    schema: REPORT_SCHEMA,
    status: "incomplete",
    complete: false,
    evidence: emptyEvidence(),
    cleanup: emptyCleanup(),
    missing_evidence: [...REQUIRED_EVIDENCE],
    violations: ["invalid_input"],
  };
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsContiguous(values, expected) {
  for (let start = 0; start <= values.length - expected.length; start += 1) {
    if (sameArray(values.slice(start, start + expected.length), expected)) return true;
  }
  return false;
}

export class RemoteCenterAcceptanceMachine {
  constructor() {
    this.nowMs = 0;
    this.enabled = false;
    this.relayUp = true;
    this.localAvailable = true;
    this.cleaned = false;
    this.cleanupReport = emptyCleanup();
    this.listenerCount = 0;
    this.generations = { pin: 1, mac: 1, vps: 1 };
    this.networks = { pin: "wifi_secondary", mac: "wifi_primary" };
    this.connections = { pin: null, mac: null };
    this.connectReady = { pin: false, mac: false };
    this.timers = { pin: null, mac: null };
    this.failureStreak = { pin: 0, mac: 0 };
    this.sessions = new Map();
    this.seenNonces = new Set();
    this.pending = new Map();
    this.pendingProbe = null;
    this.usedRequests = new Set();
    this.resources = new Map();
    this.nextResource = 1;
    this.staleStamps = new Set();
    this.violations = new Set();
    this.eventsConsumed = 0;
    this.completedRoundtrips = 0;
    this.allowedRouteHits = 0;
    this.forbiddenRouteHits = 0;
    this.defaultObserved = false;
    this.inboundProbeRejected = false;
    this.allTransportAttemptsOutbound = true;
    this.outboundConnected = new Set();
    this.unrelatedRoundtrip = false;
    this.restartPending = null;
    this.restartRecovered = { pin: false, vps: false, mac: false };
    this.handoffPending = false;
    this.handoffRecovered = false;
    this.backoffProofs = new Map();
    this.hungDetected = false;
    this.hungRecoveryPending = false;
    this.hungRecovered = false;
    this.staleRejected = false;
    this.replayRejected = false;
    this.revokedRejected = false;
    this.forbiddenRouteRejected = false;
    this.relayOutagePhase = null;
    this.localObservedDuringOutage = false;
    this.relayOutageRecovered = false;
  }

  violate(code) {
    if (!VIOLATION_CODES.has(code)) throw new Error("internal violation code");
    this.violations.add(code);
  }

  createResource(kind) {
    const id = this.nextResource;
    this.nextResource += 1;
    this.resources.set(id, { kind, closes: 0 });
    return id;
  }

  closeResource(id) {
    if (id === null || id === undefined) return;
    const resource = this.resources.get(id);
    if (resource === undefined || resource.closes !== 0) {
      this.violate("state_transition_invalid");
      return;
    }
    resource.closes = 1;
  }

  currentEndpointStamp(node, event) {
    return (
      event.node_generation === this.generations[node] &&
      event.relay_generation === this.generations.vps
    );
  }

  currentRoundtripStamp(event) {
    return (
      event.pin_generation === this.generations.pin &&
      event.mac_generation === this.generations.mac &&
      event.relay_generation === this.generations.vps
    );
  }

  connectionIsCurrent(node) {
    const connection = this.connections[node];
    return (
      connection !== null &&
      connection.nodeGeneration === this.generations[node] &&
      connection.relayGeneration === this.generations.vps
    );
  }

  bothConnectionsCurrent() {
    return this.connectionIsCurrent("pin") && this.connectionIsCurrent("mac");
  }

  rememberStaleConnection(node, connection) {
    if (connection === null) return;
    this.staleStamps.add(`${node}:${connection.nodeGeneration}:${connection.relayGeneration}`);
  }

  closeConnection(node) {
    const connection = this.connections[node];
    if (connection === null) return;
    this.rememberStaleConnection(node, connection);
    this.closeResource(connection.resource);
    this.connections[node] = null;
  }

  closeTimer(node) {
    const timer = this.timers[node];
    if (timer === null) return;
    this.closeResource(timer.resource);
    this.timers[node] = null;
  }

  closeAuthority({ interrupted = false } = {}) {
    if (interrupted && this.pending.size > 0) {
      this.violate("pending_work_interrupted");
    }
    for (const request of this.pending.values()) this.closeResource(request.resource);
    this.pending.clear();
    for (const session of this.sessions.values()) {
      if (session.status === "active") {
        this.closeResource(session.resource);
        session.status = "invalidated";
      }
    }
  }

  invalidateEndpoint(node, { incrementGeneration }) {
    this.closeConnection(node);
    this.closeTimer(node);
    this.closeAuthority({ interrupted: true });
    if (incrementGeneration) this.generations[node] += 1;
    this.failureStreak[node] = 0;
    this.connectReady[node] = this.enabled && this.relayUp;
  }

  invalidateRelay({ incrementGeneration }) {
    this.closeConnection("pin");
    this.closeConnection("mac");
    this.closeTimer("pin");
    this.closeTimer("mac");
    this.closeAuthority({ interrupted: true });
    if (incrementGeneration) this.generations.vps += 1;
    for (const node of REMOTE_CENTER_CONTRACT.endpoints) {
      this.failureStreak[node] = 0;
      this.connectReady[node] = this.enabled && this.relayUp;
    }
  }

  handleSnapshotDefaults() {
    const pristine =
      this.eventsConsumed === 1 &&
      !this.enabled &&
      this.listenerCount === 0 &&
      this.connections.pin === null &&
      this.connections.mac === null &&
      this.timers.pin === null &&
      this.timers.mac === null &&
      this.sessions.size === 0 &&
      this.pending.size === 0;
    if (!pristine) {
      this.violate("default_probe_late");
      return;
    }
    this.defaultObserved = true;
  }

  handleInboundProbe(event) {
    if (event.direction !== "inbound" || !ENDPOINTS.has(event.node)) {
      this.violate("state_transition_invalid");
      return;
    }
    if (this.listenerCount === 0) this.inboundProbeRejected = true;
  }

  handleEnable() {
    if (this.enabled || this.cleaned) {
      this.violate("state_transition_invalid");
      return;
    }
    this.enabled = true;
    this.connectReady.pin = true;
    this.connectReady.mac = true;
  }

  validateTransportAttempt(event) {
    if (event.direction !== "outbound") {
      this.allTransportAttemptsOutbound = false;
      this.violate("inbound_transport_attempt");
      return false;
    }
    if (!this.currentEndpointStamp(event.node, event)) {
      this.violate("generation_mismatch");
      return false;
    }
    if (!this.enabled || !this.relayUp || this.connections[event.node] !== null) {
      this.violate("state_transition_invalid");
      return false;
    }
    return true;
  }

  handleConnectFailure(event) {
    if (!this.validateTransportAttempt(event)) return;
    const node = event.node;
    if (!this.connectReady[node] || this.timers[node] !== null) {
      this.violate("state_transition_invalid");
      return;
    }
    this.connectReady[node] = false;
    this.failureStreak[node] += 1;
    const delayMs = Math.min(
      REMOTE_CENTER_CONTRACT.backoffBaseMs * 2 ** (this.failureStreak[node] - 1),
      REMOTE_CENTER_CONTRACT.backoffMaxMs,
    );
    const proofKey = `${node}:${this.generations[node]}:${this.generations.vps}`;
    const proof = this.backoffProofs.get(proofKey) ?? { delays: [], exactRetries: 0 };
    proof.delays.push(delayMs);
    this.backoffProofs.set(proofKey, proof);
    this.timers[node] = {
      dueMs: this.nowMs + delayMs,
      nodeGeneration: this.generations[node],
      relayGeneration: this.generations.vps,
      proofKey,
      resource: this.createResource("retry_timer"),
    };
  }

  handleAdvance(event) {
    this.nowMs += event.ms;
  }

  handleRetry(event) {
    const timer = this.timers[event.node];
    if (timer === null) {
      this.violate("retry_timing_invalid");
      return;
    }
    if (
      !this.currentEndpointStamp(event.node, event) ||
      timer.nodeGeneration !== event.node_generation ||
      timer.relayGeneration !== event.relay_generation
    ) {
      this.violate("generation_mismatch");
      return;
    }
    if (this.nowMs !== timer.dueMs) {
      this.violate("retry_timing_invalid");
      return;
    }
    this.closeTimer(event.node);
    this.connectReady[event.node] = true;
    const proof = this.backoffProofs.get(timer.proofKey);
    if (proof === undefined) throw new Error("missing backoff proof");
    proof.exactRetries += 1;
  }

  handleConnect(event) {
    if (!this.validateTransportAttempt(event)) return;
    const node = event.node;
    if (!this.connectReady[node] || this.timers[node] !== null) {
      this.violate("state_transition_invalid");
      return;
    }
    this.connections[node] = {
      nodeGeneration: this.generations[node],
      relayGeneration: this.generations.vps,
      lastStreamAtMs: this.nowMs,
      healthy: false,
      resource: this.createResource("connection"),
    };
    this.connectReady[node] = false;
    this.failureStreak[node] = 0;
    this.outboundConnected.add(node);
  }

  handleStreamActivity(event) {
    const connection = this.connections[event.node];
    if (
      connection !== null &&
      this.currentEndpointStamp(event.node, event) &&
      connection.nodeGeneration === event.node_generation &&
      connection.relayGeneration === event.relay_generation
    ) {
      connection.lastStreamAtMs = this.nowMs;
      return;
    }
    const key = `${event.node}:${event.node_generation}:${event.relay_generation}`;
    if (this.staleStamps.has(key)) {
      this.staleRejected = true;
      return;
    }
    this.violate("unexpected_stale_event");
  }

  handleHealth(event) {
    const connection = this.connections[event.node];
    if (
      connection === null ||
      !this.currentEndpointStamp(event.node, event) ||
      connection.nodeGeneration !== event.node_generation ||
      connection.relayGeneration !== event.relay_generation
    ) {
      this.violate("generation_mismatch");
      return;
    }
    connection.healthy = event.healthy;
  }

  handleLivenessCheck(event) {
    const connection = this.connections[event.node];
    if (
      connection === null ||
      !this.currentEndpointStamp(event.node, event) ||
      connection.nodeGeneration !== event.node_generation ||
      connection.relayGeneration !== event.relay_generation
    ) {
      const key = `${event.node}:${event.node_generation}:${event.relay_generation}`;
      if (this.staleStamps.has(key)) {
        this.staleRejected = true;
        return;
      }
      this.violate("generation_mismatch");
      return;
    }
    if (
      connection.healthy !== true ||
      this.nowMs - connection.lastStreamAtMs <= REMOTE_CENTER_CONTRACT.streamTimeoutMs ||
      this.anotherRecoveryPending()
    ) {
      this.violate("state_transition_invalid");
      return;
    }
    this.hungDetected = true;
    this.hungRecoveryPending = true;
    this.invalidateEndpoint(event.node, { incrementGeneration: true });
  }

  handleIssueSession(event) {
    if (
      !this.enabled ||
      !this.relayUp ||
      !this.bothConnectionsCurrent() ||
      this.sessions.has(event.session)
    ) {
      this.violate("state_transition_invalid");
      return;
    }
    this.sessions.set(event.session, {
      status: "active",
      explicitlyRevoked: false,
      resource: this.createResource("session"),
    });
  }

  hasCurrentAuthority(event) {
    return this.enabled && this.relayUp && this.bothConnectionsCurrent() && this.currentRoundtripStamp(event);
  }

  handleRequestStart(event) {
    const session = this.sessions.get(event.session);
    if (
      event.route !== REMOTE_CENTER_CONTRACT.routes.allowed ||
      !this.hasCurrentAuthority(event) ||
      session?.status !== "active" ||
      this.seenNonces.has(event.nonce) ||
      this.usedRequests.has(event.request) ||
      this.pending.has(event.request)
    ) {
      this.violate("request_authority_invalid");
      return;
    }
    this.seenNonces.add(event.nonce);
    this.usedRequests.add(event.request);
    this.allowedRouteHits += 1;
    this.pending.set(event.request, {
      stage: "request_started",
      session: event.session,
      pinGeneration: event.pin_generation,
      macGeneration: event.mac_generation,
      relayGeneration: event.relay_generation,
      resource: this.createResource("pending_request"),
    });
  }

  handleRoundtripStage(event, expectedStage, nextStage) {
    const pending = this.pending.get(event.request);
    if (
      pending === undefined ||
      pending.stage !== expectedStage ||
      !this.currentRoundtripStamp(event) ||
      pending.pinGeneration !== event.pin_generation ||
      pending.macGeneration !== event.mac_generation ||
      pending.relayGeneration !== event.relay_generation
    ) {
      this.violate("roundtrip_sequence_invalid");
      return false;
    }
    pending.stage = nextStage;
    return true;
  }

  handleResponseComplete(event) {
    if (!this.handleRoundtripStage(event, "response_started", "complete")) return;
    const pending = this.pending.get(event.request);
    this.closeResource(pending.resource);
    this.pending.delete(event.request);
    this.completedRoundtrips += 1;

    if (this.networks.pin !== this.networks.mac) this.unrelatedRoundtrip = true;
    if (this.restartPending !== null) {
      this.restartRecovered[this.restartPending] = true;
      this.restartPending = null;
    }
    if (this.handoffPending) {
      this.handoffRecovered = true;
      this.handoffPending = false;
    }
    if (this.hungRecoveryPending && this.hungDetected) {
      this.hungRecovered = true;
      this.hungRecoveryPending = false;
    }
    if (this.relayOutagePhase === "recovering" && this.localObservedDuringOutage) {
      this.relayOutageRecovered = true;
      this.relayOutagePhase = null;
    }
  }

  handleReplayProbe(event) {
    const session = this.sessions.get(event.session);
    if (
      event.route === REMOTE_CENTER_CONTRACT.routes.allowed &&
      this.hasCurrentAuthority(event) &&
      session?.status === "active" &&
      this.seenNonces.has(event.nonce)
    ) {
      this.beginRejectionProbe("replay");
      return;
    }
    this.violate("request_authority_invalid");
  }

  handleRevokeSession(event) {
    const session = this.sessions.get(event.session);
    if (session?.status !== "active") {
      this.violate("state_transition_invalid");
      return;
    }
    this.closeResource(session.resource);
    session.status = "revoked";
    session.explicitlyRevoked = true;
    let interrupted = false;
    for (const [requestId, pending] of this.pending) {
      if (pending.session === event.session) {
        interrupted = true;
        this.closeResource(pending.resource);
        this.pending.delete(requestId);
      }
    }
    if (interrupted) this.violate("pending_work_interrupted");
  }

  handleRevokedProbe(event) {
    const session = this.sessions.get(event.session);
    if (
      event.route === REMOTE_CENTER_CONTRACT.routes.allowed &&
      this.hasCurrentAuthority(event) &&
      session?.status === "revoked" &&
      session.explicitlyRevoked === true &&
      !this.seenNonces.has(event.nonce)
    ) {
      this.beginRejectionProbe("revoked");
      return;
    }
    this.violate("request_authority_invalid");
  }

  handleForbiddenRouteProbe(event) {
    const session = this.sessions.get(event.session);
    if (
      event.route === REMOTE_CENTER_CONTRACT.routes.forbidden &&
      this.hasCurrentAuthority(event) &&
      session?.status === "active" &&
      !this.seenNonces.has(event.nonce) &&
      this.forbiddenRouteHits === 0
    ) {
      this.beginRejectionProbe("forbidden_route");
      return;
    }
    this.violate("request_authority_invalid");
  }

  beginRejectionProbe(kind) {
    if (this.pendingProbe !== null) {
      this.violate("rejection_observation_missing");
      return;
    }
    this.pendingProbe = {
      kind,
      pendingRequests: this.pending.size,
      allowedRouteHits: this.allowedRouteHits,
      forbiddenRouteHits: this.forbiddenRouteHits,
    };
  }

  handleProbeResult(event) {
    const probe = this.pendingProbe;
    this.pendingProbe = null;
    if (probe === null || probe.kind !== event.probe) {
      this.violate("rejection_observation_invalid");
      return;
    }
    const unchanged =
      this.pending.size === probe.pendingRequests &&
      this.allowedRouteHits === probe.allowedRouteHits &&
      this.forbiddenRouteHits === probe.forbiddenRouteHits;
    if (
      event.outcome !== "rejected" ||
      event.forwarded ||
      event.side_effects ||
      !unchanged
    ) {
      if (
        probe.kind === "forbidden_route" &&
        (event.outcome === "accepted" || event.forwarded || event.side_effects)
      ) {
        this.forbiddenRouteHits += 1;
      }
      this.violate("rejection_observation_invalid");
      return;
    }
    if (probe.kind === "replay") this.replayRejected = true;
    else if (probe.kind === "revoked") this.revokedRejected = true;
    else this.forbiddenRouteRejected = true;
  }

  anotherRecoveryPending() {
    return (
      this.restartPending !== null ||
      this.handoffPending ||
      this.hungRecoveryPending ||
      this.relayOutagePhase !== null
    );
  }

  handleRestart(event) {
    if (!this.enabled || !this.relayUp || !this.bothConnectionsCurrent() || this.anotherRecoveryPending()) {
      this.violate("state_transition_invalid");
      return;
    }
    this.restartPending = event.node;
    if (event.node === "vps") {
      this.invalidateRelay({ incrementGeneration: true });
    } else {
      this.invalidateEndpoint(event.node, { incrementGeneration: true });
    }
  }

  handleHandoff(event) {
    const validTransition =
      event.node === "pin" &&
      ((this.networks.pin === "wifi_secondary" && event.network === "cellular") ||
        (this.networks.pin === "cellular" && event.network === "wifi_secondary"));
    if (
      !validTransition ||
      !this.enabled ||
      !this.relayUp ||
      !this.bothConnectionsCurrent() ||
      this.anotherRecoveryPending()
    ) {
      this.violate("state_transition_invalid");
      return;
    }
    this.networks.pin = event.network;
    this.handoffPending = true;
    this.invalidateEndpoint("pin", { incrementGeneration: true });
  }

  handleRelayDown() {
    if (
      !this.enabled ||
      !this.relayUp ||
      !this.bothConnectionsCurrent() ||
      this.anotherRecoveryPending()
    ) {
      this.violate("state_transition_invalid");
      return;
    }
    this.relayUp = false;
    this.relayOutagePhase = "down";
    this.localObservedDuringOutage = false;
    this.invalidateRelay({ incrementGeneration: true });
  }

  handleLocalProbe() {
    if (this.relayOutagePhase !== "down" || this.relayUp || !this.localAvailable) {
      this.violate("state_transition_invalid");
      return;
    }
    this.localObservedDuringOutage = true;
  }

  handleRelayUp() {
    if (this.relayOutagePhase !== "down" || this.relayUp) {
      this.violate("state_transition_invalid");
      return;
    }
    this.relayUp = true;
    this.relayOutagePhase = "recovering";
    this.connectReady.pin = true;
    this.connectReady.mac = true;
  }

  handleCleanup() {
    if (this.cleaned) {
      this.violate("cleanup_repeated");
      return;
    }
    const recoveryWasSettled =
      this.restartPending === null &&
      !this.handoffPending &&
      !this.hungRecoveryPending &&
      this.relayOutagePhase === null;
    const workWasSettled =
      this.pending.size === 0 &&
      this.timers.pin === null &&
      this.timers.mac === null;
    if (!recoveryWasSettled) this.violate("cleanup_with_incomplete_recovery");
    if (!workWasSettled) this.violate("cleanup_with_incomplete_work");
    this.closeConnection("pin");
    this.closeConnection("mac");
    this.closeTimer("pin");
    this.closeTimer("mac");
    this.closeAuthority();
    this.sessions.clear();
    this.seenNonces.clear();
    this.usedRequests.clear();
    this.staleStamps.clear();
    this.pendingProbe = null;
    this.pending.clear();
    this.enabled = false;
    this.relayUp = true;
    this.networks.pin = "wifi_secondary";
    this.networks.mac = "wifi_primary";
    this.connectReady.pin = false;
    this.connectReady.mac = false;
    this.failureStreak.pin = 0;
    this.failureStreak.mac = 0;
    this.restartPending = null;
    this.handoffPending = false;
    this.hungRecoveryPending = false;
    this.relayOutagePhase = null;
    this.cleaned = true;

    const resourcesClosedExactlyOnce = [...this.resources.values()].every(
      (resource) => resource.closes === 1,
    );
    this.cleanupReport = {
      performed: true,
      remote_disabled: !this.enabled,
      connections_closed: this.connections.pin === null && this.connections.mac === null,
      retry_timers_cancelled: this.timers.pin === null && this.timers.mac === null,
      pending_requests_cleared: this.pending.size === 0,
      sessions_revoked: this.sessions.size === 0,
      ephemeral_authority_cleared:
        this.seenNonces.size === 0 &&
        this.usedRequests.size === 0 &&
        this.staleStamps.size === 0 &&
        this.pendingProbe === null,
      recovery_state_cleared:
        recoveryWasSettled &&
        this.restartPending === null &&
        !this.handoffPending &&
        !this.hungRecoveryPending &&
        this.relayOutagePhase === null,
      synthetic_network_restored:
        this.networks.pin === "wifi_secondary" && this.networks.mac === "wifi_primary",
      relay_baseline_restored: this.relayUp,
      resources_closed_exactly_once: resourcesClosedExactlyOnce,
      inbound_listeners_absent: this.listenerCount === 0,
    };
  }

  consume(event) {
    validateSyntheticEvent(event);
    this.eventsConsumed += 1;
    if (this.cleaned) {
      if (event.type === "cleanup") this.violate("cleanup_repeated");
      else this.violate("event_after_cleanup");
      return this;
    }
    if (this.pendingProbe !== null && event.type !== "probe_result") {
      this.violate("rejection_observation_missing");
      this.pendingProbe = null;
    }

    switch (event.type) {
      case "snapshot_defaults":
        this.handleSnapshotDefaults();
        break;
      case "probe_inbound":
        this.handleInboundProbe(event);
        break;
      case "enable":
        this.handleEnable();
        break;
      case "connect_failure":
        this.handleConnectFailure(event);
        break;
      case "advance":
        this.handleAdvance(event);
        break;
      case "retry":
        this.handleRetry(event);
        break;
      case "connect":
        this.handleConnect(event);
        break;
      case "stream_activity":
        this.handleStreamActivity(event);
        break;
      case "health":
        this.handleHealth(event);
        break;
      case "liveness_check":
        this.handleLivenessCheck(event);
        break;
      case "issue_session":
        this.handleIssueSession(event);
        break;
      case "request_start":
        this.handleRequestStart(event);
        break;
      case "request_forward":
        this.handleRoundtripStage(event, "request_started", "request_forwarded");
        break;
      case "response_start":
        this.handleRoundtripStage(event, "request_forwarded", "response_started");
        break;
      case "response_complete":
        this.handleResponseComplete(event);
        break;
      case "probe_replay":
        this.handleReplayProbe(event);
        break;
      case "revoke_session":
        this.handleRevokeSession(event);
        break;
      case "probe_revoked":
        this.handleRevokedProbe(event);
        break;
      case "probe_forbidden_route":
        this.handleForbiddenRouteProbe(event);
        break;
      case "probe_result":
        this.handleProbeResult(event);
        break;
      case "restart":
        this.handleRestart(event);
        break;
      case "handoff":
        this.handleHandoff(event);
        break;
      case "relay_down":
        this.handleRelayDown();
        break;
      case "local_probe":
        this.handleLocalProbe();
        break;
      case "relay_up":
        this.handleRelayUp();
        break;
      case "cleanup":
        this.handleCleanup();
        break;
      default:
        throw new Error("unreachable event type");
    }
    return this;
  }

  report() {
    const boundedBackoff = [...this.backoffProofs.values()].some(
      (proof) =>
        containsContiguous(
          proof.delays,
          REMOTE_CENTER_CONTRACT.backoffProofDelaysMs,
        ) &&
        proof.delays.every((delay) => delay <= REMOTE_CENTER_CONTRACT.backoffMaxMs) &&
        proof.exactRetries >= REMOTE_CENTER_CONTRACT.backoffProofDelaysMs.length,
    );
    const exactCleanup =
      this.cleanupReport.performed &&
      Object.entries(this.cleanupReport)
        .filter(([key]) => key !== "performed")
        .every(([, value]) => value === true);
    const evidence = {
      default_off: this.defaultObserved,
      outbound_only:
        this.inboundProbeRejected &&
        this.allTransportAttemptsOutbound &&
        this.listenerCount === 0 &&
        REMOTE_CENTER_CONTRACT.endpoints.every((node) => this.outboundConnected.has(node)),
      unrelated_network_roundtrip: this.unrelatedRoundtrip,
      pin_restart_recovered: this.restartRecovered.pin,
      vps_restart_recovered: this.restartRecovered.vps,
      mac_restart_recovered: this.restartRecovered.mac,
      wifi_cellular_handoff_recovered: this.handoffRecovered,
      bounded_backoff: boundedBackoff,
      stale_generation_rejected: this.staleRejected,
      hung_stream_detected_despite_health: this.hungDetected && this.hungRecovered,
      replay_rejected: this.replayRejected,
      revoked_session_rejected: this.revokedRejected,
      forbidden_route_unreachable:
        this.forbiddenRouteRejected && this.forbiddenRouteHits === 0,
      relay_outage_independent: this.relayOutageRecovered,
      exact_cleanup: exactCleanup,
    };
    const missingEvidence = REQUIRED_EVIDENCE.filter((key) => evidence[key] !== true);
    const violations = [...this.violations].sort();
    const complete = missingEvidence.length === 0 && violations.length === 0;
    return {
      schema: REPORT_SCHEMA,
      status: complete ? "pass" : "incomplete",
      complete,
      evidence,
      cleanup: { ...this.cleanupReport },
      missing_evidence: missingEvidence,
      violations,
    };
  }
}

export function runRemoteCenterAcceptance(events) {
  validateSyntheticEvents(events);
  const machine = new RemoteCenterAcceptanceMachine();
  for (const event of events) machine.consume(event);
  const report = machine.report();
  if (!isPrivacySafeReport(report)) throw new Error("unsafe report shape");
  return report;
}

function stamp(pinGeneration, macGeneration, relayGeneration) {
  return {
    pin_generation: pinGeneration,
    mac_generation: macGeneration,
    relay_generation: relayGeneration,
  };
}

function endpointStamp(node, nodeGeneration, relayGeneration) {
  return { node, node_generation: nodeGeneration, relay_generation: relayGeneration };
}

function connectionEvents(node, nodeGeneration, relayGeneration) {
  return [
    {
      type: "connect",
      ...endpointStamp(node, nodeGeneration, relayGeneration),
      direction: "outbound",
    },
    { type: "stream_activity", ...endpointStamp(node, nodeGeneration, relayGeneration) },
  ];
}

function rejectionResult(probe) {
  return {
    type: "probe_result",
    probe,
    outcome: "rejected",
    forwarded: false,
    side_effects: false,
  };
}

function roundtripEvents({ request, session, nonce, pinGeneration, macGeneration, relayGeneration }) {
  const generations = stamp(pinGeneration, macGeneration, relayGeneration);
  return [
    {
      type: "request_start",
      request,
      session,
      nonce,
      route: REMOTE_CENTER_CONTRACT.routes.allowed,
      ...generations,
    },
    { type: "request_forward", request, ...generations },
    { type: "response_start", request, ...generations },
    { type: "response_complete", request, ...generations },
  ];
}

export function createCompleteSyntheticEvents() {
  const events = [
    { type: "snapshot_defaults" },
    {
      type: "probe_inbound",
      node: "pin",
      route: REMOTE_CENTER_CONTRACT.routes.allowed,
      direction: "inbound",
    },
    { type: "enable" },
  ];

  for (const delay of REMOTE_CENTER_CONTRACT.backoffProofDelaysMs) {
    events.push({
      type: "connect_failure",
      ...endpointStamp("pin", 1, 1),
      direction: "outbound",
    });
    events.push({ type: "advance", ms: delay });
    events.push({ type: "retry", ...endpointStamp("pin", 1, 1) });
  }
  events.push(...connectionEvents("pin", 1, 1));
  events.push(...connectionEvents("mac", 1, 1));
  events.push({ type: "issue_session", session: "s1" });
  events.push(
    ...roundtripEvents({
      request: "r1",
      session: "s1",
      nonce: "n1",
      pinGeneration: 1,
      macGeneration: 1,
      relayGeneration: 1,
    }),
  );
  events.push({
    type: "probe_replay",
    session: "s1",
    nonce: "n1",
    route: REMOTE_CENTER_CONTRACT.routes.allowed,
    ...stamp(1, 1, 1),
  });
  events.push(rejectionResult("replay"));
  events.push({ type: "revoke_session", session: "s1" });
  events.push({
    type: "probe_revoked",
    session: "s1",
    nonce: "n2",
    route: REMOTE_CENTER_CONTRACT.routes.allowed,
    ...stamp(1, 1, 1),
  });
  events.push(rejectionResult("revoked"));
  events.push({ type: "issue_session", session: "s2" });
  events.push({
    type: "probe_forbidden_route",
    session: "s2",
    nonce: "n3",
    route: REMOTE_CENTER_CONTRACT.routes.forbidden,
    ...stamp(1, 1, 1),
  });
  events.push(rejectionResult("forbidden_route"));

  events.push({ type: "restart", node: "pin" });
  events.push(...connectionEvents("pin", 2, 1));
  events.push({ type: "issue_session", session: "s3" });
  events.push(
    ...roundtripEvents({
      request: "r2",
      session: "s3",
      nonce: "n4",
      pinGeneration: 2,
      macGeneration: 1,
      relayGeneration: 1,
    }),
  );

  events.push({ type: "restart", node: "vps" });
  events.push(...connectionEvents("pin", 2, 2));
  events.push(...connectionEvents("mac", 1, 2));
  events.push({ type: "issue_session", session: "s4" });
  events.push(
    ...roundtripEvents({
      request: "r3",
      session: "s4",
      nonce: "n5",
      pinGeneration: 2,
      macGeneration: 1,
      relayGeneration: 2,
    }),
  );

  events.push({ type: "restart", node: "mac" });
  events.push(...connectionEvents("mac", 2, 2));
  events.push({ type: "issue_session", session: "s5" });
  events.push(
    ...roundtripEvents({
      request: "r4",
      session: "s5",
      nonce: "n6",
      pinGeneration: 2,
      macGeneration: 2,
      relayGeneration: 2,
    }),
  );

  events.push({ type: "handoff", node: "pin", network: "cellular" });
  events.push(...connectionEvents("pin", 3, 2));
  events.push({ type: "issue_session", session: "s6" });
  events.push(
    ...roundtripEvents({
      request: "r5",
      session: "s6",
      nonce: "n7",
      pinGeneration: 3,
      macGeneration: 2,
      relayGeneration: 2,
    }),
  );

  events.push({ type: "stream_activity", ...endpointStamp("mac", 2, 2) });
  events.push({ type: "health", ...endpointStamp("mac", 2, 2), healthy: true });
  events.push({ type: "advance", ms: REMOTE_CENTER_CONTRACT.streamTimeoutMs + 1 });
  events.push({ type: "liveness_check", ...endpointStamp("mac", 2, 2) });
  events.push({ type: "stream_activity", ...endpointStamp("mac", 2, 2) });
  events.push(...connectionEvents("mac", 3, 2));
  events.push({ type: "issue_session", session: "s7" });
  events.push(
    ...roundtripEvents({
      request: "r6",
      session: "s7",
      nonce: "n8",
      pinGeneration: 3,
      macGeneration: 3,
      relayGeneration: 2,
    }),
  );

  events.push({ type: "relay_down" });
  events.push({ type: "local_probe" });
  events.push({ type: "relay_up" });
  events.push(...connectionEvents("pin", 3, 3));
  events.push(...connectionEvents("mac", 3, 3));
  events.push({ type: "issue_session", session: "s8" });
  events.push(
    ...roundtripEvents({
      request: "r7",
      session: "s8",
      nonce: "n9",
      pinGeneration: 3,
      macGeneration: 3,
      relayGeneration: 3,
    }),
  );
  events.push({ type: "cleanup" });
  return events;
}

export function isPrivacySafeReport(report) {
  if (!isPlainRecord(report)) return false;
  const topKeys = Reflect.ownKeys(report).sort();
  if (
    !sameArray(topKeys, [
      "cleanup",
      "complete",
      "evidence",
      "missing_evidence",
      "schema",
      "status",
      "violations",
    ]) ||
    report.schema !== REPORT_SCHEMA ||
    !["pass", "incomplete"].includes(report.status) ||
    typeof report.complete !== "boolean" ||
    !isPlainRecord(report.evidence) ||
    !isPlainRecord(report.cleanup) ||
    !Array.isArray(report.missing_evidence) ||
    !Array.isArray(report.violations)
  ) {
    return false;
  }
  if (!sameArray(Reflect.ownKeys(report.evidence), REQUIRED_EVIDENCE)) return false;
  if (Object.values(report.evidence).some((value) => typeof value !== "boolean")) return false;
  const cleanupKeys = Object.keys(emptyCleanup());
  if (!sameArray(Reflect.ownKeys(report.cleanup), cleanupKeys)) return false;
  if (Object.values(report.cleanup).some((value) => typeof value !== "boolean")) return false;
  if (report.missing_evidence.some((value) => !REQUIRED_EVIDENCE.includes(value))) return false;
  if (report.violations.some((value) => !VIOLATION_CODES.has(value))) return false;
  return true;
}

function usage() {
  return [
    "Usage:",
    "  bun platform/deploy/acceptance/pin/remote-center-acceptance.mjs --self-check",
    "  bun platform/deploy/acceptance/pin/remote-center-acceptance.mjs --stdin",
    "",
    "This is a deterministic host-only model. --stdin accepts one bounded JSON",
    "document with schema_version 1 and a synthetic events array. It opens no",
    "connections and starts no external processes. Reports contain only fixed",
    "status codes and booleans. Any absent evidence returns incomplete and exit 1.",
  ].join("\n");
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) invalidInput();
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { mode: "help" };
  }
  if (argv.length === 1 && argv[0] === "--self-check") return { mode: "self-check" };
  if (argv.length === 1 && argv[0] === "--stdin") return { mode: "stdin" };
  invalidInput();
}

export function main(argv = process.argv.slice(2), io = {}) {
  const readStdin = io.readStdin ?? (() => readFileSync(0));
  const writeStdout = io.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = io.writeStderr ?? ((value) => process.stderr.write(value));
  try {
    const options = parseCliArgs(argv);
    if (options.mode === "help") {
      writeStdout(`${usage()}\n`);
      return 0;
    }
    const events =
      options.mode === "self-check"
        ? createCompleteSyntheticEvents()
        : parseSyntheticEventDocument(readStdin());
    const report = runRemoteCenterAcceptance(events);
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.complete ? 0 : 1;
  } catch {
    const report = invalidReport();
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    writeStderr("remote-center-acceptance: invalid synthetic evidence\n");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
