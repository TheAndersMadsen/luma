"""HTTP + real Git + subprocess Scion lifecycle contract (no model quota in CI)."""
import http.server
import json
import os
import signal
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

from server import Store, GitBridge, make_server


# Each job has its own Scion project; the fixture keeps the project's agent
# state beside its link file and acts on the --workspace the adapter passes.
SCION_FIXTURE = '''#!/usr/bin/env python3
import json, os, pathlib, sys, uuid
root = pathlib.Path.cwd()
args = sys.argv[1:]
assert args[-1] == '--non-interactive'
args = args[:-1]
assert 'GH_TOKEN' not in os.environ and 'LUMA_SCM_TOKEN' not in os.environ
def flag(name):
    return args[args.index(name) + 1]
if args[0] == '--global':
    args = args[1:]
    if args[:3] == ['hub', 'projects', 'delete']:
        assert args[-1] == '--yes'
        with open(root / 'deleted-projects', 'a') as stream:
            stream.write(args[3] + '\\n')
    else:
        assert args[0] == 'secret' or args[:2] == ['hub', 'secret']
        keys = os.environ.get('SCION_FIXTURE_SECRETS', 'CLAUDE_CODE_OAUTH_TOKEN,CODEX_AUTH').split(',')
        print(json.dumps({'secrets': [{'key': key, 'type': 'file'} for key in keys if key]}))
    raise SystemExit(0)
if args[0] == 'init':
    assert not (root / '.scion').exists()
    (root / '.scion').write_text('project-id: ' + uuid.uuid4().hex + '\\nproject-name: ' + root.name + '\\n')
    raise SystemExit(0)
assert (root / '.scion').is_file(), 'adapter must run Scion from the job project'
states = root / '.fixture-agents'
states.mkdir(exist_ok=True)
if args[:2] == ['hub', 'link']:
    if root.name in os.environ.get('SCION_FIXTURE_EXISTING', '').split(','):
        (root / '.scion').write_text('project-id: someone-elses\\nproject-name: ' + root.name + '\\n')
elif args[0] == 'start':
    name, workspace = args[1], pathlib.Path(flag('--workspace'))
    assert flag('--task-file') == '-'
    assert flag('--harness-auth') == {'claude': 'oauth-token', 'codex': 'auth-file'}[flag('--harness')]
    assert workspace == root / 'workspace' and not (workspace / 'source/.luma-scm.json').exists()
    config = json.loads(pathlib.Path(flag('--config')).read_text())
    assert not pathlib.Path(flag('--config')).is_relative_to(root)
    task = sys.stdin.read()
    assert '/workspace/source' in task and '/workspace/HANDOFF.md' in task
    source, activity = workspace / 'source', 'completed'
    if 'WAIT_FOREVER' in task:
        activity = 'working'
    elif 'NEEDS_INPUT' in task:
        activity = 'waiting_for_input'
    elif 'NO_CHANGES' not in task:
        (source / 'docs/readme.txt').write_text('Edited by subprocess Scion agent\\n')
        (source / '.luma-scm.json').write_text(json.dumps({'base': 'attacker-base', 'endpoint': 'http://bad.invalid'}))
        (source / 'node_modules/pkg').mkdir(parents=True)
        (source / 'node_modules/pkg/index.js').write_text('build output\\n')
        (workspace / 'HANDOFF.md').write_text('# Clarify the readme\\n\\nRewrote docs/readme.txt.\\n\\nChecks: none needed.\\n')
    if 'STOCK_CODE' in task:
        (source / 'docs/stock.java').write_text('/* loaded ' 'from: classes.dex */\\nclass Switchboard {}\\n')
    if 'CREDENTIAL' in task:
        (workspace / 'HANDOFF.md').write_text('# Done\\n\\nkey sk-ant-oat01-' + 'A' * 40 + '\\n')
    if 'HANDOFF_SYMLINK' in task:
        (workspace / 'HANDOFF.md').unlink()
        (workspace / 'HANDOFF.md').symlink_to(os.environ['SCION_FIXTURE_HOST_SECRET'])
    (states / (name + '.json')).write_text(json.dumps({'name': name, 'phase': 'running', 'activity': activity,
        'args': args, 'config': config}))
elif args[0] == 'list':
    print(json.dumps({'agents': [json.loads(p.read_text()) for p in sorted(states.glob('*.json'))]}))
elif args[0] == 'stop':
    state = states / (args[1] + '.json')
    item = json.loads(state.read_text()); item['phase'] = 'stopped'; state.write_text(json.dumps(item))
elif args[0] == 'delete':
    assert '--force' in args
    (states / (args[1] + '.json')).unlink()
else:
    raise SystemExit('Unexpected Scion invocation: ' + repr(args))
'''


class AgentsE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        upstream = self.root / 'upstream.git'
        original = self.root / 'original'
        subprocess.run(['git', 'init', '-q', '--bare', str(upstream)], check=True)
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(original)], check=True)
        def git(*args):
            return subprocess.check_output(['git', '-C', str(original), *args], stderr=subprocess.PIPE)
        git('config', 'user.name', 'Agent E2E'); git('config', 'user.email', 'agent@localhost')
        (original / 'docs').mkdir(); (original / 'docs/readme.txt').write_text('Before\n')
        (original / 'AGENTS.md').write_text('Only make the requested source change.\n')
        (original / 'private-tree').mkdir(); (original / 'private-tree/absent.txt').write_text('Not selected\n')
        git('add', '.'); git('commit', '-qm', 'Baseline'); git('push', '-q', str(upstream), 'main')
        self.store = Store(self.root / 'server-state')
        self.bridge = GitBridge(self.store, str(upstream))
        self.imported = self.bridge.import_main()['changeset']
        self.http = make_server(self.store, self.bridge, 'owner-token-for-test', '127.0.0.1', 0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.endpoint = 'http://127.0.0.1:' + str(self.http.server_port)
        self.token_file = self.root / 'token'; self.token_file.write_text('owner-token-for-test')
        self.token_file.chmod(0o600)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        executable = self.bin / 'scion'; executable.write_text(SCION_FIXTURE); executable.chmod(0o755)
        self.stock = self.root / 'stock'
        (self.stock / 'decompiled/ironman/sources').mkdir(parents=True)
        (self.stock / 'manifest.json').write_text('{}\n')
        self.host_secret = self.root / 'host-secret'
        self.host_secret.write_text('HOST-ONLY-SECRET-VALUE\n')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        GH_TOKEN='host-secret-must-not-enter-scion', LUMA_SCM_TOKEN='host-only-secret',
                        LUMA_SCM_CACHE=str(self.root / 'client-cache'),
                        SCION_FIXTURE_HOST_SECRET=str(self.host_secret))
        self.env.pop('LUMA_SCION_HARNESS', None)
        self.jobs = self.root / 'jobs'

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        if hasattr(self.store, 'close'): self.store.close()
        self.tmp.cleanup()

    def run_agent(self, *args, success=True, env=None):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('client.py')),
            '--endpoint', self.endpoint, '--token-file', str(self.token_file),
            'agent', '--jobs-dir', str(self.jobs), *args],
            env=env or self.env, text=True, capture_output=True, timeout=30)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def start(self, name, task, *args, **kwargs):
        return self.run_agent('start', name, task, '--stock-reference', str(self.stock), *args, **kwargs)

    def fixture(self, name):
        return json.loads((self.project(name) / '.fixture-agents' / (name + '.json')).read_text())

    def project(self, name):
        return self.jobs / name / ('luma-' + name)

    def test_task_collects_exact_workspace_and_publishes_handoff_once(self):
        started = self.start('docs-fix', 'Edit the documentation', '--prefix', 'docs/')
        workspace, source = Path(started['workspace']), Path(started['source'])
        self.assertEqual((started['harness'], started['model'], started['template'], started['image']),
                         ('claude', 'claude-opus-5-5', 'luma', 'luma.invalid/agent-claude:current'))
        self.assertFalse((source / 'private-tree').exists())
        self.assertTrue((source / 'AGENTS.md').is_file())
        data = workspace / 'state'
        self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o700)
        self.assertEqual((data / '.luma-managed').read_text(), 'schema=1\nproduct=luma\n')
        self.assertEqual(stat.S_IMODE((workspace / 'cache').stat().st_mode), 0o700)
        launched = self.fixture('docs-fix')
        for flag, value in [('--harness', 'claude'), ('--type', 'luma'), ('--model', 'claude-opus-5-5'),
                            ('--image', 'luma.invalid/agent-claude:current'), ('--message-mode', 'none')]:
            self.assertEqual(launched['args'][launched['args'].index(flag) + 1], value)
        self.assertEqual(launched['config']['volumes'], [{'source': str(workspace), 'target': '/workspace'},
            {'source': str(self.stock), 'target': '/workspace/state/stock-reference', 'read_only': True}])
        self.assertEqual(launched['config']['env']['LUMA_DATA_DIR'], '/workspace/state')
        self.assertEqual(launched['config']['resources'], {'limits': {'cpu': '6', 'memory': '12Gi'}})
        record = (self.jobs / 'docs-fix/job.json').read_text()
        self.assertNotIn('owner-token-for-test', record)
        submitted = self.run_agent('submit', 'docs-fix')
        self.assertEqual(submitted['status'], 'submitted')
        self.assertEqual(submitted['runtime']['phase'], 'stopped')
        self.assertEqual(json.loads((source / '.luma-scm.json').read_text())['base'], 'attacker-base')
        self.assertFalse(Path(submitted['collection']).is_relative_to(workspace))
        self.assertFalse((Path(submitted['collection']) / 'node_modules').exists())
        publications = self.store.publications()
        self.assertEqual(len(publications), 1)
        self.assertEqual(publications[0]['title'], 'Clarify the readme')
        self.assertIn('Rewrote docs/readme.txt.', publications[0]['body'])
        self.assertIn('Agent `docs-fix` · harness `claude` · model `claude-opus-5-5`', publications[0]['body'])
        cs = self.store.changeset(publications[0]['changeset'])
        self.assertEqual(cs['parents'], [self.imported])
        self.assertEqual([r['path'] for r in cs['changes']], ['docs/readme.txt'])
        again = self.run_agent('submit', 'docs-fix')
        self.assertEqual(again['result'], submitted['result'])
        self.assertEqual(self.run_agent('stop', 'docs-fix')['status'], 'submitted')
        self.assertEqual(self.run_agent('submit', 'docs-fix')['result'], submitted['result'])
        self.assertEqual(len(self.store.publications()), 1)
        self.start('docs-fix', 'Overwrite existing', success=False)
        project_id = (self.project('docs-fix') / '.scion').read_text().split()[1]
        self.assertEqual(self.run_agent('delete', 'docs-fix'), {'name': 'docs-fix', 'deleted': True})
        self.assertFalse((self.jobs / 'docs-fix').exists())
        self.assertEqual((self.jobs / 'deleted-projects').read_text().split(), [project_id])
        print(json.dumps({'evidence': 'agent-subprocess-to-http-publication', 'sparseFilesChanged': 1,
                          'publications': 1, 'credentialsInWorkspace': False, 'metadataTamperingIgnored': True,
                          'handoffBecamePullRequestBody': True, 'buildOutputCollected': False}))

    def test_refused_start_leaves_no_job_and_names_the_missing_secret(self):
        env = dict(self.env, SCION_FIXTURE_SECRETS='CODEX_AUTH')
        refused = self.start('codex-only', 'Edit docs', env=env, success=False)
        self.assertIn('CLAUDE_CODE_OAUTH_TOKEN', refused.stderr)
        self.assertFalse((self.jobs / 'codex-only').exists())
        self.start('codex-only', '   ', success=False)
        self.assertFalse((self.jobs / 'codex-only').exists())
        started = self.start('codex-only', 'Edit docs', '--harness', 'codex', '--model', 'fixture-model', env=env)
        self.assertEqual(self.fixture('codex-only')['args'][self.fixture('codex-only')['args'].index('--image') + 1],
                         'luma.invalid/agent-codex:current')
        self.assertEqual(started['model'], 'fixture-model')
        self.run_agent('submit', 'codex-only')
        reused = self.run_agent('delete', 'codex-only')
        self.assertTrue(reused['deleted'])
        again = self.start('codex-only', 'Edit docs again', '--harness', 'codex', env=env, success=False)
        self.assertIn('work/codex-only holds earlier agent work', again.stderr)
        self.assertFalse((self.jobs / 'codex-only').exists())
        taken = self.start('taken', 'Edit docs', env=dict(self.env, SCION_FIXTURE_EXISTING='luma-taken'), success=False)
        self.assertIn('A Hub project named luma-taken already exists', taken.stderr)
        self.assertFalse((self.project('taken') / '.fixture-agents/taken.json').exists())
        self.run_agent('stop', 'taken', success=False)
        self.assertTrue(self.run_agent('delete', 'taken', '--force')['deleted'])
        self.assertNotIn('someone-elses', (self.jobs / 'deleted-projects').read_text())
        print(json.dumps({'evidence': 'agent-start-preconditions', 'missingSecretNamed': True,
                          'nameBurnedByRefusal': False}))

    def test_bounded_wait_and_attention_preserve_running_jobs(self):
        started = self.start('waiting', 'WAIT_FOREVER', '--prefix', 'docs/', '--wait', '--timeout', '0.01')
        self.assertIn('timed out', started['waiting'])
        self.assertEqual(self.run_agent('status', 'waiting')['runtime']['phase'], 'running')
        self.run_agent('submit', 'waiting', success=False)
        self.run_agent('delete', 'waiting', success=False)
        self.assertEqual(self.run_agent('stop', 'waiting')['runtime']['phase'], 'stopped')
        self.assertEqual(len(self.store.publications()), 0)
        asking = self.start('asking', 'NEEDS_INPUT', '--wait', '--timeout', '20')
        self.assertIn('needs attention (waiting_for_input)', asking['waiting'])
        (self.jobs / 'broken').mkdir(); (self.jobs / 'broken/job.json').write_text('{"name": "broken"}')
        listing = self.run_agent('status')['agents']
        self.assertEqual({job['name']: bool(job.get('error')) for job in listing},
                         {'asking': False, 'broken': True, 'waiting': False})
        self.start('../escape', 'No traversal', success=False)
        self.assertTrue(self.run_agent('delete', 'waiting', '--force')['deleted'])
        print(json.dumps({'evidence': 'agent-timeout-attention-stop', 'sourceRetained': True,
                          'publicationWhileRunning': False, 'brokenJobListed': True}))

    def test_publication_guards_and_no_change_agents(self):
        self.start('stock', 'Edit docs STOCK_CODE')
        refused = self.run_agent('submit', 'stock', success=False)
        self.assertIn('docs/stock.java contains decompiled stock code', refused.stderr)
        self.assertEqual(self.run_agent('status', 'stock')['status'], 'refused')
        source = Path(self.run_agent('status', 'stock')['source'])
        (source / 'docs/stock.java').unlink()
        self.assertEqual(self.run_agent('submit', 'stock')['status'], 'submitted')
        self.start('secret', 'Edit docs CREDENTIAL')
        self.assertIn('HANDOFF.md contains a credential', self.run_agent('submit', 'secret', success=False).stderr)
        self.start('linked', 'Edit docs HANDOFF_SYMLINK')
        self.assertIn('HANDOFF.md is not a regular file', self.run_agent('submit', 'linked', success=False).stderr)
        self.start('idle', 'NO_CHANGES')
        self.assertEqual(self.run_agent('submit', 'idle')['status'], 'no_changes')
        publications = self.store.publications()
        self.assertEqual(len(publications), 1)
        self.assertNotIn('HOST-ONLY-SECRET-VALUE', json.dumps(publications))
        self.assertNotIn('sk-ant-oat01', json.dumps(publications))
        print(json.dumps({'evidence': 'agent-publication-guards', 'stockCodeRefused': True,
                          'credentialRefused': True, 'symlinkedHandoffRead': False, 'noChangeTerminal': True}))

    def test_agent_gone_from_scion_can_still_be_submitted(self):
        self.start('vanished', 'Edit docs')
        (self.project('vanished') / '.fixture-agents/vanished.json').unlink()
        self.assertEqual(self.run_agent('status', 'vanished')['runtime']['phase'], 'deleted')
        self.assertEqual(self.run_agent('submit', 'vanished')['status'], 'submitted')
        print(json.dumps({'evidence': 'agent-removed-outside-adapter', 'submitted': True}))

    def test_planted_workspace_metadata_cannot_redirect_the_owner_token(self):
        received = []
        class Capture(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *args):
                pass
        capture = http.server.HTTPServer(('127.0.0.1', 0), Capture)
        thread = threading.Thread(target=capture.serve_forever, daemon=True); thread.start()
        try:
            planted = self.root / 'planted'; planted.mkdir()
            (planted / '.luma-scm.json').write_text(json.dumps({'version': 1, 'base': 'x', 'ref': 'work/x', 'prefixes': [''],
                'endpoint': 'http://127.0.0.1:' + str(capture.server_port), 'branch': 'scion/x', 'files': {}}))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('client.py')),
                '--token-file', str(self.token_file), 'status'], cwd=planted, env=self.env,
                text=True, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('pass --endpoint to use it', result.stderr + result.stdout)
            self.assertEqual(received, [])
        finally:
            capture.shutdown(); capture.server_close(); thread.join()
        print(json.dumps({'evidence': 'planted-endpoint-refused', 'tokenSent': False}))

    def test_sigkill_after_server_accepts_commit_recovers_durable_request_once(self):
        self.start('killed', 'Edit docs', '--prefix', 'docs/')
        original_send = self.http.RequestHandlerClass.send
        ready = threading.Event()
        process = None
        def send(handler, status, body, raw=False):
            if handler.path == '/v1/changesets' and status == 201:
                ready.wait(10)
                os.kill(process.pid, signal.SIGKILL)
                return
            return original_send(handler, status, body, raw)
        self.http.RequestHandlerClass.send = send
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('client.py')),
            '--endpoint', self.endpoint, '--token-file', str(self.token_file),
            'agent', '--jobs-dir', str(self.jobs), 'submit', 'killed'],
            env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ready.set()
        process.communicate(timeout=30)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.assertEqual(len(self.store.publications()), 1)
        metadata_path = self.jobs / 'killed/collection/.luma-scm.json'
        self.assertIn('pending', json.loads(metadata_path.read_text()))
        self.http.RequestHandlerClass.send = original_send
        recovered = self.run_agent('submit', 'killed')
        self.assertEqual(recovered['status'], 'submitted')
        self.assertEqual(len(self.store.publications()), 1)
        self.assertNotIn('pending', json.loads(metadata_path.read_text()))
        print(json.dumps({'evidence': 'agent-sigkill-after-accepted-write',
                          'recovered': True, 'publications': 1}))


if __name__ == '__main__':
    unittest.main()
