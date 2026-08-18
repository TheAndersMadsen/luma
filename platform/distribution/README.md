# Distribution contract

`build.mjs` packages the complete `distribution` release profile with the
existing deterministic release builder. It stamps `version.json` only in a
temporary source tree, verifies the immutable payload, and always emits a
manifest, distribution descriptor, and `SHA256SUMS` beside the archive.

The Homebrew file is deliberately a template. A usable URL and digest are
rendered only inside the explicitly tag-gated publication job; this repository
does not claim that an unreleased artifact exists. Homebrew supplies Node 22
and installs the full payload under `libexec`. Docker, signing material, a
connected Pin, and physical acceptance remain external requirements.
