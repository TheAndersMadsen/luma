#!/usr/bin/env python3
"""Single-host, delta-based source control experiment. No third-party dependencies."""
import argparse
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse, parse_qs

class Failure(Exception):
    def __init__(self, message, status=400, **details):
        super().__init__(message)
        self.status, self.details = status, details

def pathcheck(path):
    if not isinstance(path, str) or not path or '\x00' in path or '\\' in path or path.startswith('/') or any(p in ('', '.', '..', '.git') for p in path.split('/')):
        raise Failure('Invalid repository path')
    return path

class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / 'blobs').mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / 'store.db', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS changesets(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, target TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gitmap(cs TEXT PRIMARY KEY, sha TEXT NOT NULL);')
        self.db.commit()

    def putblob(self, data):
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / 'blobs' / digest
        with self.lock:
            if not path.exists():
                tmp = path.with_suffix('.tmp')
                tmp.write_bytes(data)
                os.replace(tmp, path)
        return {'hash': digest, 'bytes': len(data)}

    def blob(self, digest):
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise Failure('Invalid blob hash')
        path = self.root / 'blobs' / digest
        if not path.is_file():
            raise Failure('Blob does not exist', 404)
        return path.read_bytes()

    def resolve(self, value):
        if not isinstance(value, str):
            raise Failure('A changeset or ref is required')
        with self.lock:
            row = self.db.execute('SELECT target FROM refs WHERE name=?', (value,)).fetchone()
            target = row[0] if row else value
            if not self.db.execute('SELECT 1 FROM changesets WHERE id=?', (target,)).fetchone():
                raise Failure('Changeset or ref does not exist', 404)
            return target

    def changeset(self, value):
        target = self.resolve(value)
        with self.lock:
            return dict(json.loads(self.db.execute('SELECT data FROM changesets WHERE id=?', (target,)).fetchone()[0]), id=target)

    def create(self, parents, changes, message):
        parents = [self.resolve(p) for p in parents]
        if len(parents) > 2 or not isinstance(message, str) or not message.strip():
            raise Failure('Message and at most two parents are required')
        if not isinstance(changes, list):
            raise Failure('Changes must be a list')
        clean, seen = [], set()
        for row in changes:
            path = pathcheck(row['path'])
            if path in seen:
                raise Failure('Duplicate path')
            seen.add(path)
            if row.get('delete') is True:
                clean.append({'path': path, 'delete': True})
            else:
                mode = row.get('mode', '100644')
                if mode not in ('100644', '100755', '120000', '160000'):
                    raise Failure('Unsupported file mode')
                self.blob(row['blob'])
                clean.append({'path': path, 'blob': row['blob'], 'mode': mode})
        data = {'parents': parents, 'changes': sorted(clean, key=lambda r: r['path']), 'message': message, 'created_ns': time.time_ns()}
        canonical = json.dumps(data, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        with self.lock:
            self.db.execute('INSERT INTO changesets VALUES(?, ?)', (digest, canonical))
            self.db.commit()
        return dict(data, id=digest)

    def tree(self, value):
        chain, tree = [], {}
        cs = self.changeset(value)
        while True:
            chain.append(cs)
            if not cs['parents']:
                break
            cs = self.changeset(cs['parents'][0])
        for cs in reversed(chain):
            for row in cs['changes']:
                if row.get('delete'):
                    tree.pop(row['path'], None)
                else:
                    tree[row['path']] = {k: row[k] for k in ('blob', 'mode')}
        return tree

    def refs(self):
        with self.lock:
            return dict(self.db.execute('SELECT name,target FROM refs'))

    def cas(self, name, expected, target):
        pathcheck(name)
        target = self.resolve(target)
        with self.lock:
            actual = self.refs().get(name)
            if actual != expected:
                raise Failure('Ref changed concurrently', 409, actual=actual)
            self.db.execute('INSERT OR REPLACE INTO refs VALUES(?,?)', (name, target))
            self.db.commit()
        return {'name': name, 'target': target}

    @staticmethod
    def delta(before, after):
        return [dict({'path': p}, **after[p]) if p in after else {'path': p, 'delete': True}
                for p in sorted(before.keys() | after.keys()) if before.get(p) != after.get(p)]

    def ancestors(self, value):
        distances, todo = {}, [(self.resolve(value), 0)]
        while todo:
            cs, distance = todo.pop(0)
            if cs in distances:
                continue
            distances[cs] = distance
            todo.extend((p, distance + 1) for p in self.changeset(cs)['parents'])
        return distances

    def combine(self, left, right, message, rebase=False):
        left, right = self.resolve(left), self.resolve(right)
        la, ra = self.ancestors(left), self.ancestors(right)
        common = la.keys() & ra.keys()
        if not common:
            raise Failure('No common ancestor', 409)
        base = min(common, key=lambda x: (la[x] + ra[x], x))
        bt, lt, rt = self.tree(base), self.tree(left), self.tree(right)
        result, conflicts = dict(lt), []
        for p in sorted(bt.keys() | lt.keys() | rt.keys()):
            b, l, r = bt.get(p), lt.get(p), rt.get(p)
            if r == b or r == l:
                continue
            if l != b:
                conflicts.append(p)
            elif r is None:
                result.pop(p, None)
            else:
                result[p] = r
        if conflicts:
            raise Failure('Concurrent file edits require resolution', 409, conflicts=conflicts)
        return self.create([left] if rebase else [left, right], self.delta(lt, result), message)

    def gitsha(self, cs):
        with self.lock:
            row = self.db.execute('SELECT sha FROM gitmap WHERE cs=?', (cs,)).fetchone()
            return row[0] if row else None

    def mapgit(self, cs, sha):
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO gitmap VALUES(?,?)', (cs, sha))
            self.db.commit()

class GitBridge:
    def __init__(self, store, remote):
        self.store, self.remote = store, remote
        self.repo = store.root / 'mirror.git'
        self.lock = threading.RLock()
        if not self.repo.exists():
            subprocess.run(['git', 'init', '--bare', '-q', str(self.repo)], check=True)
            self.git('remote', 'add', 'origin', remote)
            self.git('config', 'credential.helper', '!gh auth git-credential')
        self.git('config', 'user.name', 'Luma source-control prototype')
        self.git('config', 'user.email', 'luma-scm@localhost')

    def git(self, *args, data=None, env=None):
        r = subprocess.run(['git', '--git-dir', str(self.repo), *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        if r.returncode:
            raise Failure('Git operation failed: ' + args[0], 409)
        return r.stdout

    def import_main(self):
        with self.lock:
            self.git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main')
            sha = self.git('rev-parse', 'refs/remotes/origin/main').decode().strip()
            with self.store.lock:
                existing = self.store.db.execute('SELECT cs FROM gitmap WHERE sha=?', (sha,)).fetchone()
            if existing:
                return {'changeset': existing[0], 'git_commit': sha}
            previous = self.store.refs().get('github')
            tree = {}
            for entry in self.git('ls-tree', '-rz', '--full-tree', sha).split(b'\x00'):
                if not entry:
                    continue
                meta, name = entry.split(b'\t', 1)
                mode, kind, oid = meta.decode().split()
                path = pathcheck(name.decode('utf-8'))
                data = oid.encode() if mode == '160000' else self.git('cat-file', 'blob', oid)
                tree[path] = {'blob': self.store.putblob(data)['hash'], 'mode': mode}
            before = self.store.tree(previous) if previous else {}
            cs = self.store.create([previous] if previous else [], self.store.delta(before, tree), 'Import GitHub main ' + sha)['id']
            self.store.mapgit(cs, sha)
            self.store.cas('github', previous, cs)
            if self.store.refs().get('main') == previous:
                self.store.cas('main', previous, cs)
            return {'changeset': cs, 'git_commit': sha, 'files': len(tree)}

    def materialize(self, cs, pending):
        mapped = pending.get(cs) or self.store.gitsha(cs)
        if mapped:
            return mapped
        change = self.store.changeset(cs)
        parents = [self.materialize(p, pending) for p in change['parents']]
        index = self.store.root / ('index-' + secrets.token_hex(8))
        date = str(change['created_ns'] // 1000000000) + ' +0000'
        env = dict(os.environ, GIT_INDEX_FILE=str(index), GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        try:
            self.git('read-tree', parents[0] if parents else '--empty', env=env)
            lines = []
            for row in change['changes']:
                if row.get('delete'):
                    mode, oid = '0', '0' * 40
                else:
                    mode = row['mode']
                    content = self.store.blob(row['blob'])
                    oid = content.decode() if mode == '160000' else self.git('hash-object', '-w', '--stdin', data=content).decode().strip()
                lines.append((mode + ' ' + oid + '\t' + row['path']).encode() + b'\x00')
            self.git('update-index', '-z', '--index-info', data=b''.join(lines), env=env)
            tree = self.git('write-tree', env=env).decode().strip()
            args = ['commit-tree', tree]
            for p in parents:
                args.extend(['-p', p])
            sha = self.git(*args, data=(change['message'] + '\n\nChangeset: ' + cs + '\n').encode(), env=env).decode().strip()
            pending[cs] = sha
            return sha
        finally:
            index.unlink(missing_ok=True)

    def publish(self, at, branch):
        if not isinstance(branch, str) or not branch.startswith('scion-prototype/'):
            raise Failure('Only scion-prototype/ branches can be published')
        self.git('check-ref-format', 'refs/heads/' + branch)
        with self.lock:
            cs = self.store.resolve(at)
            pending = {}
            sha = self.materialize(cs, pending)
            self.git('push', '--quiet', 'origin', sha + ':refs/heads/' + branch)
            # Record mappings only after an accepted, non-forced Git push.
            for mapped_cs, mapped_sha in pending.items():
                self.store.mapgit(mapped_cs, mapped_sha)
            return {'changeset': cs, 'git_commit': sha, 'branch': branch}

def make_server(store, bridge, token, host, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send(self, status, body, raw=False):
            content = body if raw else json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/octet-stream' if raw else 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        def do_GET(self):
            self.route()
        def do_POST(self):
            self.route()
        def route(self):
            try:
                u = urlparse(self.path)
                if u.path == '/health' and self.command == 'GET':
                    return self.send(200, b'OK', True)
                if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    raise Failure('Authentication required', 401)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                size = int(self.headers.get('Content-Length', '0'))
                if size < 0 or size > 32 * 1024 * 1024:
                    raise Failure('Request exceeds 32 MiB', 413)
                raw = self.rfile.read(size)
                d = json.loads(raw) if raw and u.path != '/v1/blobs' else {}
                p = u.path
                if self.command == 'POST':
                    if p == '/v1/blobs': return self.send(201, store.putblob(raw))
                    if p == '/v1/changesets':
                        return self.send(201, store.create([d['parent']] if d.get('parent') else [], d['changes'], d['message']))
                    if p.startswith('/v1/refs/'):
                        return self.send(200, store.cas(p[len('/v1/refs/'):], d.get('expected'), d['target']))
                    if p == '/v1/merge': return self.send(201, store.combine(d['left'], d['right'], d['message']))
                    if p == '/v1/rebase': return self.send(201, store.combine(d['onto'], d['changeset'], d.get('message', 'Rebase'), True))
                    if p == '/v1/github/import': return self.send(200, bridge.import_main())
                    if p == '/v1/github/publish': return self.send(200, bridge.publish(d['at'], d['branch']))
                elif self.command == 'GET':
                    if p == '/v1/refs': return self.send(200, {'refs': store.refs()})
                    if p.startswith('/v1/refs/'):
                        name = p[len('/v1/refs/'):]
                        return self.send(200, {'name': name, 'target': store.resolve(name)})
                    if p.startswith('/v1/blobs/'): return self.send(200, store.blob(p.rsplit('/', 1)[1]), True)
                    if p.startswith('/v1/changesets/'): return self.send(200, store.changeset(p.rsplit('/', 1)[1]))
                    if p == '/v1/files':
                        at = store.resolve(q.get('at', 'main'))
                        rows = [dict(path=k, **v, size=len(store.blob(v['blob']))) for k, v in sorted(store.tree(at).items()) if k.startswith(q.get('prefix', ''))]
                        return self.send(200, {'at': at, 'files': rows})
                    if p == '/v1/diff':
                        before, after = store.tree(q['base']), store.tree(q['head'])
                        return self.send(200, {'changes': [{'path': r['path'], 'before': before.get(r['path']), 'after': after.get(r['path'])} for r in store.delta(before, after)]})
                    if p == '/v1/history':
                        path = pathcheck(q['path'])
                        cs, rows = store.changeset(q.get('at', 'main')), []
                        while True:
                            if any(r['path'] == path for r in cs['changes']): rows.append(cs)
                            if not cs['parents']: break
                            cs = store.changeset(cs['parents'][0])
                        return self.send(200, {'changesets': rows})
                raise Failure('Route not found', 404)
            except Failure as e:
                self.send(e.status, dict(error=str(e), **e.details))
            except (KeyError, TypeError, ValueError, UnicodeError):
                self.send(400, {'error': 'Invalid request'})
            except Exception:
                self.send(500, {'error': 'Internal error; inspect service state'})
    return ThreadingHTTPServer((host, port), Handler)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--state', required=True)
    p.add_argument('--remote', default='https://github.com/TheAndersMadsen/luma.git')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8100)
    a = p.parse_args()
    store = Store(a.state)
    tokenfile = store.root / 'token'
    if not tokenfile.exists():
        fd = os.open(tokenfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f: f.write(secrets.token_urlsafe(32))
    server = make_server(store, GitBridge(store, a.remote), tokenfile.read_text().strip(), a.host, a.port)
    print('Luma source-control prototype listening on ' + a.host + ':' + str(a.port), flush=True)
    server.serve_forever()
