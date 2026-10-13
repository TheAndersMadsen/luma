#!/usr/bin/env python3
"""Run Google Scion agents on isolated Luma checkouts; submit their work on the host.

Each job folder keeps host-only state (job.json, the trusted checkout metadata,
the frozen collection) beside the job's own Scion project, `luma-NAME`. Only the
project's `workspace` is mounted at /workspace: `source` is the checkout,
`state` is the agent's LUMA_DATA_DIR with the stock reference mounted
read-only inside it, `cache` holds Cargo, pnpm and Bun state, and the agent
writes its hand-off to `HANDOFF.md`. The project's link file stays outside the
mount, and a job's project never contains another job.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import time
import tomllib

# Each harness signs in with one of the owner's accounts through this Scion
# user secret (docs/source-control.md "Agent host"). Claude takes a dedicated
# `claude setup-token` token: a copied interactive login would rotate the
# refresh token the owner's own Claude Code depends on.
HARNESS_AUTH = {'claude': ('oauth-token', 'CLAUDE_CODE_OAUTH_TOKEN'),
                'codex': ('auth-file', 'CODEX_AUTH'),
                'opencode': ('auth-file', 'OPENCODE_AUTH')}
# tools/scion/install builds these locally. The reserved .invalid domain keeps
# Scion from rewriting the name to its registry and Docker from pulling it.
IMAGE = 'luma.invalid/agent-{}:current'
# Rust builds need more than Scion's default of two CPUs and no memory bound.
RESOURCES = {'limits': {'cpu': '6', 'memory': '12Gi'}}
# Paths inside the agent container; the job's workspace is mounted at /workspace.
CONTAINER_ENV = {
    'LUMA_DATA_DIR': '/workspace/state',
    'CARGO_HOME': '/workspace/cache/cargo',
    'CARGO_TARGET_DIR': '/workspace/cache/cargo-target',
    'npm_config_store_dir': '/workspace/cache/pnpm-store',
    'BUN_INSTALL_CACHE_DIR': '/workspace/cache/bun',
}
STOCK_MOUNT = '/workspace/state/stock-reference'
TERMINAL = {'submitted', 'no_changes'}
# Scion activities after which an agent needs a person (pkg/agent/state).
# `stalled` only means no recent activity event, e.g. during a long build.
ATTENTION = {'waiting_for_input', 'blocked', 'limits_exceeded', 'crashed', 'offline'}
HANDOFF_BYTES = 60_000
PROMPT = ('You are a Luma agent. Your checkout is /workspace/source: change into it and read its AGENTS.md '
          'before you work. Edit files only there; never commit, push, or change Git configuration or remotes. '
          'Before you finish, write your hand-off to /workspace/HANDOFF.md and report completion as your '
          'instructions describe. The host publishes your edits as a GitHub pull request, and Luma CI decides '
          'whether it lands.\n\nTask:\n')
# Publication is public. Decompiler output (AGENTS.md "Stock reference") and
# credential material never leave the host.
# The literals are split so this file never matches its own pattern.
STOCK_CODE = re.compile(rb'JADX (?:WARN|WARNING|INFO|DEBUG)|Code decompiled' rb' incorrectly|'
                        rb'/\* (?:loaded|compiled|renamed) from: ')
CREDENTIAL = re.compile(rb'sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gh[opsur]_[A-Za-z0-9]{36,}|'
                        rb'github_pat_[A-Za-z0-9_]{60,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{20,}|'
                        rb'-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}')


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


def _outside_git(path, label):
    if any((ancestor / '.git').exists() for ancestor in (path, *path.parents)):
        raise SystemExit(label + ' must live outside a Git checkout so Scion cannot select an ancestor repository')
    return path


def _root(args):
    root = _outside_git(Path(args.jobs_dir).expanduser().resolve(), 'Agent jobs')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def _project_id(project):
    for line in (project / '.scion').read_text().splitlines():
        if line.startswith('project-id:'):
            return line.split(':', 1)[1].strip()
    raise SystemExit('Scion project marker has no project ID: ' + str(project / '.scion'))


def _job_project(job):
    # Host commands act only on the project this job created.
    project = Path(job['project'])
    if job.get('project_id') and _project_id(project) != job['project_id']:
        raise SystemExit('The Scion project link of ' + job['name'] + ' no longer names its own project; refusing to act on it')
    return project


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


def _exec(command, cwd, *, data=None, timeout=90, accept=(0,)):
    # Authentication for inference is resolved by Scion's existing Hub secret.
    # Host GitHub and source-control credentials never enter child environment.
    env = {k: v for k, v in os.environ.items()
           if k not in {'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
                        'GITHUB_ENTERPRISE_TOKEN', 'LUMA_SCM_TOKEN'}
           and not k.startswith('GIT_CONFIG_')}
    env['GIT_TERMINAL_PROMPT'] = '0'
    if not Path(cwd).is_dir():
        raise SystemExit('Directory is missing: ' + str(cwd))
    try:
        result = subprocess.run(command, cwd=cwd, input=data, text=True,
                                capture_output=True, timeout=timeout, env=env)
    except FileNotFoundError:
        raise SystemExit('Required executable is unavailable: ' + command[0])
    except subprocess.TimeoutExpired:
        raise SystemExit(command[0] + ' timed out; job state and source files were retained')
    if result.returncode not in accept:
        # Child output may contain interactive auth codes or remote diagnostics.
        # Keep them out of durable records and command output.
        raise SystemExit(f'{command[0]} {command[1]} failed (exit {result.returncode}); use scion in {cwd} to diagnose')
    return result


def _scion(project, *args, data=None, timeout=90, accept=(0,)):
    return _exec(['scion', *args, '--non-interactive'], project, data=data, timeout=timeout, accept=accept)


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


def _default_model(harness):
    # Claude agents use Opus 5.5; Codex and OpenCode follow the owner's working
    # host configuration.
    if harness == 'claude':
        return 'claude-opus-5-5'
    try:
        if harness == 'codex':
            data = tomllib.loads((Path.home() / '.codex/config.toml').read_text())
        else:
            data = json.loads((Path.home() / '.config/opencode/opencode.json').read_text())
        if isinstance(data.get('model'), str):
            return data['model']
    except (OSError, ValueError):
        pass
    return 'gpt-5.6-terra' if harness == 'codex' else None


def _secret_boundary(root, harness):
    # Non-Git project avoids automatic GitHub clone credentials. Refuse a Hub
    # configuration that would nevertheless inject unrelated repository tokens.
    # Checked before the job's project exists, so a refusal leaves nothing behind.
    keys = set()
    for command in [('hub', 'secret', 'list'), ('secret', 'list')]:
        values = _json(_scion(root, '--global', *command, '--format', 'json').stdout)
        rows = values.get('secrets', []) if isinstance(values, dict) else values
        for row in rows:
            key = row.get('key', '').upper()
            keys.add(key)
            if key in {'GH_TOKEN', 'GITHUB_TOKEN', 'LUMA_SCM_TOKEN'} or key.startswith(('GITHUB_', 'GH_ENTERPRISE_')):
                raise SystemExit('Scion would receive a repository credential (' + key + '); remove it from this project/user scope before starting an agent')
    if HARNESS_AUTH[harness][1] not in keys:
        raise SystemExit('Scion holds no ' + HARNESS_AUTH[harness][1] + ' secret for the ' + harness +
                         ' harness; the owner stores it as described in docs/source-control.md "Agent host"')


def _runtime(project, name):
    result = _json(_scion(project, 'list', '--format', 'json').stdout)
    rows = result.get('agents', []) if isinstance(result, dict) else result
    return next((r for r in rows if r.get('name') == name or r.get('slug') == name), None)


def _refresh(folder, job):
    if job.get('status') in {'preparing', 'starting'}:
        return job
    row = _runtime(_job_project(job), job['name'])
    # Deliberately omit taskSummary/terminal/log output from state: arbitrary
    # agent text is not required to decide lifecycle or to publish a change.
    # An agent Scion no longer lists is gone; its source can still be submitted.
    runtime = ({k: row.get(k) for k in ('id', 'phase', 'activity', 'containerStatus')} if row
               else dict(job.get('runtime') or {}, phase='deleted', containerStatus=None))
    if runtime.get('activity') == 'completed':
        job.setdefault('completed_at', time.time())
    return _save(folder, job, runtime=runtime)


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


def _prepare_state(workspace, stock):
    # ./luma accepts a non-default LUMA_DATA_DIR only at mode 0700 with its
    # marker (platform/cli/context.js ensureManagedRoot). The stock reference
    # mount point exists before Docker would create it as root.
    data, cache = workspace / 'state', workspace / 'cache'
    for directory in (data, cache):
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)
    marker = data / '.luma-managed'
    marker.write_text('schema=1\nproduct=luma\n')
    marker.chmod(0o600)
    # Inline volumes replace the mount --workspace would add, so the job's
    # workspace is listed itself; without it Scion mounts the whole project.
    config = {'env': dict(CONTAINER_ENV), 'resources': RESOURCES,
              'volumes': [{'source': str(workspace), 'target': '/workspace'}]}
    # A reference is mounted whole or not at all: an empty one would read as
    # a partial reference to the evidence tests.
    if (stock / 'decompiled').is_dir() and (stock / 'manifest.json').is_file():
        (data / 'stock-reference').mkdir(mode=0o755)
        config['volumes'].append({'source': str(stock), 'target': STOCK_MOUNT, 'read_only': True})
    return config


def start(args, endpoint, token):
    from client import checkout, request
    name = _name(args.name)
    task = args.task.strip()
    if not task:
        raise SystemExit('The task must not be empty')
    root = _root(args)
    folder = root / name
    if folder.exists():
        raise SystemExit('Agent job already exists; use agent status/submit/delete: ' + name)
    ref = 'work/' + name
    if request(endpoint, token, 'GET', '/v1/refs')['refs'].get(ref) and args.at != ref:
        raise SystemExit(ref + ' holds earlier agent work; continue it with --at ' + ref + ' or choose another name')
    _secret_boundary(root, args.harness)
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
    try:
        folder.mkdir(mode=0o700)
    except FileExistsError:
        raise SystemExit('Agent job already exists; use agent status/submit/delete: ' + name)
    project = folder / ('luma-' + name)
    workspace = project / 'workspace'
    source = workspace / 'source'
    stock = Path(args.stock_reference).expanduser()
    job = {'name': name, 'project': str(project), 'workspace': str(workspace), 'source': str(source),
           'endpoint': endpoint, 'at': args.at, 'prefixes': scopes,
           'branch': args.branch or 'scion/' + name, 'auto_merge': args.auto_merge,
           'message': args.message, 'task_title': task.splitlines()[0][:160],
           'harness': args.harness, 'model': args.model or _default_model(args.harness),
           'template': args.template, 'image': IMAGE.format(args.harness),
           'created': time.time(), 'status': 'preparing'}
    _save(folder, job)
    with _locked(folder):
        try:
            project.mkdir(mode=0o700)
            workspace.mkdir(mode=0o700)
            checkout(endpoint, token, args.at, job['prefixes'], source, ref=ref, branch=job['branch'])
            metadata = source / '.luma-scm.json'
            _atomic(folder / 'workspace.json', json.loads(metadata.read_text()))
            metadata.unlink()
            _git_initial(source)
            # The project directory is not a Git checkout, so Scion creates no
            # worktree and injects no clone credentials. Linking matches an
            # existing Hub project by name; refuse to join someone else's.
            _scion(project, 'init')
            _save(folder, job, project_id=_project_id(project))
            _scion(project, 'hub', 'link')
            if _project_id(project) != job['project_id']:
                raise SystemExit('A Hub project named luma-' + name + ' already exists; choose another agent name')
            config = _prepare_state(workspace, stock)
            # Host-only file: the agent never sees how it was configured.
            _atomic(folder / 'scion-config.json', config)
            _save(folder, job, status='starting', stock_reference=len(config['volumes']) > 1)
            model = ['--model', job['model']] if job['model'] else []
            # Exit 3: running, but the harness did not report ready in time.
            _scion(project, 'start', name, '--workspace', str(workspace), '--type', job['template'],
                   '--harness', job['harness'], '--harness-auth', HARNESS_AUTH[job['harness']][0],
                   '--image', job['image'], *model,
                   '--config', str(folder / 'scion-config.json'), '--message-mode', 'none',
                   '--label', 'luma-job=' + name, '--wait-ready', '--wait-timeout', '180s', '--task-file', '-',
                   data=PROMPT + task, timeout=240, accept=(0, 3))
            _save(folder, job, status='running')
            _refresh(folder, job)
        except (Exception, SystemExit) as error:
            _save(folder, job, status='error', error=str(error))
            raise
    if args.wait:
        return wait(args, endpoint, token)
    return job


def _folders(args):
    root = _root(args)
    if args.name:
        return [root / _name(args.name)]
    return sorted(p for p in root.iterdir() if p.is_dir() and (p / 'job.json').exists())


def status(args, endpoint, token):
    jobs = []
    for folder in _folders(args):
        try:
            with _locked(folder):
                job = _load(folder)
                if job.get('status') not in TERMINAL:
                    _refresh(folder, job)
                jobs.append(job)
        except (Exception, SystemExit) as error:
            if args.name:
                raise
            jobs.append({'name': folder.name, 'error': str(error) or type(error).__name__})
    return jobs[0] if args.name else {'agents': jobs}


def stop(args, endpoint, token):
    folder = _root(args) / _name(args.name)
    with _locked(folder):
        job = _load(folder)
        _refresh(folder, job)
        if not _stopped(job):
            _scion(_job_project(job), 'stop', job['name'])
            _refresh(folder, job)
        if job.get('status') in TERMINAL:
            return job
        return _save(folder, job, status='stopped')


def delete(args, endpoint, token):
    folder = _root(args) / _name(args.name)
    with _locked(folder):
        job = _load(folder)
        if job.get('status') not in TERMINAL and not args.force:
            raise SystemExit('Agent ' + job['name'] + ' has unsubmitted work; submit it, or pass --force to discard it')
        project = Path(job['project'])
        # A job whose link joined another project never touches that project.
        if (project / '.scion').is_file() and _project_id(project) == job.get('project_id'):
            if _runtime(project, job['name']):
                _scion(project, 'delete', job['name'], '--force')
            _scion(folder.parent, '--global', 'hub', 'projects', 'delete', job['project_id'], '--yes')
        # The job folder goes last, so a failed Scion removal can be retried.
        shutil.rmtree(folder)
    return {'name': job['name'], 'deleted': True}


def _collect(folder, job, collection):
    from client import BUILD_DIRS
    source = Path(job.get('source') or job['workspace'])
    if source.is_symlink() or not source.is_dir():
        raise SystemExit('Agent workspace was replaced; refusing source collection')
    trusted = json.loads((folder / 'workspace.json').read_text())
    # Build output is skipped unless it holds tracked files, matching scan().
    tracked = {str(parent) for path in trusted['files'] for parent in PurePosixPath(path).parents}

    def ignore(directory, names):
        relative = PurePosixPath(Path(directory).relative_to(source).as_posix())
        return [name for name in names
                if name in {'.git', '.scion'} or name.startswith('.luma-scm')
                or (name in BUILD_DIRS and str(relative / name) not in tracked)]
    if collection.exists():
        shutil.rmtree(collection)
    shutil.copytree(source, collection, symlinks=True, ignore=ignore)
    _atomic(collection / '.luma-scm.json', trusted)


def _handoff(job):
    # The agent writes HANDOFF.md in its mount. Never follow its symlinks or
    # block on a FIFO, and bound what is read.
    workspace = Path(job['workspace'])
    if workspace.is_symlink():
        raise SystemExit('Agent workspace was replaced; refusing to read the hand-off')
    try:
        fd = os.open(workspace / 'HANDOFF.md', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        return {'problem': 'HANDOFF.md is not a regular file'}
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            return {'problem': 'HANDOFF.md is not a regular file'}
        data = stream.read(HANDOFF_BYTES + 1)
    lines = data[:HANDOFF_BYTES].decode('utf-8', 'replace').replace('\x00', '').strip().splitlines()
    title = None
    if lines and lines[0].startswith('# '):
        title = lines.pop(0)[2:].strip()[:120] or None
    body = '\n'.join(lines).strip()
    if len(data) > HANDOFF_BYTES:
        body += '\n\n(The host truncated this hand-off.)'
    return {'title': title, 'body': body, 'data': data[:HANDOFF_BYTES]}


def _guard(state, handoff):
    problems = []
    if handoff and handoff.get('problem'):
        problems.append(handoff['problem'])
    texts = [(change['path'], state['current'][change['path']]['data'])
             for change in state['changes'] if change['after'] is not None]
    if handoff and handoff.get('data'):
        texts.append(('HANDOFF.md', handoff['data']))
    for path, data in texts:
        if STOCK_CODE.search(data):
            problems.append(path + ' contains decompiled stock code')
        if CREDENTIAL.search(data):
            problems.append(path + ' contains a credential')
    return problems


def submit(args, endpoint, token):
    from client import commit_workspace, request, scan
    folder = _root(args) / _name(args.name)
    with _locked(folder):
        job = _load(folder)
        if endpoint.rstrip('/') != job['endpoint'].rstrip('/'):
            raise SystemExit('Use the same source-control endpoint that created this job')
        if job.get('status') in TERMINAL:
            return job
        _refresh(folder, job)
        if not (_done(job) or _stopped(job)):
            raise SystemExit('Agent is still working or failed; inspect it or stop it before submitting')
        if not _stopped(job):
            _scion(_job_project(job), 'stop', job['name'])
            for _ in range(20):
                _refresh(folder, job)
                if _stopped(job):
                    break
                time.sleep(0.5)
            if not _stopped(job):
                raise SystemExit('Agent has not stopped; source collection deferred')
        # Freeze source outside the container mount. The client journals pending
        # requests here, so even SIGKILL after the server accepted a change is
        # recoverable; metadata never has to be copied out in a finally block.
        collection = folder / 'collection'
        if job.get('status') not in {'submitting', 'submit_failed'}:
            _collect(folder, job, collection)
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
        handoff = _handoff(job)
        if not metadata.get('pending'):
            state = scan(collection, metadata)
            if not state['changes'] and not state['outside']:
                return _save(folder, job, status='no_changes', error=None, handoff=bool(handoff))
            problems = _guard(state, handoff)
            if problems:
                _save(folder, job, status='refused', error='; '.join(problems))
                raise SystemExit('Publication refused: ' + '; '.join(problems) +
                                 '. Fix the workspace, then submit again')
        title = (args.message or job.get('message') or (handoff or {}).get('title') or job['task_title'])
        footer = ('Agent `' + job['name'] + '` · harness `' + job.get('harness', 'codex') + '` · model `' +
                  (job.get('model') or 'harness default') + '` · base `' + original['base'][:12] + '`, published by luma-scm.')
        body = ((handoff or {}).get('body') or '') + '\n\n---\n' + footer
        _save(folder, job, status='submitting')
        try:
            result = commit_workspace(endpoint, token, collection, title, branch=job['branch'],
                                      auto_merge=job['auto_merge'], title=title, body=body.strip())
            return _save(folder, job, status='submitted', result=result, error=None,
                         collection=str(collection))
        except (Exception, SystemExit) as error:
            _save(folder, job, status='submit_failed', error=str(error))
            raise


def wait(args, endpoint, token):
    deadline = time.monotonic() + args.timeout
    while True:
        job = status(args, endpoint, token)
        if job.get('status') in TERMINAL:
            return job
        if _done(job):
            return submit(args, endpoint, token)
        runtime = job.get('runtime', {})
        if runtime.get('phase') in {'error', 'stopped', 'suspended', 'deleted'} or runtime.get('activity') in ATTENTION:
            return dict(job, waiting='Agent needs attention (' + str(runtime.get('activity') or runtime.get('phase')) +
                        '); inspect it with scion look, then submit or stop it')
        if time.monotonic() >= deadline:
            return dict(job, waiting='Wait timed out; job continues. Use agent wait or agent submit later')
        time.sleep(min(3, max(0, deadline - time.monotonic())))


def add_parser(sub):
    parser = sub.add_parser('agent', help='Run Google Scion on isolated source-control workspaces')
    parser.add_argument('--jobs-dir', default=os.environ.get('LUMA_SCION_JOBS', str(Path.home() / '.local/state/luma-scm/agents')))
    commands = parser.add_subparsers(dest='agent_command', required=True)
    launch = commands.add_parser('start')
    launch.add_argument('name'); launch.add_argument('task')
    launch.add_argument('--harness', choices=sorted(HARNESS_AUTH), default=os.environ.get('LUMA_SCION_HARNESS', 'claude'))
    launch.add_argument('--model'); launch.add_argument('--template', default='luma')
    launch.add_argument('--at', default='main'); launch.add_argument('--prefix', action='append')
    launch.add_argument('--branch'); launch.add_argument('--message')
    launch.add_argument('--auto-merge', action='store_true')
    launch.add_argument('--stock-reference', default=os.environ.get('LUMA_STOCK_REFERENCE', '/srv/dev/luma-stock-reference'))
    launch.add_argument('--wait', action='store_true'); launch.add_argument('--timeout', type=float, default=1800)
    inspect = commands.add_parser('status'); inspect.add_argument('name', nargs='?')
    collect = commands.add_parser('submit'); collect.add_argument('name'); collect.add_argument('--message')
    halt = commands.add_parser('stop'); halt.add_argument('name')
    remove = commands.add_parser('delete'); remove.add_argument('name'); remove.add_argument('--force', action='store_true')
    awaiting = commands.add_parser('wait'); awaiting.add_argument('name')
    awaiting.add_argument('--timeout', type=float, default=1800); awaiting.add_argument('--message')
    return parser


def run(args, endpoint, token):
    return {'start': start, 'status': status, 'stop': stop, 'submit': submit, 'wait': wait,
            'delete': delete}[args.agent_command](args, endpoint, token)
