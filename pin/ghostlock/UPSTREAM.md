# Upstream provenance

This directory is a vendored copy of GhostLock for Humane AI Pin:

- Repository: https://github.com/TheAndersMadsen/humane-aipin-ghostlock
- Last commit-backed import: `5ae716621168ffada6d96d4fe1f04c3406c7a9ca`
- Current source snapshot: owner-supplied
  `Pin-Ghostlock-Updated-Ghost09222026.zip`
- Snapshot SHA-256:
  `c35bc0d8df5a2c1cd932f541ababf744e6b9f71290f57a2e3839c3a68ce45988`
- Snapshot Git commit: unavailable in the supplied archive; none is inferred
- Vendored on: 2026-09-28

The import excludes the archive's terminal log, Python bytecode, generated
`source/build/` tree, and prebuilt payload. Luma builds the payload from the
reviewed source with its pinned Android NDK.

This copy also carries the reviewable `bugreport-v1` KASLR proof and the
repair-first direct-route reliability changes prepared for upstream after the
first physical slot-`_b` replays reset. The current sequence completed the full
chain in its first clean-boot slot-`_b` replay. The upstream patch is kept
outside the checkout at
`~/.local/share/luma/firmware-analysis/ghostlock-bugreport-v1.patch` (SHA-256
`b9eae515d3c532a717c903ccba313e188fe5c10c1ea69466b2995131df40a0d7`)
until the owner publishes it. No upstream commit is inferred before that
happens.

Keep Luma integration outside this directory (`pin/hook/module`,
`platform/cli/pin-dock.js`, and the `./luma pin dock` commands). Changes to the
vendored helper must remain directly applicable to its upstream repository. To
refresh from a commit-backed checkout:

    git clone https://github.com/TheAndersMadsen/humane-aipin-ghostlock /tmp/ghostlock
    rsync -a --delete --exclude '.git' --exclude '.github' /tmp/ghostlock/ pin/ghostlock/
    # keep UPSTREAM.md (this file) and update the commit above

GhostLock remains boot-scoped and does not modify verified boot. Luma's
optional on-device Root access flag starts one guarded GhostLock attempt on a
fresh boot; a durable latch turns the flag off if that attempt reboots the Pin,
preventing an unattended retry loop. The host-side `./luma pin dock run` and
`./luma pin dock follow` commands use the same one-attempt-per-boot boundary.
Read the vendored README, SAFETY, and COMPATIBILITY documents before any
device attempt.
