# Prototype failure cases

These are the boundaries the E2E suite must exercise before implementation.

- Unauthorized callers cannot read repository data or write objects.
- Unknown parents/blobs and unsafe paths cannot create a changeset.
- Two writers racing on a ref produce one winner and one 409; both immutable changesets survive.
- Commits store deltas, not copies of the repository. A later deletion must hide an earlier file.
- Sparse reads return only the requested prefix, including binary content and executable modes.
- Path history and diffs are computed server-side and follow first-parent history.
- Disjoint merges and rebases work; conflicting file edits are reported without committing markers.
- Git import preserves file modes, binary data and symlinks, and repeated import is idempotent.
- GitHub mirroring preserves the original main/history and writes only the experimental branch.
- A diverged mirror branch cannot be overwritten, and failed pushes are not recorded as successful.
- State and immutable blobs survive a server restart.

The prototype is one-owner, one-host software. SQLite WAL serializes writes; this is not Anthropic's distributed, lock-free implementation.
