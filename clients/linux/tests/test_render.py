"""Qt offscreen render of every preview state: the QML loads without a single
warning and paints a real frame.

PySide6 is not a dependency of the host Python the CLI uses, so the render
uses the client's own venv when one exists: COSMOS_LINUX_PYTHON, the venv
under the external build directory (REVIVAL_BUILD_DIR/linux-client/venv), or
the current interpreter when it can import PySide6. Skipped otherwise.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from cosmos_linux.app import VIEWS

CLIENT = Path(__file__).resolve().parent.parent
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IGNORED = ("font family", "does not support raise", "QStandardPaths", "xkbcommon", "Populating font")


def render_python():
    explicit = os.environ.get("COSMOS_LINUX_PYTHON")
    candidates = [Path(explicit)] if explicit else []
    build = Path(os.environ.get("REVIVAL_BUILD_DIR") or Path.home() / ".local/share/ai-pin-revival/build")
    candidates.append(build / "linux-client" / "venv" / "bin" / "python")
    for candidate in candidates:
        if candidate.is_file():
            probe = subprocess.run([str(candidate), "-c", "import PySide6"], capture_output=True)
            if probe.returncode == 0:
                return candidate
    try:
        import PySide6  # noqa: F401
    except ImportError:
        return None
    return Path(sys.executable)


PYTHON = render_python()


@unittest.skipUnless(PYTHON is not None, "no Python with PySide6 (set COSMOS_LINUX_PYTHON)")
class OffscreenRenderTest(unittest.TestCase):
    def test_file_picker_callback_attaches_literal_filename_and_sends_original_bytes(self):
        environment = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software",
                       "QT_QUICK_CONTROLS_STYLE": "Basic", "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(
            [str(PYTHON), "-B", "-c", "from tests.test_render import attachment_scenario; attachment_scenario()"],
            cwd=CLIENT, env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_real_document_frame_completes_the_matching_task_once(self):
        environment = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software",
                       "QT_QUICK_CONTROLS_STYLE": "Basic", "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(
            [str(PYTHON), "-B", "-c", "from tests.test_render import document_scenario; document_scenario()"],
            cwd=CLIENT, env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_transferred_document_frame_renders_without_a_destination_file(self):
        environment = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software",
                       "QT_QUICK_CONTROLS_STYLE": "Basic", "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(
            [str(PYTHON), "-B", "-c", "from tests.test_render import document_scenario; document_scenario(transferred=True)"],
            cwd=CLIENT, env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def render(self, kind: str, output: Path, extra_env: dict = None) -> str:
        environment = {
            **os.environ, "QT_QPA_PLATFORM": "offscreen", "QT_QUICK_BACKEND": "software",
            "PYTHONDONTWRITEBYTECODE": "1", "QT_LOGGING_RULES": "qt.qpa.fonts=false", **(extra_env or {}),
        }
        result = subprocess.run(
            [str(PYTHON), "-B", "-m", "cosmos_linux", "--preview", kind, "--screenshot", str(output),
             "--screenshot-delay", "300"],
            cwd=CLIENT, env=environment, capture_output=True, text=True, timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.is_file(), kind)
        self.assertEqual(output.read_bytes()[:8], PNG_MAGIC, kind)
        self.assertGreater(output.stat().st_size, 10_000, "a painted frame, not a blank one")
        return "\n".join(line for line in result.stderr.splitlines()
                         if line.strip() and not any(marker in line for marker in IGNORED))

    def test_every_preview_renders_without_qml_warnings(self):
        with tempfile.TemporaryDirectory() as temporary:
            for kind in VIEWS:
                with self.subTest(kind=kind):
                    noise = self.render(kind, Path(temporary) / f"{kind}.png")
                    self.assertEqual(noise, "", f"{kind}: {noise}")

    def test_light_theme_and_reduced_motion_render(self):
        with tempfile.TemporaryDirectory() as temporary:
            noise = self.render("connected", Path(temporary) / "light.png",
                                {"COSMOS_THEME": "light", "COSMOS_REDUCED_MOTION": "1"})
            self.assertEqual(noise, "")


def attachment_scenario():
    """Exercise the actual dialog signal, queued file read, chip and request."""
    import hashlib
    import json
    from PySide6.QtCore import QMetaObject, QObject, QTimer, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlApplicationEngine
    from cosmos_linux import strings as S
    from cosmos_linux.app import PACKAGE_DIR, make_backend_class, theme_tokens
    from tests.test_attachment import AttachmentControllerTest
    from tests.fixtures import policy_document

    application = QGuiApplication([])
    harness = AttachmentControllerTest()
    harness.setUp()
    try:
        file = harness.root / "<b>draft.txt"
        body = b"Original saved version\r\n"
        file.write_bytes(body)
        harness.connected()
        harness.deliver(policy_document(roots=({'id': 'docs', 'label': 'Documents', 'path': str(harness.root)},)))
        backend = make_backend_class()(harness.controller, "Synthetic test", True)
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("backend", backend)
        engine.rootContext().setContextProperty("theme", theme_tokens())
        engine.rootContext().setContextProperty("S", S.as_map())
        engine.load(QUrl.fromLocalFile(str(PACKAGE_DIR / "qml" / "Main.qml")))
        window = engine.rootObjects()[0]
        choice = window.findChild(QObject, "attachFileChoice")
        picker = window.findChild(QObject, "fileAttachment")
        attach = window.findChild(QObject, "attachText")
        assert attach is not None and attach.property("enabled")
        assert QMetaObject.invokeMethod(attach, "clicked")
        application.processEvents()
        assert choice is not None and choice.property("visible"), "the file choice is visible when Attach opens"
        assert picker is not None and picker.setProperty("selectedFile", QUrl.fromLocalFile(str(file)))
        assert QMetaObject.invokeMethod(picker, "accepted")
        assert harness.state.context_busy and not harness.state.can_send
        errors = []
        finished = False

        def check():
            nonlocal finished
            try:
                if harness.state.context_busy:
                    return
                context = harness.state.context
                assert context is not None, harness.state.message
                assert not harness.commands("send_text_with_document"), "selection uploads nothing"
                label = "Using: <b>draft.txt"
                chips = [item for item in window.findChildren(QObject, "chipLabel") if item.property("text") == label]
                assert len(chips) == 1
                assert engine.newQObject(chips[0]).property("textFormat").toInt() == 0, "filenames must be literal text"
                file.write_text("A newer version")
                backend.setTarget("macos")
                assert backend.send("Explain this on my Mac")
                request = harness.commands("send_text_with_document")[-1]
                assert request[3].encode() == body and request[4] == "macos"
                assert json.loads(request[5])["version"] == hashlib.sha256(body).hexdigest()
                finished = True
                application.quit()
            except Exception as error:
                errors.append(error)
                application.quit()

        timer = QTimer()
        timer.timeout.connect(check)
        timer.start(30)
        QTimer.singleShot(5000, application.quit)
        application.exec()
        timer.stop()
        window.hide()
        if errors:
            raise errors[0]
        assert finished, "the picker callback never completed the attachment"
    finally:
        harness.controller.shutdown()
        harness.doCleanups()


def document_scenario(transferred=False):
    """Actual QML layout/frame-swap against a synthetic admitted command.

    Exercises the renderer/bridge/controller together, with no enrolled device
    or private request. This is not a physical handoff acceptance test.
    """
    from PySide6.QtCore import QObject, QTimer, QUrl
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlApplicationEngine
    from cosmos_linux import strings as S
    from cosmos_linux.app import PACKAGE_DIR, make_backend_class, theme_tokens
    from tests.test_device_actions import HandoffTest
    from tests.fixtures import TASK_ID, revoked

    application = QGuiApplication([])
    harness = HandoffTest()
    harness.setUp()
    try:
        source = "😀 Heading\n" + "\n".join(f"Line {line}" for line in range(2, 101))
        if transferred:
            harness.document.unlink()
            task = harness.transferred_act(source, line=70)
        else:
            harness.document.write_text(source, encoding="utf-8")
            task = harness.act(position={"kind": "line", "line": 70})
        harness.connected()
        harness.show()
        harness.fold(task=task)
        harness.settle("acknowledge_task")
        expected = harness.state.document
        assert harness.commands("report") == []
        backend = make_backend_class()(harness.controller, "Synthetic test", True)
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("backend", backend)
        engine.rootContext().setContextProperty("theme", theme_tokens())
        engine.rootContext().setContextProperty("S", S.as_map())
        engine.load(QUrl.fromLocalFile(str(PACKAGE_DIR / "qml" / "Main.qml")))
        window = engine.rootObjects()[0]
        window.frameSwapped.connect(backend.frame_painted)
        window.requestActivate()
        errors = []
        finished = False

        def check():
            nonlocal finished
            try:
                harness.controller.drain()
                reports = harness.commands("report")
                if not reports:
                    window.update()
                    return
                assert len(reports) == 1 and reports[0][1]["outcome"] == "completed", reports
                assert reports[0][1]["evidence"]["documentDigest"] == expected.digest
                harness.settle("report")
                assert harness.state.task.phase == "done"
                editor = window.findChild(QObject, "documentText")
                assert editor is not None and editor.property("text") == expected.text
                assert editor.property("cursorPosition") == expected.cursor
                harness.fold(revoked=revoked())
                assert harness.state.document is None
                backend.documentRendered(TASK_ID, expected.digest, expected.line)
                backend.frame_painted()
                assert len(harness.commands("report")) == 1, "a stale frame cannot report twice"
                finished = True
                application.quit()
            except Exception as error:
                errors.append(error)
                application.quit()

        timer = QTimer()
        timer.timeout.connect(check)
        timer.start(30)
        QTimer.singleShot(5000, application.quit)
        application.exec()
        timer.stop()
        window.hide()
        if errors:
            raise errors[0]
        assert finished, "the actual QML document/line frame never completed"
    finally:
        harness.controller.shutdown()
        harness.doCleanups()


if __name__ == "__main__":
    unittest.main()
