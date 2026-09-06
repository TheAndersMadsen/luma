import unittest

from cosmos_linux.controller import (
    COMMAND_DEADLINE, CONNECTED_MESSAGE, RECONNECT_DELAYS, Controller, Failure, Phase,
)
from cosmos_linux.native import QUEUE_FULL, NativeError

from .fixtures import (
    ACTION_ID, BOOT_EPOCH, ENROLLMENT_ID, SPEECH_ID, FakeIdentity, FakeJournal, FakePlayer, FakeScheduler,
    FakeSurface, admission, snapshot, speech_reply, text_card,
)


class ControllerHarness(unittest.TestCase):
    def setUp(self):
        FakeSurface.instances = []
        self.scheduler = FakeScheduler()
        self.player = FakePlayer()
        self.persisted = []
        self.creates = []
        self.queue_full_before_success = 0

        def factory(config, platform):
            self.creates.append(config)
            if self.queue_full_before_success > 0:
                self.queue_full_before_success -= 1
                raise NativeError(QUEUE_FULL, "create")
            return FakeSurface(config, platform)

        self.controller = Controller(
            surface_factory=factory, identity=FakeIdentity(), journal=FakeJournal(), scheduler=self.scheduler,
            player=self.player, boot_epoch=BOOT_EPOCH, persist_server=self.persisted.append,
        )
        self.changes = []
        self.controller.subscribe(self.changes.append)

    @property
    def surface(self) -> FakeSurface:
        return FakeSurface.instances[-1]

    @property
    def state(self):
        return self.controller.state

    def prepared(self):
        self.assertTrue(self.controller.prepare("https://Center.Andersmadsen.dk/"))
        self.surface.emit(snapshot("prepare"))
        self.controller.drain()
        return self.surface

    def connected(self):
        surface = self.prepared()
        self.scheduler.advance(RECONNECT_DELAYS[0])
        surface.emit(snapshot("connect", connected=True, needsReconnect=False))
        self.controller.drain()
        self.assertEqual(self.state.phase, Phase.CONNECTED)
        return surface

    def fold(self, value: dict):
        self.surface.emit(value)
        self.controller.drain()


class PrepareTest(ControllerHarness):
    def test_prepare_creates_the_native_client_with_public_configuration(self):
        surface = self.prepared()
        self.assertEqual(surface.config, {
            "version": 1, "serverOrigin": "https://center.andersmadsen.dk", "enrollmentId": ENROLLMENT_ID,
            "platform": "linux", "bootEpoch": BOOT_EPOCH,
        })
        self.assertEqual(self.state.phase, Phase.PREPARED)
        self.assertEqual(self.state.descriptor.enrollment_id, ENROLLMENT_ID)
        self.assertEqual(self.persisted, ["https://center.andersmadsen.dk"])
        self.assertFalse(self.state.busy)
        self.assertEqual(self.state.message, "Approve this public descriptor in Center, then connect.")

    def test_prepare_stays_busy_until_its_snapshot_folds(self):
        self.controller.prepare("https://center.andersmadsen.dk")
        self.assertEqual(self.state.phase, Phase.PREPARING)
        self.assertTrue(self.state.busy)
        self.controller.drain()
        self.assertTrue(self.state.busy)
        self.assertIsNone(self.state.descriptor)

    def test_invalid_server_never_creates_a_client(self):
        self.assertFalse(self.controller.prepare("http://center.example"))
        self.assertEqual(self.state.failure, Failure.INVALID_SERVER)
        self.assertEqual(self.creates, [])

    def test_queue_full_is_retried_after_the_native_slot_frees(self):
        self.queue_full_before_success = 2
        self.controller.prepare("https://center.andersmadsen.dk")
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(self.scheduler.pending_delays(), [0.3])
        self.scheduler.advance(0.3)
        self.scheduler.advance(0.3)
        self.assertEqual(len(self.creates), 3)
        self.assertEqual(len(FakeSurface.instances), 1)

    def test_descriptor_mismatch_blocks(self):
        self.controller.prepare("https://center.andersmadsen.dk")
        foreign = snapshot("prepare")
        foreign["descriptor"]["enrollmentId"] = "9f0f4c6a-6d4d-4a1e-9f7c-1d2a3b4c5d6e"
        self.fold(foreign)
        self.assertEqual(self.state.phase, Phase.BLOCKED)
        self.assertEqual(self.state.failure, Failure.INVALID_RESPONSE)

    def test_undecodable_snapshot_blocks(self):
        self.controller.prepare("https://center.andersmadsen.dk")
        self.surface.queue.append(b"{not json")
        self.controller.drain()
        self.assertEqual(self.state.phase, Phase.BLOCKED)
        self.assertEqual(self.state.message, Failure.INVALID_RESPONSE.message)

    def test_prepare_again_destroys_the_previous_client(self):
        first = self.prepared()
        self.assertTrue(self.controller.prepare("https://other.example"))
        self.assertTrue(first.destroyed)
        self.assertEqual(self.surface.config["serverOrigin"], "https://other.example")


class ReconnectTest(ControllerHarness):
    def test_retained_connection_is_rejoined_with_backoff_until_approved(self):
        surface = self.prepared()
        self.assertTrue(self.state.wants_connection)
        self.assertEqual(self.scheduler.pending_delays(), [1.5])
        observed = []
        for expected in (1.5, 3.0, 6.0, 12.0, 30.0, 30.0):
            self.assertEqual(self.scheduler.pending_delays(), [expected])
            observed.append(expected)
            self.scheduler.advance(expected)
            self.assertEqual(surface.commands[-1], "connect")
            self.assertEqual(self.state.phase, Phase.CONNECTING)
            self.fold(snapshot("connect", error="denied"))
            self.assertEqual(self.state.phase, Phase.PREPARED)
            self.assertEqual(self.state.failure, Failure.APPROVAL_REQUIRED)
            self.assertEqual(self.state.message, Failure.APPROVAL_REQUIRED.message)
            self.assertIn("Waiting for approval", self.state.status_text)
        self.assertEqual(observed, [1.5, 3.0, 6.0, 12.0, 30.0, 30.0])
        self.assertEqual(surface.commands.count("connect"), 6)

    def test_successful_connect_resets_backoff_and_rejoins_a_dropped_room(self):
        surface = self.connected()
        self.assertTrue(self.state.session_seen)
        self.assertEqual(self.state.message, CONNECTED_MESSAGE)
        self.assertEqual(self.scheduler.pending_delays(), [])
        self.fold(snapshot("heartbeat", connected=False))
        self.assertEqual(self.state.phase, Phase.PREPARED)
        self.assertEqual(self.state.message, "The Cosmos connection dropped. Reconnecting…")
        self.assertEqual(self.scheduler.pending_delays(), [1.5])
        self.scheduler.advance(1.5)
        self.assertEqual(surface.commands[-1], "connect")

    def test_explicit_disconnect_stops_automatic_rejoin(self):
        surface = self.connected()
        self.assertTrue(self.controller.disconnect())
        self.assertEqual(self.state.phase, Phase.DISCONNECTING)
        self.assertEqual(surface.commands[-1], "disconnect")
        self.fold(snapshot("disconnect", connected=False))
        self.assertEqual(self.state.phase, Phase.PREPARED)
        self.assertFalse(self.state.wants_connection)
        self.assertEqual(self.state.message, "Session disconnected. Owner approval remains in Center.")
        self.controller.drain()
        self.assertEqual(self.scheduler.pending_delays(), [])
        self.assertTrue(self.state.can_connect)

    def test_disconnect_waits_for_the_running_command(self):
        surface = self.connected()
        self.assertTrue(self.controller.send("hello"))
        self.assertTrue(self.controller.disconnect())
        self.assertEqual(surface.commands[-1], ("send_text", "hello"))
        self.fold(snapshot("send_text", connected=True, admission=admission()))
        self.assertEqual(surface.commands[-1], "disconnect")


class CommandTest(ControllerHarness):
    def test_commands_settle_only_when_their_own_snapshot_folds(self):
        surface = self.prepared()
        self.assertTrue(self.controller.connect())
        self.assertTrue(self.state.busy)
        self.assertEqual(self.scheduler.pending_delays(), [])
        for _ in range(3):
            self.controller.drain()
            self.assertTrue(self.state.busy)
        self.fold(snapshot("heartbeat"))
        self.assertTrue(self.state.busy, "a foreign snapshot never settles the command")
        self.assertEqual(self.state.phase, Phase.CONNECTING)
        self.fold(snapshot("connect", connected=True, needsReconnect=False))
        self.assertFalse(self.state.busy)
        self.assertEqual(self.state.phase, Phase.CONNECTED)
        self.assertEqual(surface.commands, ["connect"])

    def test_send_requires_a_connection_and_reports_admission(self):
        self.prepared()
        self.assertFalse(self.controller.send("hello"))
        surface = self.connected()
        sent = []
        self.controller.on_sent = sent.append
        self.assertFalse(self.controller.send("   "))
        self.assertEqual(self.state.failure, Failure.INVALID_TEXT)
        self.assertTrue(self.controller.send("What is the weather?"))
        self.assertEqual(surface.commands[-1], ("send_text", "What is the weather?"))
        self.assertFalse(self.controller.send("again"), "one command at a time")
        self.fold(snapshot("send_text", connected=True, admission=admission()))
        self.assertEqual(sent, [True])
        self.assertEqual(self.state.admission.turn_id, admission()["turnId"])
        self.assertTrue(self.state.can_cancel)
        self.assertTrue(self.controller.cancel())
        self.assertEqual(surface.commands[-1], "cancel")

    def test_refused_enqueue_reports_a_fixed_message(self):
        surface = self.connected()
        surface.refuse["send_text"] = QUEUE_FULL
        self.assertFalse(self.controller.send("hello"))
        self.assertEqual(self.state.failure, Failure.BUSY)
        self.assertFalse(self.state.busy)

    def test_visibility_is_deferred_behind_the_running_command(self):
        surface = self.prepared()
        self.controller.connect()
        self.controller.set_visible(True)
        self.assertEqual(surface.commands, ["connect"])
        self.fold(snapshot("connect", connected=True, needsReconnect=False))
        self.assertEqual(surface.commands[-1], ("set_visible", True))
        self.assertTrue(self.state.busy)
        self.fold(snapshot("set_visible", connected=True, needsReconnect=False, visible=True))
        self.assertTrue(self.state.visible)
        self.controller.set_visible(True)
        self.controller.drain()
        self.assertEqual(surface.commands.count(("set_visible", True)), 1)
        self.controller.set_visible(False)
        self.controller.drain()
        self.assertEqual(surface.commands[-1], ("set_visible", False))

    def test_pending_operation_pauses_new_requests(self):
        surface = self.connected()
        self.fold(snapshot("send_text", connected=True, needsReconnect=False, error="pending_operation",
                           pending={"kind": "text", "instanceId": ACTION_ID, "sequence": 3, "canRetry": True}))
        self.assertTrue(self.state.has_pending)
        self.assertEqual(self.state.failure, Failure.UNCERTAIN_REQUEST)
        self.assertFalse(self.state.can_send)
        self.assertTrue(self.state.can_retry_pending)
        self.assertTrue(self.controller.retry_pending())
        self.assertEqual(surface.commands[-1], "retry_pending")

    def test_command_deadline_marks_the_outcome_unknown(self):
        surface = self.connected()
        self.controller.send("hello")
        self.scheduler.now += COMMAND_DEADLINE + 1
        self.controller.drain()
        self.assertFalse(self.state.busy)
        self.assertTrue(self.state.has_pending)
        self.assertEqual(self.state.failure, Failure.UNCERTAIN_REQUEST)
        self.assertEqual(surface.commands[-1], ("send_text", "hello"))

    def test_callback_failures_refine_the_message(self):
        surface = self.connected()
        surface.callback_failure = "storage"
        self.fold(snapshot("send_text", connected=True, error="persistence"))
        self.assertEqual(self.state.failure, Failure.STORAGE_BLOCKED)
        self.assertEqual(self.state.phase, Phase.BLOCKED)
        self.assertTrue(self.state.can_retry)

    def test_shutdown_destroys_the_client(self):
        surface = self.connected()
        self.controller.shutdown()
        self.assertTrue(surface.destroyed)
        self.assertEqual(self.state.phase, Phase.DISCONNECTED)
        self.assertFalse(self.controller.has_surface)


class DisplayAndSpeechTest(ControllerHarness):
    def test_card_is_acknowledged_once_after_commit(self):
        surface = self.connected()
        self.fold(snapshot("display", connected=True, needsReconnect=False, display=text_card()))
        self.assertEqual(self.state.display.text, "Hello from Cosmos")
        self.assertEqual(self.state.message, "Cosmos delivered a card to this window.")
        self.assertNotIn("acknowledge", surface.commands)
        self.controller.display_committed("not-the-card")
        self.controller.drain()
        self.assertNotIn("acknowledge", surface.commands)
        self.controller.display_committed(ACTION_ID)
        self.controller.display_committed(ACTION_ID)
        self.controller.drain()
        self.assertEqual(surface.commands.count("acknowledge"), 1)
        self.fold(snapshot("acknowledge", connected=True, needsReconnect=False, display=text_card()))
        self.controller.display_committed(ACTION_ID)
        self.controller.drain()
        self.assertEqual(surface.commands.count("acknowledge"), 1)

    def test_private_invitation_and_card_are_named_without_content(self):
        surface = self.connected()
        invitation = {"id": ACTION_ID, "origin": "pin", "privacy": "private", "expiresAtMs": 1_900_000_000_000}
        self.fold(snapshot("invitation", connected=True, needsReconnect=False, invitation=invitation))
        self.assertEqual(self.state.invitation.origin, "pin")
        self.assertIn("private reply is waiting", self.state.message)
        self.fold(snapshot("display", connected=True, needsReconnect=False,
                           display={**text_card(), "privacy": "private"}))
        self.assertTrue(self.state.display.private)
        self.assertIn("private card", self.state.message)
        self.controller.display_committed(ACTION_ID)
        self.controller.drain()
        self.assertEqual(surface.commands[-1], "acknowledge")

    def test_retired_card_is_never_acknowledged(self):
        surface = self.connected()
        self.fold(snapshot("display", connected=True, needsReconnect=False, display=text_card()))
        self.controller.display_committed(ACTION_ID)
        self.fold(snapshot("display", connected=True, needsReconnect=False, display=None))
        self.assertNotIn("acknowledge", surface.commands)

    def test_speech_plays_once_and_acknowledges_only_complete_playback(self):
        surface = self.connected()
        surface.audio = b"mp3!!"
        self.fold(snapshot("speech", connected=True, needsReconnect=False, speech=speech_reply()))
        self.assertEqual(len(self.player.played), 1)
        self.assertEqual(self.player.played[0][1], b"mp3!!")
        self.assertTrue(self.state.speaking)
        self.assertEqual(self.state.status_text, "Connected · speaking")
        self.fold(snapshot("heartbeat", connected=True, needsReconnect=False, speech=speech_reply()))
        self.assertEqual(len(self.player.played), 1, "the same reply is not replayed")
        self.player.finish(True)
        self.assertFalse(self.state.speaking)
        self.controller.drain()
        self.assertEqual(surface.commands[-1], "acknowledge_speech")
        self.fold(snapshot("acknowledge_speech", connected=True, needsReconnect=False, speech=speech_reply()))
        self.controller.drain()
        self.assertEqual(surface.commands.count("acknowledge_speech"), 1)

    def test_interrupted_or_mismatched_speech_is_not_acknowledged(self):
        surface = self.connected()
        surface.audio = b"mp3!!"
        self.fold(snapshot("speech", connected=True, needsReconnect=False, speech=speech_reply()))
        self.player.finish(False)
        self.controller.drain()
        self.assertNotIn("acknowledge_speech", surface.commands)
        surface.audio = b"mp3"
        other = speech_reply(action_id=ACTION_ID, byte_length=5)
        self.fold(snapshot("speech", connected=True, needsReconnect=False, speech=other))
        self.assertEqual(len(self.player.played), 1, "bytes that do not match the snapshot are not played")

    def test_replaced_reply_stops_playback_without_acknowledging(self):
        surface = self.connected()
        surface.audio = b"mp3!!"
        self.fold(snapshot("speech", connected=True, needsReconnect=False, speech=speech_reply()))
        self.fold(snapshot("speech", connected=True, needsReconnect=False, speech=None))
        self.assertEqual(self.player.stopped, 1)
        self.assertFalse(self.state.speaking)
        self.player.finish(True)
        self.controller.drain()
        self.assertNotIn("acknowledge_speech", surface.commands)
        self.assertNotEqual(SPEECH_ID, ACTION_ID)


if __name__ == "__main__":
    unittest.main()
