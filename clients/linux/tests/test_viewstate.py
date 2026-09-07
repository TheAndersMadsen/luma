"""The words on screen, mapped from wire facts by pure functions."""
import unittest

from cosmos_linux import strings as S
from cosmos_linux import viewstate
from cosmos_linux.events import TurnStatus
from cosmos_linux.viewstate import EMPTY_LINE, Line, destination_for, destinations, status_line

from .fixtures import TURN_ID


def turn(state: str, platform=None) -> TurnStatus:
    return TurnStatus(turn_id=TURN_ID, generation=2, state=state, surface_platform=platform, privacy="shared_room")


class StatusLineTest(unittest.TestCase):
    def test_vocabulary_for_every_state_and_surface(self):
        previous = Line("Working")
        cases = {
            ("working", None): Line("Working"),
            ("working", "macos"): Line("Working"),
            ("waiting", "linux"): Line("Waiting for you"),
            ("waiting", None): Line("Waiting for a device"),
            ("waiting", "android"): Line("Waiting for a device", "Waiting for your phone"),
            ("shown", "linux"): Line("Completed"),
            ("shown", "macos"): Line("Completed", "Shown on your MacBook"),
            ("shown", "android_tv"): Line("Completed", "Shown on your TV"),
            ("shown", "browser"): Line("Completed", "Shown on your browser"),
            ("spoken", "android"): Line("Completed", "Spoken on your phone"),
            ("spoken", "pin"): Line("Completed", "Spoken on your Ai Pin"),
            ("spoken", "linux"): Line("Completed"),
            ("nowhere", None): Line("Cannot confirm", S.CANNOT_CONFIRM_DETAIL),
            ("unknown", "macos"): previous,
        }
        for (state, platform), expected in cases.items():
            with self.subTest(state=state, platform=platform):
                self.assertEqual(status_line(turn(state, platform), previous), expected)

    def test_unknown_keeps_the_previous_line_and_none_clears_it(self):
        self.assertEqual(status_line(turn("unknown"), Line("Completed", "Shown on your MacBook")),
                         Line("Completed", "Shown on your MacBook"))
        self.assertEqual(status_line(turn("unknown"), EMPTY_LINE), EMPTY_LINE)
        self.assertEqual(status_line(None, Line("Working")), EMPTY_LINE)

    def test_line_text_joins_with_a_middle_dot(self):
        self.assertEqual(Line("Completed", "Shown on your MacBook").text, "Completed · Shown on your MacBook")
        self.assertEqual(Line("Working").text, "Working")
        self.assertEqual(Line("", "Connected").text, "Connected")

    def test_no_technical_words_reach_the_owner(self):
        for state in ("working", "waiting", "shown", "spoken", "nowhere"):
            for platform in (None, "macos", "android", "android_tv", "browser", "linux"):
                line = status_line(turn(state, platform), EMPTY_LINE).text
                for banned in ("turn", "generation", "incarnation", "uuid", "_", "{", "}", "null"):
                    self.assertNotIn(banned, line.lower(), line)


class DestinationTest(unittest.TestCase):
    def test_no_destination_is_the_default_and_says_nothing(self):
        """Cosmos chooses the screen from what the answer is, so the picker opens on
        no destination at all and the chip is silent until the owner names one."""
        entries = destinations()
        self.assertIsNone(entries[0].target)
        self.assertEqual(entries[0].name, "Wherever it fits")
        self.assertEqual(entries[0].chip, "", "nothing is said while no destination is named")
        self.assertEqual(destination_for(None).chip, "")
        self.assertEqual(destination_for("plan9").chip, "", "an unknown target names no destination")

    def test_naming_a_device_is_an_override_that_stays_available(self):
        entries = destinations()
        self.assertEqual([entry.name for entry in entries],
                         ["Wherever it fits", "MacBook Pro", "Pixel 10 Pro", "Shield TV"])
        self.assertEqual([entry.target for entry in entries], [None, "macos", "android", "android_tv"])
        self.assertTrue(all(entry.online for entry in entries))
        self.assertEqual(destination_for("android").chip, "→ Pixel 10 Pro")

    def test_this_computer_is_never_an_entry(self):
        """Naming the device the request came from earns nothing in the runtime's
        ranking, so offering it would be a promise this client cannot keep."""
        self.assertNotIn("linux", [entry.target for entry in destinations()])
        self.assertNotIn("This screen", [entry.name for entry in destinations()])

    def test_room_members_replace_the_defaults_and_keep_offline_ones_greyed(self):
        members = [
            {"platform": "android", "name": "Pixel 10 Pro", "online": False},
            {"platform": "linux", "name": "Omarchy", "online": True},
            {"platform": "macos", "name": "MacBook Pro", "online": True},
            {"platform": "browser", "name": "Chrome"},
        ]
        entries = destinations(members)
        self.assertEqual([entry.name for entry in entries], ["Wherever it fits", "Pixel 10 Pro", "MacBook Pro"])
        self.assertEqual([entry.online for entry in entries], [True, False, True])
        self.assertIsNone(entries[0].target)

    def test_targets_match_the_shared_library_grammar(self):
        self.assertEqual(viewstate.TARGETS, ("macos", "android", "android_tv"))


class ChipsAndPromptsTest(unittest.TestCase):
    def test_context_label_names_the_app(self):
        self.assertEqual(viewstate.context_label("Mail"), "Using: Mail selection")

    def test_example_prompts_offer_the_screen_only_where_context_exists(self):
        self.assertEqual(viewstate.example_prompts(False), ("Find cafés near me", "Show my notes about the kitchen"))
        self.assertEqual(viewstate.example_prompts(True)[-1], "What's on my screen?")

    def test_digit_keys_pick_choices_within_bounds(self):
        self.assertEqual(viewstate.choice_for_key("1", 3), 0)
        self.assertEqual(viewstate.choice_for_key("3", 3), 2)
        self.assertIsNone(viewstate.choice_for_key("4", 3))
        self.assertIsNone(viewstate.choice_for_key("0", 3))
        self.assertIsNone(viewstate.choice_for_key("a", 3))
        self.assertIsNone(viewstate.choice_for_key("12", 8))

    def test_strings_map_is_flat_and_complete(self):
        table = S.as_map()
        for key in ("WORKING", "WAITING_FOR_YOU", "WAITING_FOR_DEVICE", "COMPLETED", "CANNOT_CONFIRM", "DISCONNECTED",
                    "RECONNECTING", "CONNECTED", "USE_SELECTION", "CANCEL_TASK", "CLOSE", "SCREEN_CONTEXT_OFF"):
            self.assertIn(key, table)
        self.assertEqual(table["DEVICE_NAMES"]["android"], "phone")


if __name__ == "__main__":
    unittest.main()
