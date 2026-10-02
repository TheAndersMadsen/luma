#!/usr/bin/env python3
"""Score synthetic clone traces against a content-free expected contract.

This module only reads local JSON files. Its deliberately closed schema has no
field capable of containing an utterance, response body, prompt, or raw payload.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
MAX_INPUT_BYTES = 128 * 1024
MAX_EVENTS = 256
TOKEN_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")

ACTIONS = frozenset(
    {
        "session.open",
        "intent.accept",
        "tool.dispatch",
        "tool.complete",
        "response.finalize",
        "session.recover",
        "session.close",
    }
)
STATUSES = frozenset(
    {"pending", "ok", "retryable_error", "terminal_error", "cancelled", "timeout"}
)
SEMANTIC_LABELS = frozenset(
    {
        "acknowledges",
        "answers",
        "asks_clarification",
        "confirms_recovery",
        "no_result",
        "reports_failure",
        "safe_refusal",
        "uses_tool",
    }
)
STYLE_LABELS = frozenset(
    {
        "brief",
        "conversational",
        "direct",
        "error_clear",
        "final",
        "neutral",
        "no_repetition",
    }
)
RECOVERY_LABELS = frozenset({"none", "retry", "fallback", "clarify", "abort", "resume"})
GATE_NAMES = (
    "action",
    "status",
    "ordering_finality",
    "semantics_style",
    "timing",
    "recovery",
)


class TraceValidationError(ValueError):
    """Raised when a file does not satisfy the content-free trace schema."""


@dataclass(frozen=True)
class TimingWindow:
    min_ms: int
    max_ms: int


@dataclass(frozen=True)
class ExpectedEvent:
    event_id: str
    action: str
    status: str
    final: bool
    semantics: frozenset[str]
    style: frozenset[str]
    timing: TimingWindow
    recovery: str


@dataclass(frozen=True)
class CloneEvent:
    event_id: str
    action: str
    status: str
    final: bool
    semantics: frozenset[str]
    style: frozenset[str]
    at_ms: int
    recovery: str


@dataclass(frozen=True)
class ExpectedTrace:
    scenario_id: str
    events: tuple[ExpectedEvent, ...]


@dataclass(frozen=True)
class CloneTrace:
    scenario_id: str
    events: tuple[CloneEvent, ...]


@dataclass(frozen=True)
class Failure:
    code: str
    event_id: str | None = None
    expected: str | int | bool | list[str] | None = None
    actual: str | int | bool | list[str] | None = None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"code": self.code}
        if self.event_id is not None:
            value["event_id"] = self.event_id
        if self.expected is not None:
            value["expected"] = self.expected
        if self.actual is not None:
            value["actual"] = self.actual
        return value


@dataclass(frozen=True)
class GateResult:
    passed: bool
    failures: tuple[Failure, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failures": [failure.as_dict() for failure in self.failures],
        }


@dataclass(frozen=True)
class ParityReport:
    scenario_id: str
    passed: bool
    gates: Mapping[str, GateResult]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "scenario_id": self.scenario_id,
            "passed": self.passed,
            "gates": {name: self.gates[name].as_dict() for name in GATE_NAMES},
        }


def _read_json(path: Path) -> Mapping[str, Any]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise TraceValidationError(f"cannot read trace file: {path}") from exc
    if size > MAX_INPUT_BYTES:
        raise TraceValidationError(f"trace exceeds {MAX_INPUT_BYTES} bytes")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TraceValidationError(f"invalid local JSON trace: {path}") from exc
    return _mapping(value, "trace")


def _mapping(value: Any, context: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise TraceValidationError(f"{context} must be an object")
    return value


def _exact_keys(value: Mapping[str, Any], allowed: set[str], context: str) -> None:
    actual = set(value)
    missing = sorted(allowed - actual)
    extra = sorted(actual - allowed)
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"missing={','.join(missing)}")
        if extra:
            # Never reflect an attacker-controlled key into logs or reports: a
            # rejected key could itself have been used to smuggle content.
            parts.append(f"unsupported_fields={len(extra)}")
        raise TraceValidationError(f"{context} fields invalid ({'; '.join(parts)})")


def _integer(value: Any, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TraceValidationError(f"{context} must be a non-negative integer")
    return value


def _boolean(value: Any, context: str) -> bool:
    if not isinstance(value, bool):
        raise TraceValidationError(f"{context} must be a boolean")
    return value


def _token(value: Any, context: str) -> str:
    if not isinstance(value, str) or not TOKEN_RE.fullmatch(value):
        raise TraceValidationError(f"{context} must be a bounded lowercase token")
    return value


def _enum(value: Any, allowed: frozenset[str], context: str) -> str:
    token = _token(value, context)
    if token not in allowed:
        raise TraceValidationError(f"{context} is not in the fixed vocabulary")
    return token


def _labels(value: Any, allowed: frozenset[str], context: str) -> frozenset[str]:
    if not isinstance(value, list) or not value:
        raise TraceValidationError(f"{context} must be a non-empty label list")
    labels = [_enum(item, allowed, f"{context}[]") for item in value]
    if len(labels) != len(set(labels)):
        raise TraceValidationError(f"{context} contains duplicate labels")
    return frozenset(labels)


def _trace_header(value: Mapping[str, Any], kind: str) -> tuple[str, Sequence[Any]]:
    _exact_keys(value, {"schema_version", "kind", "scenario_id", "events"}, "trace")
    if value["schema_version"] != SCHEMA_VERSION:
        raise TraceValidationError(f"schema_version must be {SCHEMA_VERSION}")
    if value["kind"] != kind:
        raise TraceValidationError(f"kind must be {kind}")
    scenario_id = _token(value["scenario_id"], "scenario_id")
    events = value["events"]
    if not isinstance(events, list) or not events:
        raise TraceValidationError("events must be a non-empty list")
    if len(events) > MAX_EVENTS:
        raise TraceValidationError(f"events exceeds maximum of {MAX_EVENTS}")
    return scenario_id, events


def _common_event(value: Any, context: str, allowed_keys: set[str]) -> tuple[Any, ...]:
    event = _mapping(value, context)
    _exact_keys(event, allowed_keys, context)
    return (
        _token(event["event_id"], f"{context}.event_id"),
        _enum(event["action"], ACTIONS, f"{context}.action"),
        _enum(event["status"], STATUSES, f"{context}.status"),
        _boolean(event["final"], f"{context}.final"),
        _labels(event["semantics"], SEMANTIC_LABELS, f"{context}.semantics"),
        _labels(event["style"], STYLE_LABELS, f"{context}.style"),
        _enum(event["recovery"], RECOVERY_LABELS, f"{context}.recovery"),
    )


def _unique_event_ids(events: Iterable[ExpectedEvent | CloneEvent]) -> None:
    ids = [event.event_id for event in events]
    if len(ids) != len(set(ids)):
        raise TraceValidationError("event_id values must be unique")


def load_expected_trace(path: str | Path) -> ExpectedTrace:
    """Load and validate a local synthetic expected trace."""

    value = _read_json(Path(path))
    scenario_id, raw_events = _trace_header(value, "synthetic_expected")
    events: list[ExpectedEvent] = []
    allowed = {
        "event_id",
        "action",
        "status",
        "final",
        "semantics",
        "style",
        "timing",
        "recovery",
    }
    for index, raw_event in enumerate(raw_events):
        context = f"events[{index}]"
        event_id, action, status, final, semantics, style, recovery = _common_event(
            raw_event, context, allowed
        )
        raw_timing = _mapping(raw_event["timing"], f"{context}.timing")
        _exact_keys(raw_timing, {"min_ms", "max_ms"}, f"{context}.timing")
        min_ms = _integer(raw_timing["min_ms"], f"{context}.timing.min_ms")
        max_ms = _integer(raw_timing["max_ms"], f"{context}.timing.max_ms")
        if min_ms > max_ms:
            raise TraceValidationError(f"{context}.timing min_ms exceeds max_ms")
        events.append(
            ExpectedEvent(
                event_id,
                action,
                status,
                final,
                semantics,
                style,
                TimingWindow(min_ms, max_ms),
                recovery,
            )
        )
    _unique_event_ids(events)
    if sum(event.final for event in events) != 1 or not events[-1].final:
        raise TraceValidationError("expected trace must have exactly one final event, at the end")
    return ExpectedTrace(scenario_id, tuple(events))


def load_clone_trace(path: str | Path) -> CloneTrace:
    """Load and validate a local synthetic clone observation trace."""

    value = _read_json(Path(path))
    scenario_id, raw_events = _trace_header(value, "synthetic_clone")
    events: list[CloneEvent] = []
    allowed = {
        "event_id",
        "action",
        "status",
        "final",
        "semantics",
        "style",
        "at_ms",
        "recovery",
    }
    for index, raw_event in enumerate(raw_events):
        context = f"events[{index}]"
        event_id, action, status, final, semantics, style, recovery = _common_event(
            raw_event, context, allowed
        )
        events.append(
            CloneEvent(
                event_id,
                action,
                status,
                final,
                semantics,
                style,
                _integer(raw_event["at_ms"], f"{context}.at_ms"),
                recovery,
            )
        )
    _unique_event_ids(events)
    return CloneTrace(scenario_id, tuple(events))


def _result(failures: list[Failure]) -> GateResult:
    return GateResult(not failures, tuple(failures))


def _missing(event_id: str) -> Failure:
    return Failure("missing_event", event_id=event_id)


def score(expected: ExpectedTrace, clone: CloneTrace) -> ParityReport:
    """Compare all six hard gates; any failed gate fails the scenario."""

    if expected.scenario_id != clone.scenario_id:
        raise TraceValidationError("scenario_id values do not match")

    expected_by_id = {event.event_id: event for event in expected.events}
    clone_by_id = {event.event_id: event for event in clone.events}

    action_failures: list[Failure] = []
    status_failures: list[Failure] = []
    semantic_failures: list[Failure] = []
    timing_failures: list[Failure] = []
    recovery_failures: list[Failure] = []

    for event_id, expected_event in expected_by_id.items():
        clone_event = clone_by_id.get(event_id)
        if clone_event is None:
            for failures in (
                action_failures,
                status_failures,
                semantic_failures,
                timing_failures,
                recovery_failures,
            ):
                failures.append(_missing(event_id))
            continue
        if expected_event.action != clone_event.action:
            action_failures.append(
                Failure(
                    "action_mismatch", event_id, expected_event.action, clone_event.action
                )
            )
        if expected_event.status != clone_event.status:
            status_failures.append(
                Failure(
                    "status_mismatch", event_id, expected_event.status, clone_event.status
                )
            )
        if expected_event.semantics != clone_event.semantics:
            semantic_failures.append(
                Failure(
                    "semantics_mismatch",
                    event_id,
                    sorted(expected_event.semantics),
                    sorted(clone_event.semantics),
                )
            )
        if expected_event.style != clone_event.style:
            semantic_failures.append(
                Failure(
                    "style_mismatch",
                    event_id,
                    sorted(expected_event.style),
                    sorted(clone_event.style),
                )
            )
        if not expected_event.timing.min_ms <= clone_event.at_ms <= expected_event.timing.max_ms:
            timing_failures.append(
                Failure(
                    "outside_timing_window",
                    event_id,
                    f"{expected_event.timing.min_ms}..{expected_event.timing.max_ms}",
                    clone_event.at_ms,
                )
            )
        if expected_event.recovery != clone_event.recovery:
            recovery_failures.append(
                Failure(
                    "recovery_mismatch",
                    event_id,
                    expected_event.recovery,
                    clone_event.recovery,
                )
            )

    ordering_failures: list[Failure] = []
    expected_order = [event.event_id for event in expected.events]
    clone_order = [event.event_id for event in clone.events]
    if expected_order != clone_order:
        ordering_failures.append(
            Failure("event_order_mismatch", expected=expected_order, actual=clone_order)
        )
    if sum(event.final for event in clone.events) != 1 or not clone.events[-1].final:
        ordering_failures.append(Failure("invalid_clone_finality"))
    for event_id, expected_event in expected_by_id.items():
        clone_event = clone_by_id.get(event_id)
        if clone_event is not None and expected_event.final != clone_event.final:
            ordering_failures.append(
                Failure(
                    "finality_mismatch",
                    event_id,
                    expected_event.final,
                    clone_event.final,
                )
            )
    if any(
        later.at_ms < earlier.at_ms
        for earlier, later in zip(clone.events, clone.events[1:])
    ):
        ordering_failures.append(Failure("non_monotonic_timing"))

    gates = {
        "action": _result(action_failures),
        "status": _result(status_failures),
        "ordering_finality": _result(ordering_failures),
        "semantics_style": _result(semantic_failures),
        "timing": _result(timing_failures),
        "recovery": _result(recovery_failures),
    }
    return ParityReport(expected.scenario_id, all(gate.passed for gate in gates.values()), gates)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Score two local, content-free synthetic event traces."
    )
    parser.add_argument("expected", type=Path, help="synthetic expected JSON")
    parser.add_argument("clone", type=Path, help="synthetic clone observation JSON")
    parser.add_argument("--compact", action="store_true", help="emit one-line JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = score(load_expected_trace(args.expected), load_clone_trace(args.clone))
    except TraceValidationError as exc:
        print(f"invalid parity input: {exc}", file=sys.stderr)
        return 2
    indent = None if args.compact else 2
    print(json.dumps(report.as_dict(), indent=indent, sort_keys=True))
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
