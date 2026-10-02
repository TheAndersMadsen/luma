<!-- Thanks for contributing to Luma. CONTRIBUTING.md is the short guide; AGENTS.md has the full rules. -->

## What this changes

<!-- One or two sentences. Which component: Center, Cosmos, CLI/platform, Pin apps, docs? -->

## Stock evidence

<!-- For a stock behaviour: the stock app, class, and method it recreates (cited in a code comment).
     For anything without stock or recovered-web evidence: say it is INFERRED and why it is needed.
     For docs-only changes: write "none". -->

## Checks run

<!-- Paste the tail of each command you ran. Cosmos and Pin checks need Docker. -->

- [ ] `./luma check changed --base HEAD`
- [ ] Owning component: `./luma check center` / `./luma check cosmos FILTER` / `./luma check platform` / `./luma pin check`
- [ ] Cross-component change: `./luma check platform --full` and `./luma test`
- [ ] `git diff --check` is clean and no build output (`target`, `.gradle`, `.kotlin`, `.next`, `build`) is in the tree

## Documentation

- [ ] The documentation an owner reads (README.md, the `docs/` page, or the `guides/` how-to) is updated, or not needed because: <!-- reason -->
- [ ] Every README heading or pinned sentence I changed has its references updated (`contracts/operator-setup.json`, tests)

## Confirmations

- [ ] No stock APKs, decompiled stock code, or excerpts of them are included
- [ ] Stock `humane.*` names, Android package IDs, and wire fields are unchanged (fields added, never renumbered or retyped; `contracts/wire` and `pin/runtime/core/proto` changed together)
- [ ] No secrets, tokens, serials, or personal data in the diff, commits, or attachments
- [ ] Commit messages explain why, one concern per commit
