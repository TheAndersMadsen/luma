"""Selection capture: bounded, optional, never on the UI thread's terms."""
import subprocess
import unittest

from cosmos_linux import context
from cosmos_linux.context import MAX_APP_BYTES, MAX_CONTEXT_BYTES, ScreenContext, app_from_window, bounded_context


class BoundsTest(unittest.TestCase):
    def test_text_is_cut_on_a_character_boundary_at_8000_bytes(self):
        text = "é" * 5000  # 10,000 bytes
        bounded = bounded_context("Mail", text)
        self.assertTrue(bounded.truncated)
        self.assertEqual(len(bounded.text.encode("utf-8")), MAX_CONTEXT_BYTES)
        self.assertEqual(bounded.text, "é" * 4000)
        exact = bounded_context("Mail", "x" * MAX_CONTEXT_BYTES)
        self.assertFalse(exact.truncated)
        self.assertEqual(len(exact.text), MAX_CONTEXT_BYTES)

    def test_app_name_is_bounded_and_defaults(self):
        self.assertEqual(bounded_context("", "hello").app, "Unknown app")
        self.assertEqual(bounded_context("  \n ", "hello").app, "Unknown app")
        self.assertEqual(bounded_context("Google   Chrome\n", "hello").app, "Google Chrome")
        long_name = bounded_context("A" * 100, "hello").app
        self.assertEqual(len(long_name.encode("utf-8")), MAX_APP_BYTES)

    def test_empty_or_nul_only_text_attaches_nothing(self):
        self.assertIsNone(bounded_context("Mail", ""))
        self.assertIsNone(bounded_context("Mail", "   \n\t"))
        self.assertIsNone(bounded_context("Mail", "\0\0"))
        self.assertEqual(bounded_context("Ma\0il", "a\0b").text, "ab")
        self.assertEqual(bounded_context("Ma\0il", "a\0b").app, "Mail")

    def test_app_from_hyprland_window_json(self):
        self.assertEqual(app_from_window('{"class": "firefox", "title": "Inbox"}'), "firefox")
        self.assertEqual(app_from_window('{"class": "", "initialClass": "", "title": " Inbox "}'), "Inbox")
        self.assertEqual(app_from_window("not json"), "")
        self.assertEqual(app_from_window("[1, 2]"), "")
        self.assertEqual(app_from_window("{}"), "")


class Recorder:
    """A fake subprocess.run with canned output per command."""

    def __init__(self, outputs: dict, timeouts=()):
        self.outputs = outputs
        self.timeouts = set(timeouts)
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((tuple(command), kwargs.get("timeout")))
        key = tuple(command)
        if key in self.timeouts:
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout") or 0)
        output = self.outputs.get(key)
        if output is None:
            return subprocess.CompletedProcess(command, 1, b"", b"")
        return subprocess.CompletedProcess(command, 0, output, b"")


def which_all(name: str):
    return f"/usr/bin/{name}"


class CaptureTest(unittest.TestCase):
    PRIMARY = ("wl-paste", "--primary", "--no-newline")
    CLIPBOARD = ("wl-paste", "--no-newline")
    WINDOW = ("hyprctl", "activewindow", "-j")

    def test_primary_selection_wins_and_the_active_window_names_the_app(self):
        runner = Recorder({self.PRIMARY: b"selected words", self.CLIPBOARD: b"clipboard words",
                           self.WINDOW: b'{"class":"Mail"}'})
        captured = context.capture(runner, which_all)
        self.assertEqual(captured, ScreenContext(app="Mail", text="selected words"))
        self.assertEqual([call[0] for call in runner.calls], [self.PRIMARY, self.WINDOW])
        self.assertTrue(all(timeout is not None and timeout <= 2.0 for _, timeout in runner.calls), "always bounded")
        self.assertEqual(runner.calls[0][1], context.PASTE_TIMEOUT)

    def test_clipboard_is_the_fallback_when_nothing_is_highlighted(self):
        runner = Recorder({self.PRIMARY: b"   ", self.CLIPBOARD: b"from clipboard"})
        captured = context.capture(runner, which_all)
        self.assertEqual(captured.text, "from clipboard")
        self.assertEqual(captured.app, "Unknown app", "hyprctl output missing keeps the default")

    def test_nothing_selected_or_no_tool_attaches_nothing(self):
        self.assertIsNone(context.capture(Recorder({}), which_all))
        self.assertIsNone(context.capture(Recorder({self.PRIMARY: b"text"}), lambda name: None))
        self.assertFalse(context.available(lambda name: None))
        self.assertTrue(context.available(which_all))

    def test_timeouts_and_failures_never_raise(self):
        runner = Recorder({self.CLIPBOARD: b"late but fine"}, timeouts=[self.PRIMARY, self.WINDOW])
        captured = context.capture(runner, which_all)
        self.assertEqual(captured.text, "late but fine")

        def broken(command, **kwargs):
            raise OSError("no exec")

        self.assertIsNone(context.capture(broken, which_all))

    def test_huge_selection_is_bounded_before_decoding(self):
        runner = Recorder({self.PRIMARY: b"x" * 100_000})
        captured = context.capture(runner, which_all)
        self.assertTrue(captured.truncated)
        self.assertEqual(len(captured.text), MAX_CONTEXT_BYTES)

    def test_hyprctl_is_skipped_without_the_tool(self):
        runner = Recorder({self.PRIMARY: b"words", self.WINDOW: b'{"class":"Mail"}'})
        captured = context.capture(runner, lambda name: "/usr/bin/wl-paste" if name == "wl-paste" else None)
        self.assertEqual(captured.app, "Unknown app")
        self.assertNotIn(self.WINDOW, [call[0] for call in runner.calls])


if __name__ == "__main__":
    unittest.main()
