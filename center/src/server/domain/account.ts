/*
 * Account details — Settings -> Details, over the stock gRPC account service.
 */

import { CARRY_ENABLED, Services, call } from "../cosmos";
import { failedGrpc, live, unconfigured, type Sourced } from "./provenance";

export interface AccountDetails {
  /** From AccountInfo — the only personal fields this backend actually holds. */
  preferredName: string | null;
  pronunciation: string | null;
  /** True when the wearer has sealed bio data we hold no key for. */
  hasSecureBioData: boolean;
}

/**
 * Settings -> Details.
 *
 * `UserInformationService.GetUserPersonalDetails` returns `AccountInfo`, which
 * carries exactly two fields: preferred name and pronunciation. .Center also
 * showed first/last name, username and MFA, but those came from the account
 * service (Keycloak), not from this API — so they have no source here and the
 * page says so rather than inventing a name.
 */
export async function getAccountDetails(): Promise<Sourced<AccountDetails | null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty", "carry not configured");
  try {
    const res = await call<
      Record<string, never>,
      {
        accountInfo?: { preferredName?: string; pronunciation?: string };
        secureBioData?: { data?: Uint8Array | string };
      }
    >(Services.account, "GetUserPersonalDetails", {});

    const info = res.accountInfo ?? {};
    const trimmed = (v?: string) => (v && v.trim().length > 0 ? v : null);
    return live({
      preferredName: trimmed(info.preferredName),
      pronunciation: trimmed(info.pronunciation),
      hasSecureBioData: Boolean(res.secureBioData?.data),
    });
  } catch (error) {
    return failedGrpc(null, error);
  }
}
