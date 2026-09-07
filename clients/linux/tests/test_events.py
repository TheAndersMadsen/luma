import unittest

from cosmos_linux.events import APPROVAL_PROFILE, KNOWN_APPROVALS, InvalidEvent, decode
from cosmos_linux.native import MAX_POLICY_BYTES

from .fixtures import (
    ACTION_ID, APPROVAL_REVISION, SURFACE_ID, TURN_ID, admission, choices_card, descriptor, encode,
    places_card, policy_document, policy_record, snapshot, speech_reply, status, text_card,
)


class EventDecodingTest(unittest.TestCase):
    def test_prepare_snapshot_decodes_with_a_linux_descriptor(self):
        event = decode(encode(snapshot("prepare")))
        self.assertEqual(event.operation, "prepare")
        self.assertTrue(event.ok)
        self.assertEqual(event.descriptor.platform, "linux")
        self.assertEqual(event.descriptor.approval, "native-audience-v6")
        self.assertTrue(event.needs_reconnect)
        self.assertIsNone(event.display)

    def test_every_published_approval_rung_still_decodes(self):
        """The newest profile is what this build enrols at; an installation the owner
        approved earlier keeps its own, and the challenge carries that one."""
        self.assertEqual(APPROVAL_PROFILE, "native-audience-v6")
        self.assertEqual(KNOWN_APPROVALS, (
            "native-audience-v6", "native-voice-input-v5", "native-device-action-v4",
            "native-shared-speech-v3", "native-shared-display-v2",
        ))
        for approval in KNOWN_APPROVALS:
            event = decode(encode(snapshot("prepare", descriptor={**descriptor(), "approval": approval})))
            self.assertEqual(event.descriptor.approval, approval)

    def test_foreign_descriptor_is_rejected(self):
        for change in ({"platform": "macos"}, {"approval": "native-display-v1"},
                       {"approval": "native-audience-v7"}, {"publicKey": "short"}):
            with self.assertRaises(InvalidEvent):
                decode(encode(snapshot("prepare", descriptor={**descriptor(), **change})))

    def test_unknown_shapes_are_rejected(self):
        for value in (
            snapshot("teleport"),
            {**snapshot("connect"), "version": 2},
            {**snapshot("connect"), "kind": "event"},
            {**snapshot("connect"), "outcome": "error"},
            {**snapshot("connect"), "outcome": "ok", "error": "denied"},
            {**snapshot("connect"), "visible": "yes"},
            {**snapshot("connect"), "pending": {"kind": "teleport", "instanceId": ACTION_ID, "sequence": 1, "canRetry": True}},
            {**snapshot("connect"), "pending": {"kind": "text", "instanceId": ACTION_ID, "sequence": 0, "canRetry": True}},
            {**snapshot("connect"), "admission": {"turnId": "00000000-0000-0000-0000-000000000000", "generation": 1, "duplicate": False}},
        ):
            with self.assertRaises(InvalidEvent, msg=str(value)):
                decode(encode(value))
        with self.assertRaises(InvalidEvent):
            decode(b"\xff\xfe")

    def test_error_snapshot_keeps_its_static_code(self):
        event = decode(encode(snapshot("connect", error="denied")))
        self.assertFalse(event.ok)
        self.assertEqual(event.error, "denied")
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("connect", error="x" * 65)))

    def test_text_card_is_only_current_while_connected(self):
        connected = decode(encode(snapshot("display", connected=True, display=text_card())))
        self.assertEqual(connected.display.kind, "text")
        self.assertEqual(connected.display.text, "Hello from Cosmos")
        self.assertEqual(connected.display.action_id, ACTION_ID)
        dropped = decode(encode(snapshot("display", connected=False, display=text_card())))
        self.assertIsNone(dropped.display)

    def test_places_card_carries_inert_credit_tokens(self):
        event = decode(encode(snapshot("display", connected=True, display=places_card())))
        card = event.display
        self.assertEqual(card.kind, "places")
        self.assertEqual(card.query, "coffee")
        self.assertEqual([item.name for item in card.items], ["Prolog", "Andersen"])
        self.assertIsNone(card.items[1].source_url)
        self.assertEqual(card.credits[0][1].href, "https://maps.google.com/")
        self.assertEqual(card.credits[0][0].kind, "text")

    def test_card_bounds_are_enforced(self):
        insecure = places_card()
        insecure["credits"][0][1]["href"] = "http://maps.google.com/"
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=insecure)))
        mismatched = places_card()
        mismatched["credits"] = []
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=mismatched)))
        crowded = places_card()
        crowded["content"]["items"] = crowded["content"]["items"] * 3
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=crowded)))
        text_with_credit = text_card()
        text_with_credit["credits"] = [[{"kind": "text", "text": "x"}]]
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=text_with_credit)))
        bad_digest = text_card()
        bad_digest["contentDigest"] = "A" * 64
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=bad_digest)))

    def test_speech_reply_requires_audio_mpeg_and_bounds(self):
        event = decode(encode(snapshot("speech", connected=True, speech=speech_reply())))
        self.assertEqual(event.speech.byte_length, 5)
        self.assertEqual(event.speech.format, "audio/mpeg")
        for change in ({"format": "audio/wav"}, {"byteLength": 0}, {"byteLength": 1_048_577}, {"text": "   "}):
            with self.assertRaises(InvalidEvent, msg=str(change)):
                decode(encode(snapshot("speech", connected=True, speech={**speech_reply(), **change})))
        self.assertIsNone(decode(encode(snapshot("speech", connected=False, speech=speech_reply()))).speech)

    def test_private_cards_and_invitations_decode(self):
        plain = decode(encode(snapshot("display", connected=True, display=text_card())))
        self.assertEqual(plain.display.privacy, "shared_room")
        self.assertFalse(plain.display.private)
        private = decode(encode(snapshot("display", connected=True, display={**text_card(), "privacy": "private"})))
        self.assertTrue(private.display.private)
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display={**text_card(), "privacy": "secret"})))
        invitation = {"id": ACTION_ID, "origin": "pin", "privacy": "near_user", "expiresAtMs": 1_900_000_000_000}
        event = decode(encode(snapshot("invitation", connected=True, invitation=invitation)))
        self.assertEqual(event.invitation.origin, "pin")
        self.assertIsNone(decode(encode(snapshot("invitation", connected=False, invitation=invitation))).invitation)
        for change in ({"origin": "watch"}, {"privacy": "public"}):
            with self.assertRaises(InvalidEvent, msg=str(change)):
                decode(encode(snapshot("invitation", connected=True, invitation={**invitation, **change})))
        # A waiting task is not a waiting card. This computer's action channel
        # is capped at the shared class, so every task notice the runtime can
        # mint for it arrives there; refusing that class took the client out of
        # the session for the ordinary case of asking while the window is behind.
        for privacy in ("public", "shared_room", "near_user", "private"):
            task = {**invitation, "kind": "task", "privacy": privacy}
            event = decode(encode(snapshot("invitation", connected=True, invitation=task)))
            self.assertEqual(event.invitation.kind, "task", privacy)
            self.assertTrue(event.invitation.is_task, privacy)
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("invitation", connected=True,
                                   invitation={**invitation, "kind": "task", "privacy": "sensitive"})))
        # A waiting card stays personal at every class a shared surface could name.
        for privacy in ("public", "shared_room"):
            with self.assertRaises(InvalidEvent, msg=privacy):
                decode(encode(snapshot("invitation", connected=True,
                                       invitation={**invitation, "kind": "card", "privacy": privacy})))

    def test_admission_and_pending_decode(self):
        event = decode(encode(snapshot(
            "send_text", connected=True, admission=admission(),
            pending={"kind": "text", "instanceId": ACTION_ID, "sequence": 3, "canRetry": True},
            lastUnknown={"kind": "cancel", "instanceId": ACTION_ID, "sequence": 2, "canRetry": False},
            eventsSkipped=4,
        )))
        self.assertEqual(event.admission.generation, 2)
        self.assertTrue(event.pending.can_retry)
        self.assertEqual(event.last_unknown.kind, "cancel")
        self.assertEqual(event.events_skipped, 4)


    def test_choices_card_decodes_with_two_to_eight_items(self):
        event = decode(encode(snapshot("display", connected=True, display=choices_card())))
        card = event.display
        self.assertEqual(card.kind, "choices")
        self.assertEqual(card.title, "Which one?")
        self.assertEqual([item.id for item in card.items], ["1", "2", "3"])
        self.assertEqual(card.items[0].detail, "Best match")
        self.assertEqual(card.items[1].detail, "")
        self.assertEqual(len(decode(encode(snapshot("display", connected=True, display=choices_card(count=8)))).display.items), 8)
        for change in (
            lambda card: card["content"]["items"].pop(),
            lambda card: card["content"]["items"].pop(),
            lambda card: card["content"]["items"].extend(card["content"]["items"][:6]),
            lambda card: card["content"].__setitem__("title", "   "),
            lambda card: card["content"].__setitem__("query", "x"),
            lambda card: card["content"]["items"][0].__setitem__("title", " "),
            lambda card: card["content"]["items"][0].__setitem__("id", ""),
            lambda card: card["content"]["items"][0].__setitem__("href", "https://x"),
            lambda card: card["content"]["items"][0].__setitem__("detail", 3),
            lambda card: card.__setitem__("credits", [[{"kind": "text", "text": "x"}]]),
            # The runtime's own bounds: ids number the list, and the strings are
            # visible, bounded and free of control characters.
            lambda card: card["content"]["items"][1].__setitem__("id", "3"),
            lambda card: card["content"]["items"].reverse(),
            lambda card: card["content"].__setitem__("title", "t" * 121),
            lambda card: card["content"].__setitem__("title", "Which\none?"),
            lambda card: card["content"]["items"][0].__setitem__("title", "o" * 81),
            lambda card: card["content"]["items"][0].__setitem__("title", "Op\ttion"),
            lambda card: card["content"]["items"][0].__setitem__("detail", "d" * 201),
            lambda card: card["content"]["items"][0].__setitem__("detail", "de\ttail"),
        ):
            broken = choices_card(count=2)
            change(broken)
            with self.assertRaises(InvalidEvent, msg=str(broken["content"])):
                decode(encode(snapshot("display", connected=True, display=broken)))

    def test_choices_accept_the_runtime_maximums_exactly(self):
        card = choices_card(count=2)
        card["content"]["title"] = "t" * 120
        card["content"]["items"][0]["title"] = "o" * 80
        card["content"]["items"][0]["detail"] = "d" * 200
        decoded = decode(encode(snapshot("display", connected=True, display=card))).display
        self.assertEqual(len(decoded.title), 120)
        self.assertEqual(len(decoded.items[0].detail), 200)
        # Bounds are UTF-8 bytes, not characters, exactly as the runtime counts them.
        card["content"]["items"][0]["detail"] = "é" * 101
        with self.assertRaises(InvalidEvent):
            decode(encode(snapshot("display", connected=True, display=card)))

    def test_status_decodes_only_while_connected(self):
        event = decode(encode(snapshot("status", connected=True, status=status("shown", "macos"))))
        self.assertEqual(event.operation, "status")
        self.assertEqual(event.status.state, "shown")
        self.assertEqual(event.status.surface_platform, "macos")
        self.assertEqual(event.status.turn_id, TURN_ID)
        self.assertEqual(event.status.privacy, "shared_room")
        self.assertIsNone(decode(encode(snapshot("status", connected=True, status=None))).status)
        self.assertIsNone(decode(encode(snapshot("status", connected=False, status=status()))).status)
        self.assertIsNone(decode(encode(snapshot("heartbeat", connected=True))).status, "absent means none")
        private = decode(encode(snapshot("status", connected=True, status={**status(), "privacy": "sensitive"})))
        self.assertEqual(private.status.privacy, "sensitive")
        for change in ({"state": "teleported"}, {"surfacePlatform": "watch"}, {"surfacePlatform": 3},
                       {"privacy": "secret"}, {"generation": 0}, {"turnId": "nope"}):
            with self.assertRaises(InvalidEvent, msg=str(change)):
                decode(encode(snapshot("status", connected=True, status={**status(), **change})))

    def test_the_policy_the_snapshot_names_is_read_only_while_connected(self):
        record = policy_record(policy_document())
        event = decode(encode(snapshot("policy", connected=True, policy=record)))
        self.assertEqual(event.operation, "policy")
        self.assertEqual(event.policy.surface_id, SURFACE_ID)
        self.assertEqual((event.policy.approval_revision, event.policy.actions_revision), (APPROVAL_REVISION, 3))
        self.assertIsNone(event.policy.commands_revision, "this platform runs no commands")
        self.assertEqual(event.policy.byte_length, len(policy_document()))
        # Null is an ordinary state: this installation holds no copy at all, and
        # a copy never outlives the connection that carried it.
        self.assertIsNone(decode(encode(snapshot("policy", connected=True, policy=None))).policy)
        self.assertIsNone(decode(encode(snapshot("policy", connected=False, policy=record))).policy)
        self.assertIsNone(decode(encode(snapshot("heartbeat", connected=True))).policy, "absent means none")
        for change in ({"surfaceId": "nope"}, {"approvalRevision": 0}, {"digest": "F" * 64},
                       {"digest": "abc"}, {"byteLength": 0}, {"byteLength": MAX_POLICY_BYTES + 1},
                       {"actionsRevision": 0}, {"commandsRevision": "two"}):
            with self.assertRaises(InvalidEvent, msg=str(change)):
                decode(encode(snapshot("policy", connected=True, policy={**record, **change})))


if __name__ == "__main__":
    unittest.main()
