import concurrent.futures
import json
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server import Store, GitBridge, make_server
from client import checkout


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.PIPE).decode().strip()


class SourceControlE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.upstream = self.root / 'upstream.git'
        self.work = self.root / 'original'
        subprocess.run(['git', 'init', '--bare', '-q', str(self.upstream)], check=True)
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.work)], check=True)
        git(self.work, 'config', 'user.name', 'Prototype test')
        git(self.work, 'config', 'user.email', 'prototype@localhost')
        (self.work / 'cosmos').mkdir()
        (self.work / 'cosmos/a.txt').write_text('one\n')
        (self.work / 'cosmos/b.bin').write_bytes(b'\x00\xff\x01')
        (self.work / 'center').mkdir()
        (self.work / 'center/run').write_text('#!/bin/sh\nexit 0\n')
        (self.work / 'center/run').chmod(0o755)
        (self.work / 'entry').symlink_to('cosmos/a.txt')
        git(self.work, 'add', '.')
        git(self.work, 'commit', '-qm', 'Original Luma fixture')
        self.original_git = git(self.work, 'rev-parse', 'HEAD')
        git(self.work, 'remote', 'add', 'origin', str(self.upstream))
        git(self.work, 'push', '-q', 'origin', 'main')
        self.store = Store(self.root / 'state')
        self.bridge = GitBridge(self.store, str(self.upstream))
        self.http = make_server(self.store, self.bridge, 'test-owner-token', '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)
        self.imported = self.call('POST', '/v1/github/import', {})[1]['changeset']
        self.store.cas('work/e2e', None, self.imported)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.store.close()
        self.tmp.cleanup()

    def call(self, method, path, data=None, auth=True, raw=False):
        headers = {'Authorization': 'Bearer test-owner-token'} if auth else {}
        if data is not None and not raw:
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            r = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            r = e
        body = r.read()
        r.close()
        if r.headers.get('Content-Type', '').startswith('application/json'):
            body = json.loads(body)
        return r.status, body

    def commit(self, parent, path, content):
        blob = self.call('POST', '/v1/blobs', content, raw=True)[1]['hash']
        return self.call('POST', '/v1/changesets', {'parent': parent, 'message': 'Change ' + path,
            'changes': [{'path': path, 'blob': blob, 'mode': '100644'}]})[1]['id']

    def test_auth_validation_and_incremental_sparse_history(self):
        self.assertEqual(self.call('GET', '/v1/refs', auth=False)[0], 401)
        self.assertEqual(self.call('POST', '/v1/changesets', {'parent': self.imported, 'message': 'bad',
            'changes': [{'path': '../escape', 'blob': '0'*64}]})[0], 400)
        new = self.commit(self.imported, 'cosmos/a.txt', b'two\n')
        changeset = self.call('GET', '/v1/changesets/' + new)[1]
        self.assertEqual(len(changeset['changes']), 1)
        files = self.call('GET', '/v1/files?at=' + new + '&prefix=cosmos/')[1]['files']
        self.assertEqual({f['path'] for f in files}, {'cosmos/a.txt', 'cosmos/b.bin'})
        binary = next(f for f in files if f['path'].endswith('.bin'))
        self.assertEqual(self.call('GET', '/v1/blobs/' + binary['blob'])[1], b'\x00\xff\x01')
        diff = self.call('GET', '/v1/diff?base=' + self.imported + '&head=' + new)[1]['changes']
        self.assertEqual([r['path'] for r in diff], ['cosmos/a.txt'])
        history = self.call('GET', '/v1/history?at=' + new + '&path=cosmos/a.txt')[1]['changesets']
        self.assertEqual([r['id'] for r in history], [new, self.imported])
        deleted = self.call('POST', '/v1/changesets', {'parent': new, 'message': 'Delete',
            'changes': [{'path': 'cosmos/a.txt', 'delete': True}]})[1]['id']
        self.assertNotIn('cosmos/a.txt', {r['path'] for r in self.call('GET', '/v1/files?at=' + deleted)[1]['files']})
        print(json.dumps({'evidence': 'sparse-delta-history-delete', 'changedFiles': len(diff), 'sparseFiles': len(files)}))

    def test_checkout_binary_permissions_and_unsafe_symlink(self):
        dest = self.root / 'checkout'
        result = checkout(self.base, 'test-owner-token', self.imported, '', dest)
        self.assertEqual(result['files'], 4)
        self.assertEqual((dest / 'cosmos/b.bin').read_bytes(), b'\x00\xff\x01')
        self.assertEqual((dest / 'entry').readlink(), Path('cosmos/a.txt'))
        self.assertTrue((dest / 'center/run').stat().st_mode & 0o111)
        with self.assertRaises(SystemExit):
            checkout(self.base, 'test-owner-token', self.imported, '', dest)
        blob = self.call('POST', '/v1/blobs', b'../../outside', raw=True)[1]['hash']
        bad = self.call('POST', '/v1/changesets', {'parent': self.imported, 'message': 'Unsafe link',
            'changes': [{'path': 'escape', 'blob': blob, 'mode': '120000'}]})[1]['id']
        with self.assertRaises(SystemExit):
            checkout(self.base, 'test-owner-token', bad, '', self.root / 'bad-checkout')
        self.assertFalse((self.root / 'bad-checkout').exists())

    def test_compare_and_swap_merge_rebase_and_conflict(self):
        left = self.commit(self.imported, 'cosmos/a.txt', b'left\n')
        right = self.commit(self.imported, 'center/new.txt', b'right\n')
        def move(target):
            return self.call('POST', '/v1/refs/work/e2e', {'expected': self.imported, 'target': target})[0]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            statuses = list(pool.map(move, [left, right]))
        self.assertEqual(sorted(statuses), [200, 409])
        merged = self.call('POST', '/v1/merge', {'left': left, 'right': right, 'message': 'Merge'})
        self.assertEqual(merged[0], 201)
        self.assertEqual(merged[1]['parents'], [left, right])
        self.assertEqual(self.call('POST', '/v1/rebase', {'changeset': right, 'onto': left})[0], 201)
        conflict = self.commit(self.imported, 'cosmos/a.txt', b'conflict\n')
        status, error = self.call('POST', '/v1/merge', {'left': left, 'right': conflict, 'message': 'Conflict'})
        self.assertEqual(status, 409)
        self.assertEqual(error['conflicts'], ['cosmos/a.txt'])
        print(json.dumps({'evidence': 'two-writer-CAS', 'statuses': sorted(statuses), 'conflicts': error['conflicts']}))

    def test_git_import_mirror_preserves_main_and_restart(self):
        self.assertEqual(self.call('POST', '/v1/github/import', {})[1]['changeset'], self.imported)
        files = self.call('GET', '/v1/files?at=main')[1]['files']
        self.assertEqual(next(r['mode'] for r in files if r['path'] == 'entry'), '120000')
        self.assertEqual(next(r['mode'] for r in files if r['path'] == 'center/run'), '100755')
        new = self.commit(self.imported, 'cosmos/a.txt', b'mirrored\n')
        self.assertEqual(self.call('POST', '/v1/github/publish', {'at': new, 'branch': 'main'})[0], 400)
        status, published = self.call('POST', '/v1/github/publish', {'at': new, 'branch': 'scion-prototype/e2e'})
        self.assertEqual(status, 200)
        self.assertEqual(git(self.upstream, 'rev-parse', 'refs/heads/main'), self.original_git)
        self.assertEqual(git(self.upstream, 'show', 'refs/heads/scion-prototype/e2e:cosmos/a.txt'), 'mirrored')
        self.assertEqual(git(self.upstream, 'rev-parse', published['git_commit'] + '^'), self.original_git)
        child = self.commit(new, 'center/child.txt', b'child\n')
        self.assertEqual(self.call('POST', '/v1/github/publish', {'at': child, 'branch': 'scion-prototype/e2e'})[0], 200)
        sibling = self.commit(self.imported, 'cosmos/a.txt', b'sibling\n')
        tip = git(self.upstream, 'rev-parse', 'refs/heads/scion-prototype/e2e')
        self.assertEqual(self.call('POST', '/v1/github/publish', {'at': sibling, 'branch': 'scion-prototype/e2e'})[0], 409)
        self.assertEqual(git(self.upstream, 'rev-parse', 'refs/heads/scion-prototype/e2e'), tip)
        self.assertIsNone(self.store.gitsha(sibling))
        restarted = Store(self.root / 'state')
        self.assertEqual(restarted.changeset(new)['id'], new)
        restarted.close()
        print(json.dumps({'evidence': 'Git-mirror-keeps-original-main', 'main': self.original_git,
            'mirror': published['git_commit'], 'persistentChangeset': new}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
