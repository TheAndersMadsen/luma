import unittest

from cosmos_linux.events import InvalidEvent, decode

from .fixtures import ACTION_ID, admission, descriptor, encode, places_card, snapshot, speech_reply, text_card


class EventDecodingTest(unittest.TestCase):
    def test_prepare_snapshot_decodes_with_a_linux_descriptor(self):
        event = decode(encode(snapshot("prepare")))
        self.assertEqual(event.operation, "prepare")
        self.assertTrue(event.ok)
        self.assertEqual(event.descriptor.platform, "linux")
        self.assertEqual(event.descriptor.approval, "native-shared-speech-v3")
        self.assertTrue(event.needs_reconnect)
        self.assertIsNone(event.display)

    def test_foreign_descriptor_is_rejected(self):
        for change in ({"platform": "macos"}, {"approval": "native-display-v1"}, {"publicKey": "short"}):
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


if __name__ == "__main__":
    unittest.main()
