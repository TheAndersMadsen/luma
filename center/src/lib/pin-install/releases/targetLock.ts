import type { ResolvedInstallTarget } from "./assets";

export interface TargetLock {
  readonly locked: boolean;
  readonly target: ResolvedInstallTarget;
  readonly lockedAt: string;
  readonly expiresOn: "success" | "failure" | "page-leave";
}

export function lockResolvedInstallTarget(target: ResolvedInstallTarget): TargetLock {
  return Object.freeze({
    locked: true,
    target,
    lockedAt: new Date().toISOString(),
    expiresOn: "page-leave",
  });
}

export function getLockedTarget(lock: TargetLock | null | undefined): ResolvedInstallTarget | null {
  return lock?.target ?? null;
}

export function clearTargetLock(): null {
  return null;
}
