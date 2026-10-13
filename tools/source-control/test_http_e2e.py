"""HTTP boundary and transactional workflow exercised over real TCP."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from core import Store
from bridge import GitBridge
from server import make_server
from test_e2e import git
import subprocess

class HttpWorkflowE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'state')
        blob = self.store.putblob(b'base\n')['hash']
        self.base = self.store.create([], [{'path':'README.md', 'blob':blob, 'mode':'100644'}], 'base')['id']
        self.store.set_github_head(self.base)
        remote = self.root / 'remote.git'
        subprocess.run(['git','init','--bare','-q',str(remote)],check=True)
        self.bridge = GitBridge(self.store, str(remote))
        self.http = make_server(self.store,self.bridge,'owner-test','127.0.0.1',0)
        self.thread = threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.http.server_port)
    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.store.close(); self.tmp.cleanup()
    def call(self, method, path, body=None, auth=True, raw=False):
        headers = {'Authorization':'Bearer owner-test'} if auth else {}
        if body is not None and not raw:
            body=json.dumps(body).encode(); headers['Content-Type']='application/json'
        req=urllib.request.Request(self.url+path,data=body,method=method,headers=headers)
        try: r=urllib.request.urlopen(req,timeout=10)
        except urllib.error.HTTPError as e: r=e
        with r:
            data=r.read()
            return r.status, json.loads(data) if r.headers.get_content_type()=='application/json' else data
    def test_authenticated_commit_and_recovery_contract(self):
        self.assertEqual(self.call('GET','/health',auth=False),(200,b'OK'))
        self.assertEqual(self.call('GET','/v1/status',auth=False)[0],401)
        self.assertEqual(self.call('POST','/v1/refs/main',{'expected':self.base,'target':self.base})[0],403)
        blob=self.call('POST','/v1/blobs',b'changed\n',raw=True)[1]['hash']
        body={'parent':self.base,'ref':'work/http','expected':None,'request_id':'http-test-idempotency',
              'message':'HTTP edit','changes':[{'path':'README.md','blob':blob,'mode':'100644'}],
              'publication':{'branch':'scion/http','title':'HTTP edit'}}
        status, first=self.call('POST','/v1/changesets',body)
        self.assertEqual(status,201,first)
        repeated=self.call('POST','/v1/changesets',body)[1]
        self.assertEqual(repeated['id'],first['id'])
        jobs=self.call('GET','/v1/publications')[1]['publications']
        self.assertEqual(len(jobs),1)
        self.assertEqual(jobs[0]['changeset'],first['id'])
        self.assertEqual(self.call('GET','/v1/refs')[1]['refs']['work/http'],first['id'])
        self.assertEqual(self.call('GET','/v1/refs')[1]['refs']['main'],self.base)
        status, landed=self.call('POST','/v1/publications/'+jobs[0]['id']+'/land',{})
        self.assertEqual(status,200,landed)
        self.assertTrue(landed['auto_merge'])
        print(json.dumps({'evidence':'http-commit-outbox-idempotency','publication_count':len(jobs),'changeset':first['id']}))
    def test_malformed_body_and_immutable_sparse_snapshot(self):
        self.assertEqual(self.call('POST','/v1/changesets',b'{',raw=True)[0],400)
        self.assertEqual(self.call('GET','/not-a-route')[0],404)
        result=self.call('GET','/v1/files?at=main&prefix=README.md')[1]
        self.assertEqual(result['at'],self.base)
        self.assertEqual(len(result['files']),1)
        self.assertEqual(self.call('GET','/v1/history?at=main')[1]['changesets'][0]['id'],self.base)
        self.assertEqual(self.call('GET','/v1/blobs/'+result['files'][0]['blob'])[1],b'base\n')

if __name__=='__main__': unittest.main(verbosity=2)
