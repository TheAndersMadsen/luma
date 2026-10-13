#!/usr/bin/env python3
"""Copy and verify a consistent m1box backup on the owner's Mac, retaining 14."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from backup import verify

PATTERN = r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}'

def main():
    os.umask(0o077)
    root = Path.home() / '.local/state/luma-scm/backups'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    response = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'm1box',
                               'python3 /srv/dev/luma-scm/backup.py'], check=True, capture_output=True, text=True, timeout=300)
    report = json.loads(response.stdout)
    remote = report['destination']
    if not re.fullmatch('/srv/state/luma-scm-backups/' + PATTERN, remote):
        raise SystemExit('Server returned an unexpected backup location')
    name = Path(remote).name
    partial = root / ('.' + name + '.partial')
    partial.mkdir(mode=0o700)
    subprocess.run(['rsync', '-az', '--', 'm1box:' + remote + '/', str(partial) + '/'], check=True, timeout=300)
    result = verify(partial)
    destination = root / name
    partial.rename(destination)
    result.update(destination=str(destination), copied_from='m1box', verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (destination / 'off-machine-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    backups = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch(PATTERN, p.name))
    for old in backups[:-14]:
        shutil.rmtree(old)
    cleanup = '''from pathlib import Path
import re, shutil
root = Path('/srv/state/luma-scm-backups')
items = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}', p.name))
for old in items[:-14]: shutil.rmtree(old)
'''
    subprocess.run(['ssh', '-o', 'BatchMode=yes', 'm1box', 'python3', '-'], input=cleanup, text=True, check=True, timeout=60)
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
