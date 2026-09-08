import dataclasses
import hashlib
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cosmos_linux import actions as A, commands as C, policy as P, viewstate
from cosmos_linux.native import Features
from cosmos_linux.controller import COMMAND_DEADLINE

from .fixtures import FakeSurface, TASK_ID, confirmation, open_task, policy_document, revoked
from .test_device_actions import DeviceActionHarness
from .test_policy import deliver, document


def entry(**changes):
    return {"id": "check", "label": "Check project", "argv": ["/usr/bin/true"],
            "cwd": "/tmp", "mutates": False, "budgetMs": 60000, **changes}


def section(*entries, **changes):
    return {"revision": 1, "maximumClass": "shared_room", "offerOutputToCognition": False,
            "entries": list(entries or [entry()]), **changes}


def operation(value):
    return {"kind": "run", "entryId": value.id, "label": value.label, "entryDigest": value.entry_digest,
            "argvDigest": value.argv_digest, "mutates": value.mutates, "budgetMs": value.budget_ms}


class CommandPolicyTest(unittest.TestCase):
    def test_commands_only_and_independent_permission_ceilings(self):
        value = document(commands=section())
        del value["actions"]
        policy = deliver(value)
        self.assertIsNone(policy.revision)
        self.assertEqual(policy.commands_revision, 1)
        self.assertFalse(policy.allows_class("public"))
        self.assertTrue(policy.allows_class("shared_room", run=True))
        self.assertFalse(policy.allows_class("private", run=True))
        self.assertFalse(policy.offer_output_to_cognition)

    def test_one_invalid_command_refuses_the_whole_permission(self):
        for change in ({"id": ""}, {"id": "Check"}, {"id": "x" * 49}, {"label": "x" * 121},
                       {"argv": []}, {"argv": ["/bin/true"] * 13}, {"argv": ["/bin/true", "x\0"]},
                       {"argv": ["../bin/true"]}, {"argv": ["/bin/true", "x" * 257]}, {"cwd": "relative"},
                       {"cwd": "/tmp/../etc"}, {"budgetMs": True}, {"budgetMs": 0}, {"budgetMs": 900001},
                       {"mutates": True}, {"mutates": 0}, {"extra": 1}):
            with self.subTest(change=change), self.assertRaises(P.InvalidPolicy):
                deliver(document(commands=section(entry(), entry(**{"id": "other", **change}))))
        for changes in ({"entries": []}, {"entries": [entry()] * 9}, {"entries": [entry(), entry()]},
                        {"offerOutputToCognition": "yes"}, {"maximumClass": "sensitive"}, {"revision": False}):
            with self.subTest(changes=changes), self.assertRaises(P.InvalidPolicy):
                deliver(document(commands=section(**changes)))

    def test_digests_match_the_independent_shared_wire_vectors(self):
        fixture = Path(__file__).resolve().parents[3] / "contracts/fixtures/ambiance-device-action-digests-v1.json"
        vectors = {v["name"]: v for v in json.loads(fixture.read_text())["cases"]}
        values = vectors["command-argv"]["canonical"]
        value = P.CommandEntry("project-tests", "Project tests", tuple(values[2]), values[3], True, 900000)
        self.assertEqual(value.argv_digest, vectors["command-argv"]["digest"])
        self.assertEqual(value.entry_digest, vectors["command-entry"]["digest"])

    def test_binding_rejects_any_change_to_the_owner_entry_or_reported_operation(self):
        policy = deliver(document(commands=section()))
        value = policy.command("check")
        from cosmos_linux.events import decode
        from .fixtures import encode, snapshot
        def plan(op):
            return A.plan(decode(encode(snapshot("task", connected=True, task=open_task(op, channel="action.run", privacy="shared_room")))).task, policy)
        self.assertEqual(plan(operation(value)).command, value)
        for field, wrong in (("argvDigest", "f" * 64), ("entryDigest", "f" * 64), ("budgetMs", 1),
                             ("mutates", True), ("label", "Other label")):
            self.assertEqual(plan({**operation(value), field: wrong}).refusal, "entry_changed")
        self.assertEqual(plan({**operation(value), "entryId": "missing"}).refusal, "not_permitted")


class ProcessTest(unittest.TestCase):
    def run_entry(self, source, *, budget=2000, cancel=False):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "task.py"
            script.write_text(source)
            value = P.CommandEntry("check", "Check", (sys.executable, str(script)), temporary, False, budget)
            runner = C.CommandRunner()
            self.assertTrue(runner.start(value))
            if cancel:
                runner.stop()
            deadline = time.monotonic() + 5
            while runner.busy and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(runner.busy)
            result = runner.poll()
            self.assertIsNotNone(result)
            self.assertIsNone(runner.poll())
            return result

    def test_observed_nonzero_exit_is_completed_execution_with_exit_evidence(self):
        report = self.run_entry("import sys\nprint('one failure')\nsys.exit(3)\n")
        self.assertEqual(report["outcome"], "completed")
        self.assertEqual(report["evidence"]["exitCode"], 3)
        self.assertEqual(report["output"], "one failure\n")

    def test_output_is_bounded_without_blocking_and_terminal_bytes_are_data(self):
        report = self.run_entry("import os\nos.write(1, b'HEAD\\n' + b'x'*500000 + b'\\xff\\x1b[31mTAIL\\n')\n")
        self.assertEqual(report["outcome"], "completed")
        self.assertTrue(report["output"].startswith("HEAD\n"))
        self.assertTrue(report["output"].endswith("TAIL\n"))
        self.assertNotIn("\x1b", report["output"])
        self.assertTrue(report["evidence"]["truncated"])
        self.assertGreater(report["evidence"]["outputBytes"], 500000)
        self.assertLessEqual(len(report["output"].encode()), 6144)
        self.assertLessEqual(len(A.report_bytes(report)), 16384)

    def test_budget_stops_a_child_holding_output_after_its_parent_exits(self):
        report = self.run_entry("import os, signal, time\nif os.fork() == 0:\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n time.sleep(20)\n", budget=100)
        self.assertEqual(report["outcome"], "cancelled")
        self.assertLess(report["evidence"]["durationMs"], 2500)

    def test_escaped_output_leaves_room_for_the_realtime_envelope(self):
        report = self.run_entry("print(chr(34)*10000)\n")
        self.assertTrue(report["evidence"]["truncated"])
        self.assertLessEqual(len(json.dumps(report["output"], ensure_ascii=False).encode()), 8192)
        self.assertLess(len(A.report_bytes(report)), 9000)

    def test_cancellation_does_not_block_the_caller(self):
        report = self.run_entry("import time\ntime.sleep(20)\n", cancel=True)
        self.assertIn(report["outcome"], ("cancelled", "refused"))

    def test_an_unrequested_signal_is_a_failure_not_a_claim_of_cancellation(self):
        report = self.run_entry("import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n")
        self.assertEqual(report["outcome"], "failed")
        self.assertNotIn("exitCode", report["evidence"])

    def test_relative_executables_cannot_follow_a_symlink_outside_cwd(self):
        with tempfile.TemporaryDirectory() as temporary:
            os.symlink(sys.executable, Path(temporary) / "escape")
            value = P.CommandEntry("check", "Check", ("escape",), temporary, False, 100)
            self.assertIsNone(C.executable(value))
            self.assertIsNotNone(C.executable(dataclasses.replace(value, argv=(sys.executable,))))

    def test_process_environment_drops_caller_credentials_and_interpreter_overrides(self):
        with patch.dict(os.environ, {"FAKE_TEST_CREDENTIAL": "not-a-secret", "PYTHONPATH": "/tmp/override",
                                     "LD_PRELOAD": "/tmp/override", "BASH_ENV": "/tmp/override"}):
            report = self.run_entry("import os\nprint(sorted(os.environ))\n")
        for name in ("FAKE_TEST_CREDENTIAL", "PYTHONPATH", "LD_PRELOAD", "BASH_ENV"):
            self.assertNotIn(name, report["output"])


class FakeRunner:
    def __init__(self):
        self.started = []
        self.busy = False
        self.stopped = 0
        self.result = None

    def start(self, value):
        self.started.append(value)
        self.busy = True
        return True

    def stop(self):
        if self.busy:
            self.stopped += 1

    def poll(self):
        value, self.result = self.result, None
        return value


class RunControllerTest(DeviceActionHarness):
    def setUp(self):
        super().setUp()
        self.runner = FakeRunner()
        self.controller._runner = self.runner
        FakeSurface.features = Features(targets=True, context=True, actions=True, commands=True)
        self.addCleanup(setattr, FakeSurface, "features", Features(targets=True, context=True, actions=True))

    def prepare_run(self):
        self.connected()
        self.deliver(policy_document(commands=section()))
        self.controller.set_visible(True)
        self.controller.drain()
        self.fold(operation="set_visible", visible=True)
        value = self.controller.policy.command("check")
        task = open_task(operation(value), privacy="shared_room", channel="action.run")
        task["expiresAtMs"] = self.now_ms + 60000
        task["reportByMs"] = self.now_ms + 60000
        ceremony = confirmation()
        ceremony["privacy"] = "shared_room"
        ceremony["description"].update(verb="run", subject=value.label, effect="does not change files")
        ceremony["description"]["class"] = "shared_room"
        ceremony["descriptionDigest"] = A.confirmation_digest(ceremony["description"])
        self.fold(confirmation=ceremony)
        return task, ceremony

    def confirm_run(self):
        task, ceremony = self.prepare_run()
        self.assertTrue(self.controller.confirm())
        self.controller.drain()
        self.fold(operation="grant", task=task)
        self.assertEqual(self.runner.started, [], "receipt must settle before starting")
        self.settle("acknowledge_task")
        self.assertEqual(len(self.runner.started), 1)
        return task, ceremony

    def test_command_starts_after_confirmation_and_completion_waits_for_report_commit(self):
        self.confirm_run()
        self.runner.busy = False
        self.runner.result = {"outcome": "completed", "evidence": {"kind": "command", "entryId": "check",
                              "exitCode": 2, "durationMs": 10, "outputBytes": 0, "truncated": False}}
        self.controller.drain()
        self.assertEqual(self.state.task.phase, viewstate.TASK_WORKING)
        self.settle("report")
        self.assertEqual(self.state.task.phase, viewstate.TASK_DONE)
        self.assertIn("exit code 2", viewstate.task_card(self.state.task).detail)
        self.assertEqual(len(self.commands("report")), 1)

    def test_no_click_no_command_even_if_runtime_delivers_an_act(self):
        task, _ = self.prepare_run()
        self.fold(task=task)
        self.assertEqual(self.runner.started, [])
        self.assertEqual(self.commands("acknowledge_task"), [])
        self.assertEqual(self.commands("report")[-1][1]["evidence"]["reason"], "no_attestation")

    def test_lost_or_failed_grant_or_ack_never_starts_a_process(self):
        for failed in ("grant", "acknowledge_task"):
            with self.subTest(failed=failed):
                self.setUp()
                task, _ = self.prepare_run()
                self.assertTrue(self.controller.confirm())
                self.controller.drain()
                self.fold(operation="grant", error="stale" if failed == "grant" else None, task=task)
                self.fold(operation="acknowledge_task", error="stale" if failed == "acknowledge_task" else None)
                self.assertEqual(self.runner.started, [])

    def test_policy_change_or_hiding_before_ack_invalidates_local_confirmation(self):
        for change in ("policy", "hide", "expired", "cancel"):
            with self.subTest(change=change):
                self.setUp()
                task, _ = self.prepare_run()
                self.assertTrue(self.controller.confirm())
                self.controller.drain()
                self.fold(operation="grant", task=task)
                if change == "policy":
                    self.deliver(policy_document(commands=section(revision=2)))
                elif change == "hide":
                    self.controller.set_visible(False)
                elif change == "expired":
                    self.now_ms += 60000
                else:
                    self.controller.cancel_task()
                self.settle("acknowledge_task")
                self.assertEqual(self.runner.started, [])

    def test_confirmation_is_bound_to_the_task_revision_and_runtime_description(self):
        for field, value in (("actionId", "ad1ce000-1111-4111-8111-111111111111"), ("generation", 4)):
            self.setUp()
            task, _ = self.prepare_run()
            self.controller.confirm()
            self.controller.drain()
            task[field] = value
            self.fold(operation="grant", task=task)
            self.assertEqual(self.runner.started, [])
            self.assertEqual(self.commands("acknowledge_task"), [])

    def test_progress_and_revocation_use_the_existing_action_channel(self):
        self.confirm_run()
        self.scheduler.now += 5
        self.controller.drain()
        self.assertEqual(self.commands("progress")[-1][1:], (1, 5000))
        self.settle("progress")
        self.fold(revoked=revoked())
        self.assertGreater(self.runner.stopped, 0)
        self.assertEqual(self.commands("report"), [], "a stop request alone proves no outcome")

    def test_hidden_and_expired_ceremonies_cannot_send_a_grant(self):
        _, ceremony = self.prepare_run()
        self.controller.set_visible(False)
        self.assertFalse(self.controller.confirm())
        self.assertEqual(self.commands("grant"), [])
        self.controller.set_visible(True)
        self.now_ms = ceremony["expiresAtMs"]
        self.assertFalse(self.controller.confirm())

    def test_a_lost_binding_acknowledgment_shows_unknown_and_never_starts_late(self):
        task, _ = self.prepare_run()
        self.controller.confirm()
        self.controller.drain()
        self.fold(operation="grant", task=task)
        self.scheduler.now += COMMAND_DEADLINE + 1
        self.controller.drain()
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)
        self.settle("acknowledge_task")
        self.assertEqual(self.runner.started, [])

    def test_policy_loss_and_shutdown_stop_running_commands_without_claiming_an_outcome(self):
        for change in ("policy", "shutdown"):
            self.setUp()
            self.confirm_run()
            if change == "policy":
                self.deliver(policy_document())
            else:
                self.controller.shutdown()
            self.assertGreater(self.runner.stopped, 0)
            self.assertEqual(self.commands("report"), [])


if __name__ == "__main__":
    unittest.main()
