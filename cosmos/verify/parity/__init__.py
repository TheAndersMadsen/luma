"""Content-free behavioral parity scoring."""

from .scorer import (
    GateResult,
    ParityReport,
    TraceValidationError,
    load_clone_trace,
    load_expected_trace,
    score,
)

__all__ = [
    "GateResult",
    "ParityReport",
    "TraceValidationError",
    "load_clone_trace",
    "load_expected_trace",
    "score",
]
