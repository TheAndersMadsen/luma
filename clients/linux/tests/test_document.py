"""Immutable byte/position handling, independent of Qt or a live connection."""
import hashlib
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import document as D
from cosmos_linux import actions as A
from cosmos_linux import events as E
from cosmos_linux import policy as P
from .fixtures import snapshot as state_snapshot, policy_document, APPROVAL_REVISION


def snapshot(data: bytes, position=None):
    return D.from_bytes(data, hashlib.sha256(data).hexdigest(), position)


class DocumentTest(unittest.TestCase):
    def test_transferred_document_decodes_and_renders_without_a_destination_file(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / "contracts" / "fixtures" /
                              "ambiance-document-snapshot-v1.json").read_text())
        wire = dict(fixture["frame"]["command"])
        wire["expiresAtMs"] = wire.pop("expiresAt")
        wire["reportByMs"] = wire.pop("reportBy")
        raw_policy = policy_document(surface_id=wire["surfaceId"],
                                     roots=[{"id": "notes", "label": "Notes", "path": "/no/destination/files"}])
        policy = P.parse_policy(raw_policy, surface_id=wire["surfaceId"], approval_revision=APPROVAL_REVISION,
                                digest=hashlib.sha256(raw_policy).hexdigest())
        def decode(value):
            return E.decode(json.dumps(state_snapshot("task", connected=True, task=value)).encode()).task
        task = decode(wire)
        self.assertEqual(A.content_digest(task.operation), fixture["contentDigest"])
        def no_files(*args, **kwargs):
            self.fail("snapshot delivery must not resolve a destination path")
        result = A.plan(task, policy, resolve=no_files, which=no_files)
        self.assertTrue(result.bound)
        self.assertIsNone(result.launch)
        self.assertEqual(result.document.text, "This document has three lines.\n\nFirst line\nSecond 🚀 line\n<p>literal</p>")
        self.assertEqual(result.document.digest, fixture["document"]["version"])
        self.assertEqual(result.document.line, 2)
        self.assertEqual(result.document.cursor, len("This document has three lines.\n\nFirst line\n"))
        self.assertNotIn("Second 🚀 line", repr(task))
        self.assertFalse(A.plan(task, None).bound)
        for key in ("text", "explanation", "version", "taskId", "revision"):
            changed = copy.deepcopy(wire)
            changed["document"][key] = 3 if key == "revision" else "changed"
            with self.subTest(key=key), self.assertRaises(E.InvalidEvent):
                decode(changed)
        missing = copy.deepcopy(wire)
        missing.pop("document")
        with self.assertRaises(E.InvalidEvent):
            decode(missing)
        for key, value in (("rootId", "elsewhere"), ("audience", "00000000-0000-0000-0000-000000000004")):
            changed = copy.deepcopy(wire)
            locator = changed["operation"]["locator"]
            (locator if key == "rootId" else locator["content"])[key] = value
            changed["contentDigest"] = A.content_digest(changed["operation"])
            self.assertFalse(A.plan(decode(changed), policy).bound)

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
