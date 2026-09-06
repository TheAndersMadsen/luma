"""Every module compiles, and the Qt-free modules import without Qt."""
import os
import py_compile
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "cosmos_linux"


class SourcesTest(unittest.TestCase):
    def test_every_module_compiles(self):
        modules = sorted(PACKAGE.glob("*.py"))
        self.assertGreaterEqual(len(modules), 10)
        with tempfile.TemporaryDirectory() as temporary:
            for module in modules:
                py_compile.compile(str(module), cfile=os.path.join(temporary, module.name + "c"), doraise=True)
        self.assertFalse((PACKAGE / "__pycache__").exists() and os.environ.get("PYTHONDONTWRITEBYTECODE") == "1")

    def test_qml_and_assets_are_shipped(self):
        for relative in ("qml/Main.qml", "qml/SetupView.qml", "qml/ApprovalView.qml", "qml/ConnectedView.qml",
                         "qml/CosmosPanel.qml", "qml/CosmosWaveform.qml", "qml/CosmosButton.qml",
                         "assets/cosmos-logo.png", "assets/nebula-bottom.png", "assets/panel-frame.png"):
            self.assertTrue((PACKAGE / relative).is_file(), relative)

    def test_pure_modules_do_not_import_qt(self):
        import cosmos_linux.app as app
        import cosmos_linux.controller as controller
        import cosmos_linux.events as events
        import cosmos_linux.native as native
        self.assertEqual(app.view_for(controller.State(), False, False), "setup")
        preview = app.preview_state("connected")
        self.assertEqual(app.view_for(preview, True, False), "connected")
        self.assertEqual(app.view_for(app.preview_state("approval"), True, False), "approval")
        self.assertEqual(app.credit_line_html(preview.display.credits[0]),
                         'Data from <a href="https://maps.google.com/">Google Maps</a>')
        self.assertEqual(app.credit_line_html([events.CreditPart("text", "<b>&")]), "&lt;b&gt;&amp;")
        self.assertEqual(native.MAX_EVENT_BYTES, 16384)


if __name__ == "__main__":
    unittest.main()
