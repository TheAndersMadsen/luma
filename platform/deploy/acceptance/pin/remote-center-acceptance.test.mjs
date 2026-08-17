import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REMOTE_CENTER_CONTRACT,
  REQUIRED_EVIDENCE,
  RemoteCenterAcceptanceMachine,
  RemoteCenterInputError,
  createCompleteSyntheticEvents,
  isPrivacySafeReport,
  main,
  parseCliArgs,
  parseSyntheticEventDocument,
  runRemoteCenterAcceptance,
  validateSyntheticEvent,
  validateSyntheticEvents,
} from "./remote-center-acceptance.mjs";

function completeEvents() {
  return structuredClone(createCompleteSyntheticEvents());
}

function documentFor(events) {
  return JSON.stringify({
    schema_version: REMOTE_CENTER_CONTRACT.schemaVersion,
    events,
  });
}

function removeFirst(events, predicate) {
  const index = events.findIndex(predicate);
  assert.notEqual(index, -1, "fixture event was not found");
  events.splice(index, 1);
  return events;
}

function findAfter(events, startType, predicate) {
  const start = events.findIndex((event) => event.type === startType);
  assert.notEqual(start, -1, `fixture ${startType} event was not found`);
  const relative = events.slice(start + 1).findIndex(predicate);
  assert.notEqual(relative, -1, "fixture event after boundary was not found");
  return start + 1 + relative;
}

test("complete synthetic trace passes every required acceptance gate", () => {
  const report = runRemoteCenterAcceptance(completeEvents());

  assert.equal(report.status, "pass");
  assert.equal(report.complete, true);
  assert.deepEqual(Object.keys(report.evidence), REQUIRED_EVIDENCE);
  assert.deepEqual(report.evidence, Object.fromEntries(REQUIRED_EVIDENCE.map((key) => [key, true])));
  assert.deepEqual(report.missing_evidence, []);
  assert.deepEqual(report.violations, []);
  assert.ok(Object.values(report.cleanup).every(Boolean));
  assert.equal(isPrivacySafeReport(report), true);
});

test("the same injected trace produces byte-identical deterministic output", () => {
  const first = JSON.stringify(runRemoteCenterAcceptance(completeEvents()));
  const second = JSON.stringify(runRemoteCenterAcceptance(completeEvents()));
  assert.equal(second, first);
});

test("default state is disabled, listener-free, and resource-free", () => {
  const machine = new RemoteCenterAcceptanceMachine();
  machine.consume({ type: "snapshot_defaults" });
  const report = machine.report();

  assert.equal(report.evidence.default_off, true);
  assert.equal(report.complete, false);
  assert.ok(report.missing_evidence.includes("outbound_only"));
});

test("an inbound connection attempt is rejected and can never prove outbound-only", () => {
  const events = completeEvents();
  const connection = events.find((event) => event.type === "connect");
  connection.direction = "inbound";

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.equal(report.evidence.outbound_only, false);
  assert.ok(report.violations.includes("inbound_transport_attempt"));
});

test("unrelated-network evidence requires a causally completed roundtrip", () => {
  const events = completeEvents().filter((event) => event.type !== "response_complete");
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.equal(report.evidence.unrelated_network_roundtrip, false);
  assert.ok(report.violations.includes("state_transition_invalid"));
});

test("each Pin, relay, and Mac restart is fenced and recovered by a later roundtrip", () => {
  const report = runRemoteCenterAcceptance(completeEvents());
  assert.equal(report.evidence.pin_restart_recovered, true);
  assert.equal(report.evidence.vps_restart_recovered, true);
  assert.equal(report.evidence.mac_restart_recovered, true);

  for (const [node, evidence] of [
    ["pin", "pin_restart_recovered"],
    ["vps", "vps_restart_recovered"],
    ["mac", "mac_restart_recovered"],
  ]) {
    const events = completeEvents();
    removeFirst(events, (event) => event.type === "restart" && event.node === node);
    const incomplete = runRemoteCenterAcceptance(events);
    assert.equal(incomplete.complete, false, node);
    assert.equal(incomplete.evidence[evidence], false, node);
  }
});

test("Wi-Fi to cellular handoff needs a fresh generation and post-handoff roundtrip", () => {
  const events = completeEvents();
  removeFirst(events, (event) => event.type === "handoff");
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.equal(report.evidence.wifi_cellular_handoff_recovered, false);
  assert.ok(report.violations.includes("generation_mismatch"));
});

test("backoff proof reaches and repeats the cap with exact virtual deadlines", () => {
  const report = runRemoteCenterAcceptance(completeEvents());
  assert.equal(report.evidence.bounded_backoff, true);

  const events = completeEvents();
  const firstAdvance = events.find(
    (event) => event.type === "advance" && event.ms === REMOTE_CENTER_CONTRACT.backoffBaseMs,
  );
  firstAdvance.ms += 1;
  const incomplete = runRemoteCenterAcceptance(events);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.evidence.bounded_backoff, false);
  assert.ok(incomplete.violations.includes("retry_timing_invalid"));
});

test("omitting the backoff exercise leaves only that proof absent", () => {
  const events = completeEvents();
  events.splice(3, REMOTE_CENTER_CONTRACT.backoffProofDelaysMs.length * 3);
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.evidence.bounded_backoff, false);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missing_evidence, ["bounded_backoff"]);
  assert.deepEqual(report.violations, []);
});

test("backoff delays from different nodes cannot be spliced into one proof", () => {
  const events = completeEvents();
  const cycle = (node, delay) => [
    {
      type: "connect_failure",
      node,
      node_generation: 1,
      relay_generation: 1,
      direction: "outbound",
    },
    { type: "advance", ms: delay },
    {
      type: "retry",
      node,
      node_generation: 1,
      relay_generation: 1,
    },
  ];
  events.splice(
    3,
    REMOTE_CENTER_CONTRACT.backoffProofDelaysMs.length * 3,
    ...cycle("mac", 100),
    ...cycle("mac", 200),
    ...cycle("pin", 100),
    ...cycle("pin", 200),
    ...cycle("pin", 400),
    ...cycle("mac", 400),
  );

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.equal(report.evidence.bounded_backoff, false);
  assert.deepEqual(report.missing_evidence, ["bounded_backoff"]);
  assert.deepEqual(report.violations, []);
});

test("a healthy endpoint with a silent event stream is failed and then recovered", () => {
  const report = runRemoteCenterAcceptance(completeEvents());
  assert.equal(report.evidence.hung_stream_detected_despite_health, true);

  const events = completeEvents();
  removeFirst(events, (event) => event.type === "health" && event.healthy === true);
  const incomplete = runRemoteCenterAcceptance(events);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.evidence.hung_stream_detected_despite_health, false);
});

test("a hung-stream recovery cannot overlap an unfinished handoff recovery", () => {
  const events = completeEvents();
  removeFirst(
    events,
    (event) =>
      event.type === "response_complete" &&
      event.request === "r5",
  );
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.equal(report.evidence.wifi_cellular_handoff_recovered, false);
  assert.equal(report.evidence.hung_stream_detected_despite_health, false);
  assert.ok(report.violations.includes("state_transition_invalid"));
});

test("a late stream event from the pre-timeout generation is rejected", () => {
  const report = runRemoteCenterAcceptance(completeEvents());
  assert.equal(report.evidence.stale_generation_rejected, true);

  const events = completeEvents();
  const staleIndex = findAfter(
    events,
    "liveness_check",
    (event) =>
      event.type === "stream_activity" &&
      event.node === "mac" &&
      event.node_generation === 2 &&
      event.relay_generation === 2,
  );
  events.splice(staleIndex, 1);
  const incomplete = runRemoteCenterAcceptance(events);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.evidence.stale_generation_rejected, false);
  assert.deepEqual(incomplete.violations, []);
});

test("a stale liveness check cannot tear down the replacement generation", () => {
  const events = completeEvents();
  const insertion = events.findIndex(
    (event) => event.type === "issue_session" && event.session === "s5",
  );
  assert.notEqual(insertion, -1);
  events.splice(
    insertion,
    0,
    {
      type: "health",
      node: "mac",
      node_generation: 2,
      relay_generation: 2,
      healthy: true,
    },
    { type: "advance", ms: REMOTE_CENTER_CONTRACT.streamTimeoutMs + 1 },
    {
      type: "liveness_check",
      node: "mac",
      node_generation: 1,
      relay_generation: 2,
    },
  );

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, true);
  assert.deepEqual(report.violations, []);
});

test("replay, explicit revocation, and forbidden-route probes are independent fail-closed gates", () => {
  const cases = [
    ["probe_replay", "replay_rejected"],
    ["probe_revoked", "revoked_session_rejected"],
    ["probe_forbidden_route", "forbidden_route_unreachable"],
  ];

  for (const [type, evidence] of cases) {
    const events = completeEvents();
    removeFirst(events, (event) => event.type === type);
    const report = runRemoteCenterAcceptance(events);
    assert.equal(report.complete, false, type);
    assert.equal(report.evidence[evidence], false, type);
    assert.ok(report.missing_evidence.includes(evidence), type);
  }
});

test("rejection gates require an explicit no-forward, no-side-effect observation", () => {
  const cases = [
    ["replay", "outcome", "accepted", "replay_rejected"],
    ["revoked", "side_effects", true, "revoked_session_rejected"],
    ["forbidden_route", "forwarded", true, "forbidden_route_unreachable"],
  ];

  for (const [probe, field, value, evidence] of cases) {
    const events = completeEvents();
    const result = events.find(
      (event) => event.type === "probe_result" && event.probe === probe,
    );
    assert.ok(result, probe);
    result[field] = value;
    const report = runRemoteCenterAcceptance(events);
    assert.equal(report.complete, false, probe);
    assert.equal(report.evidence[evidence], false, probe);
    assert.ok(report.violations.includes("rejection_observation_invalid"), probe);
  }
});

test("a rejection observation must immediately follow its matching probe", () => {
  const events = completeEvents();
  removeFirst(
    events,
    (event) => event.type === "probe_result" && event.probe === "replay",
  );
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.equal(report.evidence.replay_rejected, false);
  assert.ok(report.violations.includes("rejection_observation_missing"));
});

test("revocation cancels an in-flight request and rejects every later stage", () => {
  const events = completeEvents();
  const revokeIndex = events.findIndex(
    (event) => event.type === "revoke_session" && event.session === "s1",
  );
  assert.notEqual(revokeIndex, -1);
  const generations = {
    pin_generation: 1,
    mac_generation: 1,
    relay_generation: 1,
  };
  events.splice(revokeIndex, 0, {
    type: "request_start",
    request: "r8",
    session: "s1",
    nonce: "n10",
    route: REMOTE_CENTER_CONTRACT.routes.allowed,
    ...generations,
  });
  const shiftedRevoke = events.findIndex(
    (event) => event.type === "revoke_session" && event.session === "s1",
  );
  events.splice(
    shiftedRevoke + 1,
    0,
    { type: "request_forward", request: "r8", ...generations },
    { type: "response_start", request: "r8", ...generations },
    { type: "response_complete", request: "r8", ...generations },
  );

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.ok(report.violations.includes("pending_work_interrupted"));
  assert.ok(report.violations.includes("roundtrip_sequence_invalid"));
  assert.equal(report.evidence.revoked_session_rejected, true);
});

test("restart, handoff, hung-stream recovery, outage, and revocation flag interrupted work", () => {
  const cases = [
    {
      boundary: (event) => event.type === "restart" && event.node === "pin",
      session: "s2",
      generations: [1, 1, 1],
    },
    {
      boundary: (event) => event.type === "handoff",
      session: "s5",
      generations: [2, 2, 2],
    },
    {
      boundary: (event) => event.type === "liveness_check",
      session: "s6",
      generations: [3, 2, 2],
    },
    {
      boundary: (event) => event.type === "relay_down",
      session: "s7",
      generations: [3, 3, 2],
    },
    {
      boundary: (event) => event.type === "revoke_session" && event.session === "s1",
      session: "s1",
      generations: [1, 1, 1],
    },
  ];

  for (const fixture of cases) {
    const events = completeEvents();
    const boundaryIndex = events.findIndex(fixture.boundary);
    assert.notEqual(boundaryIndex, -1);
    const [pinGeneration, macGeneration, relayGeneration] = fixture.generations;
    events.splice(boundaryIndex, 0, {
      type: "request_start",
      request: "r8",
      session: fixture.session,
      nonce: "n10",
      route: REMOTE_CENTER_CONTRACT.routes.allowed,
      pin_generation: pinGeneration,
      mac_generation: macGeneration,
      relay_generation: relayGeneration,
    });
    const report = runRemoteCenterAcceptance(events);
    assert.equal(report.complete, false, fixture.session);
    assert.ok(report.violations.includes("pending_work_interrupted"), fixture.session);
  }
});

test("automatic generation invalidation cannot masquerade as explicit revocation", () => {
  const events = completeEvents().filter(
    (event) =>
      !(event.type === "revoke_session" && event.session === "s1") &&
      event.type !== "probe_revoked" &&
      !(event.type === "probe_result" && event.probe === "revoked"),
  );
  const insertion = events.findIndex(
    (event) => event.type === "issue_session" && event.session === "s3",
  );
  assert.notEqual(insertion, -1);
  events.splice(
    insertion,
    0,
    {
      type: "probe_revoked",
      session: "s1",
      nonce: "n2",
      route: REMOTE_CENTER_CONTRACT.routes.allowed,
      pin_generation: 2,
      mac_generation: 1,
      relay_generation: 1,
    },
    {
      type: "probe_result",
      probe: "revoked",
      outcome: "rejected",
      forwarded: false,
      side_effects: false,
    },
  );

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.equal(report.evidence.revoked_session_rejected, false);
  assert.ok(report.violations.includes("request_authority_invalid"));
});

test("relay outage proof requires local success while remote transport is down and later recovery", () => {
  const events = completeEvents();
  removeFirst(events, (event) => event.type === "local_probe");
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.equal(report.evidence.relay_outage_independent, false);
  assert.ok(report.missing_evidence.includes("relay_outage_independent"));
});

test("cleanup closes every active connection, session, timer, and pending request exactly once", () => {
  const full = runRemoteCenterAcceptance(completeEvents());
  assert.ok(Object.values(full.cleanup).every(Boolean));

  const timerMachine = new RemoteCenterAcceptanceMachine();
  for (const event of [
    { type: "snapshot_defaults" },
    { type: "enable" },
    {
      type: "connect_failure",
      node: "pin",
      node_generation: 1,
      relay_generation: 1,
      direction: "outbound",
    },
    { type: "cleanup" },
  ]) {
    timerMachine.consume(event);
  }
  assert.ok(Object.values(timerMachine.report().cleanup).every(Boolean));

  const pendingMachine = new RemoteCenterAcceptanceMachine();
  for (const event of [
    { type: "snapshot_defaults" },
    { type: "enable" },
    {
      type: "connect",
      node: "pin",
      node_generation: 1,
      relay_generation: 1,
      direction: "outbound",
    },
    {
      type: "connect",
      node: "mac",
      node_generation: 1,
      relay_generation: 1,
      direction: "outbound",
    },
    { type: "issue_session", session: "s1" },
    {
      type: "request_start",
      request: "r1",
      session: "s1",
      nonce: "n1",
      route: REMOTE_CENTER_CONTRACT.routes.allowed,
      pin_generation: 1,
      mac_generation: 1,
      relay_generation: 1,
    },
    { type: "cleanup" },
  ]) {
    pendingMachine.consume(event);
  }
  assert.ok(Object.values(pendingMachine.report().cleanup).every(Boolean));
});

test("missing, repeated, or non-terminal cleanup is never accepted", () => {
  const missing = completeEvents();
  missing.pop();
  const missingReport = runRemoteCenterAcceptance(missing);
  assert.equal(missingReport.complete, false);
  assert.equal(missingReport.evidence.exact_cleanup, false);

  const repeated = completeEvents();
  repeated.push({ type: "cleanup" });
  const repeatedReport = runRemoteCenterAcceptance(repeated);
  assert.equal(repeatedReport.complete, false);
  assert.ok(repeatedReport.violations.includes("cleanup_repeated"));

  const nonTerminal = completeEvents();
  nonTerminal.push({ type: "advance", ms: 1 });
  const nonTerminalReport = runRemoteCenterAcceptance(nonTerminal);
  assert.equal(nonTerminalReport.complete, false);
  assert.ok(nonTerminalReport.violations.includes("event_after_cleanup"));
});

test("cleanup cannot erase a newly interrupted recovery after an earlier successful proof", () => {
  const cases = [
    [{ type: "restart", node: "pin" }],
    [{ type: "handoff", node: "pin", network: "wifi_secondary" }],
    [
      {
        type: "health",
        node: "mac",
        node_generation: 3,
        relay_generation: 3,
        healthy: true,
      },
      { type: "advance", ms: REMOTE_CENTER_CONTRACT.streamTimeoutMs + 1 },
      {
        type: "liveness_check",
        node: "mac",
        node_generation: 3,
        relay_generation: 3,
      },
    ],
    [{ type: "relay_down" }],
  ];

  for (const pendingRecovery of cases) {
    const events = completeEvents();
    events.splice(events.length - 1, 0, ...pendingRecovery);
    const report = runRemoteCenterAcceptance(events);
    assert.equal(report.complete, false, pendingRecovery[0].type);
    assert.equal(report.evidence.exact_cleanup, false, pendingRecovery[0].type);
    assert.equal(report.cleanup.recovery_state_cleared, false, pendingRecovery[0].type);
    assert.ok(
      report.violations.includes("cleanup_with_incomplete_recovery"),
      pendingRecovery[0].type,
    );
  }
});

test("cleanup succeeds but acceptance remains incomplete when ordinary work is interrupted", () => {
  const events = completeEvents();
  events.splice(events.length - 1, 0, {
    type: "request_start",
    request: "r8",
    session: "s8",
    nonce: "n10",
    route: REMOTE_CENTER_CONTRACT.routes.allowed,
    pin_generation: 3,
    mac_generation: 3,
    relay_generation: 3,
  });
  const report = runRemoteCenterAcceptance(events);

  assert.equal(report.complete, false);
  assert.ok(Object.values(report.cleanup).every(Boolean));
  assert.equal(report.evidence.exact_cleanup, true);
  assert.ok(report.violations.includes("cleanup_with_incomplete_work"));
});

test("roundtrip stages are causal and cannot be reordered", () => {
  const events = completeEvents();
  const forward = events.findIndex((event) => event.type === "request_forward");
  const response = events.findIndex((event) => event.type === "response_start");
  [events[forward], events[response]] = [events[response], events[forward]];

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.ok(report.violations.includes("roundtrip_sequence_invalid"));
});

test("a current-stage event with a wrong process generation fails closed", () => {
  const events = completeEvents();
  const firstForward = events.find((event) => event.type === "request_forward");
  firstForward.relay_generation += 1;

  const report = runRemoteCenterAcceptance(events);
  assert.equal(report.complete, false);
  assert.ok(report.violations.includes("roundtrip_sequence_invalid"));
});

test("every required evidence field participates in completion", () => {
  const transformations = new Map([
    ["default_off", (events) => removeFirst(events, (event) => event.type === "snapshot_defaults")],
    ["outbound_only", (events) => removeFirst(events, (event) => event.type === "probe_inbound")],
    [
      "unrelated_network_roundtrip",
      (events) => events.filter((event) => event.type !== "response_complete"),
    ],
    [
      "pin_restart_recovered",
      (events) =>
        removeFirst(events, (event) => event.type === "restart" && event.node === "pin"),
    ],
    [
      "vps_restart_recovered",
      (events) =>
        removeFirst(events, (event) => event.type === "restart" && event.node === "vps"),
    ],
    [
      "mac_restart_recovered",
      (events) =>
        removeFirst(events, (event) => event.type === "restart" && event.node === "mac"),
    ],
    [
      "wifi_cellular_handoff_recovered",
      (events) => removeFirst(events, (event) => event.type === "handoff"),
    ],
    [
      "bounded_backoff",
      (events) => {
        events.splice(3, REMOTE_CENTER_CONTRACT.backoffProofDelaysMs.length * 3);
        return events;
      },
    ],
    [
      "stale_generation_rejected",
      (events) => {
        const staleIndex = findAfter(
          events,
          "liveness_check",
          (event) =>
            event.type === "stream_activity" &&
            event.node === "mac" &&
            event.node_generation === 2,
        );
        events.splice(staleIndex, 1);
        return events;
      },
    ],
    [
      "hung_stream_detected_despite_health",
      (events) => removeFirst(events, (event) => event.type === "health"),
    ],
    ["replay_rejected", (events) => removeFirst(events, (event) => event.type === "probe_replay")],
    ["revoked_session_rejected", (events) => removeFirst(events, (event) => event.type === "probe_revoked")],
    [
      "forbidden_route_unreachable",
      (events) => removeFirst(events, (event) => event.type === "probe_forbidden_route"),
    ],
    ["relay_outage_independent", (events) => removeFirst(events, (event) => event.type === "local_probe")],
    ["exact_cleanup", (events) => events.slice(0, -1)],
  ]);

  for (const [evidence, transform] of transformations) {
    const report = runRemoteCenterAcceptance(transform(completeEvents()));
    assert.equal(report.evidence[evidence], false, evidence);
    assert.equal(report.complete, false, evidence);
  }
});

test("event schema accepts only bounded synthetic enums, IDs, generations, and exact keys", () => {
  assert.throws(
    () => validateSyntheticEvent({ type: "unknown", private_note: "do-not-echo" }),
    RemoteCenterInputError,
  );
  assert.throws(
    () => validateSyntheticEvent({ type: "snapshot_defaults", extra: true }),
    RemoteCenterInputError,
  );
  assert.throws(
    () =>
      validateSyntheticEvent({
        type: "connect",
        node: "pin",
        node_generation: 0,
        relay_generation: 1,
        direction: "outbound",
      }),
    RemoteCenterInputError,
  );
  assert.throws(
    () => validateSyntheticEvents(Array(REMOTE_CENTER_CONTRACT.maxEvents + 1).fill({ type: "cleanup" })),
    RemoteCenterInputError,
  );
});

test("stdin document is strict, bounded, and versioned", () => {
  const events = completeEvents();
  assert.deepEqual(parseSyntheticEventDocument(documentFor(events)), events);
  assert.throws(
    () => parseSyntheticEventDocument(JSON.stringify({ schema_version: 2, events })),
    RemoteCenterInputError,
  );
  assert.throws(
    () => parseSyntheticEventDocument(JSON.stringify({ schema_version: 1, events, extra: true })),
    RemoteCenterInputError,
  );
  assert.throws(
    () => parseSyntheticEventDocument(Buffer.alloc(REMOTE_CENTER_CONTRACT.maxInputBytes + 1)),
    RemoteCenterInputError,
  );
});

test("CLI modes are explicit and cannot be combined", () => {
  assert.deepEqual(parseCliArgs(["--self-check"]), { mode: "self-check" });
  assert.deepEqual(parseCliArgs(["--stdin"]), { mode: "stdin" });
  assert.deepEqual(parseCliArgs(["--help"]), { mode: "help" });
  assert.throws(() => parseCliArgs([]), RemoteCenterInputError);
  assert.throws(() => parseCliArgs(["--stdin", "--self-check"]), RemoteCenterInputError);
});

test("CLI returns zero only for complete evidence and nonzero for a missing cleanup", () => {
  let stdout = "";
  let stderr = "";
  const completeCode = main(["--self-check"], {
    writeStdout(value) {
      stdout += value;
    },
    writeStderr(value) {
      stderr += value;
    },
  });
  assert.equal(completeCode, 0);
  assert.equal(JSON.parse(stdout).status, "pass");
  assert.equal(stderr, "");

  const events = completeEvents();
  events.pop();
  stdout = "";
  const incompleteCode = main(["--stdin"], {
    readStdin: () => documentFor(events),
    writeStdout(value) {
      stdout += value;
    },
    writeStderr(value) {
      stderr += value;
    },
  });
  const report = JSON.parse(stdout);
  assert.equal(incompleteCode, 1);
  assert.equal(report.status, "incomplete");
  assert.equal(report.evidence.exact_cleanup, false);
});

test("invalid private-looking input is never reflected in stdout or stderr", () => {
  const marker = "PRIVATE-MARKER-SHOULD-NOT-APPEAR";
  let stdout = "";
  let stderr = "";
  const code = main(["--stdin"], {
    readStdin: () =>
      JSON.stringify({
        schema_version: 1,
        events: [{ type: "snapshot_defaults", private_note: marker }],
      }),
    writeStdout(value) {
      stdout += value;
    },
    writeStderr(value) {
      stderr += value;
    },
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).status, "incomplete");
  assert.doesNotMatch(stdout, new RegExp(marker));
  assert.doesNotMatch(stderr, new RegExp(marker));
  assert.equal(stderr, "remote-center-acceptance: invalid synthetic evidence\n");
});

test("reports omit all request, session, nonce, route, generation, and raw-event values", () => {
  const serialized = JSON.stringify(runRemoteCenterAcceptance(completeEvents()));
  for (const forbidden of [
    '"r1"',
    '"s1"',
    '"n1"',
    '"center_rpc"',
    '"forbidden_admin"',
    '"wifi_primary"',
    '"wifi_secondary"',
    '"node_generation"',
    '"relay_generation"',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("harness source has no network or subprocess capability", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./remote-center-acceptance.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']node:(?:net|http|https|tls|dgram|child_process)["']/);
  assert.doesNotMatch(
    source,
    /(?<![.\w])(?:spawn|spawnSync|exec|execFile|fork)\s*\(/,
  );
});
