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


if __name__ == "__main__":
    unittest.main()
