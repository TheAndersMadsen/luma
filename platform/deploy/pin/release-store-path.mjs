import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The single owner-controlled Pin release namespace.
 *
 * `active` is the only directory mounted into Center. A matching operator
 * release may be downloaded into `staging` during setup, but it is promoted to
 * `active` only by the production deployment transaction.
 */
export function canonicalPinReleasePaths(environment = process.env) {
  const data = resolve(
    environment.REVIVAL_DATA_DIR ??
      join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"),
  );
  return Object.freeze({
    data,
    active: join(data, "pin-releases"),
    staging: join(data, "pin-release-staging"),
  });
}

export function canonicalPinReleaseRoot(environment = process.env) {
  return canonicalPinReleasePaths(environment).active;
}

