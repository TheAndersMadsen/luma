# Bridge failure cases, specified before implementation

- Imported merge commits lose parents, executable bits, symlink targets, binary
  bytes, author identity, deletions, or history; repeat imports duplicate data.
- Local changes materialize with a different Git SHA after restart or export only
  the tip without its ancestry; a push succeeds before bookkeeping is saved.
- A queued publication disappears during an outage or restart, is pushed out of
  order on its branch, or overwrites somebody else's divergent branch.
- A successful branch push has no PR; a PR-creation response is lost and retry
  opens a duplicate; a subsequent task on a merged branch needs a new PR.
- Missing/pending/failed CI, failed status contexts, a draft, rejected review,
  conflicts, an updated PR head, or GitHub branch protections permit a merge.
- A branch is merged without the job's explicit auto_merge flag; a merge failure
  is represented as success; successful merge responses lost in transit cause
  another merge attempt rather than reconciliation.
- A collaborator retargets the PR, changes its repository identity, closes it,
  or changes mergeability during CI verification; the last refresh must recheck
  all merge preconditions before sending the exact-head merge request.
- Direct publication to main or a branch outside scion/ and scion-prototype/
  is accepted; output leaks credentials or Git stderr containing remote secrets.
- Main changes on GitHub but the local main ref doesn't advance; import outages
  halt the worker forever rather than leaving visible retryable status.
- Multiple worker turns overlap Git/index writes or the worker cannot stop.

Verification uses real temporary Git repositories plus a local HTTP GitHub
fixture, including controlled transport failures. Evidence is emitted as JSON
by test_bridge_e2e.py. Production credentials and actual GitHub are not used.
