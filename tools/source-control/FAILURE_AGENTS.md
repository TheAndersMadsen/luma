# Agent bridge failure cases

Written before the adapter implementation. Exercise the workflow through its
commands, a real HTTP source-control service and a subprocess Scion fixture;
also verify one real Google Scion/Codex task on m1box.

- A duplicate or invalid job name must never overwrite existing workspace or state.
- Missing Scion, failure to initialize/link/start, or a restart mid-start must leave
  durable job state and preserve files for diagnosis.
- Sparse selections must retain root and ancestor AGENTS.md and .gitignore files,
  so the model receives repository instructions and build outputs stay ignored.
- The container must see only its isolated source workspace and harness credentials;
  never the source-control bearer token, GitHub credentials, or job control files.
- Agent writes must be collected from the exact workspace passed to Scion, not a
  different automatically created Git worktree. File deletion, binary and mode
  changes use the normal client commit path.
- A running task cannot be submitted while it can still mutate the checkout;
  collection stops its container first. Completion must come from Scion state,
  never inferred merely from the existence of an edited file.
- A bounded wait times out with a resumable job. Status and stop work after the
  starting client has exited. Completed jobs submit at most one publication.
- Agent-authored metadata, symlinks or Git configuration must not redirect the
  host submit operation or replace its authoritative base/ref.
- Failed submission retains metadata/pending request for an idempotent retry.
- Agent startup must handle the installed harness model and trust configuration:
  the previous image trusted /workspace but started in /repo-root, and its default
  model was unavailable for the installed ChatGPT credential.
