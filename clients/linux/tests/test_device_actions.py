"""The controller carrying one command out: bind, acknowledge, observe, report.

What this computer may open is the permission Cosmos delivers on the connection
it holds; how it opens it is the local openers file. Acknowledging says the
command is legal here and claims nothing. Only what this computer observed is
reported, exactly once, about the action it names, and a repeat opens nothing a
second time. A revoke stops what can be stopped and reports cancelled.
"""
import os
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import actions as A
from cosmos_linux import policy as P
from cosmos_linux import strings as S
from cosmos_linux import viewstate
from cosmos_linux.app import policy_notice
from cosmos_linux.controller import RECONNECT_DELAYS, Controller, Failure, Phase
from cosmos_linux.native import Features

from .fixtures import (
    APPROVAL_REVISION, BOOT_EPOCH, SURFACE_ID, TASK_ID, TURN_ID, FakeIdentity, FakeJournal, FakeLauncher, FakePlayer,
    FakeScheduler, FakeSurface, confirmation, open_task, policy_document, policy_record, revoked, snapshot,
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
        # What the owner allowed, as Cosmos will deliver it…
        self.delivered = policy_document(
            hosts=["github.com"], roots=[{"id": "repo", "label": "Projects", "path": str(self.root)}])
        # …and how this desktop opens a `.rs` at a line, which stays here.
        self.openers = P.parse_openers({
            "version": 1, "openers": [{"suffixes": [".rs"], "argv": ["code", "-g", "{path}:{line}"]}]})
        self.now_ms = 1_900_000_000_000
        self.controller = Controller(
            surface_factory=lambda config, platform: FakeSurface(config, platform), identity=FakeIdentity(),
            journal=FakeJournal(), scheduler=self.scheduler, player=FakePlayer(), boot_epoch=BOOT_EPOCH,
            openers=self.openers, launcher=self.launcher, which=lambda name: "/usr/bin/" + name,
            now_ms=lambda: self.now_ms,
        )
        self.addCleanup(self.temporary.cleanup)

    @property
    def surface(self) -> FakeSurface:
        return FakeSurface.instances[-1]

    @property
    def state(self):
        return self.controller.state

    def connected(self, policy: bool = True) -> FakeSurface:
        self.assertTrue(self.controller.prepare("https://center.andersmadsen.dk"))
        self.surface.emit(snapshot("prepare"))
        self.controller.drain()
        self.scheduler.advance(RECONNECT_DELAYS[0])
        self.surface.emit(snapshot("connect", connected=True, needsReconnect=False))
        self.controller.drain()
        self.assertEqual(self.state.phase, Phase.CONNECTED)
        if policy:
            self.deliver(self.delivered)
        return self.surface

    def deliver(self, document: bytes, **overrides) -> None:
        """One `policy` frame: the worker publishes the bytes, the snapshot
        names them, and this client re-verifies them before holding anything."""
        self.surface.policy = document
        self.fold(operation="policy", policy=policy_record(document, **overrides))

    def fold(self, **overrides):
        base = dict(connected=True, needsReconnect=False, visible=self.state.visible)
        if self.surface.policy is not None:
            # Every snapshot names the copy the worker holds, exactly as the
            # library's own does.
            base["policy"] = policy_record(self.surface.policy)
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
        self.assertEqual(reports[0][1], {"outcome": "unknown", "evidence": {
            "kind": "open", "opened": False, "resolvedApp": "code"}})
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)
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

    def test_run_without_a_command_policy_is_refused(self):
        self.connected()
        self.fold(task=open_task({"kind": "run", "entryId": "project-tests"}, channel="action.run"))
        self.assertEqual(self.commands("report")[0][1]["evidence"]["reason"], "not_permitted")
        self.assertIsNone(self.state.task.unsupported)
        self.assertEqual(self.launcher.started, [])

    def test_a_report_names_the_action_it_is_about(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][2], TASK_ID)


class PermissionTest(DeviceActionHarness):
    """The owner's permission arrives from Cosmos, and nothing is held without it."""

    def test_every_operation_is_refused_while_this_computer_holds_no_permission(self):
        self.connected(policy=False)
        self.assertFalse(self.state.policy_held)
        self.assertIsNone(self.controller.policy)
        for task in (self.file_task(),
                     open_task({"kind": "open", "locator": {
                         "scheme": "https", "url": "https://github.com/owner/repo/pull/412"},
                         "label": "PR 412"}, action_id="3a2b1c09-4d5e-4a6b-8c7d-9e0f1a2b3c4d", key="e" * 64)):
            self.fold(task=task)
            self.assertEqual(self.commands("acknowledge_task"), [], "nothing was bound")
            self.assertEqual(self.launcher.started, [], "nothing was opened")
            self.settle("report")
        self.assertTrue(all(report[1] == {"outcome": "refused", "evidence": {
            "kind": "declined", "reason": "not_permitted"}} for report in self.commands("report")))
        # And the window says so plainly rather than looking ready.
        self.assertEqual(policy_notice(self.state), S.POLICY_NONE + " " + S.POLICY_NONE_REMEDY)

    def test_the_delivered_document_is_what_this_computer_verifies_against(self):
        self.connected()
        self.assertTrue(self.state.policy_held)
        self.assertEqual(self.controller.policy.approval_revision, APPROVAL_REVISION)
        self.assertEqual(policy_notice(self.state), "")
        self.fold(task=self.file_task())
        self.assertEqual(len(self.launcher.started), 1)
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.settle("report")
        # The owner narrows it in Center: the same folder is no longer allowed,
        # and this computer follows the new document, not an older file.
        self.deliver(policy_document(hosts=["github.com"], revision=4))
        self.assertEqual(self.controller.policy.revision, 4)
        self.fold(task=self.file_task(action_id="3a2b1c09-4d5e-4a6b-8c7d-9e0f1a2b3c4d", key="e" * 64))
        self.assertEqual(len(self.launcher.started), 1, "nothing was opened under the old copy")
        self.assertEqual(self.commands("report")[-1][1]["evidence"]["reason"], "not_permitted")

    def test_a_document_that_is_not_this_connection_is_refused_and_nothing_is_held(self):
        self.connected()
        for overrides in ({"surfaceId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"},
                          {"approvalRevision": APPROVAL_REVISION + 1}):
            self.deliver(policy_document(hosts=["github.com"], **{
                "surface_id": overrides.get("surfaceId", SURFACE_ID),
                "approval_revision": overrides.get("approvalRevision", APPROVAL_REVISION)}), **overrides)
            self.assertFalse(self.state.policy_held, overrides)
            self.assertTrue(self.state.policy_refused, overrides)
            self.assertIsNone(self.controller.policy)
            self.assertEqual(policy_notice(self.state), S.POLICY_REFUSED + " " + S.POLICY_REFUSED_REMEDY)
            self.fold(task=self.file_task())
            self.assertEqual(self.launcher.started, [])
            self.assertEqual(self.commands("report")[-1][1]["evidence"]["reason"], "not_permitted")
            self.settle("report")

    def test_a_document_that_is_not_the_one_the_snapshot_named_is_refused_whole(self):
        self.connected(policy=False)
        self.deliver(policy_document(hosts=["github.com"]), digest="f" * 64)
        self.assertFalse(self.state.policy_held)
        self.assertTrue(self.state.policy_refused)
        # So is one this client will not act on any part of.
        self.deliver(policy_document(hosts=["GitHub.com"]))
        self.assertFalse(self.state.policy_held)
        self.assertIsNone(self.controller.policy)

    def test_the_copy_goes_with_the_connection_and_is_never_written_down(self):
        self.connected()
        self.assertTrue(self.state.policy_held)
        # The connection drops: the copy drops with it, and this computer
        # carries nothing out until the new policy arrives.
        self.surface.policy = None
        self.fold(operation="heartbeat", connected=False, needsReconnect=True)
        self.assertFalse(self.state.policy_held)
        self.assertIsNone(self.controller.policy)
        self.assertEqual([entry for entry in os.listdir(self.temporary.name)], ["projects"])

    def test_a_withdrawn_policy_leaves_this_computer_doing_nothing(self):
        self.connected()
        self.surface.policy = None
        self.fold(operation="policy")
        self.assertFalse(self.state.policy_held)
        self.assertFalse(self.state.policy_refused)
        self.fold(task=self.file_task())
        self.assertEqual(self.launcher.started, [])
        self.assertEqual(self.commands("report")[-1][1]["evidence"]["reason"], "not_permitted")


class StaleReportTest(DeviceActionHarness):
    """A report is about one action. A task the runtime replaced in between is a
    different command, and closing it would claim an outcome nobody observed."""

    def test_a_report_for_a_task_that_is_no_longer_current_closes_nothing(self):
        self.connected()
        self.fold(task=self.file_task())
        self.settle("acknowledge_task")
        self.launcher.observe(A.Observation(A.EXITED, 0))
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][2], TASK_ID)
        # The runtime replaced the command between the read and the queue.
        self.fold(operation="report", error="stale_task")
        self.assertIsNone(self.state.failure, "a stale report is not a failed effect")
        self.assertEqual(self.state.phase, Phase.CONNECTED)
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)
        self.assertEqual(len(self.commands("report")), 1, "it is never re-sent for that action")


class HandoffTest(DeviceActionHarness):
    """Destination tests using a local file. These do not establish transfer,
    private routing eligibility or a physical Mac-to-PC handoff."""

    def act(self, **overrides) -> dict:
        operation = {"kind": "open",
                     "locator": {"scheme": "file", "rootId": "repo", "relative": "src/state.rs"},
                     "version": A.file_digest(str(self.document)),
                     "position": {"kind": "line", "line": 1},
                     "label": "state.rs"}
        operation.update(overrides)
        result = open_task({key: value for key, value in operation.items() if value is not None},
                           privacy="shared_room")
        result["expiresAtMs"] = self.now_ms + 60_000
        result["reportByMs"] = self.now_ms + 10_000
        return result

    def show(self):
        self.controller.set_visible(True)
        self.controller.drain()
        self.settle("set_visible")
        self.fold(visible=True)

    def transferred_act(self, text="First line\r\nSecond 🚀 line\r\n<p>literal</p>", line=2):
        explanation = "This explanation travels with the document."
        version = hashlib.sha256(text.encode()).hexdigest()
        document = {"kind": "document", "text": text, "explanation": explanation,
                    "version": version, "taskId": TURN_ID, "revision": 3}
        digest = hashlib.sha256(json.dumps(["cosmos.document-snapshot", 1, text, explanation, version,
                                           TURN_ID, "3"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        operation = {"kind": "open", "locator": {"scheme": "snapshot", "rootId": "repo", "content": {
            "id": TASK_ID, "digest": digest, "expiresAtMs": self.now_ms + 60_000, "audience": SURFACE_ID}},
                     "version": version, "position": {"kind": "line", "line": line}, "label": "notes.txt"}
        return {**open_task(operation, privacy="shared_room"), "document": document,
                "expiresAtMs": self.now_ms + 60_000, "reportByMs": self.now_ms + 10_000}

    def test_transferred_document_is_drawn_without_a_file_and_revoked_after_completion(self):
        self.document.unlink()
        self.connected()
        self.show()
        task = self.transferred_act()
        self.fold(task=task)
        self.settle("acknowledge_task")
        self.assertEqual(self.launcher.started, [])
        self.assertTrue(self.state.document.text.startswith(task["document"]["explanation"] + "\n\n"))
        self.assertTrue(self.paint())
        self.controller.drain()
        self.settle("report")
        self.assertEqual(self.state.task.phase, viewstate.TASK_DONE)
        self.fold(revoked=revoked())
        self.assertIsNone(self.state.document)
        self.assertEqual(self.state.task.phase, viewstate.TASK_DONE, "revoking a view does not undo its observed history")
        self.assertIsNone(self.controller._task.document)
        self.assertEqual(len(self.commands("report")), 1)

    def paint(self, **overrides):
        values = dict(action_id=TASK_ID, digest=self.state.document.digest, line=self.state.document.line)
        values.update(overrides)
        return self.controller.document_committed(**values)

    def test_completion_waits_for_the_exact_document_and_line_to_be_painted(self):
        self.connected()
        self.show()
        self.fold(task=self.act())
        self.assertEqual(self.launcher.started, [])
        self.assertEqual(self.state.document.text, "fn main() {}\n")
        self.assertEqual(self.commands("report"), [])
        self.settle("acknowledge_task")
        self.assertFalse(self.paint(digest="f" * 64))
        self.assertFalse(self.paint(line=2))
        self.assertFalse(self.paint(action_id="f" * 36))
        self.assertEqual(self.commands("report"), [])
        self.assertTrue(self.paint())
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][1], {
            "outcome": "completed",
            "evidence": {"kind": "open", "opened": True, "resolvedApp": "dk.andersmadsen.cosmos.linux",
                         "documentDigest": A.file_digest(str(self.document))}})
        self.assertFalse(self.paint(), "the same frame cannot complete twice")
        self.assertEqual(self.state.task.phase, viewstate.TASK_WORKING, "the report has not committed yet")
        self.settle("report")
        card = viewstate.task_card(self.state.task)
        self.assertEqual((card.title, card.detail), (S.COMPLETED, "state.rs is open on this computer."))

    def test_source_changes_after_reading_do_not_substitute_what_gets_rendered(self):
        self.connected()
        self.show()
        self.fold(task=self.act())
        original = self.state.document.digest
        self.document.write_text("different bytes\n", encoding="utf-8")
        self.settle("acknowledge_task")
        self.assertEqual(self.state.document.text, "fn main() {}\n")
        self.assertTrue(self.paint())
        self.controller.drain()
        self.assertEqual(self.commands("report")[0][1]["evidence"]["documentDigest"], original)

    def test_a_rejected_render_report_never_becomes_a_completed_status(self):
        self.connected()
        self.show()
        self.fold(task=self.act())
        self.settle("acknowledge_task")
        self.assertTrue(self.paint())
        self.controller.drain()
        self.assertEqual(self.state.task.phase, viewstate.TASK_WORKING)
        self.fold(operation="report", error="stale_task")
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)

    def test_a_confirmation_covering_the_view_invalidates_a_pending_frame(self):
        self.connected()
        self.show()
        self.fold(task=self.act())
        self.settle("acknowledge_task")
        self.fold(confirmation=confirmation())
        self.assertFalse(self.paint())
        self.assertEqual(self.commands("report"), [])

    def test_hidden_or_expired_views_cannot_report_completion(self):
        self.connected()
        self.fold(task=self.act())
        self.assertFalse(self.paint())
        self.show()
        self.now_ms += 10_000
        self.assertFalse(self.paint())
        self.controller.drain()
        self.assertIsNone(self.state.document)
        self.assertEqual(self.state.task.phase, viewstate.TASK_UNKNOWN)

    def test_revocation_cancellation_disconnect_and_policy_change_release_the_snapshot(self):
        for transition in ("revoke", "cancel", "disconnect", "policy", "hide"):
            with self.subTest(transition=transition):
                self.setUp()
                self.connected()
                self.show()
                self.fold(task=self.act())
                self.settle("acknowledge_task")
                digest = self.state.document.digest
                if transition == "revoke":
                    self.fold(revoked=revoked())
                elif transition == "cancel":
                    self.controller.cancel_task()
                elif transition == "disconnect":
                    self.fold(connected=False)
                elif transition == "policy":
                    self.deliver(policy_document(hosts=["github.com"], revision=4))
                else:
                    self.controller.set_visible(False)
                self.assertIsNone(self.state.document)
                self.assertFalse(self.controller.document_committed(TASK_ID, digest, 1))

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
        self.controller.set_visible(True)
        self.controller.drain()
        self.fold(operation="set_visible", visible=True)
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
