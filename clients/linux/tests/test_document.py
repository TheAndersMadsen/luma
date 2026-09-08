"""Immutable byte/position handling, independent of Qt or a live connection."""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import document as D


def snapshot(data: bytes, position=None):
    return D.from_bytes(data, hashlib.sha256(data).hexdigest(), position)


class DocumentTest(unittest.TestCase):
    def test_versions_hash_the_original_bytes_and_cursor_counts_utf16(self):
        data = "😀 First line\r\nNext line\r\n".encode("utf-8")
        result = snapshot(data, {"kind": "line", "line": 2})
        self.assertEqual(result.text, "😀 First line\nNext line\n")
        self.assertEqual(result.digest, hashlib.sha256(data).hexdigest())
        self.assertEqual(result.cursor, 14)
        self.assertNotIn("Next line", repr(result))

    def test_markup_is_inert_text_and_an_empty_document_has_a_first_line(self):
        data = b'<img src="https://example.test/image"><script>nothing()</script>'
        self.assertEqual(snapshot(data).text.encode(), data)
        self.assertEqual(snapshot(b"").cursor, 0)

    def test_changed_bytes_unsupported_positions_and_non_text_do_not_get_substituted(self):
        with self.assertRaises(D.Unavailable) as mismatch:
            D.from_bytes(b"changed", "a" * 64, None)
        self.assertEqual(mismatch.exception.reason, "version_changed")
        for data, position in ((b"a\n", {"kind": "line", "line": 3}),
                               (b"a", {"kind": "line", "line": True}),
                               (b"a", {"kind": "page", "page": 1}),
                               (b"a", {"kind": "fragment", "value": "a"}),
                               (b"\xff", None), (b"a\x00b", None),
                               (b"a" * (D.MAX_BYTES + 1), None)):
            with self.subTest(position=position, length=len(data)), self.assertRaises(D.Unavailable):
                snapshot(data, position)

    def test_read_uses_one_bounded_regular_file_and_retains_no_path(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "notes.txt"
            path.write_bytes(b"original\n")
            result = D.read(str(path), hashlib.sha256(b"original\n").hexdigest(), None)
            path.write_bytes(b"changed\n")
            self.assertEqual(result.text, "original\n")
            self.assertNotIn(str(path), repr(result))
            link = Path(root) / "link"
            link.symlink_to(path)
            with self.assertRaises(D.Unavailable):
                D.read(str(link), result.digest, None)
            fifo = Path(root) / "pipe"
            os.mkfifo(fifo)
            with self.assertRaises(D.Unavailable):
                D.read(str(fifo), result.digest, None)
