import contextlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("prepare_whisper", Path(__file__).with_name("prepare_whisper.py"))
whisper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(whisper)

ORIGINAL = b"first\nabort here\nlast\n"
PATCH = b"--- a/src/whisper.cpp\n+++ b/src/whisper.cpp\n@@ -1,3 +1,3 @@\n first\n-abort here\n+return instead\n last\n"
PATCHED = b"first\nreturn instead\nlast\n"
PREFIX = whisper.CRATE + "/whisper.cpp/"


def bundle(extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data, kind in [
                (PREFIX + "CMakeLists.txt", b"# fixture\n", tarfile.REGTYPE),
                (PREFIX + "src/whisper.cpp", ORIGINAL, tarfile.REGTYPE),
                *extra]:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(data) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = "../../outside"
            archive.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    return output.getvalue()


def manifest(data):
    return {**whisper.load_manifest(), "bytes": len(data), "sha256": whisper.sha256(data),
            "patchSha256": whisper.sha256(PATCH), "originalSourceSha256": whisper.sha256(ORIGINAL),
            "patchedSourceSha256": whisper.sha256(PATCHED)}


@contextlib.contextmanager
def fixture(data=None):
    data = bundle() if data is None else data
    contract = manifest(data)
    with tempfile.TemporaryDirectory() as directory, patch.object(whisper, "load_manifest", return_value=contract), patch.object(whisper, "load_patch", return_value=PATCH):
        yield Path(directory), contract, data


class WhisperInputs(unittest.TestCase):
    def test_pinned_manifest_and_checked_in_patch_agree(self):
        contract = whisper.load_manifest()
        self.assertEqual(contract["bytes"], 1757612)
        self.assertEqual(contract["sha256"], "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f")
        self.assertEqual(whisper.sha256(whisper.load_patch(contract)), contract["patchSha256"])

    def test_verified_patch_is_materialized_and_reused_without_network(self):
        with fixture() as (cache, contract, data), patch.object(whisper, "download", side_effect=lambda output, _: output.write(data)) as fetch:
            root = whisper.prepare(cache)
            self.assertEqual((root / "src/whisper.cpp").read_bytes(), PATCHED)
            self.assertTrue((root / "CMakeLists.txt").is_file())
            self.assertEqual(whisper.prepare(cache), root)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual((cache / (contract["crate"] + ".crate")).read_bytes(), data)
            self.assertFalse(any(item.name.startswith(".") for item in cache.iterdir()))

    def test_bad_download_is_never_published(self):
        good = bundle()
        for bad in [good[:-1], good + b"extra", bytes([good[0] ^ 1]) + good[1:]]:
            with self.subTest(size=len(bad)), fixture(good) as (cache, _, _), patch.object(whisper, "download", side_effect=lambda output, _, bad=bad: output.write(bad)):
                with self.assertRaises(ValueError):
                    whisper.prepare(cache)
                self.assertEqual([item.name for item in cache.iterdir()], ["whisper.lock"])

    def test_existing_archive_tamper_and_symlink_fail_without_replacement(self):
        with fixture() as (cache, contract, data), patch.object(whisper, "download") as fetch:
            archive = cache / (contract["crate"] + ".crate")
            archive.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                whisper.prepare(cache)
            self.assertEqual(archive.read_bytes(), b"changed")
            archive.unlink()
            original = cache / "original"
            original.write_bytes(data)
            archive.symlink_to(original)
            with self.assertRaises(ValueError):
                whisper.prepare(cache)
            self.assertEqual(fetch.call_count, 0)

    def test_cached_sources_must_match_complete_patched_archive(self):
        mutations = ["changed", "missing", "extra", "symlink", "directory", "root_symlink"]
        for mutation in mutations:
            with self.subTest(mutation=mutation), fixture() as (cache, _, data), patch.object(whisper, "download", side_effect=lambda output, _: output.write(data)) as fetch:
                root = whisper.prepare(cache)
                source = root / "src/whisper.cpp"
                if mutation == "changed":
                    source.write_bytes(ORIGINAL)
                elif mutation == "missing":
                    source.unlink()
                elif mutation == "extra":
                    (root / "extra.cpp").write_bytes(b"unexpected compiler input")
                elif mutation == "symlink":
                    source.unlink()
                    source.symlink_to(root / "CMakeLists.txt")
                elif mutation == "directory":
                    (root / "extra").mkdir()
                else:
                    moved = cache / "moved"
                    root.rename(moved)
                    root.symlink_to(moved, target_is_directory=True)
                with self.assertRaises(ValueError):
                    whisper.prepare(cache)
                self.assertEqual(fetch.call_count, 1)
                self.assertFalse(any(item.name.startswith(".") for item in cache.iterdir()))

    def test_unsafe_members_fail_before_any_source_is_materialized(self):
        extras = [
            (PREFIX + "../../escape", b"escape", tarfile.REGTYPE),
            ("/escape", b"escape", tarfile.REGTYPE),
            ("other/file", b"escape", tarfile.REGTYPE),
            (PREFIX + "bad\\file", b"escape", tarfile.REGTYPE),
            (PREFIX + "src/whisper.cpp", b"duplicate", tarfile.REGTYPE),
            (PREFIX + "link", b"", tarfile.SYMTYPE),
            (PREFIX + "hardlink", b"", tarfile.LNKTYPE),
            (PREFIX + "fifo", b"", tarfile.FIFOTYPE),
            (PREFIX + "./hidden", b"escape", tarfile.REGTYPE),
        ]
        for extra in extras:
            with self.subTest(member=extra[0], kind=extra[2]), fixture(bundle([extra])) as (cache, contract, data), patch.object(whisper, "download", side_effect=lambda output, _: output.write(data)):
                with self.assertRaises(ValueError):
                    whisper.prepare(cache)
                self.assertEqual(sorted(item.name for item in cache.iterdir()), [contract["crate"] + ".crate", "whisper.lock"])

    def test_archive_expansion_member_count_and_member_size_are_bounded(self):
        for name, bound in [("MAX_EXPANDED", 1024), ("MAX_MEMBERS", 1), ("MAX_FILE", 1)]:
            with self.subTest(bound=name), fixture() as (cache, contract, data), patch.object(whisper, name, bound):
                archive = cache / "archive.crate"
                archive.write_bytes(data)
                with self.assertRaises(ValueError):
                    whisper.compiler_inputs(archive, contract, PATCH)

    def test_missing_required_source_and_patch_mismatch_never_publish_tree(self):
        for field in ["patchSha256", "originalSourceSha256", "patchedSourceSha256"]:
            with self.subTest(field=field), fixture() as (cache, contract, data), patch.object(whisper, "download", side_effect=lambda output, _: output.write(data)):
                contract[field] = "0" * 64
                with self.assertRaises(ValueError):
                    whisper.prepare(cache)
                self.assertFalse(any(item.is_dir() for item in cache.iterdir()))
                self.assertFalse(any(item.name.startswith(".") for item in cache.iterdir()))
        with fixture() as (cache, contract, data):
            archive = cache / "archive.crate"
            archive.write_bytes(data)
            contract["nativePrefix"] += "missing/"
            with self.assertRaisesRegex(ValueError, "missing required"):
                whisper.compiler_inputs(archive, contract, PATCH)

    def test_patch_requires_exact_positions_context_counts_and_headers(self):
        cases = [
            PATCH.replace(b"abort here", b"different"),
            PATCH.replace(b"-1,3", b"-2,3"),
            PATCH.replace(b"+1,3", b"+2,3"),
            PATCH.replace(b"-1,3", b"-1,4"),
            PATCH.replace(b"b/src/whisper.cpp", b"b/other.cpp"),
            PATCH.split(b"@@")[0],
        ]
        for changed in cases:
            with self.subTest(patch=changed), self.assertRaises(ValueError):
                whisper.apply_patch(ORIGINAL, changed)

    def test_checkout_cache_and_insecure_redirects_are_rejected(self):
        with self.assertRaises(ValueError):
            whisper.prepare(Path(__file__).resolve().parents[2] / "whisper-cache-fixture")
        for url in ["http://example.invalid/source", "https://secret@example.invalid/source"]:
            with self.assertRaises(ValueError):
                whisper.HttpsRedirects().redirect_request(None, None, 302, "redirect", {}, url)

    def test_network_body_size_headers_and_deadline_are_bounded(self):
        class Response(io.BytesIO):
            url = "https://example.invalid/source"
            headers = {}

        contract = manifest(b"fixture")
        for data in [b"fixture-extra", b"short"]:
            with self.subTest(data=data), patch.object(whisper.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value = Response(data)
                with self.assertRaises(ValueError):
                    whisper.download(io.BytesIO(), contract)
        with patch.object(whisper.urllib.request, "build_opener") as opener:
            response = Response(b"fixture")
            response.headers = {"Content-Length": "8"}
            opener.return_value.open.return_value = response
            with self.assertRaises(ValueError):
                whisper.download(io.BytesIO(), contract)
        with patch.object(whisper.urllib.request, "build_opener") as opener, patch.object(whisper.time, "monotonic", side_effect=[0, 181]):
            opener.return_value.open.return_value = Response(b"fixture")
            output = io.BytesIO()
            with self.assertRaises(TimeoutError):
                whisper.download(output, contract)
            self.assertEqual(output.getvalue(), b"")

    def test_wall_deadline_interrupts_a_blocked_network_open_and_cleans_download(self):
        with fixture() as (cache, _, _), patch.object(whisper, "DOWNLOAD_SECONDS", 0.02), patch.object(whisper.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = lambda *_args, **_kwargs: threading.Event().wait(1)
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                whisper.prepare(cache)
            self.assertEqual([item.name for item in cache.iterdir()], ["whisper.lock"])


if __name__ == "__main__":
    unittest.main()
