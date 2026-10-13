---
name: luma-stock-reference
description: Find Humane stock behaviour in the read-only decompiled stock apps mounted in a Luma agent container, and cite it without copying stock code.
---

# Find stock behaviour

The stock Pin's decompiled apps are Luma's specification (AGENTS.md "Stock
reference" and "Extend Luma faithfully"). They are mounted read-only at
`$LUMA_DATA_DIR/stock-reference`, which is
`/workspace/state/stock-reference`:

| Path | Contents |
| --- | --- |
| `decompiled/<app>/sources/` | jadx Java for each stock app or framework jar |
| `decompiled/<app>/resources/` | manifests, layouts and strings |
| `manifest.json` | jadx version, the firmware build fingerprint, each input's SHA-256 |
| `apks/` | the stock inputs, which the evidence tests hash |

If the directory is missing, do what AGENTS.md says: do not infer stock
behaviour; say in your hand-off that the owner must provide the reference.

## Search

    R=/workspace/state/stock-reference/decompiled
    ls $R                                            # the stock apps and jars
    rg -l 'class Switchboard\b' $R/*/sources         # where a class lives
    rg -n 'mActionLimit' $R/ironman/sources          # a field or method
    rg -n 'humane\.aibus' $R/*/sources | head        # calls into a stock gRPC service

`ironman` is the Pin's experience app (the assistant client, for example
`humaneinternal/system/switchboard/Switchboard.java`); `krypto` is its
encryption client; the `humane_*` entries are the feature apps and their
libraries. Packages live under `hu/ma/ne/`, `humane/` and `humaneinternal/`.

Start from what Luma already cites: the comments near the code you change
name the stock classes behind it, and `cosmos/crates/core/src/registry.rs`
lists all 98 stock gRPC method paths the Pin calls.

## Cite, never copy

Name the stock class or method in a code comment for each stock behaviour you
implement, the way the code already does, for example
``//! stock `NotableEventsTtlWorker` deletes local rows older than 14 days``.
Mark a claim with no stock or recovered-web evidence INFERRED.

Never copy decompiled code, resources or APK content into the checkout, an
issue or your hand-off. They are Humane's code, and the host refuses to
publish a file that carries decompiler output.
