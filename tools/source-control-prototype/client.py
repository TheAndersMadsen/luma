#!/usr/bin/env python3
"""Thin online client: metadata and source-control operations remain on the server."""
import argparse
import hashlib
import json
import os
import urllib.request
import urllib.error
from pathlib import Path, PurePosixPath
from urllib.parse import urlencode

def request(endpoint, token, method, route, data=None, raw=False):
    headers = {'Authorization': 'Bearer ' + token}
    if data is not None and not raw:
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(endpoint.rstrip('/') + route, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            body = response.read()
            return json.loads(body) if response.headers.get_content_type() == 'application/json' else body
    except urllib.error.HTTPError as e:
        with e:
            raise SystemExit('HTTP ' + str(e.code) + ': ' + e.read().decode())

def checkout(endpoint, token, at, prefix, destination):
    dest = Path(destination)
    if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
        raise SystemExit('Checkout destination must be empty')
    result = request(endpoint, token, 'GET', '/v1/files?' + urlencode({'at': at, 'prefix': prefix}))
    # Download and validate before touching the destination. Never follow repository symlinks.
    files = []
    paths = {r['path'] for r in result['files']}
    for row in result['files']:
        path = PurePosixPath(row['path'])
        if path.is_absolute() or any(p in ('.', '..', '.git') for p in path.parts):
            raise SystemExit('Unsafe checkout path')
        if any(str(parent) in paths for parent in path.parents if str(parent) != '.'):
            raise SystemExit('File/directory collision')
        content = request(endpoint, token, 'GET', '/v1/blobs/' + row['blob'])
        if hashlib.sha256(content).hexdigest() != row['blob']:
            raise SystemExit('Blob integrity check failed')
        if row['mode'] == '160000':
            raise SystemExit('Submodule checkouts are not implemented; query the gitlink through the API')
        if row['mode'] == '120000':
            target = Path(content.decode())
            resolved = (dest / row['path']).parent.joinpath(target).resolve()
            if target.is_absolute() or not resolved.is_relative_to(dest.resolve()):
                raise SystemExit('Symlink would escape checkout')
        files.append((row, content))
    dest.mkdir(parents=True, exist_ok=True)
    for row, content in files:
        path = dest / row['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        if row['mode'] == '120000': path.symlink_to(content.decode())
        else:
            path.write_bytes(content)
            path.chmod(0o755 if row['mode'] == '100755' else 0o644)
    return {'changeset': result['at'], 'files': len(files), 'destination': str(dest.resolve())}

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--endpoint', default='http://127.0.0.1:8100')
    p.add_argument('--token-file', default='/srv/state/luma-scm/token')
    sub = p.add_subparsers(dest='command', required=True)
    api = sub.add_parser('api'); api.add_argument('method', choices=['GET', 'POST']); api.add_argument('route'); api.add_argument('--json', default=None)
    co = sub.add_parser('checkout'); co.add_argument('destination'); co.add_argument('--at', default='main'); co.add_argument('--prefix', default='')
    change = sub.add_parser('commit'); change.add_argument('--parent', default='main'); change.add_argument('--message', required=True); change.add_argument('--file', action='append', default=[], help='repository-path=local-file'); change.add_argument('--delete', action='append', default=[])
    a = p.parse_args()
    token = Path(a.token_file).read_text().strip()
    if a.command == 'checkout': result = checkout(a.endpoint, token, a.at, a.prefix, a.destination)
    elif a.command == 'api': result = request(a.endpoint, token, a.method, a.route, json.loads(a.json) if a.json else None)
    else:
        changes = []
        for mapping in a.file:
            repo, source = mapping.split('=', 1)
            src = Path(source)
            blob = request(a.endpoint, token, 'POST', '/v1/blobs', src.read_bytes(), raw=True)['hash']
            changes.append({'path': repo, 'blob': blob, 'mode': '100755' if os.access(src, os.X_OK) else '100644'})
        changes.extend({'path': path, 'delete': True} for path in a.delete)
        parent = request(a.endpoint, token, 'GET', '/v1/refs')['refs'].get(a.parent, a.parent)
        result = request(a.endpoint, token, 'POST', '/v1/changesets', {'parent': parent, 'message': a.message, 'changes': changes})
    print(json.dumps(result, indent=2) if not isinstance(result, bytes) else result.decode())
