"""Backup restore failures, specified before implementation.

A verified backup must not silently lose its Git mirror, a mapped commit, or
the blobs reachable from that commit. Git mappings to non-commit objects must
also fail verification. Exercise real Git, the HTTP backup route and the actual
verification subprocess, with corruption confined to disposable snapshots.
"""
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

from client import request
from server import Store, GitBridge, make_server


class BackupE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.upstream = self.root / 'upstream.git'
        self.git(self.root, 'init', '--bare', '-q', str(self.upstream))
        work = self.root / 'work'
        self.git(self.root, 'init', '-q', '-b', 'main', str(work))
        self.git(work, 'config', 'user.name', 'Backup fixture')
        self.git(work, 'config', 'user.email', 'backup@localhost')
        (work / 'doc.txt').write_text('Original\n')
        self.git(work, 'add', '.')
        self.git(work, 'commit', '-qm', 'Original')
        self.git(work, 'push', '-q', str(self.upstream), 'main')
        self.store = Store(self.root / 'state')
        self.bridge = GitBridge(self.store, str(self.upstream))
        base = self.bridge.import_main()['changeset']
        blob = self.store.putblob(b'Published change\n')['hash']
        self.changeset = self.store.create([base], [{'path': 'doc.txt', 'blob': blob, 'mode': '100644'}], 'Published change')['id']
        self.commit = self.bridge.publish(self.changeset, 'scion/backup')['git_commit']
        self.git_blob = self.git(self.bridge.repo, 'rev-parse', self.commit + ':doc.txt')
        self.http = make_server(self.store, self.bridge, 'backup-test-token', '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = 'http://127.0.0.1:' + str(self.http.server_port)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.store.close()
        self.temp.cleanup()

    @staticmethod
    def git(path, *args):
        return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.PIPE).decode().strip()

    def snapshot(self):
        result = request(self.endpoint, 'backup-test-token', 'POST', '/v1/backup', {})
        return Path(result['destination'])

    def verify(self, snapshot):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('backup.py')), '--verify', str(snapshot)],
                              capture_output=True, text=True, timeout=30)

    def test_missing_and_corrupt_git_objects_are_not_verified(self):
        good = self.snapshot()
        result = self.verify(good)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['verified'])
        rejected = 0
        for damage in ('missing-mirror', 'missing-mapped-commit', 'corrupt-reachable-blob', 'mapping-to-blob'):
            with self.subTest(damage=damage):
                snapshot = self.root / damage
                shutil.copytree(good, snapshot)
                mirror = snapshot / 'mirror.git'
                if damage == 'missing-mirror':
                    shutil.rmtree(mirror)
                elif damage == 'missing-mapped-commit':
                    (mirror / 'objects' / self.commit[:2] / self.commit[2:]).unlink()
                elif damage == 'corrupt-reachable-blob':
                    damaged = mirror / 'objects' / self.git_blob[:2] / self.git_blob[2:]
                    damaged.chmod(0o600)
                    damaged.write_bytes(b'not a Git object')
                else:
                    with sqlite3.connect(snapshot / 'store.db') as database:
                        database.execute('UPDATE gitmap SET sha=? WHERE cs=?', (self.git_blob, self.changeset))
                result = self.verify(snapshot)
                self.assertNotEqual(result.returncode, 0, 'Corrupt snapshot was verified: ' + damage)
                self.assertNotIn('"verified": true', result.stdout)
                self.assertIn('Git', result.stderr)
                rejected += 1
        self.assertEqual(rejected, 4)
        print(json.dumps({'evidence': 'backup-git-integrity', 'validSnapshotAccepted': True,
                          'corruptSnapshotsRejected': rejected}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
