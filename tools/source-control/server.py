#!/usr/bin/env python3
"""Authenticated Luma source-control service and automatic GitHub synchronization."""
import argparse
import contextlib
import fcntl
import hmac
import ipaddress
import json
import logging
import os
import secrets
import signal
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from core import Failure, Store, pathcheck
from bridge import GitBridge

LOG = logging.getLogger('luma-scm')
MAX_BODY = 32 * 1024 * 1024

def publication_options(data):
    if not isinstance(data, dict):
        raise Failure('publication must be an object')
    allowed = {'branch', 'title', 'body', 'auto_merge'}
    if set(data) - allowed:
        raise Failure('Unknown publication fields')
    if not isinstance(data.get('branch'), str):
        raise Failure('A publication branch is required')
    if not isinstance(data.get('auto_merge', False), bool):
        raise Failure('auto_merge must be a boolean')
    return data

class BoundedServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True
    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            with contextlib.suppress(OSError):
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n')
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

def make_server(store, bridge, token, host, port):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'LumaSCM/1'
        sys_version = ''
        def setup(self):
            super().setup()
            self.connection.settimeout(30)
        def log_message(self, *args):
            pass
        def send(self, status, body, raw=False):
            content = body if raw else json.dumps(body, ensure_ascii=True).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/octet-stream' if raw else 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(content)
        def do_GET(self):
            self.route()
        def do_POST(self):
            self.route()
        def route(self):
            try:
                self.dispatch()
            except Failure as exc:
                self.send(exc.status, dict(error=str(exc), **exc.details))
            except (KeyError, TypeError, ValueError, UnicodeError):
                self.send(400, {'error': 'Invalid request fields or JSON'})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except Exception as exc:
                # Do not log request bodies or credential-bearing subprocess arguments.
                LOG.error('request_failed type=%s', type(exc).__name__)
                self.send(500, {'error': 'Internal operation failed; inspect service logs and retry with the same request ID'})
        def dispatch(self):
            parsed = urlparse(self.path)
            p = unquote(parsed.path)
            if p == '/health' and self.command == 'GET':
                return self.send(200, b'OK', raw=True)
            received = self.headers.get('Authorization', '').encode()
            if not hmac.compare_digest(received, ('Bearer ' + token).encode()):
                raise Failure('Authentication required', 401)
            if self.headers.get('Transfer-Encoding'):
                raise Failure('Send a Content-Length; chunked uploads are unsupported', 400)
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1:
                raise Failure('Duplicate Content-Length', 400)
            size = int(lengths[0]) if lengths else 0
            if size < 0 or size > MAX_BODY:
                raise Failure('Request exceeds 32 MiB', 413)
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise Failure('Incomplete request body')
            data = json.loads(raw) if raw and p != '/v1/blobs' else {}
            if not isinstance(data, dict):
                raise Failure('JSON body must be an object')
            q = {k: values[0] for k, values in parse_qs(parsed.query).items()}
            if self.command == 'POST':
                return self.post(p, data, raw)
            if self.command == 'GET':
                return self.get(p, q)
            raise Failure('Method not allowed', 405)
        def post(self, p, d, raw):
            if p == '/v1/blobs':
                return self.send(201, store.putblob(raw))
            if p == '/v1/changesets':
                if d.get('ref') in ('main', 'github'):
                    raise Failure('main and github follow merged GitHub changes; use a work ref', 403)
                options = {}
                for k in ('ref', 'expected', 'request_id', 'author'):
                    if k in d:
                        options[k] = d[k]
                if 'publication' in d:
                    options['publication'] = publication_options(d['publication'])
                if options.get('ref') and 'expected' not in options:
                    raise Failure('An expected ref value (or null for a new ref) is required')
                parents = [d['parent']] if d.get('parent') else []
                return self.send(201, store.create(parents, d['changes'], d['message'], **options))
            if p.startswith('/v1/refs/'):
                name = p[len('/v1/refs/'):]
                if name in ('main', 'github'):
                    raise Failure('main and github follow merged GitHub changes; use a work ref', 403)
                if 'expected' not in d:
                    raise Failure('An expected ref value is required')
                return self.send(200, store.cas(name, d['expected'], d['target']))
            if p == '/v1/merge':
                return self.send(201, store.combine(d['left'], d['right'], d.get('message', 'Merge GitHub changes')))
            if p == '/v1/rebase':
                return self.send(201, store.combine(d['onto'], d['changeset'], d.get('message', 'Rebase changes'), rebase=True))
            if p == '/v1/publications':
                options = publication_options({k: v for k, v in d.items() if k != 'at'})
                return self.send(202, store.enqueue(store.resolve(d['at']), **options))
            if p.startswith('/v1/publications/'):
                parts = p[len('/v1/publications/'):].split('/')
                if len(parts) == 2 and parts[1] in ('retry', 'land'):
                    job = store.publication(parts[0])
                    fields = {'auto_merge': True} if parts[1] == 'land' else {}
                    if job['status'] not in ('published', 'merged'):
                        fields.update(status='pending', next_attempt=0, error=None)
                    store.update_publication(parts[0], **fields)
                    return self.send(200, store.publication(parts[0]))
            if p == '/v1/github/import':
                return self.send(200, bridge.import_main())
            if p == '/v1/github/publish':
                return self.send(200, bridge.publish(d['at'], d['branch']))
            if p == '/v1/sync':
                return self.send(200, bridge.sync_once())
            if p == '/v1/backup':
                destination = store.root.parent / (store.root.name + '-backups') / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(3))
                with bridge.lock:
                    return self.send(201, store.backup(destination))
            raise Failure('Route not found', 404)
        def get(self, p, q):
            if p == '/v1/status':
                return self.send(200, {'refs': store.refs(), 'publications': store.publications(), 'sync': getattr(bridge, 'last_sync', None)})
            if p == '/v1/refs':
                return self.send(200, {'refs': store.refs()})
            if p.startswith('/v1/refs/'):
                name = p[len('/v1/refs/'):]
                if name not in store.refs():
                    raise Failure('Ref does not exist', 404)
                return self.send(200, {'name': name, 'target': store.refs()[name]})
            if p.startswith('/v1/blobs/'):
                return self.send(200, store.blob(p.rsplit('/', 1)[1]), raw=True)
            if p.startswith('/v1/changesets/'):
                return self.send(200, store.changeset(p.rsplit('/', 1)[1]))
            if p == '/v1/files':
                at = store.resolve(q.get('at', 'main'))
                tree = store.tree(at, prefix=q.get('prefix', ''))
                rows = [dict(path=path, **value, size=(store.root / 'blobs' / value['blob']).stat().st_size) for path, value in sorted(tree.items())]
                return self.send(200, {'at': at, 'files': rows})
            if p == '/v1/diff':
                base, head = store.resolve(q['base']), store.resolve(q['head'])
                before, after = store.tree(base), store.tree(head)
                rows = [{'path': r['path'], 'before': before.get(r['path']), 'after': after.get(r['path'])} for r in store.delta(before, after)]
                return self.send(200, {'base': base, 'head': head, 'changes': rows})
            if p == '/v1/history':
                at = store.resolve(q.get('at', 'main'))
                limit = int(q.get('limit', '100'))
                if limit < 1 or limit > 1000:
                    raise Failure('History limit must be between 1 and 1000')
                if q.get('path'):
                    rows = store.history(at, pathcheck(q['path']), limit=limit)
                else:
                    rows, current = [], at
                    while current and len(rows) < limit:
                        row = store.changeset(current)
                        rows.append(row)
                        current = row['parents'][0] if row['parents'] else None
                return self.send(200, {'at': at, 'changesets': rows})
            if p == '/v1/blame':
                return self.send(200, bridge.blame(q.get('at', 'main'), pathcheck(q['path'])))
            if p == '/v1/publications':
                return self.send(200, {'publications': store.publications()})
            if p.startswith('/v1/publications/'):
                return self.send(200, store.publication(p[len('/v1/publications/'):]))
            raise Failure('Route not found', 404)
    return BoundedServer((host, port), Handler)

def read_token(root):
    path = root / 'token'
    if not path.exists():
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(secrets.token_urlsafe(32))
            stream.flush()
            os.fsync(stream.fileno())
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit('Token must be a regular owner-only file (mode 600)')
    token = path.read_text().strip()
    if not token:
        raise SystemExit('Token file is empty')
    return token

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--remote', default='https://github.com/TheAndersMadsen/luma.git')
    parser.add_argument('--github-repo', default='TheAndersMadsen/luma')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8100)
    parser.add_argument('--sync-interval', type=float, default=30)
    parser.add_argument('--no-sync', action='store_true')
    args = parser.parse_args()
    if not ipaddress.ip_address(args.host).is_loopback:
        raise SystemExit('Listen on loopback and access the service through SSH')
    if args.sync_interval < 1:
        raise SystemExit('sync-interval must be at least one second')
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (args.state / 'server.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('A source-control server already uses this state directory')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    store = Store(args.state)
    bridge = GitBridge(store, args.remote, github_repo=args.github_repo)
    server = make_server(store, bridge, read_token(args.state), args.host, args.port)
    stopping = threading.Event()
    def shutdown(*_):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if not args.no_sync:
        bridge.start(interval=args.sync_interval)
    LOG.info('listening host=%s port=%s automatic_sync=%s', args.host, args.port, not args.no_sync)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        bridge.stop()
        server.server_close()
        store.close()
        lock.close()

if __name__ == '__main__':
    main()
