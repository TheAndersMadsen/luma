from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from verify.parity.scorer import (
    GATE_NAMES,
    TraceValidationError,
    load_clone_trace,
    load_expected_trace,
    main,
    score,
)


FIXTURES = Path(__file__).parent / "fixtures"


class ParityScorerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.expected_path = FIXTURES / "expected-success.json"
        self.clone_path = FIXTURES / "clone-success.json"

    def test_all_hard_gates_pass(self) -> None:
        report = score(
            load_expected_trace(self.expected_path), load_clone_trace(self.clone_path)
        )

        self.assertTrue(report.passed)
        self.assertEqual(tuple(report.gates), GATE_NAMES)
        self.assertTrue(all(result.passed for result in report.gates.values()))
        self.assertEqual(report.as_dict()["scenario_id"], "tool-success")

    def test_deliberately_broken_fixture_fails_every_gate(self) -> None:
        report = score(
            load_expected_trace(self.expected_path),
            load_clone_trace(FIXTURES / "clone-all-gates-fail.json"),
        )

        self.assertFalse(report.passed)
        self.assertTrue(all(not result.passed for result in report.gates.values()))

    def test_timing_windows_are_inclusive(self) -> None:
        clone = json.loads(self.clone_path.read_text(encoding="utf-8"))
        clone["events"][0]["at_ms"] = 0
        clone["events"][1]["at_ms"] = 100
        clone["events"][2]["at_ms"] = 1500

        with self._json_file(clone) as path:
            report = score(load_expected_trace(self.expected_path), load_clone_trace(path))

        self.assertTrue(report.gates["timing"].passed)

    def test_unknown_content_field_is_rejected(self) -> None:
        clone = json.loads(self.clone_path.read_text(encoding="utf-8"))
        clone["events"][0]["transcript"] = "not permitted"

        with self._json_file(clone) as path:
            with self.assertRaises(TraceValidationError) as raised:
                load_clone_trace(path)

        self.assertIn("unsupported_fields=1", str(raised.exception))
        self.assertNotIn("transcript", str(raised.exception))
        self.assertNotIn("not permitted", str(raised.exception))

    def test_free_form_label_is_rejected(self) -> None:
        clone = json.loads(self.clone_path.read_text(encoding="utf-8"))
        clone["events"][0]["semantics"] = ["arbitrary_sentence"]

        with self._json_file(clone) as path:
            with self.assertRaisesRegex(TraceValidationError, "fixed vocabulary"):
                load_clone_trace(path)

    def test_expected_contract_requires_final_event_at_end(self) -> None:
        expected = json.loads(self.expected_path.read_text(encoding="utf-8"))
        expected["events"][-1]["final"] = False

        with self._json_file(expected) as path:
            with self.assertRaisesRegex(TraceValidationError, "exactly one final event"):
                load_expected_trace(path)

    def test_mismatched_scenario_is_invalid_comparison(self) -> None:
        clone = json.loads(self.clone_path.read_text(encoding="utf-8"))
        clone["scenario_id"] = "different-scenario"

        with self._json_file(clone) as path:
            with self.assertRaisesRegex(TraceValidationError, "do not match"):
                score(load_expected_trace(self.expected_path), load_clone_trace(path))

    def test_cli_exit_codes_and_report_are_deterministic(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = main([str(self.expected_path), str(self.clone_path), "--compact"])

        self.assertEqual(exit_code, 0)
        parsed = json.loads(output.getvalue())
        self.assertTrue(parsed["passed"])
        self.assertEqual(list(parsed["gates"]), sorted(GATE_NAMES))

        with contextlib.redirect_stdout(io.StringIO()):
            fail_code = main(
                [
                    str(self.expected_path),
                    str(FIXTURES / "clone-all-gates-fail.json"),
                    "--compact",
                ]
            )
        self.assertEqual(fail_code, 1)

    @contextlib.contextmanager
    def _json_file(self, value: dict[str, object]):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            yield path


if __name__ == "__main__":
    unittest.main()
