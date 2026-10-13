# Client failure cases (written before implementation)

- Sparse work loses unselected files when committing or updating; new out-of-scope files silently disappear.
- Changes to executable bits, symlinks, binary files, deleted files, or previously ignored tracked files go unnoticed.
- Dependencies, build output, Git/Scion internals, local credentials, or workspace metadata enter a commit.
- Remote file paths, ancestor symlinks, overlapping files/directories, or escaping symlink targets write outside a checkout.
- Case-insensitive or Unicode-normalizing filesystems alias repository paths or overwrite reserved workspace metadata.
- A corrupted blob cache yields corrupt source, or cache usage grows without a bound.
- A stale work ref overwrites another writer. The workspace base changes before the server acknowledges the atomic commit.
- A timed-out accepted commit gets duplicated on retry, or newer local edits get recorded as already committed.
- Update discards dirty work, unlanded commits, ignored files, or external Git commits; repeated update/publish cannot fast-forward the mirror.
- A crash after ref movement leaves the workspace unrecoverable; a checkout/update download failure damages existing files.
- Authentication failures print credentials; routine network/ref failures expose stack traces instead of actionable errors.

E2E proof uses real HTTP, real Git fixtures, and client subprocesses. Evidence JSON
is printed by the suite. The client delegates ignore semantics to Git check-ignore
with an isolated temporary Git directory and no global/system Git configuration.
Reserved control directories are always omitted. Sparse checkout also materializes
ancestor .gitignore files so Git uses the repository's actual ignore rules.
