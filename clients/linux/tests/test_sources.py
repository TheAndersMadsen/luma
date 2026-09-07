"""Every module compiles, and the Qt-free modules import without Qt."""
import json
import os
import py_compile
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "cosmos_linux"


class SourcesTest(unittest.TestCase):
    def test_every_module_compiles(self):
        modules = sorted(PACKAGE.glob("*.py"))
        self.assertGreaterEqual(len(modules), 15)
        with tempfile.TemporaryDirectory() as temporary:
            for module in modules:
                py_compile.compile(str(module), cfile=os.path.join(temporary, module.name + "c"), doraise=True)
        self.assertFalse((PACKAGE / "__pycache__").exists() and os.environ.get("PYTHONDONTWRITEBYTECODE") == "1")

    def test_qml_and_assets_are_shipped(self):
        for relative in ("qml/Main.qml", "qml/SetupView.qml", "qml/ApprovalView.qml", "qml/ConnectedView.qml",
                         "qml/CosmosPanel.qml", "qml/CosmosWaveform.qml", "qml/CosmosButton.qml", "qml/Chip.qml",
                         "qml/ChoiceList.qml", "qml/DestinationPicker.qml", "qml/Disclosure.qml",
                         "qml/PresenceLine.qml", "qml/TaskCard.qml", "qml/ConfirmDialog.qml",
                         "assets/cosmos-logo.png", "assets/nebula-bottom.png",
                         "assets/panel-frame.png", "assets/design-tokens.json", "assets/KIT-LICENSE.md"):
            self.assertTrue((PACKAGE / relative).is_file(), relative)
        licence = (PACKAGE / "assets" / "KIT-LICENSE.md").read_text(encoding="utf-8")
        self.assertIn("MIT License", licence)
        self.assertIn("Asset provenance", licence)

    def test_pure_modules_do_not_import_qt(self):
        import cosmos_linux.app as app
        import cosmos_linux.context  # noqa: F401
        import cosmos_linux.controller as controller
        import cosmos_linux.events as events
        import cosmos_linux.actions  # noqa: F401
        import cosmos_linux.native as native
        import cosmos_linux.policy as policy
        import cosmos_linux.strings  # noqa: F401
        import cosmos_linux.viewstate as viewstate
        self.assertNotIn("PySide6", sys.modules)
        self.assertEqual(app.view_for(controller.State(), False, False), "setup")
        preview = app.preview_state("connected")
        self.assertEqual(app.view_for(preview, True, False), "connected")
        self.assertEqual(app.view_for(app.preview_state("approval"), True, False), "approval")
        for kind in app.VIEWS:
            self.assertIsInstance(app.preview_state(kind), controller.State, kind)
        self.assertEqual(app.preview_state("choices").display.kind, "choices")
        self.assertEqual(app.preview_state("choices").presence.title, "Waiting for you")
        self.assertEqual(app.preview_state("working").presence.title, "Working")
        self.assertEqual(app.preview_state("reconnecting").presence.text, "Disconnected · Reconnecting…")
        self.assertEqual(app.preview_state("empty").presence.text, "Connected")
        tokens = app.theme_tokens(True)
        self.assertEqual(tokens["accent"], "#27E6DF")
        self.assertTrue(tokens["dark"])
        self.assertFalse(app.theme_tokens(False)["dark"])
        self.assertEqual(set(app.LIGHT_COLORS), {key for key in tokens if key in app.LIGHT_COLORS})
        self.assertEqual(app.credit_line_html(preview.display.credits[0]),
                         'Data from <a href="https://maps.google.com/">Google Maps</a>')
        self.assertEqual(app.credit_line_html([events.CreditPart("text", "<b>&")]), "&lt;b&gt;&amp;")
        self.assertEqual(native.MAX_EVENT_BYTES, 16384)
        # Every preview the check renders is a real state, the new cards included.
        self.assertEqual(app.preview_state("task").task.phase, "working")
        self.assertEqual(app.preview_state("refused").task.phase, "refused")
        self.assertIsNotNone(app.preview_state("ceremony").confirmation)
        self.assertTrue(app.preview_state("ceremony").ceremony_open)
        # A preview is a state the controller would accept: its words bind.
        self.assertTrue(controller.Controller._words_bind(app.preview_state("ceremony").confirmation))
        self.assertFalse(viewstate.ceremony(app.preview_state("ceremony-locked").confirmation, 21).can_confirm)
        # The example the CLI prints is an openers file this client would read.
        self.assertTrue(policy.parse_openers(json.loads(policy.example_document())).loaded)
        # The permission itself is not a file: it arrives on the connection.
        self.assertEqual(app.policy_notice(app.preview_state("task")), "")
        # The foreground report is what releases a card Cosmos held for this
        # computer, and keyboard focus is no part of it.
        self.assertTrue(app.window_in_front(shown=True, hidden=False, exposed=True))
        self.assertFalse(app.window_in_front(shown=False, hidden=False, exposed=True))
        self.assertFalse(app.window_in_front(shown=True, hidden=True, exposed=True))
        self.assertFalse(app.window_in_front(shown=True, hidden=False, exposed=False))


if __name__ == "__main__":
    unittest.main()
