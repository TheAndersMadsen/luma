#!/usr/bin/env python3
"""Create a consistent authenticated server backup, or verify a restored copy."""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from client import request
from core import Store

def verify_git(root, store):
    mirror = root / 'mirror.git'
    if not mirror.is_dir() or mirror.is_symlink():
        raise SystemExit('Restored Git mirror is missing')
    environment = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
    command = ['git', '--git-dir', str(mirror)]
    try:
        integrity = subprocess.run([*command, 'fsck', '--full'], capture_output=True,
                                   env=environment, timeout=180)
        if integrity.returncode:
            raise SystemExit('Restored Git mirror failed object integrity verification')
        mappings = [row[0] for row in store.db.execute('SELECT DISTINCT sha FROM gitmap')]
        if any(not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', sha) for sha in mappings):
            raise SystemExit('Restored Git mapping has an invalid object ID')
        if mappings:
            checked = subprocess.run([*command, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
                                     input=('\n'.join(mappings) + '\n').encode(), capture_output=True,
                                     env=environment, timeout=180)
            expected = [sha + ' commit' for sha in mappings]
            if checked.returncode or checked.stdout.decode().splitlines() != expected:
                raise SystemExit('Restored Git mapping references a missing or non-commit object')
        return len(mappings)
    except (OSError, subprocess.TimeoutExpired):
        raise SystemExit('Could not verify restored Git objects; install Git and retry') from None

def verify(destination):
    root = Path(destination).resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    store = Store(root)
    try:
        if store.db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('Restored database failed integrity check')
        if store.db.execute('SELECT COUNT(*) FROM changesets').fetchone()[0] != manifest['changesets']:
            raise SystemExit('Restored changeset count differs from the manifest')
        count = 0
        for path in (root / 'blobs').iterdir():
            if len(path.name) == 64:
                store.blob(path.name)
                count += 1
        if count != manifest['blobs'] or store.refs() != manifest['refs']:
            raise SystemExit('Restored snapshot differs from its manifest')
        for cs, in store.db.execute('SELECT id FROM changesets').fetchall():
            record = store.changeset(cs)
            for row in record['changes']:
                if not row.get('delete'):
                    store.blob(row['blob'])
        mapped_commits = verify_git(root, store)
        return {'verified': True, 'destination': str(root), 'blobs': count,
                'changesets': manifest['changesets'], 'refs': store.refs(),
                'git_integrity_verified': True, 'mapped_git_commits': mapped_commits}
    finally:
        store.close()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--endpoint', default='http://127.0.0.1:8100')
    p.add_argument('--token-file', default='/srv/state/luma-scm/token')
    p.add_argument('--verify', metavar='BACKUP_DIRECTORY')
    args = p.parse_args()
    if args.verify:
        result = verify(args.verify)
    else:
        token = Path(args.token_file).read_text().strip()
        result = request(args.endpoint, token, 'POST', '/v1/backup', {})
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
