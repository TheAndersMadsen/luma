"""The controller carrying one command out: bind, acknowledge, observe, report.

Acknowledging says the command is legal here and claims nothing. Only what this
computer observed is reported, exactly once, and a repeat opens nothing a second
time. A revoke stops what can be stopped and reports cancelled.
"""
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import actions as A
from cosmos_linux import policy as P
from cosmos_linux import strings as S
from cosmos_linux import viewstate
from cosmos_linux.controller import RECONNECT_DELAYS, Controller, Failure, Phase
from cosmos_linux.native import Features

from .fixtures import (
    BOOT_EPOCH, TASK_ID, FakeIdentity, FakeJournal, FakeLauncher, FakePlayer, FakeScheduler, FakeSurface,
    confirmation, open_task, revoked, snapshot,
)


class DeviceActionHarness(unittest.TestCase):
    def setUp(self):
        FakeSurface.instances = []
        FakeSurface.features = Features(targets=True, context=True, actions=True)
        self.scheduler = FakeScheduler()
        self.launcher = FakeLauncher()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "projects"
        (self.root / "src").mkdir(parents=True)
        self.document = self.root / "src" / "state.rs"
        self.document.write_text("fn main() {}\n", encoding="utf-8")
        self.policy = P.parse({"version": 1, "open": {
            "hosts": ["github.com"],
            "roots": [{"id": "repo", "label": "Projects", "path": str(self.root)}],
            "openers": [{"suffixes": [".rs"], "argv": ["code", "-g", "{path}:{line}"]}],
        }})
        self.now_ms = 1_900_000_000_000
        self.controller = Controller(
            surface_factory=lambda config, platform: FakeSurface(config, platform), identity=FakeIdentity(),
            journal=FakeJournal(), scheduler=self.scheduler, player=FakePlayer(), boot_epoch=BOOT_EPOCH,
            policy=self.policy, launcher=self.launcher, which=lambda name: "/usr/bin/" + name,
            now_ms=lambda: self.now_ms,
        )
        self.addCleanup(self.temporary.cleanup)

    @property
    def surface(self) -> FakeSurface:
        return FakeSurface.instances[-1]

    @property
    def state(self):
        return self.controller.state

    def connected(self) -> FakeSurface:
        self.assertTrue(self.controller.prepare("https://center.andersmadsen.dk"))
        self.surface.emit(snapshot("prepare"))
        self.controller.drain()
        self.scheduler.advance(RECONNECT_DELAYS[0])
        self.surface.emit(snapshot("connect", connected=True, needsReconnect=False))
        self.controller.drain()
        self.assertEqual(self.state.phase, Phase.CONNECTED)
        return self.surface

    def fold(self, **overrides):
        base = dict(connected=True, needsReconnect=False)
        base.update(overrides)
        self.surface.emit(snapshot(base.pop("operation", "task"), **base))
        self.controller.drain()

    def settle(self, operation: str):
        """The worker's snapshot for a command this client sent, so the next
        deferred command can run."""
        self.fold(operation=operation)

    def commands(self, name: str) -> list:
        return [entry for entry in self.surface.commands
                if (entry[0] if isinstance(entry, tuple) else entry) == name]

    def file_task(self, **overrides) -> dict:
        operation = {"kind": "open",
                     "locator": {"scheme": "file", "rootId": "repo", "relative": "src/state.rs"},
                     "position": {"kind": "line", "line": 1710}, "label": "state.rs"}
        operation.update(overrides.pop("operation", {}))
        return open_task(operation, **overrides)


class BindingTest(DeviceActionHarness):
    def test_a_legal_command_is_acknowledged_and_launched_but_claims_nothing_yet(self):
        self.connected()
        self.fold(task=self.file_task())
        self.assertEqual(len(self.commands("acknowledge_task")), 1)
        self.assertEqual(self.commands("report"), [])
        self.assertEqual(self.launcher.started[0].argv,
                         ("code", "-g", f"{os.path.realpath(self.document)}:1710"))
        self.assertEqual(self.state.task.phase, viewstate.TASK_WORKING)
        self.assertEqual(self.state.presence.text, "Working · This computer is doing it")

    def test_the_report_is_what_this_computer_observed_and_arrives_once(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.scheduler.now += 3
        self.controller.drain()
        reports = self.commands("report")
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0][1], {"outcome": "completed", "evidence": {
            "kind": "open", "opened": True, "resolvedApp": "code"}})
        self.assertEqual(self.state.task.phase, viewstate.TASK_DONE)
        self.assertEqual(self.state.task.elapsed, 3)
        # Nothing more is sent for the same command.
        self.controller.drain()
        self.assertEqual(len(self.commands("report")), 1)

    def test_a_launch_this_computer_could_not_observe_is_unknown_never_completed(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.UNOBSERVED))
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][1]["outcome"], "unknown")
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)
        card = viewstate.task_card(self.state.task)
        self.assertEqual(card.title, S.CANNOT_CONFIRM)

    def test_a_refused_command_is_never_acknowledged_and_is_reported_as_declined(self):
        self.connected()
        self.fold(task=open_task({"kind": "open", "locator": {
            "scheme": "https", "url": "https://evil.example/x"}, "label": "Page"}))
        self.assertEqual(self.commands("acknowledge_task"), [])
        self.assertEqual(self.commands("report")[0][1], {
            "outcome": "refused", "evidence": {"kind": "declined", "reason": "not_permitted"}})
        self.assertEqual(self.launcher.started, [])
        self.assertEqual(self.state.task.phase, viewstate.TASK_REFUSED)

    def test_a_symlink_escape_is_refused_by_this_computer_whatever_the_runtime_said(self):
        outside = Path(self.temporary.name) / "secrets"
        outside.mkdir()
        (outside / "id_ed25519").write_text("private\n", encoding="utf-8")
        os.symlink(outside / "id_ed25519", self.root / "src" / "key.rs")
        self.connected()
        self.fold(task=self.file_task(operation={
            "locator": {"scheme": "file", "rootId": "repo", "relative": "src/key.rs"}, "position": None}))
        self.assertEqual(self.commands("report")[0][1]["evidence"]["reason"], "unresolvable")
        self.assertEqual(self.launcher.started, [])

    def test_run_route_and_play_are_unsupported_and_say_so_plainly(self):
        self.connected()
        self.fold(task=open_task({"kind": "run", "entryId": "project-tests"}, channel="action.run"))
        self.assertEqual(self.commands("report")[0][1]["evidence"]["reason"], "not_permitted")
        self.assertEqual(self.state.task.unsupported, "run")
        card = viewstate.task_card(self.state.task)
        self.assertEqual((card.title, card.detail, card.remedy),
                         (S.NOT_DONE, S.UNSUPPORTED_RUN, S.UNSUPPORTED_REMEDY))

    def test_an_empty_policy_opens_nothing_at_all(self):
        controller = Controller(
            surface_factory=lambda config, platform: FakeSurface(config, platform), identity=FakeIdentity(),
            journal=FakeJournal(), scheduler=FakeScheduler(), player=FakePlayer(), boot_epoch=BOOT_EPOCH,
            launcher=FakeLauncher(), which=lambda name: "/usr/bin/" + name,
        )
        self.assertTrue(controller.policy.empty)
        self.assertFalse(controller.state.policy_loaded)


class HandoffTest(DeviceActionHarness):
    """"Explain this document on the Mac, continue on my PC": the receiving half.

    The runtime binds the locator from the document handle the Mac attached to
    its screen context, and this computer opens exactly that, at exactly that
    place, only when the file it holds still hashes to the version the Mac read.
    """

    def act(self, **overrides) -> dict:
        operation = {"kind": "open",
                     "locator": {"scheme": "file", "rootId": "repo", "relative": "src/state.rs"},
                     "version": A.file_digest(str(self.document)),
                     "position": {"kind": "line", "line": 1710},
                     "label": "state.rs"}
        operation.update(overrides)
        return open_task({key: value for key, value in operation.items() if value is not None},
                         privacy="private")

    def test_the_pc_opens_the_same_document_at_the_same_place(self):
        self.connected()
        self.fold(task=self.act())
        self.assertEqual(self.launcher.started[0].argv,
                         ("code", "-g", f"{os.path.realpath(self.document)}:1710"))
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][1], {
            "outcome": "completed",
            "evidence": {"kind": "open", "opened": True, "resolvedApp": "code",
                         "documentDigest": A.file_digest(str(self.document))}})
        card = viewstate.task_card(self.state.task)
        self.assertEqual((card.title, card.detail), (S.COMPLETED, "state.rs is open on this computer."))

    def test_a_document_that_changed_on_the_way_is_not_opened_and_never_substituted(self):
        original = A.file_digest(str(self.document))
        self.document.write_text("fn main() { changed(); }\n", encoding="utf-8")
        self.connected()
        self.fold(task=self.act(version=original))
        self.assertEqual(self.launcher.started, [])
        self.assertEqual(self.commands("report")[0][1]["evidence"]["reason"], "version_changed")
        card = viewstate.task_card(self.state.task)
        self.assertEqual((card.title, card.detail, card.remedy),
                         (S.NOT_DONE, S.REFUSAL_VERSION_CHANGED, S.REFUSAL_VERSION_CHANGED_REMEDY))

    def test_a_root_id_this_pc_does_not_share_with_the_mac_is_unresolvable(self):
        self.connected()
        self.fold(task=self.act(locator={"scheme": "file", "rootId": "documents",
                                         "relative": "src/state.rs"}, version=None))
        self.assertEqual(self.commands("report")[0][1]["evidence"]["reason"], "not_permitted")

    def test_a_web_document_continues_at_its_fragment(self):
        self.connected()
        self.fold(task=open_task({"kind": "open",
                                  "locator": {"scheme": "https",
                                              "url": "https://github.com/owner/repo/pull/412"},
                                  "position": {"kind": "fragment", "value": "discussion_r1"},
                                  "label": "PR 412"}))
        self.assertEqual(self.launcher.started[0].argv,
                         ("xdg-open", "https://github.com/owner/repo/pull/412#discussion_r1"))


class DedupeTest(DeviceActionHarness):
    def test_a_repeat_of_the_same_command_re_sends_the_report_and_opens_nothing(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.settle("report")
        first = self.commands("report")[0][1]
        # The same command again, with the same idempotency key and a new action.
        self.fold(task=self.file_task(action_id="3a2b1c09-4d5e-4a6b-8c7d-9e0f1a2b3c4d"))
        self.settle("acknowledge_task")
        self.assertEqual(len(self.launcher.started), 1, "nothing was opened a second time")
        self.assertEqual(self.commands("report")[1][1], first)

    def test_a_different_key_is_a_different_command(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.settle("report")
        self.fold(task=self.file_task(action_id="3a2b1c09-4d5e-4a6b-8c7d-9e0f1a2b3c4d", key="e" * 64))
        self.settle("acknowledge_task")
        self.assertEqual(len(self.launcher.started), 2)


class StoppingTest(DeviceActionHarness):
    def test_cancel_task_stops_the_launch_and_reports_cancelled(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.assertTrue(self.state.can_cancel_task)
        self.assertTrue(self.controller.cancel_task())
        self.controller.drain()
        self.assertEqual(self.launcher.stopped, 1)
        self.assertEqual(self.commands("report")[0][1]["outcome"], "cancelled")
        self.assertEqual(self.state.task.phase, viewstate.TASK_STOPPED)
        card = viewstate.task_card(self.state.task)
        self.assertEqual((card.title, card.detail), (S.NOT_DONE, S.TASK_STOPPED))

    def test_a_revoke_stops_the_launch_and_reports_cancelled(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.fold(task=None, revoked=revoked("preempted"))
        self.controller.drain()
        self.assertEqual(self.launcher.stopped, 1)
        self.assertEqual(self.commands("report")[0][1]["outcome"], "cancelled")

    def test_closing_the_window_is_not_cancelling(self):
        self.connected()
        self.fold(task=self.file_task())
        self.controller.set_visible(False)
        self.controller.drain()
        self.assertEqual(self.launcher.stopped, 0)
        self.assertEqual(self.commands("report"), [])
        self.assertTrue(self.state.task.running)

    def test_a_build_without_the_library_calls_opens_nothing_and_says_so(self):
        FakeSurface.features = Features(targets=True, context=True, actions=False)
        self.connected()
        self.fold(task=self.file_task())
        self.assertEqual(self.launcher.started, [])
        self.assertEqual(self.commands("report"), [])
        self.assertEqual(self.state.failure, Failure.ACTIONS_UNAVAILABLE)


class CeremonyTest(DeviceActionHarness):
    def test_the_ceremony_reads_the_runtime_words_and_shows_a_countdown(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.assertTrue(self.state.ceremony_open)
        self.assertEqual(self.state.ceremony_seconds, 30)
        ceremony = viewstate.ceremony(self.state.confirmation, self.state.ceremony_seconds)
        self.assertEqual(ceremony.question, "Open state.rs on this computer?")
        self.assertEqual(ceremony.effect, "Opens that document on this computer.")
        self.assertEqual(ceremony.note, S.CONFIRM_CLASS_PRIVATE)
        self.assertEqual(ceremony.countdown, "30s left")
        self.assertTrue(ceremony.can_confirm)
        self.assertEqual(self.state.presence.text, "Waiting for you · Confirm it on this computer")

    def test_confirming_carries_the_attestation_this_desktop_can_actually_prove(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.assertTrue(self.controller.confirm())
        self.controller.drain()
        self.assertEqual(self.commands("grant")[0][1:], (True, "foreground_tap"))

    def test_declining_weighs_the_same_and_carries_no_attestation(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.assertTrue(self.controller.decline())
        self.controller.drain()
        self.assertEqual(self.commands("grant")[0][1:], (False, None))

    def test_dismissing_answers_nothing_at_all(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.assertTrue(self.controller.dismiss_ceremony())
        self.controller.drain()
        self.assertEqual(self.commands("grant"), [])
        self.assertFalse(self.state.ceremony_open)
        self.assertIsNotNone(self.state.confirmation)
        self.assertEqual(self.state.message, S.CONFIRM_DISMISSED)
        # A dismissed ceremony stays dismissed while the same request stands.
        self.fold(operation="heartbeat", confirmation=confirmation())
        self.assertFalse(self.state.ceremony_open)

    def test_a_new_request_is_shown_again_after_an_earlier_one_was_dismissed(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.controller.dismiss_ceremony()
        other = confirmation()
        other["grantId"] = "aa11bb22-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
        self.fold(operation="confirmation", confirmation=other)
        self.assertTrue(self.state.ceremony_open)

    def test_a_ceremony_whose_words_do_not_bind_its_digest_is_never_shown(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation(digest="f" * 64))
        self.assertIsNone(self.state.confirmation)
        self.assertFalse(self.state.ceremony_open)
        self.assertFalse(self.controller.confirm())
        self.controller.drain()
        self.assertEqual(self.commands("grant"), [])

    def test_a_ceremony_needing_evidence_this_desktop_cannot_produce_is_not_confirmable(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation(attestation="device_owner_auth"))
        ceremony = viewstate.ceremony(self.state.confirmation, self.state.ceremony_seconds)
        self.assertFalse(ceremony.can_confirm)
        self.assertEqual(ceremony.cannot_reason, S.CONFIRM_CANNOT)
        self.assertFalse(self.controller.confirm())
        self.controller.drain()
        self.assertEqual(self.commands("grant"), [])
        # Declining is still one control away.
        self.assertTrue(self.controller.decline())

    def test_the_countdown_ticks_from_one_clock(self):
        self.connected()
        self.fold(operation="confirmation", confirmation=confirmation())
        self.now_ms += 9_000
        self.controller.drain()
        self.assertEqual(self.state.ceremony_seconds, 21)
        self.now_ms += 60_000
        self.controller.drain()
        self.assertEqual(self.state.ceremony_seconds, 0)


class KeyTest(unittest.TestCase):
    """One rule for the ceremony's keys, so no stray keypress can resolve it."""

    def test_enter_confirms_escape_dismisses_and_nothing_else_does_anything(self):
        self.assertEqual(viewstate.ceremony_key("return", True), viewstate.CONFIRM)
        self.assertEqual(viewstate.ceremony_key("escape", True), viewstate.DISMISS)
        self.assertEqual(viewstate.ceremony_key("escape", False), viewstate.DISMISS)
        for stray in ("other", "space", "y", "", "Return", "enter"):
            self.assertEqual(viewstate.ceremony_key(stray, True), viewstate.IGNORE, stray)

    def test_enter_answers_nothing_when_this_desktop_cannot_confirm(self):
        self.assertEqual(viewstate.ceremony_key("return", False), viewstate.IGNORE)


class TaskCardTest(unittest.TestCase):
    """The words on the card, from the phase and the clock alone."""

    def card(self, phase: str, **overrides):
        view = viewstate.TaskView(TASK_ID, overrides.pop("label", "state.rs"), phase, **overrides)
        return viewstate.task_card(view)

    def test_no_command_is_no_card(self):
        self.assertIsNone(viewstate.task_card(None))

    def test_a_running_command_shows_the_state_word_the_sentence_and_the_clock(self):
        card = self.card(viewstate.TASK_WORKING, elapsed=14)
        self.assertEqual((card.title, card.detail, card.elapsed), (S.WORKING, "Opening state.rs", "0:14"))
        self.assertTrue(card.cancellable)

    def test_a_finished_command_freezes_its_clock_and_stops_offering_cancel(self):
        card = self.card(viewstate.TASK_DONE, elapsed=62)
        self.assertEqual((card.title, card.detail, card.elapsed),
                         (S.COMPLETED, "state.rs is open on this computer.", "1:02"))
        self.assertFalse(card.cancellable)

    def test_a_refusal_reads_not_done_with_one_sentence_each_way(self):
        for reason, happened, remedy in (
                ("no_handler", S.REFUSAL_NO_HANDLER, S.REFUSAL_NO_HANDLER_REMEDY),
                ("not_permitted", S.REFUSAL_NOT_PERMITTED, S.REFUSAL_NOT_PERMITTED_REMEDY),
                ("unresolvable", S.REFUSAL_UNRESOLVABLE, S.REFUSAL_UNRESOLVABLE_REMEDY),
                ("version_changed", S.REFUSAL_VERSION_CHANGED, S.REFUSAL_VERSION_CHANGED_REMEDY)):
            card = self.card(viewstate.TASK_REFUSED, reason=reason)
            self.assertEqual((card.title, card.detail, card.remedy), (S.NOT_DONE, happened, remedy), reason)
            self.assertEqual(card.tone, "error")

    def test_an_unknown_reason_still_refuses_rather_than_inventing_a_sentence(self):
        card = self.card(viewstate.TASK_REFUSED, reason="something_new")
        self.assertEqual((card.title, card.detail), (S.NOT_DONE, S.REFUSAL_NOT_PERMITTED))

    def test_a_command_this_computer_could_not_observe_says_so(self):
        card = self.card(viewstate.TASK_UNKNOWN, elapsed=5)
        self.assertEqual(card.title, S.CANNOT_CONFIRM)
        self.assertIn("cannot confirm", card.detail)

    def test_the_clock_reads_as_minutes_and_seconds(self):
        self.assertEqual(viewstate.elapsed_text(0), "0:00")
        self.assertEqual(viewstate.elapsed_text(9.6), "0:09")
        self.assertEqual(viewstate.elapsed_text(600), "10:00")
        self.assertEqual(viewstate.elapsed_text(3661), "1:01:01")
        self.assertEqual(viewstate.elapsed_text(-5), "0:00")


class StatusLineTest(unittest.TestCase):
    """The four new committed states, in the words of the shared vocabulary."""

    def line(self, state: str, platform=None):
        from cosmos_linux.events import TurnStatus
        return viewstate.status_line(TurnStatus("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", 3, state, platform,
                                                "private"), viewstate.EMPTY_LINE)

    def test_each_state_reads_as_the_shared_vocabulary(self):
        self.assertEqual(self.line("confirming", "linux").text, "Waiting for you · Confirm it on this computer")
        self.assertEqual(self.line("confirming", "macos").text, "Waiting for a device · Waiting for your MacBook")
        self.assertEqual(self.line("acting", "linux").text, "Working · This computer is doing it")
        self.assertEqual(self.line("acting", "macos").text, "Working · Your MacBook is doing it")
        self.assertEqual(self.line("done", "linux").text, "Completed")
        self.assertEqual(self.line("done", "macos").text, "Completed · Done on your MacBook")

    def test_a_refusal_elsewhere_never_says_why_or_where(self):
        for platform in ("macos", "android", None):
            line = self.line("refused", platform)
            self.assertEqual(line.title, S.NOT_DONE)
            self.assertEqual(line.detail, S.NOT_DONE_ELSEWHERE)
            self.assertNotIn("MacBook", line.text)


if __name__ == "__main__":
    unittest.main()
