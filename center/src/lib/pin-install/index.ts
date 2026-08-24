/**
 * The installer brain: the framework-free pipeline that makes the PenumbraOS
 * SystemInjector installable onto an Ai Pin from Center.
 *
 * Ported with behaviour preserved from the retired Setup SPA's
 * `install/{domain,ops,releases,presentation}`. Nothing here imports React,
 * Next, or a stylesheet, and nothing touches `window`/`document`/`navigator`
 * at module scope — the whole tree is safe for the server to import and
 * directly unit-testable.
 *
 * Layers, innermost first:
 *   generated/ — @generated Tier-A package identities (do not edit by hand).
 *   device.ts  — the ONLY seam onto `@/lib/pin-device`; internal.
 *   domain/    — what is on the device and what may be done to it.
 *   releases/  — what a trustworthy release is, and how to fetch/verify one.
 *   ops/       — the mutation pipelines (install, uninstall, conflict cleanup).
 *   app/state  — the pure reducer + command derivation the route hook drives.
 *   presentation/ — view models over the above; still framework-free.
 *
 * `device.ts` is deliberately not re-exported: the device layer's own public
 * exports are at `@/lib/pin-device`, and callers should use those directly
 * rather than reaching for them through the installer.
 */

export * from "./generated/tier-a-symbols";

export * from "./domain/types";
export * from "./domain/managedPackages";
export * from "./domain/recognition";
export * from "./domain/versions";
export * from "./domain/actionState";
export * from "./domain/knownPackageConflicts";
export * from "./domain/keepDataEligibility";
export * from "./domain/inspection";
export * from "./domain/migrationDecision";

export * from "./releases/manifest";
export * from "./releases/assets";
export * from "./releases/targetLock";

export * from "./ops/phases";
export * from "./ops/shared";
export * from "./ops/install";
export * from "./ops/uninstall";
export * from "./ops/removeConflicts";

export * from "./app/state";

export * from "./presentation/managedPackages";
export * from "./presentation/primaryCardViewModel";
export * from "./presentation/supportBundle";
