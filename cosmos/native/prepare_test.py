import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class NativeInputs(unittest.TestCase):
    def test_verified_bytes_and_complete_materialized_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "input.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("fixture/lib/libwebrtc.a", b"synthetic archive")
                bundle.writestr("fixture/include/example.h", b"synthetic header")
            expected = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            prepare.verify(archive, expected)
            prepare.extract(archive, root, "fixture")
            prepare.verify_materialized(archive, root / "fixture")
            (root / "fixture/include/example.h").write_bytes(b"different header")
            with self.assertRaises(ValueError):
                prepare.verify_materialized(archive, root / "fixture")
            with self.assertRaises(ValueError):
                prepare.verify(archive, {**expected, "sha256": "0" * 64})

    def test_archive_paths_and_links_rejected_before_extraction(self):
        for name, mode in [("fixture/../../escape", 0), ("/escape", 0), ("other/file", 0), ("fixture/link", 0o120777)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "input.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    info = zipfile.ZipInfo(name)
                    info.external_attr = mode << 16
                    bundle.writestr(info, "test")
                with self.assertRaises(ValueError):
                    prepare.extract(archive, root, "fixture")
                self.assertFalse((root / "fixture").exists())

    def test_extra_files_and_symlinks_are_not_compiler_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "input.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("fixture/header.h", b"original")
            prepare.extract(archive, root, "fixture")
            extra = root / "fixture/extra.h"
            extra.write_text("extra")
            with self.assertRaises(ValueError):
                prepare.verify_materialized(archive, root / "fixture")
            extra.unlink()
            extra.symlink_to(root / "fixture/header.h")
            with self.assertRaises(ValueError):
                prepare.verify_materialized(archive, root / "fixture")


if __name__ == "__main__":
    unittest.main()
