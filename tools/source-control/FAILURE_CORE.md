# Source-control storage failure cases

Written before implementation. The executable evidence is `test_core_e2e.py`,
which exercises real SQLite databases, filesystem blobs, Git merge processes,
concurrent writers, process termination, and restored backup directories.

- A failed compare-and-swap must not leave an accepted changeset, moved ref,
  publication job, or idempotency record behind. Two simultaneous writers
  sharing an expected ref must produce one winner.
- Retrying an acknowledged request after a lost connection or restart must
  return the same changeset and publication. Reusing its request ID for a
  different request must fail instead of silently accepting changed content.
- Invalid paths, dangling blobs/parents, file/directory collisions, unsafe
  publication branches, or protected main/github refs must fail before writes.
- An acknowledged blob must survive immediate process exit. Blob corruption
  must be reported rather than propagated under its original content hash.
- A failed or interrupted blob write must not publish a partial blob name;
  contents and containing directory must be synced before acceptance.
- Merging disjoint edits in the same text file must preserve both changes.
  Overlapping edits, binary edits, delete/edit, incompatible modes, and
  ambiguous crisscross merge bases must surface conflicts.
- Rebasing a branch must preserve all branch commits' changes since its unique
  merge base; the resulting changeset deliberately squashes those changes.
- Existing prototype changeset IDs and mapped Git commits must survive schema
  extension. Imported author, committer, timestamp, and all parents survive.
  Distinct Git commit objects with identical interpreted content (for example,
  differing signature headers) must retain distinct mappings; empty Git commit
  messages are valid historical input.
- File history follows the first-parent chain, including deletions, through
  indexed metadata; cached trees cannot be mutated through returned objects.
- Completed publication jobs are not reset by duplicate enqueue operations;
  pending/retry state survives restart.
- A consistent SQLite backup plus immutable blobs must restore accepted refs,
  changesets, publication state, and Git objects. A failed backup must never
  appear under its final destination. Git bridge operations must be locked by
  the caller while a backup copies mirror.git. Credentials are excluded.

Real disk exhaustion and power-loss filesystem guarantees cannot be emulated
faithfully by these portable tests. Write/commit/fsync failures propagate to
the caller; SQLite synchronous=FULL and atomic filesystem publication provide
the durability boundary, subject to the host filesystem and storage hardware.
