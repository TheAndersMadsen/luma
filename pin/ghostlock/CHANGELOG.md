# Changelog

## Unreleased

- Centralize exact compatibility data in strict, hash-bound profile manifests.
- Bind host checks, native preflight, symbols, allocator geometry, and payloads
  to one profile, and accept slot `_a` after its decompressed Image was proven
  byte-identical to the profiled 45.20 Image and a clean-boot physical replay
  completed the production-equivalent chain.
- Add macOS host CI, serial-redacted check diagnostics, and clearer report
  errors.
- Batch each runner state capture into one strict tagged shell snapshot while
  retaining boot, identity, SELinux, and payload-hash validation.
- Recheck battery and external power immediately before consuming a boot's
  atomic attempt claim, reject concurrent runners, and add allowlisted phase
  durations to reduced reports.
- Recheck boot identity inside both the atomic claim and exploit exec shell,
  preserve user cancellation through cleanup failures, and support repository
  checkout paths containing spaces.
- Repair `init_cred` immediately after each collateral credential-pointer
  write, and permit the SELinux follow-up only after that repair is routed.
- Accept the runner's two-anchor, same-boot `bugreport-v1` KASLR proof in the
  native payload and skip the redundant slide-oracle corruption trigger.
- Require performance CPU 7 before direct reclaim, with a fixed UID-1000
  Binder handoff that moves the exact UID-2000 caller to the firmware-proven
  0-7 restricted cpuset and verifies the result.
- Retain one same-PFN-proven order-3 reclaim page across the direct stage and
  allocate a distinct fake lock/waiter slot to every supervised route.
- Complete the current repair-first sequence on the exact retail slot `_b`
  profile in its first clean-boot physical replay.

## 0.1.0 - 2026-09-20

- Add the exact Humane AI Pin retail 45.20 slot-`_b` profile.
- Add guarded current-boot KASLR derivation and same-PFN reclaim verification.
- Add supervised one-shot kernel write routing.
- Add a boot-scoped, shell-peer-restricted root command broker.
- Add the user-facing `check`, `run`, `verify`, `build`, and `report`
  workflows.
- Add privacy redaction, release audits, host tests, and reproducible-build
  verification.
