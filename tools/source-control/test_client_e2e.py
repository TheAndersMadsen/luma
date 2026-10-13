"""User workflow evidence through the actual CLI, HTTP server, and Git remote."""
import hashlib
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from server import Store, GitBridge, make_server


class ClientWorkflowE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.remote = self.root / 'origin.git'
        self.original = self.root / 'original'
        self.git(self.root, 'init', '--bare', '-q', str(self.remote))
        self.git(self.root, 'init', '-q', '-b', 'main', str(self.original))
        self.git(self.original, 'config', 'user.name', 'CLI workflow test')
        self.git(self.original, 'config', 'user.email', 'cli@localhost')
        (self.original / 'cosmos').mkdir()
        (self.original / 'center').mkdir()
        (self.original / '.gitignore').write_text('*.log\n.env*\nnode_modules/\n')
        (self.original / 'cosmos/one.txt').write_text('first\nsecond\nthird\n')
        (self.original / 'cosmos/remove.txt').write_text('remove\n')
        (self.original / 'center/keep.txt').write_text('kept outside sparse\n')
        self.git(self.original, 'add', '.')
        self.git(self.original, 'commit', '-qm', 'Initial fixture')
        self.git(self.original, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.original, 'push', '-q', 'origin', 'main')
        self.store = Store(self.root / 'state')
        self.bridge = GitBridge(self.store, str(self.remote))
        self.http = make_server(self.store, self.bridge, 'client-e2e-owner', '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = 'http://127.0.0.1:' + str(self.http.server_port)
        self.token = self.root / 'token'
        self.token.write_text('client-e2e-owner')
        self.token.chmod(0o600)
        self.workspace = self.root / 'workspace'
        self.env = dict(os.environ, LUMA_SCM_CACHE=str(self.root / 'cache'))
        self.cli('api', 'POST', '/v1/github/import', '--json', '{}')
        self.cli('checkout', str(self.workspace), '--prefix', 'cosmos/', '--ref', 'work/cli', '--branch', 'scion/cli')

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.store.close()
        self.tmp.cleanup()

    @staticmethod
    def git(path, *args):
        return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.PIPE).decode().strip()

    def cli(self, *args, fail=False):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('client.py')),
            '--endpoint', self.endpoint, '--token-file', str(self.token), '--json', *args],
            cwd=self.workspace if self.workspace.exists() else self.root, env=self.env, capture_output=True, text=True)
        if fail:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertNotIn('Traceback', result.stderr)
            self.assertNotIn('client-e2e-owner', result.stderr)
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    @contextlib.contextmanager
    def lost_response(self, route):
        """Real network proxy delivers one write, then drops only its response."""
        upstream, dropped = self.endpoint, []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.forward()
            def do_POST(self):
                self.forward()
            def forward(self):
                data = self.rfile.read(int(self.headers.get('Content-Length', 0))) if self.command == 'POST' else None
                req = urllib.request.Request(upstream + self.path, method=self.command, data=data,
                    headers={key: self.headers[key] for key in ('Authorization', 'Content-Type') if key in self.headers})
                with urllib.request.urlopen(req) as response:
                    body, status, content_type = response.read(), response.status, response.headers['Content-Type']
                if self.command == 'POST' and self.path == route and not dropped:
                    dropped.append(True)
                    self.close_connection = True
                    return
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=proxy.serve_forever, daemon=True)
        worker.start()
        self.endpoint = 'http://127.0.0.1:' + str(proxy.server_port)
        try:
            yield
            self.assertTrue(dropped, 'The test never dropped the intended response')
        finally:
            self.endpoint = upstream
            proxy.shutdown()
            proxy.server_close()
            worker.join()

    def test_sparse_edit_publish_update_and_status(self):
        self.assertFalse((self.workspace / 'center').exists())
        self.assertTrue((self.workspace / '.gitignore').exists())
        (self.workspace / 'cosmos/one.txt').write_text('FIRST\nsecond\nthird\n')
        (self.workspace / 'cosmos/remove.txt').unlink()
        (self.workspace / 'cosmos/script').write_text('#!/bin/sh\nexit 0\n')
        (self.workspace / 'cosmos/script').chmod(0o755)
        (self.workspace / 'cosmos/link').symlink_to('one.txt')
        (self.workspace / 'cosmos/noise.log').write_text('ignored')
        (self.workspace / 'cosmos/.env').write_text('private')
        changed = self.cli('status')['changes']
        self.assertEqual({x['path'] for x in changed}, {'cosmos/one.txt', 'cosmos/remove.txt', 'cosmos/script', 'cosmos/link'})
        self.cli('update', fail=True)
        committed = self.cli('commit', '-m', 'Sparse edits')
        self.assertEqual(committed['publication']['branch'], 'scion/cli')
        self.assertFalse(self.cli('status')['changes'])
        files = self.cli('api', 'GET', '/v1/files?at=' + committed['id'])['files']
        self.assertIn('center/keep.txt', {x['path'] for x in files})
        self.assertEqual(next(x for x in files if x['path'] == 'cosmos/script')['mode'], '100755')
        self.assertEqual(next(x for x in files if x['path'] == 'cosmos/link')['mode'], '120000')
        self.cli('sync')
        self.assertEqual(self.git(self.remote, 'show', 'scion/cli:cosmos/one.txt'), 'FIRST\nsecond\nthird')
        (self.original / 'cosmos/one.txt').write_text('first\nsecond\nTHIRD\n')
        self.git(self.original, 'commit', '-qam', 'GitHub contributor change')
        self.git(self.original, 'push', '-q', 'origin', 'main')
        self.cli('sync')
        self.cli('update')
        self.assertEqual((self.workspace / 'cosmos/one.txt').read_text(), 'FIRST\nsecond\nTHIRD\n')
        self.assertEqual((self.workspace / 'cosmos/.env').read_text(), 'private')
        self.cli('publish')
        self.cli('sync')
        self.assertEqual(self.git(self.remote, 'show', 'scion/cli:cosmos/one.txt'), 'FIRST\nsecond\nTHIRD')
        self.assertFalse(self.cli('status')['changes'])
        print(json.dumps({'evidence': 'client-sparse-publish-main-merge', 'changes': len(changed), 'outsideSparsePreserved': True}))

    def test_cache_corruption_scope_and_stale_writer(self):
        base = json.loads((self.workspace / '.luma-scm.json').read_text())['base']
        digest = hashlib.sha256(b'first\nsecond\nthird\n').hexdigest()
        (self.root / 'cache/blobs' / digest).write_text('corrupt cache')
        second = self.root / 'second'
        self.cli('checkout', str(second), '--prefix', 'cosmos/', '--ref', 'work/other')
        self.assertEqual((second / 'cosmos/one.txt').read_text(), 'first\nsecond\nthird\n')
        (self.workspace / 'center').mkdir()
        (self.workspace / 'center/accidental.txt').write_text('not selected')
        self.assertIn('outside', self.cli('commit', '-m', 'Reject out of scope', fail=True).lower())
        (self.workspace / 'center/accidental.txt').unlink()
        (self.workspace / 'cosmos/one.txt').write_text('mine\n')
        self.cli('api', 'POST', '/v1/refs/work/cli', '--json', json.dumps({'expected': None, 'target': base}))
        self.assertIn('409', self.cli('commit', '-m', 'Reject stale writer', fail=True))
        self.assertEqual(json.loads((self.workspace / '.luma-scm.json').read_text())['base'], base)
        self.assertEqual((self.workspace / 'cosmos/one.txt').read_text(), 'mine\n')
        print(json.dumps({'evidence': 'client-cache-scope-stale-writer', 'cacheVerified': True}))

    def test_lost_commit_response_is_idempotent_and_retains_later_edits(self):
        source = self.workspace / 'cosmos/one.txt'
        source.write_text('accepted once\n')
        with self.lost_response('/v1/changesets'):
            self.cli('commit', '-m', 'Accepted despite timeout', fail=True)
            pending = json.loads((self.workspace / '.luma-scm.json').read_text())
            self.assertIn('pending', pending)
            source.write_text('newer local edit\n')
            acknowledged = self.cli('commit', '-m', 'Retry')
        self.assertNotIn('pending', json.loads((self.workspace / '.luma-scm.json').read_text()))
        self.assertEqual(source.read_text(), 'newer local edit\n')
        self.assertEqual([x['path'] for x in self.cli('status')['changes']], ['cosmos/one.txt'])
        history = self.cli('log', 'cosmos/one.txt')['changesets']
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]['id'], acknowledged['id'])
        self.assertEqual(len(self.cli('api', 'GET', '/v1/publications')['publications']), 1)
        print(json.dumps({'evidence': 'client-lost-commit-response', 'uniquePublications': 1, 'laterEditRetained': True}))

    def test_lost_update_response_recovers_without_discarding_newer_edits(self):
        source = self.original / 'cosmos/one.txt'
        source.write_text('new main\n')
        self.git(self.original, 'commit', '-qam', 'Update main')
        self.git(self.original, 'push', '-q', 'origin', 'main')
        self.cli('sync')
        with self.lost_response('/v1/refs/work/cli'):
            self.cli('update', fail=True)
            self.assertIn('update', json.loads((self.workspace / '.luma-scm.json').read_text()))
            local = self.workspace / 'cosmos/one.txt'
            local.write_text('newer edit after interrupted update\n')
            self.assertIn('newer local edits', self.cli('update', fail=True))
            self.assertEqual(local.read_text(), 'newer edit after interrupted update\n')
            local.write_text('first\nsecond\nthird\n')
            self.cli('update')
        self.assertEqual((self.workspace / 'cosmos/one.txt').read_text(), 'new main\n')
        self.assertNotIn('update', json.loads((self.workspace / '.luma-scm.json').read_text()))
        self.assertFalse(self.cli('status')['changes'])
        print(json.dumps({'evidence': 'client-lost-update-response', 'journalRecovered': True}))

    def test_update_directory_file_conversion_preserves_ignored_files(self):
        import shutil
        def push(message):
            self.git(self.original, 'add', '-A')
            self.git(self.original, 'commit', '-qm', message)
            self.git(self.original, 'push', '-q', 'origin', 'main')
            self.cli('sync')
        shutil.rmtree(self.original / 'cosmos')
        (self.original / 'cosmos').write_text('directory became a file\n')
        push('Convert directory to file')
        self.cli('update')
        self.assertEqual((self.workspace / 'cosmos').read_text(), 'directory became a file\n')
        (self.original / 'cosmos').unlink()
        (self.original / 'cosmos').mkdir()
        (self.original / 'cosmos/inside').write_text('file became a directory\n')
        push('Convert file to directory')
        self.cli('update')
        self.assertEqual((self.workspace / 'cosmos/inside').read_text(), 'file became a directory\n')
        (self.workspace / 'cosmos/.env').write_text('must survive\n')
        shutil.rmtree(self.original / 'cosmos')
        (self.original / 'cosmos').write_text('another conversion\n')
        push('Blocked local conversion')
        base = json.loads((self.workspace / '.luma-scm.json').read_text())['base']
        self.assertIn('untracked', self.cli('update', fail=True))
        self.assertEqual((self.workspace / 'cosmos/.env').read_text(), 'must survive\n')
        self.assertEqual(json.loads((self.workspace / '.luma-scm.json').read_text())['base'], base)
        print(json.dumps({'evidence': 'client-update-file-directory', 'ignoredContentPreserved': True}))

    def test_checkout_rejects_control_names_and_filesystem_aliases(self):
        from client import checkout, ClientError
        self.git(self.original, 'checkout', '-qb', 'alias-fixture')
        original = self.store.resolve('main')
        digest = self.store.putblob(b'not metadata\n')['hash']
        # The API may also reject these; direct store insertion proves the
        # client independently refuses reserved names from an imported tree.
        try:
            dangerous = self.store.create([original], [{'path': '.LUMA-SCM.JSON', 'blob': digest, 'mode': '100644'}], 'Reserved alias')
        except Exception:
            dangerous = None
        if dangerous:
            with self.assertRaises(ClientError):
                checkout(self.endpoint, 'client-e2e-owner', dangerous['id'], '', self.root / 'reserved')
            self.assertFalse((self.root / 'reserved').exists())
        probe = self.root / 'case-probe'
        probe.write_text('probe')
        case_insensitive = (self.root / 'CASE-PROBE').exists()
        aliased = self.store.create([original], [
            {'path': 'Readme', 'blob': digest, 'mode': '100644'},
            {'path': 'README', 'blob': digest, 'mode': '100644'}], 'Filesystem aliases')
        if case_insensitive:
            with self.assertRaises(ClientError):
                checkout(self.endpoint, 'client-e2e-owner', aliased['id'], '', self.root / 'aliased')
            self.assertFalse((self.root / 'aliased').exists())
        else:
            checkout(self.endpoint, 'client-e2e-owner', aliased['id'], '', self.root / 'aliased')
            self.assertTrue((self.root / 'aliased/Readme').exists())
            self.assertTrue((self.root / 'aliased/README').exists())
        print(json.dumps({'evidence': 'client-filesystem-aliases', 'caseInsensitive': case_insensitive}))

    def test_partial_directory_to_symlink_update_never_traverses_new_link(self):
        import shutil
        shutil.rmtree(self.original / 'cosmos')
        (self.original / 'cosmos').symlink_to('.cache')
        self.git(self.original, 'add', '-A')
        self.git(self.original, 'commit', '-qm', 'Replace directory with safe relative link')
        self.git(self.original, 'push', '-q', 'origin', 'main')
        self.cli('sync')
        (self.workspace / '.cache').mkdir()
        sentinel = self.workspace / '.cache/one.txt'
        sentinel.write_text('ignored file must survive recovery\n')
        with self.lost_response('/v1/refs/work/cli'):
            self.cli('update', fail=True)
            # Simulate a crash after installation but before committing local metadata.
            shutil.rmtree(self.workspace / 'cosmos')
            (self.workspace / 'cosmos').symlink_to('.cache')
            self.cli('update')
        self.assertEqual(sentinel.read_text(), 'ignored file must survive recovery\n')
        self.assertEqual((self.workspace / 'cosmos').readlink(), Path('.cache'))
        self.assertFalse(self.cli('status')['changes'])
        print(json.dumps({'evidence': 'client-partial-symlink-update', 'ignoredTargetRetained': True}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
