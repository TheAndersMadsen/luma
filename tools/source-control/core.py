#!/usr/bin/env python3
"""Durable single-host changesets, immutable blobs, derived indexes and outbox."""
from collections import OrderedDict, deque
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid


class Failure(Exception):
    def __init__(self, message, status=400, **details):
        super().__init__(message)
        self.status, self.details = status, details


def pathcheck(path):
    if (not isinstance(path, str) or not path or len(path.encode('utf-8')) > 4096
            or '\x00' in path or '\\' in path or path.startswith('/')
            or any(p in ('', '.', '..', '.git') for p in path.split('/'))):
        raise Failure('Invalid repository path')
    return path


def _canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise Failure('Request must contain JSON values') from error


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _digest(value, length=64):
    return isinstance(value, str) and len(value) == length and all(c in '0123456789abcdef' for c in value)


def _fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _branch(branch):
    if (not isinstance(branch, str) or len(branch) > 240
            or not branch.startswith(('scion/', 'scion-prototype/'))
            or any(ord(c) < 33 or ord(c) == 127 or c in '~^:?*[\\' for c in branch)
            or '..' in branch or '@{' in branch or branch.endswith(('/', '.'))
            or any(not p or p.startswith('.') or p.endswith('.lock') for p in branch.split('/'))):
        raise Failure('Publication branch must be a valid scion/ or scion-prototype/ branch')
    return branch


class Store:
    """One service owns a state directory; its threads share this serialized writer.

    Changesets contain deltas only. SQL metadata indexes and bounded lazy tree
    snapshots are disposable derived data. Git mappings and publication jobs
    are authoritative, so backup includes them in the same database snapshot.
    """
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / 'blobs').mkdir(exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self._cache = OrderedDict()
        self._closed = False
        self.db = sqlite3.connect(self.root / 'store.db', check_same_thread=False,
                                  isolation_level=None, timeout=30)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA busy_timeout=30000')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS changesets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, target TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS gitmap(cs TEXT PRIMARY KEY, sha TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS gitmap_sha ON gitmap(sha);
            CREATE TABLE IF NOT EXISTS cs_meta(cs TEXT PRIMARY KEY, generation INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS parent_edges(cs TEXT NOT NULL, position INTEGER NOT NULL,
                parent TEXT NOT NULL, PRIMARY KEY(cs,position));
            CREATE INDEX IF NOT EXISTS parent_edges_parent ON parent_edges(parent);
            CREATE TABLE IF NOT EXISTS path_changes(path TEXT NOT NULL, cs TEXT NOT NULL,
                deleted INTEGER NOT NULL, PRIMARY KEY(path,cs));
            CREATE INDEX IF NOT EXISTS path_changes_cs ON path_changes(cs);
            CREATE TABLE IF NOT EXISTS tree_snapshots(cs TEXT PRIMARY KEY, data TEXT NOT NULL,
                used REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                changeset TEXT NOT NULL, publication TEXT);
            CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, changeset TEXT NOT NULL,
                branch TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
                auto_merge INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
                error TEXT, git_commit TEXT, pr_url TEXT, pr_number INTEGER,
                next_attempt REAL NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
                UNIQUE(changeset,branch));
            CREATE INDEX IF NOT EXISTS publications_pending ON publications(status,next_attempt);
        ''')
        # Extend the original schema without rewriting a changeset or its ID.
        self.db.execute('BEGIN IMMEDIATE')
        try:
            rows = self.db.execute('SELECT id,data FROM changesets WHERE id NOT IN '
                                   '(SELECT cs FROM cs_meta) ORDER BY rowid').fetchall()
            for cs, data in rows:
                self._index(cs, json.loads(data))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            self.db.close()
            raise
        _fsync_directory(self.root)

    def close(self):
        with self.lock:
            if not self._closed:
                self.db.close()
                self._closed = True

    def putblob(self, data):
        if not isinstance(data, bytes):
            raise Failure('Blob content must be bytes')
        digest = _hash(data)
        path = self.root / 'blobs' / digest
        with self.lock:
            if path.exists():
                if self.blob(digest) != data:
                    raise Failure('Existing blob is corrupt', 500, blob=digest)
            else:
                descriptor, temporary = tempfile.mkstemp(prefix='.incoming-', dir=path.parent)
                try:
                    with os.fdopen(descriptor, 'wb') as output:
                        output.write(data)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, path)
                    _fsync_directory(path.parent)
                finally:
                    Path(temporary).unlink(missing_ok=True)
        return {'hash': digest, 'bytes': len(data)}

    def blob(self, digest):
        if not _digest(digest):
            raise Failure('Invalid blob hash')
        try:
            data = (self.root / 'blobs' / digest).read_bytes()
        except FileNotFoundError as error:
            raise Failure('Blob does not exist', 404, blob=digest) from error
        if _hash(data) != digest:
            raise Failure('Blob integrity check failed', 500, blob=digest)
        return data

    def resolve(self, value):
        if not isinstance(value, str) or not value:
            raise Failure('A changeset or ref is required')
        with self.lock:
            row = self.db.execute('SELECT target FROM refs WHERE name=?', (value,)).fetchone()
            target = row[0] if row else value
            if not self.db.execute('SELECT 1 FROM changesets WHERE id=?', (target,)).fetchone():
                raise Failure('Changeset or ref does not exist', 404)
            return target

    def changeset(self, value):
        with self.lock:
            target = self.resolve(value)
            data = self.db.execute('SELECT data FROM changesets WHERE id=?', (target,)).fetchone()[0]
            return dict(json.loads(data), id=target)

    def _index(self, digest, data):
        generations = []
        for position, parent in enumerate(data['parents']):
            self.db.execute('INSERT INTO parent_edges VALUES(?,?,?)', (digest, position, parent))
            row = self.db.execute('SELECT generation FROM cs_meta WHERE cs=?', (parent,)).fetchone()
            generations.append(row[0] if row else 0)
        self.db.execute('INSERT INTO cs_meta VALUES(?,?)', (digest, max(generations, default=-1) + 1))
        self.db.executemany('INSERT INTO path_changes VALUES(?,?,?)',
                            [(r['path'], digest, int(bool(r.get('delete')))) for r in data['changes']])

    def _changes(self, changes):
        if not isinstance(changes, list):
            raise Failure('Changes must be a list')
        clean, seen = [], set()
        for row in changes:
            if not isinstance(row, dict):
                raise Failure('Each change must be an object')
            path = pathcheck(row.get('path'))
            if path in seen:
                raise Failure('Duplicate path')
            seen.add(path)
            if row.get('delete') is True:
                if 'blob' in row or 'mode' in row:
                    raise Failure('Deletion cannot also specify a blob or mode')
                clean.append({'path': path, 'delete': True})
            else:
                mode = row.get('mode', '100644')
                if mode not in ('100644', '100755', '120000', '160000'):
                    raise Failure('Unsupported file mode')
                digest = row.get('blob')
                try:
                    content = self.blob(digest)
                except Failure as error:
                    if error.status == 404:
                        raise Failure('Change references a missing blob', blob=digest) from error
                    raise
                if mode == '160000':
                    try:
                        oid = content.decode('ascii')
                    except UnicodeDecodeError as error:
                        raise Failure('Gitlink must contain a Git object ID') from error
                    if not (_digest(oid, 40) or _digest(oid, 64)):
                        raise Failure('Gitlink must contain a Git object ID')
                clean.append({'path': path, 'blob': digest, 'mode': mode})
        return sorted(clean, key=lambda row: row['path'])

    @staticmethod
    def _apply(before, changes):
        result = dict(before)
        for row in changes:
            if row.get('delete'):
                result.pop(row['path'], None)
            else:
                result[row['path']] = {'blob': row['blob'], 'mode': row['mode']}
        return result

    @staticmethod
    def _validate_tree(tree):
        for path in tree:
            parts = path.split('/')
            if any('/'.join(parts[:i]) in tree for i in range(1, len(parts))):
                raise Failure('A path cannot be both a file and a directory', path=path)

    @staticmethod
    def _author(author):
        if author is not None:
            if not isinstance(author, dict) or len(_canonical(author)) > 8192:
                raise Failure('Author must be a small JSON object')
            for field in ('name', 'email', 'date'):
                if field in author and (not isinstance(author[field], str) or '\x00' in author[field]
                                         or '\n' in author[field] or '\r' in author[field]):
                    raise Failure('Invalid author metadata')
            if 'committer' in author:
                if not isinstance(author['committer'], dict) or 'committer' in author['committer']:
                    raise Failure('Invalid committer metadata')
                Store._author(author['committer'])
        return json.loads(_canonical(author)) if author is not None else None

    def _insert(self, parents, changes, message, author=None, created_ns=None, git_commit=None):
        # Call only inside a database transaction with the Store lock held.
        data = {'parents': parents, 'changes': changes, 'message': message,
                'created_ns': time.time_ns() if created_ns is None else created_ns}
        if author is not None:
            data['author'] = author
        if git_commit is not None:
            # Git identity includes headers (such as signatures) that the SCM
            # does not interpret. Retain it to keep such commits distinct.
            data['git_commit'] = git_commit
        canonical = _canonical(data)
        digest = _hash(canonical.encode())
        inserted = self.db.execute('INSERT OR IGNORE INTO changesets VALUES(?,?)',
                                  (digest, canonical)).rowcount
        if inserted:
            self._index(digest, data)
        return dict(data, id=digest)

    def _create_inputs(self, parents, changes, message, author, allow_empty=False):
        if not isinstance(parents, list) or len(parents) > 64:
            raise Failure('Parents must be a list with at most 64 changesets')
        if (not isinstance(message, str) or (not allow_empty and not message.strip())
                or len(message.encode()) > 1024 * 1024):
            raise Failure('A non-empty message of at most 1 MiB is required')
        parents = [self.resolve(parent) for parent in parents]
        if len(set(parents)) != len(parents):
            raise Failure('Duplicate parent')
        clean = self._changes(changes)
        before = self.tree(parents[0]) if parents else {}
        self._validate_tree(self._apply(before, clean))
        return parents, clean, self._author(author)

    def create(self, parents, changes, message, *, ref=None, expected=None,
               publication=None, request_id=None, author=None):
        if ref is not None:
            self._writable_ref(ref)
        if expected is not None and not _digest(expected):
            raise Failure('Expected ref must be a changeset ID or null')
        if request_id is not None and (not isinstance(request_id, str) or not request_id
                                       or len(request_id) > 200):
            raise Failure('Invalid request ID')
        publication = self._publication_input(publication, message) if publication is not None else None
        fingerprint = _hash(_canonical({'parents': parents, 'changes': changes, 'message': message,
                                       'ref': ref, 'expected': expected, 'publication': publication,
                                       'author': author}).encode())
        with self.lock:
            if request_id:
                previous = self.db.execute('SELECT fingerprint,changeset,publication FROM requests WHERE id=?',
                                           (request_id,)).fetchone()
                if previous:
                    if previous[0] != fingerprint:
                        raise Failure('Request ID was already used for different content', 409)
                    result = self.changeset(previous[1])
                    if previous[2]:
                        result['publication'] = self.publication(previous[2])
                    return result
            parents, clean, author = self._create_inputs(parents, changes, message, author)
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if ref is not None:
                    self._expect(ref, expected)
                result = self._insert(parents, clean, message, author)
                if ref is not None:
                    self.db.execute('INSERT OR REPLACE INTO refs VALUES(?,?)', (ref, result['id']))
                if publication is not None:
                    result['publication'] = self._enqueue(result['id'], **publication)
                if request_id:
                    self.db.execute('INSERT INTO requests VALUES(?,?,?,?)',
                                    (request_id, fingerprint, result['id'],
                                     result.get('publication', {}).get('id')))
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
            return result

    def tree(self, value, prefix=''):
        if not isinstance(prefix, str):
            raise Failure('Prefix must be a string')
        if prefix:
            pathcheck(prefix.rstrip('/'))
        with self.lock:
            target = self.resolve(value)
            if target in self._cache:
                tree = self._cache[target]
                self._cache.move_to_end(target)
            else:
                chain, cursor, tree = [], target, {}
                while cursor:
                    cached = self._cache.get(cursor)
                    if cached is not None:
                        tree = cached
                        break
                    row = self.db.execute('SELECT data FROM tree_snapshots WHERE cs=?', (cursor,)).fetchone()
                    if row:
                        tree = json.loads(row[0])
                        break
                    current = self.changeset(cursor)
                    chain.append(current)
                    cursor = current['parents'][0] if current['parents'] else None
                for current in reversed(chain):
                    tree = self._apply(tree, current['changes'])
                self.db.execute('INSERT OR REPLACE INTO tree_snapshots VALUES(?,?,?)',
                                (target, _canonical(tree), time.time()))
                self.db.execute('DELETE FROM tree_snapshots WHERE cs IN '
                                '(SELECT cs FROM tree_snapshots ORDER BY used DESC LIMIT -1 OFFSET 128)')
                self._cache[target] = tree
                while len(self._cache) > 32:
                    self._cache.popitem(last=False)
            return {path: dict(entry) for path, entry in tree.items() if path.startswith(prefix)}

    def refs(self):
        with self.lock:
            return dict(self.db.execute('SELECT name,target FROM refs'))

    @staticmethod
    def _writable_ref(name):
        pathcheck(name)
        if name in ('main', 'github'):
            raise Failure('GitHub integration refs are read-only; publish a work branch', 403)
        if not name.startswith(('work/', 'prototype/')):
            raise Failure('Work refs must start with work/')

    def _expect(self, name, expected):
        row = self.db.execute('SELECT target FROM refs WHERE name=?', (name,)).fetchone()
        actual = row[0] if row else None
        if actual != expected:
            raise Failure('Ref changed concurrently; update the workspace before committing', 409, actual=actual)

    def cas(self, name, expected, target):
        self._writable_ref(name)
        with self.lock:
            target = self.resolve(target)
            self.db.execute('BEGIN IMMEDIATE')
            try:
                self._expect(name, expected)
                self.db.execute('INSERT OR REPLACE INTO refs VALUES(?,?)', (name, target))
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        return {'name': name, 'target': target}

    def set_github_head(self, cs):
        with self.lock:
            target = self.resolve(cs)
            self.db.execute('BEGIN IMMEDIATE')
            try:
                self.db.executemany('INSERT OR REPLACE INTO refs VALUES(?,?)',
                                    [('main', target), ('github', target)])
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        return {'main': target, 'github': target}

    @staticmethod
    def delta(before, after):
        return [dict({'path': path}, **after[path]) if path in after else {'path': path, 'delete': True}
                for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]

    def ancestors(self, value):
        with self.lock:
            distances, todo = {}, deque([(self.resolve(value), 0)])
            while todo:
                cs, distance = todo.popleft()
                if cs in distances:
                    continue
                distances[cs] = distance
                rows = self.db.execute('SELECT parent FROM parent_edges WHERE cs=? ORDER BY position', (cs,))
                todo.extend((parent, distance + 1) for (parent,) in rows)
            return distances

    def _merge_base(self, left, right):
        la, ra = self.ancestors(left), self.ancestors(right)
        common = la.keys() & ra.keys()
        if not common:
            raise Failure('No common ancestor', 409)
        # A best base has no descendant which is also a common ancestor.
        # Traversing parents once avoids distance heuristics that fail on merges.
        non_best, visited, todo = set(), set(), deque()
        for cs in common:
            todo.extend(parent for (parent,) in self.db.execute('SELECT parent FROM parent_edges WHERE cs=?', (cs,)))
        while todo:
            cs = todo.popleft()
            if cs in visited:
                continue
            visited.add(cs)
            if cs in common:
                non_best.add(cs)
            todo.extend(parent for (parent,) in self.db.execute('SELECT parent FROM parent_edges WHERE cs=?', (cs,)))
        best = sorted(common - non_best)
        if len(best) != 1:
            raise Failure('Multiple merge bases require explicit resolution', 409, merge_bases=best)
        return best[0]

    def _merge_file(self, base, left, right):
        if base is None or left is None or right is None:
            return None
        modes = (base['mode'], left['mode'], right['mode'])
        if any(mode not in ('100644', '100755') for mode in modes):
            return None
        if left['mode'] == right['mode'] or right['mode'] == base['mode']:
            mode = left['mode']
        elif left['mode'] == base['mode']:
            mode = right['mode']
        else:
            return None
        if left['blob'] == right['blob'] or right['blob'] == base['blob']:
            return {'blob': left['blob'], 'mode': mode}
        if left['blob'] == base['blob']:
            return {'blob': right['blob'], 'mode': mode}
        contents = [self.blob(entry['blob']) for entry in (left, base, right)]
        for data in contents:
            if b'\x00' in data:
                return None
            try:
                data.decode('utf-8')
            except UnicodeDecodeError:
                return None
        with tempfile.TemporaryDirectory(prefix='luma-merge-') as temporary:
            files = [Path(temporary) / name for name in ('left', 'base', 'right')]
            for path, data in zip(files, contents):
                path.write_bytes(data)
            result = subprocess.run(['git', 'merge-file', '-p', '--diff3', *map(str, files)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if result.returncode:
            return None
        return {'blob': self.putblob(result.stdout)['hash'], 'mode': mode}

    def combine(self, left, right, message, rebase=False):
        with self.lock:
            left, right = self.resolve(left), self.resolve(right)
            base = self._merge_base(left, right)
            if base == right:
                return self.changeset(left)
            if base == left:
                return self.changeset(right)
            bt, lt, rt = self.tree(base), self.tree(left), self.tree(right)
            result, conflicts = dict(lt), []
            for path in sorted(bt.keys() | lt.keys() | rt.keys()):
                b, l, r = bt.get(path), lt.get(path), rt.get(path)
                if r == b or r == l:
                    continue
                if l == b:
                    if r is None:
                        result.pop(path, None)
                    else:
                        result[path] = r
                else:
                    merged = self._merge_file(b, l, r)
                    if merged is None:
                        conflicts.append(path)
                    else:
                        result[path] = merged
            if conflicts:
                raise Failure('Conflicting edits require resolution', 409, conflicts=conflicts)
            try:
                self._validate_tree(result)
            except Failure as error:
                raise Failure('File/directory conflict requires resolution', 409,
                              conflicts=[error.details['path']]) from error
            # Rebase intentionally squashes all right-branch changes since base.
            return self.create([left] if rebase else [left, right], self.delta(lt, result), message)

    def history(self, at, path, limit=100):
        pathcheck(path)
        if not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise Failure('History limit must be between 1 and 1000')
        with self.lock:
            cs = self.resolve(at)
            rows = self.db.execute('''WITH RECURSIVE chain(cs,position) AS (
                SELECT ?,0 UNION ALL
                SELECT parent_edges.parent,chain.position+1 FROM chain JOIN parent_edges
                    ON parent_edges.cs=chain.cs AND parent_edges.position=0
                ) SELECT c.id,c.data FROM chain
                    JOIN path_changes pc ON pc.cs=chain.cs AND pc.path=?
                    JOIN changesets c ON c.id=chain.cs ORDER BY chain.position LIMIT ?''',
                                   (cs, path, limit)).fetchall()
            return [dict(json.loads(data), id=digest) for digest, data in rows]

    def gitsha(self, cs):
        with self.lock:
            row = self.db.execute('SELECT sha FROM gitmap WHERE cs=?', (cs,)).fetchone()
            return row[0] if row else None

    def gitcs(self, sha):
        with self.lock:
            row = self.db.execute('SELECT cs FROM gitmap WHERE sha=? ORDER BY rowid LIMIT 1', (sha,)).fetchone()
            return row[0] if row else None

    def mapgit(self, cs, sha):
        if not (_digest(sha, 40) or _digest(sha, 64)):
            raise Failure('Invalid Git commit ID')
        with self.lock:
            cs = self.resolve(cs)
            existing = self.gitsha(cs)
            if existing and existing != sha:
                raise Failure('Changeset already maps to another Git commit', 409)
            self.db.execute('INSERT OR IGNORE INTO gitmap VALUES(?,?)', (cs, sha))

    def import_git(self, sha, parents, changes, message, author=None, created_ns=None):
        if not (_digest(sha, 40) or _digest(sha, 64)):
            raise Failure('Invalid Git commit ID')
        if created_ns is not None and (not isinstance(created_ns, int) or created_ns < 0):
            raise Failure('Invalid changeset timestamp')
        with self.lock:
            existing = self.gitcs(sha)
            if existing:
                return self.changeset(existing)
            parents, changes, author = self._create_inputs(parents, changes, message, author, allow_empty=True)
            self.db.execute('BEGIN IMMEDIATE')
            try:
                result = self._insert(parents, changes, message, author, created_ns, git_commit=sha)
                self.db.execute('INSERT INTO gitmap VALUES(?,?)', (result['id'], sha))
                self.db.commit()
                return result
            except BaseException:
                self.db.rollback()
                raise

    @staticmethod
    def _publication_input(value, message='Luma change'):
        if not isinstance(value, dict):
            raise Failure('Publication must be an object')
        unknown = value.keys() - {'branch', 'title', 'body', 'auto_merge'}
        if unknown:
            raise Failure('Unknown publication fields')
        title = value.get('title') or (message.splitlines()[0] if isinstance(message, str) and message else 'Luma change')
        body, auto_merge = value.get('body', ''), value.get('auto_merge', False)
        if not isinstance(title, str) or not title.strip() or len(title) > 256 or '\n' in title:
            raise Failure('Publication title must be a non-empty line of at most 256 characters')
        if not isinstance(body, str) or len(body.encode()) > 65536:
            raise Failure('Publication body must be at most 64 KiB')
        if not isinstance(auto_merge, bool):
            raise Failure('auto_merge must be boolean')
        return {'branch': _branch(value.get('branch')), 'title': title, 'body': body, 'auto_merge': auto_merge}

    def _enqueue(self, cs, branch, title, body, auto_merge):
        digest = _hash((cs + '\n' + branch).encode())
        now = time.time()
        self.db.execute('''INSERT OR IGNORE INTO publications VALUES
            (?,?,?,?,?,?,'pending',0,NULL,NULL,NULL,NULL,0,?,?)''',
                        (digest, cs, branch, title, body, int(auto_merge), now, now))
        return self.publication(digest)

    def enqueue(self, cs, branch, title=None, body='', auto_merge=False):
        with self.lock:
            cs = self.resolve(cs)
            inputs = self._publication_input({'branch': branch, 'title': title, 'body': body,
                                               'auto_merge': auto_merge}, self.changeset(cs)['message'])
            return self._enqueue(cs, **inputs)

    @staticmethod
    def _publication_row(cursor, row):
        result = dict(zip((description[0] for description in cursor.description), row))
        result['auto_merge'] = bool(result['auto_merge'])
        return result

    def publications(self):
        with self.lock:
            cursor = self.db.execute('SELECT * FROM publications ORDER BY created,id')
            return [self._publication_row(cursor, row) for row in cursor.fetchall()]

    def publication(self, publication_id):
        with self.lock:
            cursor = self.db.execute('SELECT * FROM publications WHERE id=?', (publication_id,))
            row = cursor.fetchone()
            if row is None:
                raise Failure('Publication does not exist', 404)
            return self._publication_row(cursor, row)

    def update_publication(self, publication_id, **fields):
        allowed = {'title', 'body', 'auto_merge', 'status', 'attempts', 'error', 'git_commit',
                   'pr_url', 'pr_number', 'next_attempt'}
        if fields.keys() - allowed:
            raise Failure('Unknown publication update fields')
        if 'status' in fields and fields['status'] not in ('pending', 'retry', 'published', 'blocked', 'merged'):
            raise Failure('Invalid publication status')
        if 'auto_merge' in fields:
            if not isinstance(fields['auto_merge'], bool):
                raise Failure('auto_merge must be boolean')
            fields['auto_merge'] = int(fields['auto_merge'])
        for key in ('attempts', 'pr_number'):
            if key in fields and fields[key] is not None and (not isinstance(fields[key], int) or fields[key] < 0):
                raise Failure('Invalid publication counter')
        if not fields:
            return self.publication(publication_id)
        fields['updated'] = time.time()
        with self.lock:
            self.publication(publication_id)
            self.db.execute('UPDATE publications SET ' + ','.join(key + '=?' for key in fields) + ' WHERE id=?',
                            [*fields.values(), publication_id])
            return self.publication(publication_id)

    def backup(self, destination):
        """Create a standalone restore directory. Caller must hold GitBridge.lock.

        Token/credentials are deliberately omitted. A restored service needs a
        newly provisioned token. Copying mirror.git also requires no concurrent
        external git maintenance; the service's bridge lock covers its own Git.
        """
        destination = Path(destination).resolve()
        state = self.root.resolve()
        if destination.exists() or destination == state or state in destination.parents:
            raise Failure('Backup destination must be a new directory outside service state')
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = destination.parent / ('.' + destination.name + '.partial-' + uuid.uuid4().hex)
        temporary.mkdir(mode=0o700)
        try:
            with self.lock:
                output = sqlite3.connect(temporary / 'store.db')
                try:
                    self.db.backup(output)
                    check = output.execute('PRAGMA integrity_check').fetchone()[0]
                    if check != 'ok':
                        raise Failure('Backup database integrity check failed', 500)
                finally:
                    output.close()
                (temporary / 'blobs').mkdir(mode=0o700)
                total, count = 0, 0
                for blob in (self.root / 'blobs').iterdir():
                    if not _digest(blob.name):
                        continue
                    data = self.blob(blob.name)
                    (temporary / 'blobs' / blob.name).write_bytes(data)
                    total, count = total + len(data), count + 1
                if (self.root / 'mirror.git').exists():
                    shutil.copytree(self.root / 'mirror.git', temporary / 'mirror.git')
                manifest = {'format': 1, 'created': time.time(), 'blobs': count, 'blob_bytes': total,
                            'changesets': self.db.execute('SELECT COUNT(*) FROM changesets').fetchone()[0],
                            'refs': self.refs(), 'credentials_included': False}
                (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                # Sync every copied object before exposing the final directory.
                for directory, _, files in os.walk(temporary, topdown=False):
                    for name in files:
                        path = Path(directory) / name
                        if path.is_symlink():
                            continue
                        with path.open('rb') as copied:
                            os.fsync(copied.fileno())
                    _fsync_directory(directory)
                os.rename(temporary, destination)
                _fsync_directory(destination.parent)
            return dict(manifest, destination=str(destination))
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
