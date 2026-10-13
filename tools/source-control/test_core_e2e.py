#!/usr/bin/env python3
"""Storage/merge recovery scenarios using real disk, SQLite, Git and processes."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from core import Failure, Store


class CoreEndToEnd(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'state')
        self.base = self.create([], {'doc.txt': b'first\nsecond\nthird\nfourth\nfifth\n'})
        self.store.set_github_head(self.base['id'])

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def create(self, parents, contents, message='Change', **kwargs):
        rows = []
        for path, data in contents.items():
            rows.append({'path': path, 'delete': True} if data is None else {
                'path': path, 'blob': self.store.putblob(data)['hash'], 'mode': '100644'})
        return self.store.create(parents, rows, message, **kwargs)

    def failure(self, status, fn):
        with self.assertRaises(Failure) as caught:
            fn()
        self.assertEqual(status, caught.exception.status)
        return caught.exception

    def test_atomic_concurrent_commit_and_request_replay_after_restart(self):
        base = self.base['id']
        self.store.cas('work/task', None, base)
        common = dict(ref='work/task', expected=base,
                      publication={'branch': 'scion/task', 'auto_merge': False})
        def writer(number):
            try:
                return self.create([base], {'doc.txt': str(number).encode()},
                                   request_id='request-' + str(number), **common)
            except Failure as failure:
                return failure.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(writer, (1, 2)))
        accepted = next(value for value in results if isinstance(value, dict))
        self.assertEqual([409], [value for value in results if isinstance(value, int)])
        self.assertEqual(2, self.store.db.execute('SELECT COUNT(*) FROM changesets').fetchone()[0])
        self.assertEqual(1, len(self.store.publications()))
        winner = self.store.blob(accepted['changes'][0]['blob']).decode()
        self.store.close()
        self.store = Store(self.root / 'state')
        replay = self.create([base], {'doc.txt': winner.encode()},
                             request_id='request-' + winner, **common)
        self.assertEqual(accepted['id'], replay['id'])
        self.assertEqual(accepted['publication']['id'], replay['publication']['id'])
        self.failure(409, lambda: self.create([base], {'doc.txt': b'different'},
                                              request_id='request-' + winner, **common))
        self.store.update_publication(accepted['publication']['id'], status='published',
                                      git_commit='b' * 40, pr_url='https://github.com/a/b/pull/1')
        same = self.store.enqueue(accepted['id'], 'scion/task')
        self.assertEqual('published', same['status'])
        print(json.dumps({'scenario': 'atomic-race-replay', 'changeset': accepted['id'],
                          'publications': len(self.store.publications())}))

    def test_boundary_validation_does_not_accept_partial_transactions(self):
        base = self.base['id']
        blob = self.store.putblob(b'new')['hash']
        self.failure(403, lambda: self.store.cas('main', base, base))
        self.failure(400, lambda: self.store.create([base], [{'path': '../outside', 'blob': blob}], 'bad'))
        self.failure(400, lambda: self.store.create([base], [{'path': 'x', 'blob': '0' * 64}], 'bad'))
        self.failure(400, lambda: self.create([base], {'doc.txt/child': b'x'}))
        self.failure(400, lambda: self.create([base], {'x': b'x'}, ref='work/invalid',
                                            publication={'branch': 'main'}, request_id='bad'))
        self.assertNotIn('work/invalid', self.store.refs())
        self.assertEqual(1, self.store.db.execute('SELECT COUNT(*) FROM changesets').fetchone()[0])
        self.assertEqual([], self.store.publications())
        print(json.dumps({'scenario': 'validation-rollback', 'accepted_changesets': 1}))

    def test_text_merge_rebase_conflicts_and_history(self):
        base = self.base['id']
        left = self.create([base], {'doc.txt': b'LEFT\nsecond\nthird\nfourth\nfifth\n'})['id']
        right = self.create([base], {'doc.txt': b'first\nsecond\nthird\nfourth\nRIGHT\n'})['id']
        right2 = self.create([right], {'extra.txt': b'also retained'})['id']
        merged = self.store.combine(left, right2, 'Merge')
        expected = b'LEFT\nsecond\nthird\nfourth\nRIGHT\n'
        self.assertEqual(expected, self.store.blob(self.store.tree(merged['id'])['doc.txt']['blob']))
        rebased = self.store.combine(left, right2, 'Rebase', rebase=True)
        self.assertEqual([left], rebased['parents'])
        self.assertIn('extra.txt', self.store.tree(rebased['id']))
        self.assertEqual(expected, self.store.blob(self.store.tree(rebased['id'])['doc.txt']['blob']))
        overlap = self.create([base], {'doc.txt': b'OVERLAP\nsecond\nthird\nfourth\nfifth\n'})['id']
        self.assertEqual(['doc.txt'], self.failure(409, lambda: self.store.combine(left, overlap, 'Conflict')).details['conflicts'])
        deleted = self.create([base], {'doc.txt': None})['id']
        self.failure(409, lambda: self.store.combine(left, deleted, 'Delete conflict'))
        binary1 = self.create([base], {'doc.txt': b'\x00left'})['id']
        binary2 = self.create([base], {'doc.txt': b'\x00right'})['id']
        self.failure(409, lambda: self.store.combine(binary1, binary2, 'Binary conflict'))
        hist = self.store.history(rebased['id'], 'doc.txt')
        self.assertEqual([rebased['id'], left, base], [row['id'] for row in hist])
        tree = self.store.tree(rebased['id'], prefix='extra')
        self.assertEqual(['extra.txt'], list(tree))
        tree['extra.txt']['mode'] = 'broken'
        self.assertEqual('100644', self.store.tree(rebased['id'])['extra.txt']['mode'])
        print(json.dumps({'scenario': 'line-merge-and-branch-rebase', 'merge': merged['id'],
                          'rebase': rebased['id'], 'path_history_entries': len(hist)}))

    def test_ambiguous_merge_bases_fail_instead_of_guessing(self):
        base = self.base['id']
        left = self.create([base], {'a': b'a'})['id']
        right = self.create([base], {'b': b'b'})['id']
        cross1 = self.create([left, right], {'b': b'b'}, message='Cross one')['id']
        cross2 = self.create([right, left], {'a': b'a'}, message='Cross two')['id']
        failure = self.failure(409, lambda: self.store.combine(cross1, cross2, 'Ambiguous'))
        self.assertEqual({left, right}, set(failure.details['merge_bases']))
        print(json.dumps({'scenario': 'crisscross-conflict', 'merge_bases': sorted([left, right])}))

    def test_accepted_state_survives_abrupt_exit_and_detects_corruption(self):
        state = self.root / 'child-state'
        script = """import json, os, sys
from core import Store
s=Store(sys.argv[1]); b=s.putblob(b'accepted before immediate exit')
c=s.create([], [{'path':'durable.txt','blob':b['hash']}], 'Durable',
    ref='work/durable', expected=None, publication={'branch':'scion/durable'}, request_id='durable')
print(json.dumps({'id':c['id'],'blob':b['hash']}), flush=True)
os._exit(0)
"""
        run = subprocess.run([sys.executable, '-c', script, str(state)], cwd=Path(__file__).parent,
                             capture_output=True, check=True, text=True)
        accepted = json.loads(run.stdout)
        restored = Store(state)
        try:
            self.assertEqual(accepted['id'], restored.refs()['work/durable'])
            self.assertEqual(1, len(restored.publications()))
            self.assertEqual(b'accepted before immediate exit', restored.blob(accepted['blob']))
            (state / 'blobs' / accepted['blob']).write_bytes(b'corruption')
            self.failure(500, lambda: restored.blob(accepted['blob']))
        finally:
            restored.close()
        print(json.dumps({'scenario': 'abrupt-exit-recovery-and-integrity', 'changeset': accepted['id']}))

    def test_legacy_schema_import_and_consistent_backup_restore(self):
        legacy = self.root / 'legacy'
        legacy.mkdir()
        (legacy / 'blobs').mkdir()
        contents = b'legacy'
        digest = hashlib.sha256(contents).hexdigest()
        (legacy / 'blobs' / digest).write_bytes(contents)
        data = {'parents': [], 'changes': [{'path': 'old.txt', 'mode': '100644', 'blob': digest}],
                'message': 'Legacy', 'created_ns': 123}
        canonical = json.dumps(data, sort_keys=True, separators=(',', ':'))
        cs = hashlib.sha256(canonical.encode()).hexdigest()
        db = sqlite3.connect(legacy / 'store.db')
        db.executescript('CREATE TABLE changesets(id TEXT PRIMARY KEY,data TEXT NOT NULL);'
                         'CREATE TABLE refs(name TEXT PRIMARY KEY,target TEXT NOT NULL);'
                         'CREATE TABLE gitmap(cs TEXT PRIMARY KEY,sha TEXT NOT NULL);')
        db.execute('INSERT INTO changesets VALUES(?,?)', (cs, canonical))
        db.execute('INSERT INTO refs VALUES(?,?)', ('main', cs))
        db.execute('INSERT INTO gitmap VALUES(?,?)', (cs, 'a' * 40))
        db.commit()
        db.close()
        migrated = Store(legacy)
        try:
            self.assertEqual(cs, migrated.resolve('main'))
            self.assertEqual(cs, migrated.gitcs('a' * 40))
            self.assertEqual([cs], [c['id'] for c in migrated.history(cs, 'old.txt')])
            author = {'name': 'Original', 'email': 'original@example.test',
                      'date': '1000 +0200', 'committer': {'name': 'Committer',
                      'email': 'committer@example.test', 'date': '1001 +0200'}}
            imported = migrated.import_git('b' * 40, [cs], [], 'Imported', author=author, created_ns=1000)
            repeat = migrated.import_git('b' * 40, [cs], [], 'Imported', author=author, created_ns=1000)
            self.assertEqual(imported['id'], repeat['id'])
            self.assertEqual(author, imported['author'])
            distinct = migrated.import_git('c' * 40, [cs], [], 'Imported', author=author, created_ns=1000)
            self.assertNotEqual(imported['id'], distinct['id'])
            empty = migrated.import_git('d' * 40, [cs], [], '', author=author, created_ns=1000)
            self.assertEqual('', empty['message'])
            migrated.set_github_head(imported['id'])
            job = migrated.enqueue(imported['id'], 'scion/recovery')
            migrated.update_publication(job['id'], status='retry', attempts=2, error='Network unavailable')
            subprocess.run(['git', 'init', '--bare', '-q', str(legacy / 'mirror.git')], check=True)
            (legacy / 'token').write_text('must-not-be-copied')
            backup = migrated.backup(self.root / 'backup')
            self.assertFalse((self.root / 'backup' / 'token').exists())
            self.assertTrue((self.root / 'backup' / 'manifest.json').exists())
            restored = Store(self.root / 'backup')
            try:
                self.assertEqual(migrated.refs(), restored.refs())
                self.assertEqual('retry', restored.publication(job['id'])['status'])
                self.assertEqual(contents, restored.blob(digest))
                self.assertEqual('ok', restored.db.execute('PRAGMA integrity_check').fetchone()[0])
            finally:
                restored.close()
            print(json.dumps({'scenario': 'legacy-import-backup-restore', 'legacy_id': cs, 'backup': backup}))
        finally:
            migrated.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
