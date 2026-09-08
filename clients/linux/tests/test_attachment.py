import dataclasses
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cosmos_linux.attachment import AttachmentError, read_file
from cosmos_linux.context import ScreenContext
from cosmos_linux.native import Features
from cosmos_linux.policy import Policy, Root
from .fixtures import FakeSurface, admission, policy_document
from .test_device_actions import DeviceActionHarness


class FileCaptureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.path = self.root / 'notes.txt'
        self.policy = Policy('surface', 1, roots=(Root('docs', 'Documents', str(self.root)),))

    def test_complete_original_bytes_and_version_travel_together_without_a_destination_path(self):
        body = 'First line\r\nSecond 🚀 line\r\n'.encode()
        self.path.write_bytes(body)
        result = read_file(str(self.path), self.policy)
        handle = json.loads(result.document)
        self.assertEqual(result.text.encode(), body)
        self.assertEqual(handle['version'], hashlib.sha256(body).hexdigest())
        self.assertEqual(handle['locator'], {'scheme': 'file', 'rootId': 'docs', 'relative': 'notes.txt'})
        self.assertFalse(result.truncated)
        self.assertNotIn(str(self.root).encode(), result.document)

    def test_permission_is_required_before_opening_any_file(self):
        with patch('cosmos_linux.attachment.os.open', side_effect=AssertionError('unexpected read')):
            for policy in (None, self.policy):
                with self.assertRaises(AttachmentError):
                    read_file('/outside/the/approved/root.txt', policy)

    def test_invalid_or_oversized_files_never_become_a_partial_attachment(self):
        for body in (b'', b' \r\n', b'x' * 8001, b'\xff', b'a\0b', b'a\rb', b'"' * 6000):
            with self.subTest(size=len(body)):
                self.path.write_bytes(body)
                with self.assertRaises(AttachmentError):
                    read_file(str(self.path), self.policy)

    def test_nonregular_files_and_symlink_escapes_are_refused(self):
        os.mkfifo(self.path)
        with self.assertRaises(AttachmentError):
            read_file(str(self.path), self.policy)
        self.path.unlink()
        with tempfile.TemporaryDirectory() as outside:
            other = Path(outside) / 'outside.txt'
            other.write_text('Outside the selected root')
            self.path.symlink_to(other)
            with self.assertRaises(AttachmentError):
                read_file(str(self.path), self.policy)

    def test_most_specific_approved_root_names_the_file(self):
        folder = self.root / 'nested'
        folder.mkdir()
        file = folder / 'notes.txt'
        file.write_text('Saved text')
        policy = dataclasses.replace(self.policy, roots=(*self.policy.roots, Root('nested', 'Nested', str(folder))))
        self.assertEqual(json.loads(read_file(str(file), policy).document)['locator']['rootId'], 'nested')


class AttachmentControllerTest(DeviceActionHarness):
    def setUp(self):
        super().setUp()
        previous = FakeSurface.features
        FakeSurface.features = Features(targets=True, context=True, actions=True, document=True)
        self.addCleanup(setattr, FakeSurface, 'features', previous)

    def ready(self):
        self.connected()
        self.deliver(policy_document(roots=({'id': 'notes', 'label': 'Notes', 'path': '/tmp'},)))
        self.assertTrue(self.controller.begin_context_capture(document=True))
        return self.controller.capture_token

    @staticmethod
    def attachment():
        return ScreenContext(app='Text file', text='Original\r\n', source='file', label='notes.txt',
                             document=b'{"app":"Text file","locator":{"scheme":"file","rootId":"notes","relative":"notes.txt"},"label":"notes.txt"}')

    def test_exact_document_call_settles_and_consumes_the_attachment_only_after_admission(self):
        token = self.ready()
        self.assertFalse(self.controller.send('Too early'))
        context = self.attachment()
        self.controller.context_captured(context, token)
        self.controller.set_target('macos')
        self.assertTrue(self.controller.send('Explain this on my Mac'))
        self.assertEqual(self.commands('send_text_with_document')[-1][1:],
                         ('Explain this on my Mac', context.app, context.text, 'macos', context.document))
        self.fold(operation='send_text_with_document', admission=admission())
        self.assertIsNone(self.state.context)
        self.assertFalse(self.state.busy)

    def test_discarded_capture_cannot_replace_a_newer_one(self):
        old = self.ready()
        self.controller.drop_context()
        self.assertTrue(self.controller.begin_context_capture(document=True))
        current = self.controller.capture_token
        self.controller.context_captured(self.attachment(), old)
        self.assertTrue(self.state.context_busy)
        self.assertIsNone(self.state.context)
        self.controller.context_captured(self.attachment(), current)
        self.assertIsNotNone(self.state.context)

    def test_permission_change_retires_pending_file_content(self):
        self.permission_change(attached=False)

    def test_permission_change_retires_attached_file_content(self):
        self.permission_change(attached=True)

    def permission_change(self, *, attached):
        token = self.ready()
        if attached:
            self.controller.context_captured(self.attachment(), token)
        self.deliver(policy_document(revision=2))
        self.controller.context_captured(self.attachment(), token)
        self.assertIsNone(self.state.context)
        self.assertFalse(self.state.context_busy)

    def test_disconnect_discards_the_file_and_a_late_read_cannot_restore_it(self):
        token = self.ready()
        self.fold(operation='disconnect', connected=False)
        self.controller.context_captured(self.attachment(), token)
        self.assertIsNone(self.state.context)
        self.assertFalse(self.state.context_busy)


if __name__ == '__main__':
    unittest.main()
