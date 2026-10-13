"""HTTP + real Git + subprocess Scion lifecycle contract (no model quota in CI)."""
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from server import Store, GitBridge, make_server


SCION_FIXTURE = '''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path.cwd()
args = sys.argv[1:]
state = root / '.scion-fixture.json'
if args[0] == 'init':
    (root / '.scion').mkdir(exist_ok=True)
elif args[:2] == ['hub', 'link']:
    pass
elif 'secret' in args:
    print(json.dumps({'secrets': [{'key': 'CODEX_AUTH', 'type': 'file'}]}))
elif args[0] == 'start':
    assert '--task-file' in args and args[args.index('--task-file') + 1] == '-'
    assert args[args.index('--workspace') + 1] == str(root)
    assert not (root / 'source/.luma-scm.json').exists()
    assert 'GH_TOKEN' not in os.environ and 'LUMA_SCM_TOKEN' not in os.environ
    task = sys.stdin.read()
    assert '/workspace/source' in task
    if 'WAIT_FOREVER' not in task:
        (root / 'source/docs/readme.txt').write_text('Edited by subprocess Scion agent\\n')
        (root / 'source/.luma-scm.json').write_text(json.dumps({'base': 'attacker-base', 'endpoint': 'http://bad.invalid'}))
    state.write_text(json.dumps({'name': args[1], 'phase': 'running',
        'activity': 'working' if 'WAIT_FOREVER' in task else 'completed'}))
elif args[0] == 'list':
    print(json.dumps([json.loads(state.read_text())] if state.exists() else []))
elif args[0] == 'stop':
    item = json.loads(state.read_text()); item['phase'] = 'stopped'; state.write_text(json.dumps(item))
else:
    raise SystemExit('Unexpected Scion invocation: ' + repr(args))
'''


class AgentsE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
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
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        GH_TOKEN='host-secret-must-not-enter-scion', LUMA_SCM_TOKEN='host-only-secret')
        self.jobs = self.root / 'jobs'

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        if hasattr(self.store, 'close'): self.store.close()
        self.tmp.cleanup()

    def run_agent(self, *args, success=True):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('client.py')),
            '--endpoint', self.endpoint, '--token-file', str(self.token_file),
            'agent', '--jobs-dir', str(self.jobs), *args], env=self.env,
            text=True, capture_output=True, timeout=30)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def test_task_collects_exact_workspace_and_submits_once_after_client_restart(self):
        started = self.run_agent('start', 'docs-fix', 'Edit the documentation', '--prefix', 'docs/', '--model', 'fixture-model')
        workspace = Path(started['workspace'])
        self.assertFalse((workspace / 'private-tree').exists())
        self.assertTrue((workspace / 'AGENTS.md').is_file())
        record = (self.jobs / 'docs-fix/job.json').read_text()
        self.assertNotIn('owner-token-for-test', record)
        submitted = self.run_agent('submit', 'docs-fix')
        self.assertEqual(submitted['status'], 'submitted')
        self.assertEqual(submitted['runtime']['phase'], 'stopped')
        self.assertEqual(json.loads((workspace / '.luma-scm.json').read_text())['base'], 'attacker-base')
        self.assertFalse(Path(submitted['collection']).is_relative_to(Path(submitted['project'])))
        publications = self.store.publications()
        self.assertEqual(len(publications), 1)
        cs = self.store.changeset(publications[0]['changeset'])
        self.assertEqual(cs['parents'], [self.imported])
        self.assertEqual([r['path'] for r in cs['changes']], ['docs/readme.txt'])
        again = self.run_agent('submit', 'docs-fix')
        self.assertEqual(again['result'], submitted['result'])
        self.assertEqual(len(self.store.publications()), 1)
        self.run_agent('start', 'docs-fix', 'Overwrite existing', success=False)
        print(json.dumps({'evidence': 'agent-subprocess-to-http-publication', 'sparseFilesChanged': 1,
                          'publications': 1, 'credentialsInWorkspace': False, 'metadataTamperingIgnored': True}))

    def test_bounded_wait_preserves_running_job_and_stop_is_required_before_collection(self):
        started = self.run_agent('start', 'waiting', 'WAIT_FOREVER', '--prefix', 'docs/', '--wait', '--timeout', '0.01')
        self.assertIn('timed out', started['waiting'])
        self.assertEqual(self.run_agent('status', 'waiting')['runtime']['phase'], 'running')
        self.run_agent('submit', 'waiting', success=False)
        self.assertEqual(self.run_agent('stop', 'waiting')['runtime']['phase'], 'stopped')
        self.assertEqual(len(self.store.publications()), 0)
        self.run_agent('start', '../escape', 'No traversal', success=False)
        print(json.dumps({'evidence': 'agent-timeout-restart-stop', 'sourceRetained': True,
                          'publicationWhileRunning': False}))

    def test_sigkill_after_server_accepts_commit_recovers_durable_request_once(self):
        self.run_agent('start', 'killed', 'Edit docs', '--prefix', 'docs/')
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
