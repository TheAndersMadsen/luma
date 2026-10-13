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

## Luma agent environment

Written before the multi-harness adapter. The first adapter ran one harness and
left agents unable to verify Luma; these cases bound the second version.
`test_agents_e2e.py` exercises them through the subprocess Scion fixture, and a
real task per supported harness on m1box proves the image and template.

- Harness: an unknown harness, or one whose credential secret the Hub does not
  hold, fails before a workspace, ref or Hub project exists and names the
  secret the owner must store. The harness, model, template and image are
  recorded and passed explicitly, never inherited from another harness's
  configuration. Claude never runs on a copied interactive login, whose
  refresh would sign the owner's own Claude Code out.
- Projects: each job has its own Scion project, and only its workspace is
  mounted, never the project link or another job. A Hub project that already
  carries the job's project name is never joined, stopped or deleted.
- Names and tasks: an invalid name, an empty task or a jobs directory inside a
  Git checkout is rejected before any folder exists, so a refused start never
  burns the name.
- Build state: each agent gets its own Luma data directory on bulk storage,
  mode 0700, outside its source and its project metadata. Cargo, pnpm and Bun
  state never lands in the agent home on /srv/state or in the collected
  source. Two agents never share a Cargo target directory: Cargo trusts file
  times, and every agent's checkout has the same container path.
- Stock reference: mounted read-only where `LUMA_DATA_DIR` expects it. A
  submission whose changed files or hand-off carry decompiler output (jadx
  markers) is refused before anything is published.
- Credentials: a submission whose changed files or hand-off contain a
  provider credential pattern is refused before publication. Reading the
  hand-off never follows an agent-controlled symlink and is size-bounded.
- Hand-off: the agent's hand-off becomes the PR body above a host-written
  footer naming the job, harness, model and base. It cannot choose the branch,
  base or landing request. A missing hand-off still publishes, with the footer.
- Lifecycle: a stalled, blocked, errored or input-waiting agent ends a wait
  with an attention message instead of consuming the timeout. An agent missing
  from `scion list` is gone, so its source can still be submitted. `stop`
  after a submission keeps the job submitted. An agent that changed nothing
  ends as `no_changes`, not a failed submission. Listing every job reports a
  broken job without hiding the others.
- Cleanup: deleting a job stops and removes its Scion agent and frees its
  build directory; deleting unsubmitted work requires `--force`. A failed
  removal is reported and can be retried.
- Collection: build output directories in the workspace are not copied.
- Host metadata: a workspace `.luma-scm.json` cannot point the client at an
  endpoint other than the configured one, so a file planted in an agent
  checkout cannot receive the owner token.
