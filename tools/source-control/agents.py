#!/usr/bin/env python3
"""Run Google Scion against isolated Luma source checkouts; submit on the host."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import tomllib


def _atomic(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    tmp = Path(temporary)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _name(name):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', name):
        raise SystemExit('Agent name must start with a lowercase letter and contain at most 48 letters, digits or hyphens')
    return name


def _root(args):
    root = Path(args.jobs_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


@contextlib.contextmanager
def _locked(folder):
    if not folder.is_dir():
        raise SystemExit('Agent job does not exist: ' + folder.name)
    with open(folder / 'lock', 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def _load(folder):
    try:
        return json.loads((folder / 'job.json').read_text())
    except FileNotFoundError:
        raise SystemExit('Agent job does not exist: ' + folder.name)


def _save(folder, job, **values):
    job.update(values, updated=time.time())
    _atomic(folder / 'job.json', job)
    return job


def _exec(command, cwd, *, data=None, timeout=90):
    # Authentication for inference is resolved by Scion's existing Hub secret.
    # Host GitHub and source-control credentials never enter child environment.
    env = {k: v for k, v in os.environ.items()
           if k not in {'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
                        'GITHUB_ENTERPRISE_TOKEN', 'LUMA_SCM_TOKEN'}
           and not k.startswith('GIT_CONFIG_')}
    env['GIT_TERMINAL_PROMPT'] = '0'
    try:
        result = subprocess.run(command, cwd=cwd, input=data, text=True,
                                capture_output=True, timeout=timeout, env=env)
    except FileNotFoundError:
        raise SystemExit('Required executable is unavailable: ' + command[0])
    except subprocess.TimeoutExpired:
        raise SystemExit(command[0] + ' timed out; job state and source files were retained')
    if result.returncode:
        # Child output may contain interactive auth codes or remote diagnostics.
        # Keep them out of durable records and command output.
        raise SystemExit(f'{command[0]} {command[1]} failed (exit {result.returncode}); use scion in {cwd} to diagnose')
    return result.stdout


def _scion(project, *args, data=None, timeout=90):
    return _exec(['scion', *args, '--non-interactive'], project, data=data, timeout=timeout)


def _json(text):
    # Some Scion versions put a development-auth banner before formatted output.
    decoder = json.JSONDecoder()
    for i, char in enumerate(text):
        if char in '[{':
            try:
                result, _ = decoder.raw_decode(text[i:])
                return result
            except ValueError:
                pass
    raise SystemExit('Scion returned no JSON status')


def _model():
    if os.environ.get('LUMA_SCION_MODEL'):
        return os.environ['LUMA_SCION_MODEL']
    try:
        data = tomllib.loads((Path.home() / '.codex/config.toml').read_text())
        if isinstance(data.get('model'), str):
            return data['model']
    except (OSError, ValueError):
        pass
    return 'gpt-5.6-terra'


def _secret_boundary(project):
    # Non-Git project avoids automatic GitHub clone credentials. Refuse a Hub
    # configuration that would nevertheless inject unrelated repository tokens.
    for command in [('hub', 'secret', 'list'), ('secret', 'list')]:
        values = _json(_scion(project, *command, '--format', 'json'))
        rows = values.get('secrets', []) if isinstance(values, dict) else values
        for row in rows:
            key = row.get('key', '').upper()
            if key in {'GH_TOKEN', 'GITHUB_TOKEN', 'LUMA_SCM_TOKEN'} or key.startswith(('GITHUB_', 'GH_ENTERPRISE_')):
                raise SystemExit('Scion would receive a repository credential (' + key + '); remove it from this project/user scope before starting an agent')


def _runtime(project, name):
    result = _json(_scion(project, 'list', '--format', 'json'))
    rows = result.get('agents', []) if isinstance(result, dict) else result
    return next((r for r in rows if r.get('name') == name or r.get('slug') == name), None)


def _refresh(folder, job):
    row = _runtime(Path(job['project']), job['name'])
    if row:
        # Deliberately omit taskSummary/terminal/log output from state: arbitrary
        # agent text is not required to decide lifecycle or to publish a change.
        runtime = {k: row.get(k) for k in ('id', 'phase', 'activity', 'containerStatus')}
        if row.get('activity') == 'completed':
            job.setdefault('completed_at', time.time())
        _save(folder, job, runtime=runtime)
    return job


def _done(job):
    runtime = job.get('runtime', {})
    return runtime.get('activity') == 'completed' or runtime.get('phase') == 'completed'


def _stopped(job):
    return job.get('runtime', {}).get('phase') in {'stopped', 'deleted'}


def _git_initial(source):
    _exec(['git', 'init', '-q', '-b', 'agent'], source)
    _exec(['git', 'config', 'user.name', 'Luma Scion agent'], source)
    _exec(['git', 'config', 'user.email', 'luma-agent@localhost'], source)
    (source / '.git/info/exclude').write_text('.luma-scm.json\n.scion/\n')
    _exec(['git', 'add', '-A'], source)
    _exec(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'Source-control checkout'], source)


def start(args, endpoint, token):
    from client import checkout
    root = _root(args)
    name = _name(args.name)
    folder = root / name
    try:
        folder.mkdir(mode=0o700)
    except FileExistsError:
        raise SystemExit('Agent job already exists; use agent status/submit/stop: ' + name)
    project = folder / ('luma-' + name)
    source = project / 'source'
    if any((ancestor / '.git').exists() for ancestor in project.parents):
        raise SystemExit('Agent jobs must live outside a Git checkout so Scion cannot select an ancestor repository')
    project.mkdir(mode=0o700)
    scopes = list(args.prefix or [''])
    if '' not in scopes:
        # Sparse source still needs the instructions and ignore rules that Git
        # would normally supply from each enclosing repository directory.
        for scope in list(scopes):
            parts = scope.rstrip('/').split('/')
            for count in range(len(parts) + 1):
                ancestor = '/'.join(parts[:count])
                for filename in ('AGENTS.md', '.gitignore'):
                    policy = (ancestor + '/' if ancestor else '') + filename
                    if policy not in scopes:
                        scopes.append(policy)
    job = {'name': name, 'project': str(project), 'workspace': str(source),
           'endpoint': endpoint, 'at': args.at, 'prefixes': scopes,
           'branch': args.branch or 'scion/' + name, 'auto_merge': args.auto_merge,
           'message': args.message or args.task.splitlines()[0][:160],
           'model': args.model or _model(), 'created': time.time(), 'status': 'preparing'}
    _save(folder, job)
    with _locked(folder):
        try:
            checkout(endpoint, token, args.at, job['prefixes'], source,
                     ref='work/' + name, branch=job['branch'])
            metadata = source / '.luma-scm.json'
            _atomic(folder / 'workspace.json', json.loads(metadata.read_text()))
            metadata.unlink()
            _git_initial(source)
            # Parent of source is deliberately not a Git project. Hub mounts it
            # at /workspace, without making an additional Git worktree. One such
            # project belongs to exactly one adapter job.
            _scion(project, 'init')
            _scion(project, 'hub', 'link')
            _secret_boundary(project)
            _save(folder, job, status='starting')
            prompt = ('Your isolated source checkout is /workspace/source. Change into that directory before working. '
                      'Only edit source files there. Do not commit, push, change Git remotes/configuration, '
                      'or modify .scion or .luma-scm metadata. The host will collect your edits, run checks, '
                      'and publish them through the source-control service. Complete the task and finish.\n\n'
                      + args.task)
            _scion(project, 'start', name, '--workspace', str(project),
                   '--harness', 'codex', '--harness-auth', 'auth-file',
                   '--model', job['model'], '--message-mode', 'none',
                   '--wait-ready', '--wait-timeout', '60s', '--task-file', '-',
                   data=prompt, timeout=90)
            _save(folder, job, status='running')
            _refresh(folder, job)
        except (Exception, SystemExit) as error:
            _save(folder, job, status='error', error=str(error))
            raise
    if args.wait:
        return wait(args, endpoint, token)
    return job


def status(args, endpoint, token):
    root = _root(args)
    folders = [root / _name(args.name)] if args.name else sorted(p for p in root.iterdir() if p.is_dir() and (p / 'job.json').exists())
    jobs = []
    for folder in folders:
        with _locked(folder):
            job = _load(folder)
            if job.get('status') != 'submitted':
                _refresh(folder, job)
            jobs.append(job)
    return jobs[0] if args.name else {'agents': jobs}


def stop(args, endpoint, token):
    folder = _root(args) / _name(args.name)
    with _locked(folder):
        job = _load(folder)
        _refresh(folder, job)
        if not _stopped(job):
            _scion(Path(job['project']), 'stop', job['name'])
            _refresh(folder, job)
        return _save(folder, job, status='stopped')


def submit(args, endpoint, token):
    from client import commit_workspace, request
    folder = _root(args) / _name(args.name)
    with _locked(folder):
        job = _load(folder)
        if endpoint.rstrip('/') != job['endpoint'].rstrip('/'):
            raise SystemExit('Use the same source-control endpoint that created this job')
        if job.get('status') == 'submitted':
            return job
        _refresh(folder, job)
        if not (_done(job) or _stopped(job)):
            raise SystemExit('Agent is still working or failed; inspect it or stop it before submitting')
        if not _stopped(job):
            _scion(Path(job['project']), 'stop', job['name'])
            for _ in range(20):
                _refresh(folder, job)
                if _stopped(job):
                    break
                time.sleep(0.5)
            if not _stopped(job):
                raise SystemExit('Agent has not stopped; source collection deferred')
        source = Path(job['workspace'])
        if source.is_symlink() or not source.is_dir():
            raise SystemExit('Agent workspace was replaced; refusing source collection')
        # Freeze source outside the container mount. The client journals pending
        # requests here, so even SIGKILL after the server accepted a change is
        # recoverable; metadata never has to be copied out in a finally block.
        collection = folder / 'collection'
        if job.get('status') not in {'submitting', 'submit_failed'}:
            if collection.exists():
                shutil.rmtree(collection)
            shutil.copytree(source, collection, symlinks=True,
                            ignore=lambda directory, names: [name for name in names
                                if name in {'.git', '.scion'} or name.startswith('.luma-scm')])
            _atomic(collection / '.luma-scm.json', json.loads((folder / 'workspace.json').read_text()))
        metadata = json.loads((collection / '.luma-scm.json').read_text())
        original = json.loads((folder / 'workspace.json').read_text())
        # Client may have saved the successful response before the adapter died
        # writing its own job record. Recover that acknowledged result directly.
        if metadata['base'] != original['base'] and not metadata.get('pending'):
            result = request(endpoint, token, 'GET', '/v1/changesets/' + metadata['base'])
            if metadata.get('publication'):
                result['publication'] = request(endpoint, token, 'GET', '/v1/publications/' + metadata['publication']['id'])
            return _save(folder, job, status='submitted', result=result, error=None,
                         collection=str(collection))
        _save(folder, job, status='submitting')
        try:
            result = commit_workspace(endpoint, token, collection, args.message or job['message'],
                                      branch=job['branch'], auto_merge=job['auto_merge'],
                                      title=args.message or job['message'])
            return _save(folder, job, status='submitted', result=result, error=None,
                         collection=str(collection))
        except (Exception, SystemExit) as error:
            _save(folder, job, status='submit_failed', error=str(error))
            raise


def wait(args, endpoint, token):
    deadline = time.monotonic() + args.timeout
    while True:
        job = status(args, endpoint, token)
        if job.get('status') == 'submitted':
            return job
        if _done(job):
            return submit(args, endpoint, token)
        runtime = job.get('runtime', {})
        if runtime.get('phase') in {'error', 'stopped'} or runtime.get('activity') in {'waiting_for_input', 'blocked'}:
            return dict(job, waiting='Agent requires attention; inspect it with scion look, then submit or stop')
        if time.monotonic() >= deadline:
            return dict(job, waiting='Wait timed out; job continues. Use agent wait or agent submit later')
        time.sleep(min(3, max(0, deadline - time.monotonic())))


def add_parser(sub):
    parser = sub.add_parser('agent', help='Run Google Scion on isolated source-control workspaces')
    parser.add_argument('--jobs-dir', default=os.environ.get('LUMA_SCION_JOBS', str(Path.home() / '.local/state/luma-scm/agents')))
    commands = parser.add_subparsers(dest='agent_command', required=True)
    launch = commands.add_parser('start')
    launch.add_argument('name'); launch.add_argument('task')
    launch.add_argument('--at', default='main'); launch.add_argument('--prefix', action='append')
    launch.add_argument('--branch'); launch.add_argument('--model')
    launch.add_argument('--message'); launch.add_argument('--auto-merge', action='store_true')
    launch.add_argument('--wait', action='store_true'); launch.add_argument('--timeout', type=float, default=1800)
    inspect = commands.add_parser('status'); inspect.add_argument('name', nargs='?')
    collect = commands.add_parser('submit'); collect.add_argument('name'); collect.add_argument('--message')
    halt = commands.add_parser('stop'); halt.add_argument('name')
    awaiting = commands.add_parser('wait'); awaiting.add_argument('name')
    awaiting.add_argument('--timeout', type=float, default=1800); awaiting.add_argument('--message')
    return parser


def run(args, endpoint, token):
    return {'start': start, 'status': status, 'stop': stop, 'submit': submit, 'wait': wait}[args.agent_command](args, endpoint, token)
