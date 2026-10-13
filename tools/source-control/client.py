#!/usr/bin/env python3
"""Online Luma source-control client with sparse, recoverable workspaces."""
import argparse
import contextlib
import difflib
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import unicodedata
from pathlib import Path, PurePosixPath
from urllib.parse import urlencode, urlsplit

META = '.luma-scm.json'
RESERVED = {'.git', '.scion', META, '.luma-scm.lock'}
BUILD_DIRS = {'node_modules', 'target', 'build', 'dist', '.next', '.gradle', '.kotlin', '__pycache__', '.cache', '.secrets'}
DEFAULT_ENDPOINT = 'http://127.0.0.1:8100'
DEFAULT_TOKEN = '/srv/state/luma-scm/token'


class ClientError(SystemExit):
    def __init__(self, message, status=None, details=None):
        super().__init__(message)
        self.status, self.details = status, details or {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError('The source-control server redirected the request; check --endpoint.')


def request(endpoint, token, method, route, data=None, raw=False):
    """Shared by the CLI and Google Scion adapter. Never include tokens in errors."""
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ClientError('Invalid API endpoint; use an http:// or https:// server URL without credentials.')
    if not route.startswith('/') or route.startswith('//'):
        raise ClientError('API routes must start with a single slash.')
    headers = {'Authorization': 'Bearer ' + token}
    if data is not None:
        if not raw:
            data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/octet-stream' if raw else 'application/json'
    req = urllib.request.Request(endpoint.rstrip('/') + route, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=300) as response:
            body = response.read()
            return json.loads(body) if response.headers.get_content_type() == 'application/json' else body
    except urllib.error.HTTPError as error:
        with error:
            body = error.read(16384).decode(errors='replace')
        try:
            detail = json.loads(body)
        except ValueError:
            detail = {}
        message = detail.get('error', 'The server rejected this request.')
        if not isinstance(message, str):
            message = 'The server rejected this request.'
        if detail.get('conflicts'):
            message += ' Conflicting paths: ' + ', '.join(detail['conflicts'])
        raise ClientError('HTTP ' + str(error.code) + ': ' + message.replace(token, '[redacted]'), error.code, detail) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ClientError('Cannot reach the source-control server. Check the service or SSH tunnel, then retry the same command.') from error


def repo_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value or value.startswith('/'):
        raise ClientError('Unsafe repository path.')
    if any(part in ('', '.', '..') or part.casefold() in RESERVED for part in value.split('/')):
        raise ClientError('Unsafe or reserved repository path: ' + value)
    return value


def prefixes(values):
    values = [values] if isinstance(values, str) else values
    clean = []
    for value in values or ['']:
        value = value.rstrip('/')
        if value:
            repo_path(value)
        if value not in clean:
            clean.append(value)
    return clean


def selected(path, scopes):
    return any(not scope or path == scope or path.startswith(scope + '/') for scope in scopes)


def cache_root():
    root = Path(os.environ.get('LUMA_SCM_CACHE', str(Path.home() / '.cache/luma-scm'))).expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def atomic_json(path, data):
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(data, handle, sort_keys=True, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def workspace_lock(root):
    directory = cache_root() / 'locks'
    directory.mkdir(exist_ok=True, mode=0o700)
    name = hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()
    with (directory / name).open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ClientError('Another client is changing this workspace; wait for it to finish.') from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def blob(endpoint, token, digest):
    if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        raise ClientError('Server returned an invalid blob hash.')
    directory = cache_root() / 'blobs'
    directory.mkdir(exist_ok=True, mode=0o700)
    target = directory / digest
    try:
        if target.is_file() and not target.is_symlink():
            content = target.read_bytes()
            if hashlib.sha256(content).hexdigest() == digest:
                with contextlib.suppress(FileNotFoundError):
                    os.utime(target, None)
                return content
    except FileNotFoundError:
        pass  # Another checkout can evict a cache entry at any time.
    content = request(endpoint, token, 'GET', '/v1/blobs/' + digest)
    if not isinstance(content, bytes) or hashlib.sha256(content).hexdigest() != digest:
        raise ClientError('Blob integrity check failed; the checkout has not been changed.')
    try:
        limit = int(os.environ.get('LUMA_SCM_CACHE_BYTES', str(256 * 1024 * 1024)))
    except ValueError:
        raise ClientError('LUMA_SCM_CACHE_BYTES must be a non-negative integer.') from None
    if limit < 0:
        raise ClientError('LUMA_SCM_CACHE_BYTES must be a non-negative integer.')
    if len(content) <= limit:
        descriptor, temporary = tempfile.mkstemp(prefix='.blob-', dir=directory)
        try:
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(content)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    entries = []
    for entry in directory.iterdir():
        try:
            if entry.is_file() and not entry.is_symlink() and re.fullmatch('[0-9a-f]{64}', entry.name):
                info = entry.stat()
                entries.append((info.st_mtime_ns, info.st_size, entry))
        except FileNotFoundError:
            pass
    total = sum(row[1] for row in entries)
    for _, size, entry in sorted(entries):
        if total <= limit:
            break
        try:
            entry.unlink()
        except FileNotFoundError:
            pass
        total -= size
    return content


def _files(endpoint, token, at, scopes):
    result = request(endpoint, token, 'GET', '/v1/files?' + urlencode({'at': at}))
    files = {}
    all_rows = {row['path']: row for row in result['files']}
    included = {path for path in all_rows if selected(path, scopes)}
    for path in list(included) + scopes:
        for parent in [PurePosixPath(path).parent, *PurePosixPath(path).parents]:
            ignore = str(parent / '.gitignore')
            if ignore in all_rows:
                included.add(ignore)
    if '.gitignore' in all_rows:
        included.add('.gitignore')
    for path in sorted(included):
        repo_path(path)
        row = all_rows[path]
        if row['mode'] not in ('100644', '100755', '120000'):
            raise ClientError('Git submodule checkout is not supported: ' + path + '. Use a Git checkout for that path.')
        files[path] = {'blob': row['blob'], 'mode': row['mode']}
    for path in files:
        if any(str(parent) in files for parent in PurePosixPath(path).parents):
            raise ClientError('Server returned a file/directory collision: ' + path)
    return result['at'], files


def _safe_links(links):
    for path, target in links.items():
        try:
            target = target.decode('utf-8') if isinstance(target, bytes) else target
        except UnicodeDecodeError:
            raise ClientError('Symlink target is not UTF-8: ' + path) from None
        if not target or target.startswith('/') or '\x00' in target or '\\' in target:
            raise ClientError('Unsafe symlink target: ' + path)
        pieces = list(PurePosixPath(path).parent.parts) + target.split('/')
        resolved, hops = [], 0
        while pieces:
            part = pieces.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                if not resolved:
                    raise ClientError('Symlink would escape checkout: ' + path)
                resolved.pop()
                continue
            resolved.append(part)
            key = '/'.join(resolved)
            if key in links:
                hops += 1
                if hops > 64:
                    raise ClientError('Symlink cycle in checkout: ' + path)
                value = links[key]
                value = value.decode('utf-8') if isinstance(value, bytes) else value
                if value.startswith('/') or '\x00' in value or '\\' in value:
                    raise ClientError('Symlink would escape checkout: ' + path)
                resolved.pop()
                pieces = value.split('/') + pieces


def stage_tree(endpoint, token, files, directory):
    links = {}
    directories = {}
    def destination_for(path):
        parent = directory
        logical = []
        try:
            for part in PurePosixPath(path).parts[:-1]:
                logical.append(part)
                parent = parent / part
                parent.mkdir(exist_ok=True)
                info = parent.stat()
                identity = (info.st_dev, info.st_ino)
                name = '/'.join(logical)
                if identity in directories and directories[identity] != name:
                    raise ClientError('Repository paths alias on this filesystem: ' + name + ' and ' + directories[identity])
                directories[identity] = name
        except OSError:
            raise ClientError('This filesystem cannot represent the repository path: ' + path) from None
        target = directory / path
        if target.exists() or target.is_symlink():
            raise ClientError('Repository paths alias on this filesystem: ' + path)
        return target
    for path, row in files.items():
        content = blob(endpoint, token, row['blob'])
        if row['mode'] == '120000':
            links[path] = content
            continue
        destination = destination_for(path)
        with destination.open('xb') as handle:
            handle.write(content)
        destination.chmod(0o755 if row['mode'] == '100755' else 0o644)
    _safe_links(links)
    for path, content in links.items():
        destination = destination_for(path)
        destination.symlink_to(content.decode('utf-8'))


def checkout(endpoint, token, at, prefix, destination, *, ref=None, branch=None):
    dest = Path(destination).expanduser().absolute()
    if dest.is_symlink() or (dest.exists() and (not dest.is_dir() or any(dest.iterdir()))):
        raise ClientError('Checkout destination must be empty.')
    scopes = prefixes(prefix)
    base, files = _files(endpoint, token, at, scopes)
    slug = re.sub('[^a-zA-Z0-9._-]+', '-', dest.name).strip('.-') or 'workspace'
    ref = ref or 'work/' + slug + '-' + uuid.uuid4().hex[:8]
    if not re.fullmatch(r'work/[A-Za-z0-9][A-Za-z0-9._/-]*', ref) or not _ref_format(ref):
        raise ClientError('Workspace ref must start with work/ and have a valid name.')
    refs = request(endpoint, token, 'GET', '/v1/refs')['refs']
    expected = refs.get(ref)
    if expected and expected != base:
        raise ClientError('Work ref already exists at another changeset. Use --at ' + ref + ' or choose another --ref.')
    branch = branch or 'scion/' + ref.removeprefix('work/')
    _branch(branch)
    meta = {'version': 1, 'base': base, 'ref': ref, 'ref_target': expected, 'prefixes': scopes,
            'endpoint': endpoint.rstrip('/'), 'branch': branch, 'files': files}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with workspace_lock(dest), tempfile.TemporaryDirectory(prefix='.luma-scm-stage-', dir=dest.parent) as temp:
        stage = Path(temp) / 'tree'
        stage.mkdir()
        stage_tree(endpoint, token, files, stage)
        atomic_json(stage / META, meta)
        if dest.exists():
            if any(dest.iterdir()):
                raise ClientError('Checkout destination changed during download.')
            dest.rmdir()
        os.replace(stage, dest)
    return {'changeset': base, 'files': len(files), 'destination': str(dest), 'ref': ref, 'branch': branch}


def find_workspace(value=None):
    current = Path(value or '.').expanduser().resolve()
    for root in (current, *current.parents):
        if (root / META).is_file() and not (root / META).is_symlink():
            return root
    raise ClientError('No Luma SCM workspace found. Run luma-scm checkout first.')


def metadata(root):
    try:
        result = json.loads((root / META).read_text())
    except (OSError, ValueError):
        raise ClientError('Workspace metadata is unreadable: ' + str(root / META)) from None
    if result.get('version') != 1 or not isinstance(result.get('files'), dict):
        raise ClientError('Unsupported workspace metadata.')
    for path in result['files']:
        repo_path(path)
    return result


def _read(root, path):
    repo_path(path)
    target = root / path
    for parent in target.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise ClientError('A tracked path has a symlink parent: ' + path)
    try:
        before = target.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    if stat.S_ISLNK(before.st_mode):
        data, mode = os.readlink(target).encode(), '120000'
    elif stat.S_ISREG(before.st_mode):
        descriptor = os.open(target, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as handle:
            data = handle.read()
            after = os.fstat(handle.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ClientError('File changed while being read; retry: ' + path)
        mode = '100755' if before.st_mode & 0o111 else '100644'
    elif stat.S_ISDIR(before.st_mode):
        return None
    else:
        raise ClientError('Only ordinary files and symlinks can be committed: ' + path)
    return {'blob': hashlib.sha256(data).hexdigest(), 'mode': mode, 'data': data}


def _ignored(root, paths):
    if not paths:
        return set()
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    for key in list(env):
        if key.startswith('GIT_') and key not in ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'):
            env.pop(key)
    with tempfile.TemporaryDirectory(prefix='luma-scm-ignore-') as temp:
        initialized = subprocess.run(['git', 'init', '--bare', '--quiet', temp], env=env, capture_output=True)
        if initialized.returncode:
            raise ClientError('Git is required to apply repository ignore rules.')
        env.update(GIT_DIR=temp, GIT_WORK_TREE=str(root))
        result = subprocess.run(['git', 'check-ignore', '--no-index', '-z', '--stdin'],
                                input=('\0'.join(paths) + '\0').encode(), cwd=root, env=env, capture_output=True)
        if result.returncode not in (0, 1):
            raise ClientError('Could not evaluate repository .gitignore rules.')
        return set(result.stdout.decode().rstrip('\0').split('\0')) if result.stdout else set()


def scan(root, meta):
    tracked, candidates = meta['files'], set()
    tracked_dirs = {str(parent) for path in tracked for parent in PurePosixPath(path).parents}
    for directory, dirs, files in os.walk(root, followlinks=False):
        relative = Path(directory).relative_to(root)
        kept = []
        for name in dirs:
            path = (relative / name).as_posix()
            if name.casefold() in RESERVED or name.casefold().startswith('.luma-scm-'):
                continue
            if (root / path).is_symlink():
                candidates.add(path)
            elif name not in BUILD_DIRS or path in tracked_dirs:
                kept.append(name)
        dirs[:] = kept
        for name in files:
            if name.casefold() in RESERVED or name.casefold().startswith('.luma-scm-'):
                continue
            candidates.add((relative / name).as_posix())
    # APFS may report a different Unicode normalization than was requested.
    # Preserve logical repository spelling only when both spellings name the
    # same actual file; a case-only rename is still recorded as delete + add.
    normalized = {}
    for path in candidates:
        normalized.setdefault(unicodedata.normalize('NFC', path), []).append(path)
    for path in tracked.keys() - candidates:
        for candidate in normalized.get(unicodedata.normalize('NFC', path), []):
            try:
                left, right = (root / path).lstat(), (root / candidate).lstat()
                if (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino):
                    candidates.remove(candidate)
                    candidates.add(path)
                    break
            except OSError:
                pass
    new = candidates - tracked.keys()
    ignored = _ignored(root, sorted(new))
    # Secret configuration and generated output remain excluded even without a repository rule.
    ignored |= {p for p in new if PurePosixPath(p).name in ('.env', '.DS_Store') or
                (PurePosixPath(p).name.startswith('.env.') and PurePosixPath(p).name != '.env.example')}
    visible = candidates - ignored
    outside = sorted(path for path in visible if path not in tracked and not selected(path, meta['prefixes']))
    current, changes = {}, []
    for path in sorted((visible | tracked.keys()) - set(outside)):
        row = _read(root, path) if path in candidates else None
        if row:
            current[path] = row
        old = tracked.get(path)
        present = {k: row[k] for k in ('blob', 'mode')} if row else None
        if present != old:
            changes.append({'path': path, 'status': 'added' if old is None else 'deleted' if row is None else 'modified',
                            'before': old, 'after': present})
    _safe_links({path: row['data'] for path, row in current.items() if row['mode'] == '120000'})
    return {'changes': changes, 'outside': outside, 'current': current}


def workspace_status(endpoint, token, workspace=None):
    root = find_workspace(workspace)
    meta = metadata(root)
    result = scan(root, meta)
    remote_refs = request(endpoint, token, 'GET', '/v1/refs')['refs']
    publication = None
    if meta.get('publication'):
        publication = request(endpoint, token, 'GET', '/v1/publications/' + meta['publication']['id'])
    return {'workspace': str(root), 'base': meta['base'], 'ref': meta['ref'], 'branch': meta['branch'],
            'changes': result['changes'], 'outside': result['outside'], 'pending': bool(meta.get('pending')),
            'remote_ref': remote_refs.get(meta['ref']), 'publication': publication}


def _branch(branch):
    if not isinstance(branch, str) or not re.fullmatch(r'(scion|scion-prototype)/[A-Za-z0-9][A-Za-z0-9._/-]*', branch) or not _ref_format(branch):
        raise ClientError('Publication branch must begin with scion/ and have a valid name.')
    return branch


def _ref_format(name):
    return '..' not in name and not name.endswith('.') and all(
        part and not part.startswith('.') and not part.endswith('.lock') for part in name.split('/'))


def _finish_commit(endpoint, token, root, meta):
    pending = meta['pending']
    try:
        result = request(endpoint, token, 'POST', '/v1/changesets', pending['request'])
    except ClientError as error:
        if error.status in (400, 401, 403, 404, 409, 422):
            meta.pop('pending', None)
            atomic_json(root / META, meta)
        raise
    meta.update(base=result['id'], ref_target=result['id'], files=pending['files'], branch=pending['branch'])
    if result.get('publication'):
        meta['publication'] = result['publication']
    meta.pop('pending', None)
    atomic_json(root / META, meta)
    return result


def commit_workspace(endpoint, token, workspace, message, branch=None, auto_merge=False, title=None, body=''):
    root = find_workspace(workspace)
    with workspace_lock(root):
        meta = metadata(root)
        if meta.get('update'):
            raise ClientError('An interrupted update needs recovery. Run luma-scm update before committing.')
        if meta.get('pending'):
            return _finish_commit(endpoint, token, root, meta)
        if not message or not message.strip():
            raise ClientError('A commit message is required.')
        state = scan(root, meta)
        if state['outside']:
            raise ClientError('Files outside the sparse selection must be moved or checked out separately: ' + ', '.join(state['outside']))
        if not state['changes']:
            raise ClientError('No source changes to commit.')
        branch = _branch(branch or meta['branch'])
        changes = []
        for change in state['changes']:
            path = change['path']
            if change['after'] is None:
                changes.append({'path': path, 'delete': True})
            else:
                row = state['current'][path]
                digest = request(endpoint, token, 'POST', '/v1/blobs', row['data'], raw=True)['hash']
                if digest != row['blob']:
                    raise ClientError('Uploaded blob checksum mismatch; commit was not created.')
                changes.append({'path': path, 'blob': digest, 'mode': row['mode']})
        payload = {'parent': meta['base'], 'message': message, 'changes': changes,
                   'ref': meta['ref'], 'expected': meta.get('ref_target'), 'request_id': uuid.uuid4().hex,
                   'publication': {'branch': branch, 'title': title or message.splitlines()[0], 'body': body, 'auto_merge': auto_merge}}
        files = {path: {key: row[key] for key in ('blob', 'mode')} for path, row in state['current'].items()}
        meta['pending'] = {'request': payload, 'files': files, 'branch': branch}
        atomic_json(root / META, meta)
        return _finish_commit(endpoint, token, root, meta)


def _install_update(root, old, files, stage):
    # The durable journal and preflight have checked every path before mutation.
    for path in sorted(old, key=lambda p: (-len(PurePosixPath(p).parts), p)):
        destination = root / path
        if any((root / str(parent)).is_symlink() for parent in PurePosixPath(path).parents if str(parent) != '.'):
            # A recovery may already have installed a new tracked symlink in
            # place of this old directory. Never traverse it to remove a file.
            continue
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        parent = destination.parent
        while parent != root:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    for path in files:
        destination = root / path
        if destination.is_dir() and not destination.is_symlink():
            try:
                destination.rmdir()
            except OSError:
                raise ClientError('Update would overwrite untracked files in ' + path) from None
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(stage / path, destination)


def update_workspace(endpoint, token, workspace=None, at='main'):
    root = find_workspace(workspace)
    with workspace_lock(root):
        meta = metadata(root)
        if meta.get('pending'):
            raise ClientError('A commit response is pending. Retry luma-scm commit first to recover its result.')
        journal = meta.get('update')
        if not journal:
            state = scan(root, meta)
            if state['changes'] or state['outside']:
                raise ClientError('Workspace has uncommitted changes. Commit or move them before updating.')
            target = request(endpoint, token, 'GET', '/v1/files?' + urlencode({'at': at, 'prefix': META}))['at']
            if target == meta['base']:
                return {'changeset': target, 'updated': False}
            refs = request(endpoint, token, 'GET', '/v1/refs')['refs']
            if refs.get(meta['ref']) != meta.get('ref_target'):
                raise ClientError('Work ref moved in another workspace. Check out that ref separately; this workspace is unchanged.')
            if meta.get('ref_target'):
                target = request(endpoint, token, 'POST', '/v1/merge', {'left': meta['base'], 'right': target,
                                  'message': 'Merge ' + at + ' into ' + meta['ref']})['id']
            _, files = _files(endpoint, token, target, meta['prefixes'])
            journal = {'target': target, 'files': files, 'expected': meta.get('ref_target')}
        files = journal['files']
        with tempfile.TemporaryDirectory(prefix='.luma-scm-stage-', dir=root.parent) as temp:
            stage = Path(temp)
            stage_tree(endpoint, token, files, stage)
            # Validate all obstructions before moving the server ref or deleting local files.
            _preflight_update(root, meta['files'], files, recovering=bool(meta.get('update')))
            if not meta.get('update'):
                meta['update'] = journal
                atomic_json(root / META, meta)
            refs = request(endpoint, token, 'GET', '/v1/refs')['refs']
            if refs.get(meta['ref']) != journal['target']:
                request(endpoint, token, 'POST', '/v1/refs/' + meta['ref'],
                        {'expected': journal['expected'], 'target': journal['target']})
            _install_update(root, meta['files'], files, stage)
            meta.update(base=journal['target'], ref_target=journal['target'], files=files)
            meta.pop('update', None)
            # The existing publication refers to the previous commit, until publish is requested.
            meta.pop('publication', None)
            atomic_json(root / META, meta)
        return {'changeset': meta['base'], 'ref': meta['ref'], 'updated': True,
                'hint': 'Run luma-scm publish to mirror this merged changeset.'}


def _preflight_update(root, old, files, recovering=False):
    if not recovering:
        for path, expected in old.items():
            row = _read(root, path)
            if row is None or {k: row[k] for k in ('blob', 'mode')} != expected:
                raise ClientError('Workspace changed while downloading update; no files were replaced: ' + path)
    if recovering:
        # Partial application may contain either version. Never discard edits
        # made after an interrupted update, even when the server ref has moved.
        for path in old.keys() | files.keys():
            if any(str(parent) in old.keys() | files.keys() and (root / str(parent)).is_symlink()
                   for parent in PurePosixPath(path).parents):
                continue  # An old tracked symlink will be removed before writing.
            row = _read(root, path)
            current = {k: row[k] for k in ('blob', 'mode')} if row else None
            if current is not None and current not in (old.get(path), files.get(path)):
                raise ClientError('Update recovery found newer local edits; move them aside before retrying: ' + path)
    for path in files:
        destination = root / path
        for parent in destination.parents:
            if parent == root:
                break
            relative = parent.relative_to(root).as_posix()
            if (parent.is_symlink() or (parent.exists() and not parent.is_dir())) and relative not in old:
                raise ClientError('Update would replace an untracked path: ' + relative)
        if path not in old and (destination.exists() or destination.is_symlink()):
            if recovering and (not destination.is_dir() or destination.is_symlink()):
                row = _read(root, path)
                if row and {k: row[k] for k in ('blob', 'mode')} == files[path]:
                    continue
            if not destination.is_dir() or destination.is_symlink():
                identity = destination.lstat()
                aliases_tracked = False
                for old_path in old:
                    try:
                        other = (root / old_path).lstat()
                        if (identity.st_dev, identity.st_ino) == (other.st_dev, other.st_ino):
                            aliases_tracked = True
                            break
                    except OSError:
                        pass
                if aliases_tracked:
                    continue
            if destination.is_dir() and not destination.is_symlink():
                for directory, dirs, children in os.walk(destination, followlinks=False):
                    for child in children + [d for d in dirs if (Path(directory) / d).is_symlink()]:
                        if (Path(directory) / child).relative_to(root).as_posix() not in old:
                            raise ClientError('Update would overwrite an untracked path: ' + path)
            else:
                raise ClientError('Update would overwrite an untracked path: ' + path)


def publish_workspace(endpoint, token, workspace=None, branch=None, auto_merge=False, title=None, body=''):
    root = find_workspace(workspace)
    with workspace_lock(root):
        meta = metadata(root)
        if meta.get('pending') or meta.get('update'):
            raise ClientError('Recover the pending commit or update before publishing.')
        branch = _branch(branch or meta['branch'])
        data = {'at': meta['base'], 'branch': branch, 'auto_merge': auto_merge, 'body': body}
        if title:
            data['title'] = title
        result = request(endpoint, token, 'POST', '/v1/publications', data)
        meta.update(publication=result, branch=branch)
        atomic_json(root / META, meta)
        return result


def diff_workspace(endpoint, token, workspace=None):
    root = find_workspace(workspace)
    meta = metadata(root)
    state = scan(root, meta)
    output = []
    for change in state['changes']:
        path = change['path']
        before = blob(endpoint, token, change['before']['blob']) if change['before'] else b''
        after = state['current'][path]['data'] if change['after'] else b''
        output.append('diff --luma a/' + path + ' b/' + path + '\n')
        if change['before'] and change['after'] and change['before']['mode'] != change['after']['mode']:
            output.append('old mode ' + change['before']['mode'] + '\nnew mode ' + change['after']['mode'] + '\n')
        try:
            if b'\0' in before + after:
                raise UnicodeError()
            output.extend(difflib.unified_diff(before.decode().splitlines(keepends=True), after.decode().splitlines(keepends=True),
                                               fromfile='a/' + path, tofile='b/' + path))
        except UnicodeError:
            output.append('Binary contents changed.\n')
    return {'changes': state['changes'], 'outside': state['outside'], 'diff': ''.join(output)}


def make_parser():
    parser = argparse.ArgumentParser(description='Server-side Luma source control with normal GitHub PRs.')
    parser.add_argument('--endpoint', default=os.environ.get('LUMA_SCM_ENDPOINT'))
    parser.add_argument('--token-file', default=os.environ.get('LUMA_SCM_TOKEN_FILE', DEFAULT_TOKEN))
    parser.add_argument('--workspace', help='Workspace directory; defaults to this directory or its parent workspace.')
    parser.add_argument('--json', action='store_true', dest='output_json', help='Print machine-readable results.')
    sub = parser.add_subparsers(dest='command', required=True)
    api = sub.add_parser('api', help='Make an authenticated API request.')
    api.add_argument('method', choices=['GET', 'POST'])
    api.add_argument('route')
    api.add_argument('--json', dest='body_json')
    co = sub.add_parser('checkout', help='Create a sparse or full workspace.')
    co.add_argument('destination')
    co.add_argument('--at', default='main')
    co.add_argument('--prefix', action='append', default=[])
    co.add_argument('--ref')
    co.add_argument('--branch')
    sub.add_parser('status', help='Show changed files and GitHub publication status.')
    sub.add_parser('diff', help='Show local edits against the pinned base.')
    commit = sub.add_parser('commit', help='Commit edits and queue their GitHub branch/PR atomically.')
    commit.add_argument('-m', '--message', required=True)
    commit.add_argument('--branch')
    commit.add_argument('--title')
    commit.add_argument('--body', default='')
    commit.add_argument('--auto-merge', action='store_true')
    update = sub.add_parser('update', help='Merge latest main into a clean workspace, preserving unlanded work.')
    update.add_argument('--at', default='main')
    publish = sub.add_parser('publish', help='Queue the current changeset for GitHub publication.')
    publish.add_argument('--branch')
    publish.add_argument('--title')
    publish.add_argument('--body', default='')
    publish.add_argument('--auto-merge', action='store_true')
    land = sub.add_parser('land', help='Request a normal GitHub merge after required CI succeeds.')
    land.add_argument('--publication', help='Publication ID; defaults to this workspace’s last publication.')
    log = sub.add_parser('log', help='Show server-side commit or path history.')
    log.add_argument('path', nargs='?', default='')
    log.add_argument('--at')
    log.add_argument('--limit', type=int, default=20)
    blame = sub.add_parser('blame', help='Show line attribution through the Git bridge.')
    blame.add_argument('path')
    blame.add_argument('--at')
    sub.add_parser('sync', help='Run GitHub import/publication once and show the results.')
    try:
        import agents
    except ModuleNotFoundError as error:
        if error.name != 'agents':
            raise
    else:
        agents.add_parser(sub)
    return parser


def _display(result, command, as_json):
    if as_json:
        print(json.dumps(result, indent=2) if not isinstance(result, bytes) else json.dumps(result.decode(errors='replace')))
    elif command == 'diff':
        print(result['diff'] or 'No source changes.', end='' if result['diff'] else '\n')
        if result['outside']:
            print('Outside sparse selection: ' + ', '.join(result['outside']))
    elif command == 'status':
        print('Workspace: ' + result['ref'] + ' at ' + result['base'][:12])
        for change in result['changes']:
            print(change['status'].ljust(9) + change['path'])
        if not result['changes']:
            print('No source changes.')
        if result['outside']:
            print('Outside sparse selection: ' + ', '.join(result['outside']))
        if result['pending']:
            print('Commit response pending; retry commit to recover it.')
        if result['publication']:
            publication = result['publication']
            print('GitHub: ' + publication['status'] + (' — ' + publication['pr_url'] if publication.get('pr_url') else ''))
            if publication.get('error'):
                print(publication['error'])
    elif command == 'commit':
        print('Committed ' + result['id'])
        publication = result.get('publication')
        if publication:
            print('GitHub publication ' + publication['status'] + ': ' + publication['branch'])
            print('Run luma-scm status to see the PR, or luma-scm land to request merging after CI.')
    else:
        print(json.dumps(result, indent=2) if not isinstance(result, bytes) else result.decode(errors='replace'))


def main(argv=None):
    args = make_parser().parse_args(argv)
    try:
        root = None
        if args.command not in ('api', 'checkout', 'sync', 'agent'):
            root = find_workspace(args.workspace)
        elif args.command == 'sync':
            try:
                root = find_workspace(args.workspace)
            except ClientError:
                pass
        endpoint = args.endpoint or (metadata(root)['endpoint'] if root else DEFAULT_ENDPOINT)
        token = Path(args.token_file).expanduser().read_text().strip()
        if not token:
            raise ClientError('The API token file is empty.')
        if args.command == 'api':
            result = request(endpoint, token, args.method, args.route, json.loads(args.body_json) if args.body_json else None)
        elif args.command == 'checkout':
            result = checkout(endpoint, token, args.at, args.prefix, args.destination, ref=args.ref, branch=args.branch)
        elif args.command == 'status':
            result = workspace_status(endpoint, token, root)
        elif args.command == 'diff':
            result = diff_workspace(endpoint, token, root)
        elif args.command == 'commit':
            result = commit_workspace(endpoint, token, root, args.message, args.branch, args.auto_merge, args.title, args.body)
        elif args.command == 'update':
            result = update_workspace(endpoint, token, root, args.at)
        elif args.command == 'publish':
            result = publish_workspace(endpoint, token, root, args.branch, args.auto_merge, args.title, args.body)
        elif args.command == 'land':
            meta = metadata(root)
            if meta.get('pending') or meta.get('update'):
                raise ClientError('Recover the pending commit or update before requesting a merge.')
            publication = args.publication or (meta.get('publication') or {}).get('id')
            if not publication:
                publication = publish_workspace(endpoint, token, root)['id']
            result = request(endpoint, token, 'POST', '/v1/publications/' + publication + '/land', {})
        elif args.command in ('log', 'blame'):
            meta = metadata(root)
            path = args.path
            if path:
                path = repo_path(path)
            query = {'at': args.at or meta['base'], 'path': path}
            if args.command == 'log':
                query['limit'] = args.limit
            result = request(endpoint, token, 'GET', '/v1/' + ('history' if args.command == 'log' else 'blame') + '?' + urlencode(query))
        elif args.command == 'sync':
            result = request(endpoint, token, 'POST', '/v1/sync', {})
        elif args.command == 'agent':
            import agents
            result = agents.run(args, endpoint, token)
        _display(result, args.command, args.output_json)
        return 0
    except ClientError as error:
        print(str(error), file=sys.stderr)
        return 1
    except FileNotFoundError as error:
        print('Required file or command is missing: ' + str(error.filename or error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError) as error:
        print('Cannot complete this operation: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
