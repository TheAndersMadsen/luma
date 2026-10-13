# API / service failure cases, recorded before implementation

- A request without the owner token reads source or moves a ref.
- Malformed JSON, unsupported chunked bodies, oversized payloads or incomplete uploads tie up the service or leak internals.
- Parallel clients exceed available worker/memory resources.
- A client modifies main/github independently of GitHub integration.
- A timed-out commit is retried and creates duplicate changesets or mirror jobs.
- An accepted commit moves a work ref but does not create its mirror job.
- Publication retries or land requests mutate the wrong job / silently unpublish completed work.
- A service starts twice against one state directory, or starts before encrypted storage is mounted.
- A service exits during synchronization without leaving a recoverable publication job.
- Backup captures a DB referring to missing blobs, or restore is not independently usable.
- Background synchronization fails but health/status reports a successful sync.
- GitHub main advances while sparse files are being read, mixing snapshots.

Evidence: real authenticated HTTP requests, real Git fixture, actual subprocess restart and persisted queue. Existing component tests cover core, Git bridge, client and agent adapter.
