from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "hygiene", ROOT / "verify" / "hygiene.py"
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StandaloneHygieneTests(unittest.TestCase):
    def test_a_source_tree_without_git_is_still_checked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "-----BEGIN " + "PRIVATE KEY-----\nnot-a-real-key\n",
                encoding="utf-8",
            )

            self.assertEqual(MODULE.check(root), ["private key: README.md"])

    def test_generated_output_is_excluded_but_source_keys_are_not(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "target").mkdir()
            (root / "target" / "generated.key").write_text("generated", encoding="utf-8")
            (root / "operator.key").write_text("must fail", encoding="utf-8")

            self.assertEqual(MODULE.check(root), ["forbidden artifact: operator.key"])


if __name__ == "__main__":
    unittest.main()
