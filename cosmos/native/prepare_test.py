import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

stt_spec = importlib.util.spec_from_file_location("prepare_stt", Path(__file__).with_name("prepare_stt.py"))
stt = importlib.util.module_from_spec(stt_spec)
stt_spec.loader.exec_module(stt)


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


class SttModelInputs(unittest.TestCase):
    def model(self):
        return {**stt.load_manifest(), "bytes": 7, "sha256": hashlib.sha256(b"fixture").hexdigest()}

    def test_verified_model_is_read_only_and_reused_without_network(self):
        model = self.model()
        with tempfile.TemporaryDirectory() as directory, patch.object(stt, "load_manifest", return_value=model):
            with patch.object(stt, "download", side_effect=lambda output, _: output.write(b"fixture")) as fetch:
                target = stt.prepare(Path(directory))
                self.assertEqual(target.read_bytes(), b"fixture")
                self.assertEqual(target.stat().st_mode & 0o777, 0o444)
                self.assertEqual(stt.prepare(Path(directory)), target)
                self.assertEqual(fetch.call_count, 1)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), [model["file"]])

    def test_bad_download_does_not_publish_or_leave_temporary_files(self):
        for data in [b"partial", b"wrong", b"fixture-too-long"]:
            with self.subTest(data=data), tempfile.TemporaryDirectory() as directory:
                with patch.object(stt, "load_manifest", return_value=self.model()), patch.object(stt, "download", side_effect=lambda output, _, data=data: output.write(data)):
                    with self.assertRaises(ValueError):
                        stt.prepare(Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_corrupt_existing_model_and_symlink_fail_without_replacement(self):
        model = self.model()
        with tempfile.TemporaryDirectory() as directory, patch.object(stt, "load_manifest", return_value=model), patch.object(stt, "download") as fetch:
            root = Path(directory)
            target = root / model["file"]
            target.write_bytes(b"altered")
            with self.assertRaises(ValueError):
                stt.prepare(root)
            self.assertEqual(target.read_bytes(), b"altered")
            target.unlink()
            source = root / "source"
            source.write_bytes(b"fixture")
            target.symlink_to(source)
            with self.assertRaises(ValueError):
                stt.prepare(root)
            self.assertEqual(fetch.call_count, 0)

    def test_source_directory_and_insecure_redirect_are_rejected(self):
        with self.assertRaises(ValueError):
            stt.prepare(Path(__file__).resolve().parents[2] / "model-fixture")
        for url in ["http://example.invalid/model", "https://secret@example.invalid/model"]:
            with self.assertRaises(ValueError):
                stt.HttpsRedirects().redirect_request(None, None, 302, "redirect", {}, url)

    def test_network_stream_size_and_deadline_are_bounded_before_publication(self):
        class Response(io.BytesIO):
            url = "https://example.invalid/model"
            headers = {}

        model = self.model()
        for data in [b"fixture-extra", b"short"]:
            with self.subTest(data=data), tempfile.TemporaryDirectory() as directory, patch.object(stt, "load_manifest", return_value=model):
                with patch.object(stt.urllib.request, "build_opener") as opener:
                    opener.return_value.open.return_value = Response(data)
                    with self.assertRaises(ValueError):
                        stt.prepare(Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])
        with patch.object(stt.urllib.request, "build_opener") as opener, patch.object(stt.time, "monotonic", side_effect=[0, 181]):
            opener.return_value.open.return_value = Response(b"fixture")
            output = io.BytesIO()
            with self.assertRaises(TimeoutError):
                stt.download(output, model)
            self.assertEqual(output.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()
