"""Deciding one command and saying only what was observed.

The digests are asserted against the same fixture file the runtime, the Mac,
the phone and Center assert against, so a drift in any implementation refuses
the command instead of carrying out something the owner never approved.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import actions as A
from cosmos_linux import policy as P
from cosmos_linux.events import Task

FIXTURES = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / \
    "ambiance-device-action-digests-v1.json"
TASK_ID = "2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d"
TURN_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"


def task(operation: dict, channel: str = "action.open", digest: str = None, key: str = "d" * 64) -> Task:
    return Task(action_id=TASK_ID, turn_id=TURN_ID, generation=3, channel=channel,
                content_digest=digest if digest is not None else (A.content_digest(operation) or "0" * 64),
                idempotency_key=key, operation=operation, expires_at_ms=1_900_000_000_000,
                report_by_ms=1_900_000_010_000, privacy="private")


def which_all(name):
    return "/usr/bin/" + name


def which_none(_name):
    return None


class DigestTest(unittest.TestCase):
    """Byte-for-byte the runtime's binding, from the shared vector file."""

    def cases(self) -> dict:
        with open(FIXTURES, encoding="utf-8") as handle:
            return {case["name"]: case for case in json.load(handle)["cases"]}

    def test_every_open_vector_matches_the_shared_fixture(self):
        cases = self.cases()
        https = cases["open-https"]["canonical"]
        self.assertEqual(A.content_digest({
            "kind": "open", "locator": {"scheme": "https", "url": https[3]},
            "position": {"kind": "fragment", "value": https[7]}, "label": https[8],
        }), cases["open-https"]["digest"])
        line = cases["open-file-line"]["canonical"]
        self.assertEqual(A.content_digest({
            "kind": "open", "locator": {"scheme": "file", "rootId": line[4], "relative": line[3]},
            "version": line[5], "position": {"kind": "line", "line": int(line[7])}, "label": line[8],
        }), cases["open-file-line"]["digest"])
        app = cases["open-app"]["canonical"]
        self.assertEqual(A.content_digest({
            "kind": "open", "locator": {"scheme": "app", "id": app[3]}, "label": app[8],
        }), cases["open-app"]["digest"])

    def test_the_other_operations_and_the_ceremony_match_too(self):
        cases = self.cases()
        route = cases["route"]["canonical"]
        self.assertEqual(A.content_digest({"kind": "route", "placeId": route[2], "name": route[3],
                                           "address": route[4], "lat": route[5], "lng": route[6]}),
                         cases["route"]["digest"])
        play = cases["play"]["canonical"]
        self.assertEqual(A.content_digest({"kind": "play", "title": play[2], "query": play[3],
                                           "providers": play[4], "itemDigest": play[5]}),
                         cases["play"]["digest"])
        run = cases["run"]["canonical"]
        self.assertEqual(A.content_digest({"kind": "run", "entryId": run[2], "label": run[3],
                                           "entryDigest": run[4], "argvDigest": run[5], "budgetMs": run[6],
                                           "mutates": run[7]}), cases["run"]["digest"])
        confirm = cases["confirm"]["canonical"]
        self.assertEqual(A.confirmation_digest({"verb": confirm[2], "subject": confirm[3],
                                                "deviceKind": confirm[4], "effect": confirm[5],
                                                "class": confirm[6]}), cases["confirm"]["digest"])

    def test_a_command_whose_digest_does_not_match_its_own_shape_is_refused(self):
        operation = {"kind": "open", "locator": {"scheme": "https", "url": "https://github.com/a"},
                     "label": "A"}
        policy = P.parse({"version": 1, "open": {"hosts": ["github.com"]}})
        self.assertTrue(A.plan(task(operation), policy, which_all).bound)
        drifted = A.plan(task(operation, digest="f" * 64), policy, which_all)
        self.assertFalse(drifted.bound)
        self.assertEqual(drifted.refusal, A.NOT_PERMITTED)


class UnsupportedTest(unittest.TestCase):
    """`run`, `route` and `play` are not on this platform's manifest."""

    def test_each_unsupported_operation_is_refused_by_name(self):
        for channel, kind, name in (("action.run", "run", "run"), ("action.route", "route", "route"),
                                    ("action.play", "play", "play")):
            decision = A.plan(task({"kind": kind}, channel=channel, digest="a" * 64), P.EMPTY_POLICY, which_all)
            self.assertFalse(decision.bound, channel)
            self.assertEqual(decision.refusal, A.NOT_PERMITTED)
            self.assertEqual(decision.unsupported, name)
            self.assertEqual(A.refusal_report(decision.refusal),
                             {"outcome": "refused", "evidence": {"kind": "declined", "reason": "not_permitted"}})

    def test_an_open_channel_carrying_another_operation_is_refused(self):
        decision = A.plan(task({"kind": "run"}, digest="a" * 64), P.EMPTY_POLICY, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.unsupported, "run")


class OpenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "projects"
        (self.root / "src").mkdir(parents=True)
        self.document = self.root / "src" / "state.rs"
        self.document.write_text("fn main() {}\n", encoding="utf-8")
        self.digest = A.file_digest(str(self.document))
        self.policy = P.parse({"version": 1, "open": {
            "hosts": ["github.com"],
            "apps": [{"id": "dev.zed.Zed", "label": "Zed", "desktop": "dev.zed.Zed.desktop"}],
            "roots": [{"id": "repo", "label": "Projects", "path": str(self.root)}],
            "openers": [{"suffixes": [".rs"], "argv": ["code", "-g", "{path}:{line}"]}],
        }})
        self.addCleanup(self.temporary.cleanup)

    def file_operation(self, **overrides) -> dict:
        operation = {"kind": "open",
                     "locator": {"scheme": "file", "rootId": "repo", "relative": "src/state.rs"},
                     "version": self.digest, "position": {"kind": "line", "line": 1710},
                     "label": "state.rs"}
        operation.update(overrides)
        return {key: value for key, value in operation.items() if value is not None}

    def test_an_allowed_host_opens_through_xdg_open(self):
        decision = A.plan(task({"kind": "open", "locator": {
            "scheme": "https", "url": "https://github.com/owner/repo/pull/412"}, "label": "PR 412"}),
            self.policy, which_all)
        self.assertTrue(decision.bound)
        self.assertEqual(decision.launch.argv, ("xdg-open", "https://github.com/owner/repo/pull/412"))

    def test_a_host_absent_from_the_local_copy_is_refused_whatever_the_runtime_said(self):
        decision = A.plan(task({"kind": "open", "locator": {
            "scheme": "https", "url": "https://evil.example/owner"}, "label": "Page"}),
            self.policy, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.refusal, A.NOT_PERMITTED)

    def test_a_fragment_travels_with_the_page_and_a_line_number_does_not(self):
        fragment = A.plan(task({"kind": "open", "locator": {
            "scheme": "https", "url": "https://github.com/owner/repo/pull/412"},
            "position": {"kind": "fragment", "value": "discussion_r1"}, "label": "PR 412"}),
            self.policy, which_all)
        self.assertEqual(fragment.launch.argv[1], "https://github.com/owner/repo/pull/412#discussion_r1")
        line = A.plan(task({"kind": "open", "locator": {
            "scheme": "https", "url": "https://github.com/owner/repo/pull/412"},
            "position": {"kind": "line", "line": 12}, "label": "PR 412"}), self.policy, which_all)
        self.assertFalse(line.bound)
        self.assertEqual(line.refusal, A.NO_HANDLER)

    def test_a_file_under_a_declared_root_opens_at_its_line(self):
        decision = A.plan(task(self.file_operation()), self.policy, which_all)
        self.assertTrue(decision.bound)
        self.assertEqual(decision.launch.argv,
                         ("code", "-g", f"{os.path.realpath(self.document)}:1710"))
        self.assertEqual(decision.launch.resolved_app, "code")
        self.assertEqual(decision.launch.document_digest, self.digest)

    def test_a_root_this_installation_never_declared_is_refused(self):
        decision = A.plan(task(self.file_operation(
            locator={"scheme": "file", "rootId": "downloads", "relative": "src/state.rs"})),
            self.policy, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.refusal, A.NOT_PERMITTED)

    def test_a_symlink_escape_is_refused_after_the_link_is_followed(self):
        outside = Path(self.temporary.name) / "secrets"
        outside.mkdir()
        (outside / "id_ed25519").write_text("private\n", encoding="utf-8")
        os.symlink(outside / "id_ed25519", self.root / "src" / "key.rs")
        decision = A.plan(task(self.file_operation(
            locator={"scheme": "file", "rootId": "repo", "relative": "src/key.rs"}, version=None)),
            self.policy, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.refusal, A.UNRESOLVABLE)

    def test_a_document_that_changed_since_it_was_read_is_not_opened(self):
        self.document.write_text("fn main() { changed(); }\n", encoding="utf-8")
        decision = A.plan(task(self.file_operation()), self.policy, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.refusal, A.VERSION_CHANGED)

    def test_a_missing_tool_is_a_plain_refusal_and_never_a_crash(self):
        for operation in (self.file_operation(),
                          {"kind": "open", "locator": {"scheme": "https", "url": "https://github.com/a"},
                           "label": "A"},
                          {"kind": "open", "locator": {"scheme": "app", "id": "dev.zed.Zed"}, "label": "Zed"}):
            decision = A.plan(task(operation), self.policy, which_none)
            self.assertFalse(decision.bound)
            self.assertEqual(decision.refusal, A.NO_HANDLER)

    def test_a_position_with_no_opener_that_honours_it_is_refused_rather_than_dropped(self):
        pdf = self.root / "src" / "thesis.pdf"
        pdf.write_bytes(b"%PDF-1.4\n")
        decision = A.plan(task(self.file_operation(
            locator={"scheme": "file", "rootId": "repo", "relative": "src/thesis.pdf"},
            position={"kind": "page", "page": 12}, version=None)), self.policy, which_all)
        self.assertFalse(decision.bound)
        self.assertEqual(decision.refusal, A.NO_HANDLER)

    def test_a_file_with_no_position_falls_back_to_xdg_open(self):
        text = self.root / "notes.txt"
        text.write_text("hello\n", encoding="utf-8")
        decision = A.plan(task(self.file_operation(
            locator={"scheme": "file", "rootId": "repo", "relative": "notes.txt"},
            position=None, version=None)), self.policy, which_all)
        self.assertEqual(decision.launch.argv, ("xdg-open", os.path.realpath(text)))
        self.assertIsNone(decision.launch.resolved_app)

    def test_an_application_needs_a_desktop_entry_the_owner_declared(self):
        decision = A.plan(task({"kind": "open", "locator": {"scheme": "app", "id": "dev.zed.Zed"},
                                "label": "Zed"}), self.policy, which_all)
        self.assertEqual(decision.launch.argv, ("gio", "launch", "dev.zed.Zed.desktop"))
        unknown = A.plan(task({"kind": "open", "locator": {"scheme": "app", "id": "com.other.App"},
                               "label": "Other"}), self.policy, which_all)
        self.assertEqual(unknown.refusal, A.NOT_PERMITTED)


class ReportTest(unittest.TestCase):
    """Only an observation may say completed."""

    LAUNCH = A.Launch(argv=("xdg-open", "https://github.com/a"), resolved_app="code",
                      document_digest="a" * 64, label="PR 412")

    def test_a_launcher_that_exited_zero_is_the_observation_of_an_open(self):
        report = A.report_for(self.LAUNCH, A.Observation(A.EXITED, 0))
        self.assertEqual(report["outcome"], "completed")
        self.assertTrue(report["evidence"]["opened"])
        self.assertEqual(report["evidence"]["documentDigest"], "a" * 64)
        self.assertEqual(report["evidence"]["resolvedApp"], "code")

    def test_a_launch_this_computer_could_not_observe_is_unknown_and_never_completed(self):
        report = A.report_for(self.LAUNCH, A.Observation(A.UNOBSERVED))
        self.assertEqual(report["outcome"], "unknown")
        self.assertFalse(report["evidence"]["opened"])
        self.assertNotIn("documentDigest", report["evidence"])

    def test_a_launcher_that_failed_is_failed_and_one_that_never_started_is_refused(self):
        self.assertEqual(A.report_for(self.LAUNCH, A.Observation(A.EXITED, 3))["outcome"], "failed")
        refused = A.report_for(self.LAUNCH, A.Observation(A.NOT_STARTED))
        self.assertEqual(refused, {"outcome": "refused",
                                   "evidence": {"kind": "declined", "reason": "no_handler"}})

    def test_cancellation_is_a_promise_this_computer_can_keep(self):
        stopped = A.report_for(self.LAUNCH, A.Observation(A.STOPPED))
        self.assertEqual(stopped["outcome"], "cancelled")
        self.assertFalse(stopped["evidence"]["opened"])

    def test_a_report_is_compact_utf8_json(self):
        self.assertEqual(A.report_bytes({"outcome": "unknown", "evidence": {"kind": "open", "opened": False}}),
                         b'{"outcome":"unknown","evidence":{"kind":"open","opened":false}}')


class LedgerTest(unittest.TestCase):
    def test_a_repeat_recalls_the_same_report_and_never_a_second_effect(self):
        ledger = A.Ledger(retention=600.0)
        report = {"outcome": "completed", "evidence": {"kind": "open", "opened": True}}
        ledger.remember("k", report, 1000.0)
        self.assertEqual(ledger.recall("k", 1100.0), report)
        self.assertIsNone(ledger.recall("other", 1100.0))

    def test_a_recalled_report_cannot_be_mutated_through_the_ledger(self):
        ledger = A.Ledger()
        ledger.remember("k", {"outcome": "completed", "evidence": {}}, 0.0)
        recalled = ledger.recall("k", 0.0)
        recalled["outcome"] = "failed"
        self.assertEqual(ledger.recall("k", 0.0)["outcome"], "completed")

    def test_the_retention_window_ends(self):
        ledger = A.Ledger(retention=600.0)
        ledger.remember("k", {"outcome": "unknown", "evidence": {}}, 1000.0)
        self.assertIsNone(ledger.recall("k", 1601.0))
        self.assertEqual(len(ledger), 0)


class ProcessLauncherTest(unittest.TestCase):
    """The one impure part: a detached process, a scrubbed environment, no shell."""

    def test_the_environment_carries_only_what_a_desktop_launcher_needs(self):
        launcher = A.ProcessLauncher()
        environment = launcher.environment()
        self.assertNotIn("COSMOS_SURFACE_LIBRARY", environment)
        self.assertTrue(set(environment) <= {
            "PATH", "HOME", "LANG", "LC_ALL", "USER", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY",
            "HYPRLAND_INSTANCE_SIGNATURE"})

    def test_a_program_that_is_not_there_is_observed_as_never_started(self):
        launcher = A.ProcessLauncher(observe_seconds=2.0)
        launcher.start(A.Launch(argv=("/nonexistent/cosmos-opener", "x")))
        observation = self.settle(launcher)
        self.assertEqual(observation.kind, A.NOT_STARTED)

    def test_a_launcher_that_exits_is_observed_with_its_status(self):
        launcher = A.ProcessLauncher(observe_seconds=5.0)
        launcher.start(A.Launch(argv=("/usr/bin/true",)))
        self.assertEqual(self.settle(launcher), A.Observation(A.EXITED, 0))
        launcher.start(A.Launch(argv=("/usr/bin/false",)))
        self.assertEqual(self.settle(launcher).kind, A.EXITED)

    def test_a_launcher_still_running_at_the_budget_is_unobserved(self):
        launcher = A.ProcessLauncher(observe_seconds=0.2)
        launcher.start(A.Launch(argv=("/bin/sleep", "5")))
        observation = self.settle(launcher, timeout=8.0)
        self.assertEqual(observation.kind, A.UNOBSERVED)
        launcher.stop()

    def test_stopping_a_running_launch_is_reported_as_stopped(self):
        launcher = A.ProcessLauncher(observe_seconds=10.0)
        launcher.start(A.Launch(argv=("/bin/sleep", "10")))
        deadline = self.deadline(4.0)
        while launcher._process is None and deadline():
            pass
        launcher.stop()
        self.assertEqual(self.settle(launcher).kind, A.STOPPED)

    @staticmethod
    def deadline(seconds: float):
        import time
        end = time.monotonic() + seconds
        return lambda: time.monotonic() < end

    def settle(self, launcher, timeout: float = 6.0):
        import time
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            observation = launcher.poll()
            if observation is not None:
                return observation
            time.sleep(0.02)
        self.fail("the launcher never said what it observed")


if __name__ == "__main__":
    unittest.main()
