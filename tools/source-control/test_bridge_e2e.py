"""Real Git + HTTP bridge acceptance tests; no production credentials required."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core import Store, Failure
from bridge import GitBridge, GitHub


def git(where, *args):
    return subprocess.check_output(['git', '-C', str(where), *args], stderr=subprocess.DEVNULL).decode().strip()


class Fixture:
    def __init__(self, remote):
        self.remote, self.pulls, self.merges = remote, [], []
        self.check = 'success'
        self.review = 'APPROVED'
        self.draft = False
        self.head_changed = False
        self.outage = False
        self.fail_create_response = False
        self.missing_check = False
        self.missing_workflow = False
        self.status_context = 'success'
        self.mergeability = 'clean'
        self.race_at_merge = False
        self.final_pr_changes = None
        self.ci_observed = False
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self): self.dispatch()
            def do_POST(self): self.dispatch()
            def do_PUT(self): self.dispatch()
            def dispatch(self):
                d = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
                p = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(p.query)
                route = p.path.removeprefix('/repos/owner/luma')
                code, out = 200, {}
                if fixture.outage: code, out = 503, {'message': 'Injected outage'}
                elif route == '/pulls' and self.command == 'POST':
                    number = len(fixture.pulls) + 1
                    sha = git(remote, 'rev-parse', 'refs/heads/' + d['head'])
                    out = {'number': number, 'html_url': 'https://github.com/owner/luma/pull/' + str(number), 'state':'open', 'merged':False,
                           'head':{'sha':sha,'ref':d['head'],'repo':{'full_name':'owner/luma'}}, 'base':{'ref':'main','repo':{'full_name':'owner/luma'}},
                           'draft':False,'mergeable':True,'mergeable_state':'clean'}
                    fixture.pulls.append(out)
                    if fixture.fail_create_response: fixture.fail_create_response = False; code, out = 503, {'message':'Lost create response'}
                elif route == '/pulls':
                    branch = q.get('head', [':'])[0].split(':',1)[1]
                    state = q.get('state', ['open'])[0]
                    out = [dict(p) for p in fixture.pulls if p['head']['ref']==branch and (state=='all' or p['state']==state)]
                elif route.endswith('/reviews'): out = [{'id':1,'user':{'login':'reviewer'},'state':fixture.review,'submitted_at':'2026-10-13T00:00:00Z'}]
                elif '/pulls/' in route and route.endswith('/merge'):
                    pr = fixture.pulls[int(route.split('/')[2])-1]
                    if d.get('sha') != pr['head']['sha'] or fixture.head_changed or fixture.race_at_merge: code, out = 409, {'message':'head moved'}
                    else:
                        fixture.merges.append(d)
                        git(remote, 'update-ref', 'refs/heads/main', pr['head']['sha'])
                        pr.update(state='closed', merged=True)
                        out = {'merged':True,'sha':pr['head']['sha']}
                elif '/pulls/' in route:
                    pr = fixture.pulls[int(route.split('/')[2])-1]
                    pr['head']['sha'] = git(remote, 'rev-parse', 'refs/heads/' + pr['head']['ref'])
                    out = dict(pr, draft=fixture.draft, mergeable_state=fixture.mergeability)
                    if fixture.head_changed: out['head'] = dict(pr['head'],sha='f'*40)
                    if fixture.ci_observed and fixture.final_pr_changes: out.update(fixture.final_pr_changes)
                elif route.endswith('/check-runs'):
                    out={'total_count':1,'check_runs':[{'id':1,'name':'CI passed','head_sha':route.split('/')[2], 'status':'completed' if fixture.check!='pending' else 'in_progress','conclusion':fixture.check,'app':{'slug':'github-actions'}}]}
                    if fixture.missing_check: out={'total_count':0,'check_runs':[]}
                elif route.endswith('/status'): out={'state':fixture.status_context,'total_count':1,'statuses':[{'context':'external-lint','state':fixture.status_context}]}
                elif route == '/actions/runs':
                    fixture.ci_observed = True
                    out={'total_count':1,'workflow_runs':[{'id':10,'head_sha':q['head_sha'][0],'event':'pull_request','path':'.github/workflows/ci.yml','status':'completed','conclusion':fixture.check}]}
                    if fixture.missing_workflow: out={'total_count':0,'workflow_runs':[]}
                else: code, out = 404, {'message':'Unknown fixture route ' + route}
                body = json.dumps(out).encode()
                self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def request(self, method, path, data=None):
        body=None if data is None else json.dumps(data).encode()
        req=urllib.request.Request('http://127.0.0.1:'+str(self.server.server_port)+path,body,method=method,headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=5) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            status=e.code; e.close()
            raise Failure('GitHub HTTP '+str(status),502,github_status=status)
    def close(self): self.server.shutdown(); self.server.server_close(); self.thread.join()


class BridgeE2E(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        self.remote=self.root/'remote.git'; self.work=self.root/'work'
        self.remote.mkdir(); git(self.remote,'init','--bare','-q')
        self.work.mkdir(); git(self.work,'init','-q','-b','main')
        git(self.work,'config','user.name','Actual Author'); git(self.work,'config','user.email','author@example.test')
        (self.work/'a').write_text('one\n'); (self.work/'binary').write_bytes(b'\x00\xff')
        (self.work/'run').write_text('#!/bin/sh\n'); (self.work/'run').chmod(0o755); (self.work/'link').symlink_to('a')
        git(self.work,'add','.'); git(self.work,'commit','-qm','First'); self.first=git(self.work,'rev-parse','HEAD')
        git(self.work,'checkout','-qb','side'); (self.work/'side').write_text('side\n'); git(self.work,'add','.'); git(self.work,'commit','-qm','Side')
        git(self.work,'checkout','-q','main'); (self.work/'a').write_text('two\n'); git(self.work,'commit','-qam','Second')
        git(self.work,'merge','--no-ff','-qm','Merge side','side'); self.tip=git(self.work,'rev-parse','HEAD')
        git(self.work,'remote','add','origin',str(self.remote)); git(self.work,'push','-q','origin','main')
        self.store=Store(self.root/'state'); self.fixture=Fixture(self.remote)
        self.bridge=GitBridge(self.store,str(self.remote),'owner/luma',github=GitHub('owner/luma',request=self.fixture.request))
        self.imported=self.bridge.import_main()['changeset']
    def tearDown(self): self.bridge.stop(); self.fixture.close(); self.store.close(); self.temp.cleanup()
    def edit(self,message='Local edit',parent=None):
        blob=self.store.putblob((message+'\n').encode())['hash']
        return self.store.create([parent or self.imported],[{'path':'a','blob':blob,'mode':'100644'}],message)['id']
    def retry(self,job): self.store.update_publication(job['id'],next_attempt=0)

    def test_import_dag_binary_modes_and_restart(self):
        imported=self.store.changeset(self.imported)
        self.assertEqual(len(imported['parents']),2)
        self.assertEqual(imported['author']['name'],'Actual Author')
        self.assertIsNotNone(self.store.gitcs(self.first))
        tree=self.store.tree(self.imported)
        self.assertEqual(tree['run']['mode'],'100755'); self.assertEqual(tree['link']['mode'],'120000')
        self.assertEqual(self.store.blob(tree['binary']['blob']),b'\x00\xff')
        self.assertEqual(self.bridge.import_main()['changeset'],self.imported)
        cs=self.edit('Deterministic after restart')
        sha=self.bridge.materialize(cs)
        self.store.close(); self.store=Store(self.root/'state')
        self.bridge=GitBridge(self.store,str(self.remote),'owner/luma',github=GitHub('owner/luma',request=self.fixture.request))
        self.assertEqual(self.bridge.materialize(cs),sha)
        (self.work/'a').write_text('Normal GitHub contributor update\n')
        git(self.work,'commit','-qam','Normal Git change'); git(self.work,'push','-q','origin','main')
        normal=self.bridge.import_main()
        self.assertEqual(normal['imported'],1)
        self.assertEqual(self.store.changeset(normal['changeset'])['parents'],[self.imported])
        self.assertEqual(self.store.refs()['main'],normal['changeset'])
        print(json.dumps({'bridge_evidence':'full_git_dag','git_head':self.tip,'parents':len(imported['parents'])}))

    def test_crash_recovery_duplicate_pr_and_nonforce(self):
        cs=self.edit(); job=self.store.enqueue(cs,'scion/test',auto_merge=False)
        # Remote accepts push before process records outbox progress.
        expected=self.bridge.publish(cs,'scion/test')['git_commit']
        self.fixture.fail_create_response=True
        self.bridge.sync_once(); self.assertEqual(len(self.fixture.pulls),1)
        self.retry(job); self.bridge.sync_once()
        job=self.store.publication(job['id']); self.assertEqual(job['git_commit'],expected); self.assertEqual(job['status'],'published')
        self.assertEqual(len(self.fixture.pulls),1); self.assertEqual(self.fixture.merges,[])
        self.assertEqual(git(self.remote,'rev-parse','main'),self.tip)
        with self.assertRaises(Failure): self.bridge.publish(cs,'main')
        sibling=self.edit('Divergent edit')
        with self.assertRaises(Failure): self.bridge.publish(sibling,'scion/test')
        self.assertEqual(git(self.remote,'rev-parse','scion/test'),expected)
        print(json.dumps({'bridge_evidence':'push_and_pr_recovery','single_pr':len(self.fixture.pulls),'main_unchanged':True}))

    def test_ci_review_head_gates_and_import_landing(self):
        cs=self.edit(); job=self.store.enqueue(cs,'scion/land',auto_merge=True)
        for check,review,draft,head in [('pending','APPROVED',False,False),('failure','APPROVED',False,False),('success','CHANGES_REQUESTED',False,False),('success','APPROVED',True,False),('success','APPROVED',False,True)]:
            self.fixture.check=check; self.fixture.review=review; self.fixture.draft=draft; self.fixture.head_changed=head
            self.retry(job); self.bridge.sync_once(); self.assertEqual(self.fixture.merges,[])
        self.fixture.head_changed=False; self.fixture.draft=False; self.fixture.check='success'; self.fixture.review='APPROVED'
        for key,value in [('missing_check',True),('missing_workflow',True),('status_context','failure'),('mergeability','blocked'),('race_at_merge',True)]:
            previous=getattr(self.fixture,key); setattr(self.fixture,key,value)
            self.retry(job); self.bridge.sync_once(); self.assertEqual(self.fixture.merges,[])
            setattr(self.fixture,key,previous)
        self.retry(job); self.bridge.sync_once()
        self.assertEqual(self.store.publication(job['id'])['status'],'merged')
        self.assertEqual(len(self.fixture.merges),1)
        self.assertEqual(self.fixture.merges[0]['sha'],self.store.gitsha(cs))
        self.bridge.sync_once(); self.assertEqual(self.store.refs()['main'],cs)
        following=self.edit('Following task',parent=cs)
        next_job=self.store.enqueue(following,'scion/land')
        self.bridge.sync_once()
        self.assertEqual(len(self.fixture.pulls),2)
        self.assertEqual(self.store.publication(next_job['id'])['pr_number'],2)
        print(json.dumps({'bridge_evidence':'exact_head_ci_landing','blocked_scenarios':10,'merges':len(self.fixture.merges)}))

    def test_outage_retries_and_branch_order(self):
        first=self.edit('First queued'); second=self.edit('Second queued',parent=first)
        a=self.store.enqueue(first,'scion/queue',auto_merge=True); b=self.store.enqueue(second,'scion/queue')
        self.fixture.outage=True; self.bridge.sync_once(); self.assertGreater(self.store.publication(a['id'])['attempts'],0)
        self.fixture.outage=False; self.retry(a); self.retry(b); self.bridge.sync_once()
        self.assertEqual(git(self.remote,'rev-parse','scion/queue'),self.store.gitsha(second))
        self.assertEqual(len(self.fixture.pulls),1)
        self.assertEqual(self.fixture.merges,[])
        self.assertIn('Superseded',self.store.publication(a['id'])['error'])
        print(json.dumps({'bridge_evidence':'outage_and_order','tip':self.store.gitsha(second)}))

    def test_replaced_branch_is_not_reported_landed(self):
        cs=self.edit('Original work'); job=self.store.enqueue(cs,'scion/replaced')
        self.bridge.sync_once()
        original=self.store.gitsha(cs)
        replacement=self.edit('Replacement work'); replacement_sha=self.bridge.materialize(replacement)
        # Simulate an external actor replacing the branch (bridge never forces).
        git(self.bridge.repo,'push','--force',str(self.remote),replacement_sha+':refs/heads/scion/replaced')
        pr=self.fixture.pulls[0]; pr.update(state='closed',merged=True); pr['head']['sha']=replacement_sha
        self.retry(job); self.bridge.sync_once()
        result=self.store.publication(job['id'])
        self.assertNotEqual(result['status'],'merged')
        self.assertIn('replaced',result['error'])
        self.assertNotEqual(original,replacement_sha)
        print(json.dumps({'bridge_evidence':'replaced_branch_not_landed','status':result['status']}))

    def test_final_pr_refresh_revalidates_target_and_state(self):
        cs=self.edit('Refresh race'); job=self.store.enqueue(cs,'scion/refresh',auto_merge=True)
        sha=self.bridge.materialize(cs)
        scenarios=[
            {'base':{'ref':'release-other','repo':{'full_name':'owner/luma'}}},
            {'base':{'ref':'main','repo':{'full_name':'other/luma'}}},
            {'head':{'sha':sha,'repo':{'full_name':'other/luma'}}},
            {'state':'closed'}, {'merged':True}, {'mergeable':False},
        ]
        for changes in scenarios:
            self.fixture.ci_observed=False; self.fixture.final_pr_changes=changes
            self.retry(job); self.bridge.sync_once()
            self.assertEqual(self.fixture.merges,[],changes)
            self.assertNotEqual(self.store.publication(job['id'])['status'],'merged',changes)
        self.fixture.ci_observed=False; self.fixture.final_pr_changes=None
        self.retry(job); self.bridge.sync_once()
        self.assertEqual(len(self.fixture.merges),1)
        print(json.dumps({'bridge_evidence':'final_refresh_preconditions','refused_races':len(scenarios)}))


if __name__=='__main__': unittest.main(verbosity=2)
