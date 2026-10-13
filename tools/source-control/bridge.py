"""Git history ingestion, deterministic export, and durable GitHub publication.

GitHub main is the integration authority. This bridge never force-pushes or
pushes main. The outbox is owned by Store, so stopping the worker loses no jobs.
"""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from urllib.parse import urlencode

from core import Failure, pathcheck


class GitHub:
    """Use the owner's existing gh credential store, never token argv or logs."""
    def __init__(self, repo, request=None):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise Failure('GitHub repository must be owner/name')
        self.repo = repo
        self.transport = request or self._gh

    @staticmethod
    def _gh(method, path, data=None):
        args = ['gh', 'api', '--include', '--method', method, path,
                '-H', 'Accept: application/vnd.github+json']
        body = None
        if data is not None:
            args += ['--input', '-']
            body = json.dumps(data).encode()
        try:
            result = subprocess.run(args, input=body, capture_output=True, timeout=90)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure('GitHub API unavailable; verify gh authentication and connectivity', 502)
        output = result.stdout.decode('utf-8', 'replace').replace('\r\n', '\n')
        match = re.match(r'HTTP/\S+ (\d+)', output)
        code = int(match.group(1)) if match else 0
        if result.returncode or not 200 <= code < 300:
            # Git/gh stderr can contain credentials embedded in a remote URL.
            raise Failure('GitHub API request failed' + (' (HTTP %s)' % code if code else ''),
                          502, github_status=code)
        body = output.split('\n\n', 1)[1] if '\n\n' in output else ''
        return json.loads(body) if body.strip() else {}

    def api(self, method, route, data=None):
        return self.transport(method, '/repos/' + self.repo + route, data)

    def pages(self, route, key=None):
        rows = []
        for page in range(1, 1001):
            separator = '&' if '?' in route else '?'
            payload = self.api('GET', route + separator + urlencode({'per_page': 100, 'page': page}))
            items = payload[key] if key else payload
            rows.extend(items)
            if len(items) < 100:
                return rows
        raise Failure('GitHub response exceeded pagination limit', 502)

    def ensure_pr(self, job):
        if job.get('pr_number'):
            return self.api('GET', '/pulls/' + str(job['pr_number']))
        query = urlencode({'state': 'all', 'head': self.repo.split('/')[0] + ':' + job['branch'], 'base': 'main'})
        pulls = self.pages('/pulls?' + query)
        for pr in pulls:
            if pr['state'] == 'open' or pr['head']['sha'] == job['git_commit']:
                return self.api('GET', '/pulls/' + str(pr['number']))
        return self.api('POST', '/pulls', {'head': job['branch'], 'base': 'main',
                        'title': job['title'], 'body': job['body'], 'draft': False})

    def merge_when_ready(self, job, pr, required_check='CI passed'):
        """Return a waiting reason or merge using GitHub's atomic head-SHA guard.

        REST merge's sha argument rejects a changed head (409). We never enable
        admin bypass or override blocked/unknown mergeability. CI is checked on
        this exact head, including Luma's aggregate workflow and all contexts.
        """
        expected = job['git_commit']
        if pr.get('merged'):
            return None
        if pr['state'] != 'open': return 'Pull request is closed without being merged'
        if pr.get('draft'): return 'Pull request is still a draft'
        if pr['head']['sha'] != expected: return 'Pull request head changed; publish or land its current changeset'
        if pr.get('base', {}).get('ref') != 'main': return 'Pull request target is not main'
        for side in ('head', 'base'):
            if pr.get(side, {}).get('repo', {}).get('full_name', '').lower() != self.repo.lower():
                return 'Pull request repository does not match this bridge'
        if pr.get('mergeable') is not True or pr.get('mergeable_state') != 'clean':
            return 'Waiting for conflict-free GitHub mergeability and branch protections'
        reviews = self.pages('/pulls/' + str(pr['number']) + '/reviews')
        latest = {}
        for review in sorted(reviews, key=lambda r: r.get('id', 0)):
            if review.get('state') in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
                latest[review['user']['login']] = review['state']
        if 'CHANGES_REQUESTED' in latest.values(): return 'A reviewer has requested changes'
        checks = self.pages('/commits/' + expected + '/check-runs?filter=latest', 'check_runs')
        statuses = self.pages('/commits/' + expected + '/status', 'statuses')
        # Empty checks are never evidence that a change works. The aggregate
        # check must be emitted by GitHub Actions and its workflow must finish.
        aggregate = [c for c in checks if c.get('name') == required_check
                     and c.get('app', {}).get('slug') == 'github-actions']
        if not aggregate: return 'Waiting for required GitHub Actions check: ' + required_check
        if any(c.get('status') != 'completed' or c.get('conclusion') != 'success' for c in aggregate):
            return 'Required CI check has not passed: ' + required_check
        if any(c.get('status') != 'completed' or c.get('conclusion') not in ('success', 'neutral', 'skipped') for c in checks):
            return 'One or more check runs are pending or failed'
        if any(s.get('state') != 'success' for s in statuses):
            return 'One or more commit status contexts are pending or failed'
        runs = self.pages('/actions/runs?' + urlencode({'head_sha': expected, 'event': 'pull_request'}), 'workflow_runs')
        candidates = [r for r in runs if r.get('head_sha') == expected and r.get('path', '').split('@')[0] == '.github/workflows/ci.yml']
        if not candidates: return 'Waiting for the Luma CI workflow on this exact head'
        run = max(candidates, key=lambda r: r['id'])
        if run.get('status') != 'completed' or run.get('conclusion') != 'success':
            return 'The Luma CI workflow has not passed on this exact head'
        latest_pr = self.api('GET', '/pulls/' + str(pr['number']))
        if (latest_pr.get('state') != 'open' or latest_pr.get('merged') or latest_pr.get('draft')
                or latest_pr.get('head', {}).get('sha') != expected
                or latest_pr.get('base', {}).get('ref') != 'main'
                or latest_pr.get('mergeable') is not True
                or latest_pr.get('mergeable_state') != 'clean'
                or any((latest_pr.get(side, {}).get('repo') or {}).get('full_name', '').lower() != self.repo.lower()
                       for side in ('head', 'base'))):
            return 'Pull request changed while checking; will re-evaluate'
        result = self.api('PUT', '/pulls/' + str(pr['number']) + '/merge', {'sha': expected, 'merge_method': 'merge'})
        if result.get('merged') is not True:
            return 'GitHub refused the merge; inspect the pull request protections'
        return None


class GitBridge:
    def __init__(self, store, remote, github_repo=None, *, github=None, required_check='CI passed'):
        self.store, self.remote = store, remote
        self.repo = store.root / 'mirror.git'
        self.lock = threading.RLock()
        self._stop, self._thread = threading.Event(), None
        self.last_sync = {'running': False, 'error': None, 'completed': None}
        self.required_check = required_check
        inferred = re.search(r'github\.com[:/]([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$', remote)
        self.github_repo = github_repo or (inferred.group(1) if inferred else None)
        self.github = github or (GitHub(self.github_repo) if self.github_repo else None)
        if not self.repo.exists():
            subprocess.run(['git', 'init', '--bare', '-q', str(self.repo)], check=True, capture_output=True)
            self.git('remote', 'add', 'origin', remote)
        current = self.git('remote', 'get-url', 'origin').decode().strip()
        if current != remote:
            raise Failure('State directory belongs to a different Git remote', 409)
        self.git('config', 'credential.helper', '!gh auth git-credential')
        self.git('config', 'user.name', 'Luma source control')
        self.git('config', 'user.email', 'luma-scm@localhost')
        self.git('config', 'gc.auto', '0')
        self.git('config', 'core.fsync', 'committed')

    def git(self, *args, data=None, env=None, check=True):
        environment = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1')
        if env: environment.update(env)
        try:
            result = subprocess.run(['git', '--git-dir', str(self.repo), *args], input=data,
                                    capture_output=True, env=environment, timeout=180)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure('Git operation unavailable: ' + args[0], 502)
        if check and result.returncode:
            network = args[0] in ('fetch', 'ls-remote', 'push')
            conflict = args[0] == 'push' and any(marker in result.stderr for marker in (b'non-fast-forward', b'fetch first', b'[rejected]', b'protected branch'))
            raise Failure('Git ' + args[0] + ' failed' + ('; branch diverged or is protected, choose a new work branch' if conflict else ''),
                          409 if conflict or not network else 502)
        return result.stdout if check else result

    @staticmethod
    def _identity(raw):
        match = re.fullmatch(r'(.*) <([^<>]*)> (\d+ [+-]\d{4})', raw)
        if not match: raise Failure('Git commit has an unsupported author identity', 409)
        return {'name': match[1], 'email': match[2], 'date': match[3]}

    def import_main(self):
        with self.lock:
            self.git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main')
            sha = self.git('rev-parse', 'refs/remotes/origin/main').decode().strip()
            previous = self.store.refs().get('github')
            previous_git = self.store.gitsha(previous) if previous else None
            # Walking IDs is cheap; the known-head exclusion makes steady-state
            # ingestion incremental without omitting merged side-branch commits.
            args = ['rev-list', '--reverse', '--topo-order', sha]
            if previous_git and self.store.gitcs(previous_git): args += ['--not', previous_git]
            commits = self.git(*args).decode().splitlines()
            proc = subprocess.Popen(['git', '--git-dir', str(self.repo), 'cat-file', '--batch'],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            cache = {}
            def read_object(oid):
                if oid in cache: return cache[oid]
                proc.stdin.write(oid.encode() + b'\n'); proc.stdin.flush()
                header = proc.stdout.readline().split()
                if len(header) != 3: raise Failure('Git object is missing during import', 409)
                length = int(header[2]); body = proc.stdout.read(length)
                if len(body) != length or proc.stdout.read(1) != b'\n': raise Failure('Truncated Git object', 409)
                if len(cache) >= 2048: cache.clear()
                cache[oid] = body
                return body
            try:
                imported = 0
                for commit in commits:
                    if self.store.gitcs(commit): continue
                    raw = read_object(commit)
                    header, message = raw.split(b'\n\n', 1)
                    headers = header.decode('utf-8', 'replace').splitlines()
                    gitparents = [h[7:] for h in headers if h.startswith('parent ')]
                    parents = [self.store.gitcs(p) for p in gitparents]
                    if any(p is None for p in parents): raise Failure('Git history import is missing a parent', 409)
                    author = self._identity(next(h[7:] for h in headers if h.startswith('author ')))
                    committer = self._identity(next(h[10:] for h in headers if h.startswith('committer ')))
                    author['committer'] = committer
                    diffargs = ['diff-tree', '--no-commit-id', '--no-renames', '-r', '--raw', '-z']
                    diffargs += [gitparents[0], commit] if gitparents else ['--root', commit]
                    fields = self.git(*diffargs).split(b'\0')
                    changes = []
                    for i in range(0, len(fields)-1, 2):
                        meta, path = fields[i].decode().split(), pathcheck(fields[i+1].decode('utf-8'))
                        mode, oid, status = meta[1], meta[3], meta[4]
                        if status == 'D': changes.append({'path': path, 'delete': True})
                        else:
                            content = oid.encode() if mode == '160000' else read_object(oid)
                            changes.append({'path': path, 'blob': self.store.putblob(content)['hash'], 'mode': mode})
                    self.store.import_git(commit, parents, changes, message.decode('utf-8', 'replace').rstrip('\n'),
                                          author=author, created_ns=int(committer['date'].split()[0]) * 1000000000)
                    imported += 1
            finally:
                proc.stdin.close(); proc.stdout.close(); proc.wait(timeout=5)
            cs = self.store.gitcs(sha)
            if not cs: raise Failure('GitHub main could not be imported', 409)
            self.store.set_github_head(cs)
            return {'changeset': cs, 'git_commit': sha, 'files': len(self.store.tree(cs)), 'imported': imported}

    def materialize(self, cs, pending=None):
        pending = pending if pending is not None else {}
        # Iterative postorder avoids a Python recursion limit on long agent histories.
        stack = [(cs, False)]
        while stack:
            current, ready = stack.pop()
            mapped = pending.get(current) or self.store.gitsha(current)
            if mapped:
                pending[current] = mapped
                continue
            change = self.store.changeset(current)
            if not ready:
                stack.append((current, True))
                stack.extend((parent, False) for parent in reversed(change['parents']))
                continue
            parents = [pending[p] for p in change['parents']]
            index = self.store.root / ('index-' + secrets.token_hex(8))
            date = str(change['created_ns'] // 1000000000) + ' +0000'
            author = change.get('author') or {}
            committer = author.get('committer') or author
            env = {'GIT_INDEX_FILE': str(index), 'GIT_AUTHOR_DATE': author.get('date', date),
                   'GIT_COMMITTER_DATE': committer.get('date', date),
                   'GIT_AUTHOR_NAME': author.get('name', 'Luma source control'),
                   'GIT_AUTHOR_EMAIL': author.get('email', 'luma-scm@localhost'),
                   'GIT_COMMITTER_NAME': committer.get('name', 'Luma source control'),
                   'GIT_COMMITTER_EMAIL': committer.get('email', 'luma-scm@localhost')}
            try:
                self.git('read-tree', parents[0] if parents else '--empty', env=env)
                lines = []
                for row in change['changes']:
                    if row.get('delete'): mode, oid = '0', '0' * 40
                    else:
                        mode = row['mode']; content = self.store.blob(row['blob'])
                        oid = content.decode() if mode == '160000' else self.git('hash-object', '-w', '--stdin', data=content).decode().strip()
                        if mode == '160000' and not re.fullmatch('[0-9a-f]{40}', oid): raise Failure('Invalid Git submodule commit')
                    lines.append((mode + ' ' + oid + '\t' + row['path']).encode() + b'\0')
                self.git('update-index', '-z', '--index-info', data=b''.join(lines), env=env)
                tree = self.git('write-tree', env=env).decode().strip()
                args = ['commit-tree', tree]
                for parent in parents: args += ['-p', parent]
                message = change['message'].rstrip('\n') + '\n\nLuma-Changeset: ' + current + '\n'
                sha = self.git(*args, data=message.encode(), env=env).decode().strip()
                self.git('update-ref', 'refs/luma/changesets/' + current, sha)
                pending[current] = sha
            finally:
                index.unlink(missing_ok=True)
                Path(str(index) + '.lock').unlink(missing_ok=True)
        return pending[cs]

    def publish(self, at, branch):
        if not isinstance(branch, str) or not branch.startswith(('scion/', 'scion-prototype/')):
            raise Failure('Publish to a scion/ work branch; main is integrated through pull requests')
        self.git('check-ref-format', 'refs/heads/' + branch)
        with self.lock:
            cs = self.store.resolve(at)
            pending = {}
            sha = self.materialize(cs, pending)
            self.git('push', '--quiet', 'origin', sha + ':refs/heads/' + branch)
            # Identical deterministic commits make a lost successful push safe
            # to repeat. Only accepted pushes record exported mappings.
            for mapped_cs, mapped_sha in pending.items(): self.store.mapgit(mapped_cs, mapped_sha)
            return {'changeset': cs, 'git_commit': sha, 'branch': branch}

    def _publish_job(self, job):
        result = self.publish(job['changeset'], job['branch'])
        job = self.store.update_publication(job['id'], git_commit=result['git_commit'])
        if not self.github:
            return self.store.update_publication(job['id'], status='published', next_attempt=0,
                error='Git branch mirrored; configure --github-repo owner/name for pull requests and landing')
        pr = self.github.ensure_pr(job)
        return self.store.update_publication(job['id'], status='published', pr_url=pr['html_url'],
                                             pr_number=pr['number'], error=None, next_attempt=0)

    def _reconcile(self, job):
        pr = self.github.api('GET', '/pulls/' + str(job['pr_number']))
        if pr.get('merged'):
            return self._record_merge(job, pr)
        if pr['state'] != 'open':
            return self.store.update_publication(job['id'], status='blocked', error='Pull request was closed without merging', next_attempt=time.time()+30)
        if job['auto_merge']:
            waiting = self.github.merge_when_ready(job, pr, self.required_check)
            return self.store.update_publication(job['id'], status='published' if waiting else 'merged',
                                                 error=waiting, next_attempt=time.time()+30 if waiting else 0)
        return self.store.update_publication(job['id'], status='published', error=None, next_attempt=time.time()+30)

    def _record_merge(self, job, pr):
        expected, head = job['git_commit'], pr['head']['sha']
        included = expected == head
        if not included:
            if not re.fullmatch('[0-9a-f]{40}', head): raise Failure('GitHub returned an invalid commit ID', 502)
            if self.git('cat-file', '-e', head + '^{commit}', check=False).returncode:
                self.git('fetch', '--quiet', 'origin', head)
            included = self.git('merge-base', '--is-ancestor', expected, head, check=False).returncode == 0
        return self.store.update_publication(job['id'], status='merged' if included else 'blocked',
            error=None if included else 'Pull request merged a replaced branch; this changeset was not included',
            next_attempt=0 if included else time.time()+300)

    def sync_once(self):
        with self.lock:
            self.last_sync = dict(running=True, started=time.time(), completed=None, error=None)
            result = {'import': None, 'publications': [], 'errors': []}
            try:
                try: result['import'] = self.import_main()
                except Exception as exc:
                    result['errors'].append(str(exc) if isinstance(exc, Failure) else 'Unexpected Git import error')
                jobs = sorted(self.store.publications(), key=lambda j: (j['created'], j['id']))
                latest_by_branch = {j['branch']: j for j in jobs}
                blocked_branches = set()
                for job in jobs:
                    if job['status'] == 'merged': continue
                    if job['branch'] in blocked_branches: continue
                    if job.get('next_attempt', 0) > time.time():
                        if job['status'] in ('pending', 'retry', 'blocked') and not job.get('pr_number'):
                            blocked_branches.add(job['branch'])
                        continue
                    try:
                        if job['status'] in ('pending', 'retry', 'blocked') and not job.get('pr_number'):
                            job = self.store.update_publication(job['id'], attempts=job['attempts']+1)
                            job = self._publish_job(job)
                        if job.get('pr_number') and self.github:
                            latest = latest_by_branch[job['branch']]
                            if latest['id'] != job['id']:
                                # A later accepted publication supersedes this
                                # landing request even before its push completes.
                                # Publish in order, but only land the newest job.
                                pr = self.github.api('GET', '/pulls/' + str(job['pr_number']))
                                if pr.get('merged'):
                                    job = self._record_merge(job, pr)
                                else:
                                    job = self.store.update_publication(job['id'], status='published',
                                        error='Superseded for landing by publication ' + latest['id'], next_attempt=time.time()+30)
                            else:
                                job = self._reconcile(job)
                        result['publications'].append({'id':job['id'], 'status':job['status'], 'error':job.get('error')})
                    except Exception as exc:
                        transient = not isinstance(exc, Failure) or exc.status >= 500
                        message = str(exc) if isinstance(exc, Failure) else 'Unexpected publication error; retry is safe'
                        attempts = max(1, job['attempts'])
                        # Published jobs retain their state: retries must not push
                        # an older changeset over newer work on the same branch.
                        status = 'published' if job.get('pr_number') else ('retry' if transient else 'blocked')
                        self.store.update_publication(job['id'], status=status, error=message,
                                                      next_attempt=time.time()+min(300, 2**min(attempts, 8)))
                        blocked_branches.add(job['branch'])
                        result['errors'].append(message)
                return result
            finally:
                self.last_sync = dict(running=False, completed=time.time(), error='; '.join(result['errors']) or None)

    def start(self, interval=30):
        if self._thread and self._thread.is_alive(): return
        self._stop.clear()
        def run():
            while not self._stop.is_set():
                try: self.sync_once()
                except Exception:
                    self.last_sync = dict(running=False, completed=time.time(), error='Background synchronization failed; retrying')
                self._stop.wait(max(1, interval))
        self._thread = threading.Thread(target=run, daemon=True, name='luma-github-sync')
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread is not threading.current_thread(): self._thread.join(timeout=190)

    def blame(self, at, path):
        path = pathcheck(path)
        with self.lock:
            cs = self.store.resolve(at)
            sha = self.materialize(cs)
            raw = self.git('blame', '--line-porcelain', sha, '--', path).decode('utf-8', 'replace')
            lines, row = [], {}
            for line in raw.splitlines():
                if re.match(r'^[0-9a-f]{40} \d+ \d+', line):
                    parts = line.split(); row = {'git_commit':parts[0], 'original_line':int(parts[1]), 'line':int(parts[2])}
                elif line.startswith('\t'):
                    row['text'] = line[1:]; lines.append(row)
                elif line.startswith(('author ', 'author-mail ', 'author-time ', 'summary ')):
                    key, value = line.split(' ', 1); row[key.replace('-', '_')] = value
            return {'at':cs, 'path':path, 'lines':lines}
