/*
 * The wearer's account on Cosmos's web plane: profile, food preferences and
 * devices. Center keeps none of it.
 *
 *   GET/POST    /account-service/profile              preferred name, pronunciation
 *   GET/POST    /account-service/food-preferences     restrictions, daily intake goals
 *   GET         /account-service/food-intake          the food log's totals against the goals
 *   GET         /device-assignments/devices           paired Pins, status, block mode
 *   POST        /device-assignments/devices           pair a Pin to this account
 *   DELETE      /device-assignments/devices/{id}      release one of this account's Pins
 *   POST/DELETE /device-assignments/devices/{id}/block
 *   GET/PUT     /account-service/passcode             whether the Pin passcode is set. Set it
 *   DELETE      /account-service/account              delete everything Cosmos holds
 *
 * The profile is the stock `AccountInfo` the Pin reads with
 * `GetUserPersonalDetails`, and the food preferences are what
 * `FoodPreferencesService` serves. Cosmos writes the same rows both planes read.
 */

import {
  deviceBlockSchema,
  devicePairingSchema,
  devicesSchema,
  deviceUnpairingSchema,
  passcodeStateSchema,
  profileDtoSchema,
  type AccountDetails,
  type DeviceAssignment,
  type DeviceBlock,
  type DevicePairing,
  type DeviceUnpairing,
  type PasscodeState,
  type ProfileDto,
} from "@/lib/contracts/account";
import type { FoodIntake } from "@/lib/contracts/food";
import { foodIntakeSchema, foodPreferencesViewSchema, type FoodPreferencesView } from "@/lib/contracts/food";
import { deletedSchema } from "@/lib/contracts/pagination";
import { parseResponse } from "@/lib/contracts/parse";
import { COSMOS_WEBAPI_ENABLED, CosmosHttpError, webapiGet, webapiRequest } from "../cosmos";
import { failed, failedWebapi, live, unconfigured, type Sourced } from "./provenance";

const WEBAPI_UNSET =
  "COSMOS_WEBAPI_BASE_URL is unset - this Center cannot reach the wearer's account";

/** Cosmos refused the write as malformed (400). */
export const ACCOUNT_WRITE_REFUSED = "Cosmos refused this change as invalid.";

/** Cosmos refused the write as longer than it keeps (413). */
export const ACCOUNT_WRITE_TOO_LONG = "This is longer than your account keeps.";

/** What the Details page may write. An empty string clears the field. */
export interface AccountDetailsWrite {
  preferredName: string;
  pronunciation: string;
}

/** A write Cosmos refused for a reason the wearer can act on, or `null`. */
function refusedWrite<T>(data: T, error: unknown): Sourced<T> | null {
  if (!(error instanceof CosmosHttpError)) return null;
  switch (error.status) {
    case 400:
      return { ...failed(data, ACCOUNT_WRITE_REFUSED, "empty"), refusal: "invalid" };
    case 413:
      return { ...failed(data, ACCOUNT_WRITE_TOO_LONG, "empty"), refusal: "too_large" };
    default:
      return null;
  }
}

function details(profile: ProfileDto): AccountDetails {
  const set = (value: string) => (value.trim() ? value : null);
  return {
    preferredName: set(profile.preferredName),
    pronunciation: set(profile.pronunciation),
    hasSecureBioData: profile.hasSecureBioData,
  };
}

/**
 * Settings → Details: the preferred name and pronunciation the Pin reads. First
 * and last name, username and sign-in factors belong to Keycloak, not here.
 */
export async function getAccountDetails(): Promise<
  Sourced<AccountDetails | null>
> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    return live(
      details(
        parseResponse(
          profileDtoSchema,
          await webapiGet("/account-service/profile"),
        ),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** The Details page's edit. Answers what Cosmos stored. */
export async function saveAccountDetails(
  input: AccountDetailsWrite,
): Promise<Sourced<AccountDetails | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing saved`);
  try {
    return live(
      details(
        parseResponse(
          profileDtoSchema,
          await webapiRequest("POST", "/account-service/profile", input),
        ),
      ),
    );
  } catch (error) {
    return refusedWrite(null, error) ?? failedWebapi(null, error);
  }
}

/**
 * Give an account with no preferred name the sign-in first name, before its
 * Pin is set up. Answers the account as it stands afterwards.
 *
 * The Pin asks for the name once, right after setup, to call itself
 * "<name>’s Ai Pin" over Bluetooth, and sets its `preferred_name_fetched` latch
 * whether or not a name came back (`AppController`): an account with no name
 * leaves the Pin called "’s Ai Pin" until a factory reset. humane.center showed
 * the first name as the preferred name until the wearer changed it. A name the
 * wearer set is never replaced.
 */
export async function defaultPreferredName(
  fullName: string,
  email: string,
): Promise<Sourced<AccountDetails | null>> {
  const current = await getAccountDetails();
  const name = fullName.trim();
  const firstName = name && name !== email ? name.split(/\s+/)[0] : "";
  if (current.state !== "live" || !current.data || current.data.preferredName || !firstName) {
    return current;
  }
  return saveAccountDetails({
    preferredName: firstName,
    pronunciation: current.data.pronunciation ?? "",
  });
}

/** The body of a Details write, or `null` when it is not two strings. */
export function parseAccountDetailsWrite(body: unknown): AccountDetailsWrite | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { preferredName, pronunciation } = body as Record<string, unknown>;
  if (typeof preferredName !== "string" || typeof pronunciation !== "string") return null;
  return { preferredName, pronunciation };
}

/** Food restrictions and daily intake goals. */
export async function getFoodPreferences(): Promise<
  Sourced<FoodPreferencesView | null>
> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    return live(
      parseResponse(
        foodPreferencesViewSchema,
        await webapiGet("/account-service/food-preferences"),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/**
 * Replace the restrictions, the goals, or both. A half left out is kept as it
 * is. Answers what Cosmos stored.
 */
export async function saveFoodPreferences(
  input: FoodPreferencesWrite,
): Promise<Sourced<FoodPreferencesView | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing saved`);
  try {
    return live(
      parseResponse(
        foodPreferencesViewSchema,
        await webapiRequest("POST", "/account-service/food-preferences", input),
      ),
    );
  } catch (error) {
    return refusedWrite(null, error) ?? failedWebapi(null, error);
  }
}

/** The body of a food-preferences write, or `null` when its shape is wrong. */
type FoodPreferencesWrite = {
  restrictions?: unknown[];
  dailyIntakeGoals?: unknown[];
};

export function parseFoodPreferencesWrite(
  body: unknown,
): FoodPreferencesWrite | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const { restrictions, dailyIntakeGoals, ...rest } = body as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) return null;
  if (restrictions !== undefined && !Array.isArray(restrictions)) return null;
  if (dailyIntakeGoals !== undefined && !Array.isArray(dailyIntakeGoals))
    return null;
  if (restrictions === undefined && dailyIntakeGoals === undefined) return null;
  // Cosmos validates every item. Center only forwards the two lists.
  const write: FoodPreferencesWrite = {};
  if (restrictions) write.restrictions = restrictions;
  if (dailyIntakeGoals) write.dailyIntakeGoals = dailyIntakeGoals;
  return write;
}

/**
 * What the food log adds up to between two ISO instants, against the daily
 * goals. Cosmos does the arithmetic from the same log the Pin reads. Center
 * only renders it. The day's bounds come from the caller, because only the
 * browser knows the wearer's local midnight.
 */
export async function getFoodIntake(
  startTime: string,
  endTime: string,
): Promise<Sourced<FoodIntake | null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  const query = new URLSearchParams({ startTime, endTime });
  try {
    return live(
      parseResponse(
        foodIntakeSchema,
        await webapiGet(`/account-service/food-intake?${query}`),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** The wearer's Pins: pairing, last reported status and block mode. */
export async function getDevices(): Promise<Sourced<DeviceAssignment[]>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  try {
    const { devices } = parseResponse(
      devicesSchema,
      await webapiGet("/device-assignments/devices"),
    );
    return live(devices);
  } catch (error) {
    return failedWebapi([], error);
  }
}

/**
 * Block mode on (the wearer marked the Pin lost) or off. Cosmos then refuses
 * every call from that Pin with the stock `unauthorized-device` trailer, which
 * locks it. Turning it off lets the Pin's next call through, which unlocks it.
 */
export async function setDeviceBlocked(
  deviceId: string,
  blocked: boolean,
): Promise<Sourced<DeviceBlock | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing changed`);
  try {
    return live(
      parseResponse(
        deviceBlockSchema,
        await webapiRequest(
          blocked ? "POST" : "DELETE",
          `/device-assignments/devices/${encodeURIComponent(deviceId)}/block`,
        ),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** Cosmos refused the pairing because another account holds this Pin (409). */
export const PIN_PAIRED_ELSEWHERE =
  "This Pin is paired to another account. Its owner has to remove it first.";

/**
 * Pair a Pin to the signed-in wearer's own account: Cosmos takes the account
 * from the wearer's identity, never from Center. A Pin another account holds is
 * refused. Stock sent a new owner to support "to unlink it from your account".
 */
export async function pairDevice(
  deviceId: string,
): Promise<Sourced<DevicePairing | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing paired`);
  try {
    return live(
      parseResponse(
        devicePairingSchema,
        await webapiRequest("POST", "/device-assignments/devices", {
          deviceId,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof CosmosHttpError && error.status === 409) {
      return {
        ...failed(null, PIN_PAIRED_ELSEWHERE, "empty"),
        refusal: "conflict",
      };
    }
    return refusedWrite(null, error) ?? failedWebapi(null, error);
  }
}

/** Release one of the wearer's own Pins. `removed: false` when it was not theirs. */
export async function unpairDevice(
  deviceId: string,
): Promise<Sourced<DeviceUnpairing | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing changed`);
  try {
    return live(
      parseResponse(
        deviceUnpairingSchema,
        await webapiRequest(
          "DELETE",
          `/device-assignments/devices/${encodeURIComponent(deviceId)}`,
        ),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** Whether the wearer has set the passcode their Pin asks for during setup. */
export async function getPasscodeState(): Promise<
  Sourced<PasscodeState | null>
> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    return live(
      parseResponse(
        passcodeStateSchema,
        await webapiGet("/account-service/passcode"),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** A Pin passcode: exactly four digits, what the Pin's setup screen takes. */
export function isPasscode(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}$/u.test(value);
}

/**
 * Set or change the Pin passcode. Cosmos keeps only an OPAQUE password file
 * made from it. The old passcode stops working at once, and a Pin already set
 * up keeps its lock-screen code until its next setup.
 */
export async function setPasscode(
  passcode: string,
): Promise<Sourced<PasscodeState | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing saved`);
  try {
    return live(
      parseResponse(
        passcodeStateSchema,
        await webapiRequest("PUT", "/account-service/passcode", { passcode }),
      ),
    );
  } catch (error) {
    return refusedWrite(null, error) ?? failedWebapi(null, error);
  }
}

/**
 * Cosmos refused the deletion because one of the account's Pins is in block
 * mode (409): deleting the account would lift the block and unlock that Pin.
 */
export const LOST_PIN_BLOCKS_DELETION =
  "Unmark your lost Pin first. An account can’t be deleted while one of its Pins is in block mode, because deleting it would unlock that Pin. Turn block mode off in Settings → My Ai Pin, then delete.";

/**
 * Delete everything Cosmos holds for the signed-in wearer: notes, captures and
 * their files, events, contacts, account settings, escrowed keys, Pin
 * pairings and the passcode. Answers Cosmos's own `deleted`.
 */
export async function deleteAccount(): Promise<
  Sourced<{ deleted: boolean } | null>
> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", `${WEBAPI_UNSET}; nothing deleted`);
  try {
    return live(
      parseResponse(
        deletedSchema,
        await webapiRequest("DELETE", "/account-service/account", {
          confirm: "DELETE",
        }),
      ),
    );
  } catch (error) {
    if (error instanceof CosmosHttpError && error.status === 409) {
      return {
        ...failed(null, LOST_PIN_BLOCKS_DELETION, "empty"),
        refusal: "conflict",
      };
    }
    return failedWebapi(null, error);
  }
}
