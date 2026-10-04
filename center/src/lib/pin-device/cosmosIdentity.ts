import type { AdbSessionTransport } from "@/lib/pin-device/adb/transport";

/**
 * Calls into the Pin's privileged Cosmos identity provider (Device Services'
 * `CosmosIdentityProvider`); the authority is kept from PenumbraOS maintenance
 * tooling so content URIs survive APK replacement. Center provisioning and the
 * installer's uninstall both need the same maintenance methods, so the calls
 * live here once, beside the other device ADB modules.
 *
 * The provider answers `content call` with `Result: Bundle[{...}]` whose pairs
 * are booleans and lowercase identifiers (`CosmosIdentityProvider.result` and
 * `activationResultBundle`), so the fields are read with the same bounded
 * per-field reads the activation status parser uses.
 */
export const COSMOS_IDENTITY_URI = "content://com.penumbraos.server.cosmosidentity";

export interface CosmosIdentityCallResult {
  readonly ok: boolean;
  /** The activation code the provider answered with, e.g. `deactivated`. */
  readonly state: string | null;
  /** Whether the provider's journaled rollback of prior settings completed. */
  readonly rollbackComplete: boolean;
  readonly message: string | null;
}

/** The provider could not be reached at all, or answered unreadably. */
export class CosmosIdentityUnavailableError extends Error {
  override name = "CosmosIdentityUnavailableError";
}

/** The provider answered and refused the method (`ok=false`). */
export class CosmosIdentityRefusedError extends Error {
  override name = "CosmosIdentityRefusedError";
}

function parseIdentityCallResult(output: string): CosmosIdentityCallResult {
  const body = /^Result: Bundle\[\{([\s\S]*)\}\]$/u.exec(output.trim())?.[1];
  if (body === undefined) {
    throw new CosmosIdentityUnavailableError(
      "The Pin returned an unreadable Cosmos identity response.",
    );
  }
  const read = (name: string, pattern: string) =>
    new RegExp(`(?:^|,\\s*)${name}=(${pattern})(?=,\\s*|$)`, "u").exec(body)?.[1] ?? null;
  const ok = read("ok", "true|false") === "true";
  return {
    ok,
    state: read("state", "[a-z_]+"),
    rollbackComplete: read("rollback_complete", "true|false") === "true",
    message: read("message", "[^,]*"),
  };
}

async function callIdentityMethod(
  session: AdbSessionTransport,
  method: "DEACTIVATE" | "CLEAR",
): Promise<CosmosIdentityCallResult> {
  let result;
  try {
    result = await session.shell([
      "content",
      "call",
      "--uri",
      COSMOS_IDENTITY_URI,
      "--method",
      method,
    ]);
  } catch {
    throw new CosmosIdentityUnavailableError(
      "Center could not reach this Pin's Cosmos identity.",
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    result.exitCode !== 0 ||
    output.includes("Error while accessing provider:") ||
    output.includes("Could not find provider:")
  ) {
    throw new CosmosIdentityUnavailableError(
      "Center could not reach this Pin's Cosmos identity. Install the current Luma release on this Pin first.",
    );
  }
  const parsed = parseIdentityCallResult(result.stdout);
  if (!parsed.ok) {
    throw new CosmosIdentityRefusedError(
      parsed.message || "The Pin refused the Cosmos identity change.",
    );
  }
  return parsed;
}

/**
 * Remove the Pin's Cosmos activation and restore the settings it replaced
 * (`CosmosIdentityProvider.METHOD_DEACTIVATE` → the journaled
 * `CosmosActivationTransaction.deactivate`). Idempotent: the provider answers
 * `already_inactive` for a Pin that was never activated.
 */
export function deactivateCosmosIdentity(
  session: AdbSessionTransport,
): Promise<CosmosIdentityCallResult> {
  return callIdentityMethod(session, "DEACTIVATE");
}

/**
 * Remove the leftover identity material after a deactivation
 * (`METHOD_CLEAR`). The provider refuses it while an activation record or the
 * remote gate remains, so it runs only after a successful
 * {@link deactivateCosmosIdentity}.
 */
export function clearCosmosIdentity(
  session: AdbSessionTransport,
): Promise<CosmosIdentityCallResult> {
  return callIdentityMethod(session, "CLEAR");
}
