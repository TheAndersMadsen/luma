/*
 * /admin/pairings, the operator releases a Pin's pairing.
 *
 * A wearer pairs and releases only their own Pins, and Cosmos refuses to pair a
 * Pin another account holds. When a Pin id is paired to the wrong account, its
 * owner gets a conflict and has no way out, so the operator releases it here;
 * stock sent that case to support. `isOperatorPath` covers /admin, so
 * middleware refuses everyone else first, and the page and its action decide
 * the operator gate again from the session. A plain form posts the action, so
 * the page works without JavaScript.
 *
 * A Pin in lost-device block mode shows it, and its release needs the
 * operator's explicit confirmation: released, another account could pair it
 * and set it up without block mode. A Pin whose block state Cosmos could not
 * read is treated the same way. Cosmos refuses an unconfirmed release.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";

import { StatusMessage } from "@/components/Status";
import {
  operatorPinPairings,
  releasePinPairing,
  requireOperatorSession,
  type PinPairingRelease,
} from "@/server/operator";
import styles from "./pairings.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pin pairings",
  robots: { index: false, follow: false },
};

const PAIRINGS_PATH = "/admin/pairings";

const OUTCOMES: Record<PinPairingRelease, { tone: "info" | "warning" | "danger"; text: string }> = {
  released: {
    tone: "info",
    text: "Released. The Pin's owner can now pair it to their account and set it up again.",
  },
  "not-paired": { tone: "info", text: "That Pin was not paired to any account." },
  blocked: {
    tone: "warning",
    text:
      "That Pin is in block mode, or its block mode could not be read, so nothing was changed. " +
      "To release it anyway, tick the confirmation beside it and release it again.",
  },
  invalid: { tone: "danger", text: "That is not a Pin's device ID." },
  forbidden: { tone: "danger", text: "Operator access required." },
  unconfigured: {
    tone: "warning",
    text: "Pin pairings are not available here: this Center has no COSMOS_ADMIN_TOKEN.",
  },
  unavailable: { tone: "warning", text: "Cosmos did not answer. Nothing was changed; try again." },
};

async function releasePairing(formData: FormData) {
  "use server";
  const session = await requireOperatorSession(PAIRINGS_PATH);
  const deviceId = formData.get("deviceId");
  const confirmBlocked = formData.get("confirmBlocked") === "yes";
  const outcome = await releasePinPairing(session, typeof deviceId === "string" ? deviceId : "", confirmBlocked);
  redirect(`${PAIRINGS_PATH}?outcome=${outcome}`);
}

function isoDay(epoch: number | null): string | null {
  if (epoch === null) return null;
  const date = new Date(epoch * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export default async function PinPairingsPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string | string[] }>;
}) {
  const session = await requireOperatorSession(PAIRINGS_PATH);
  const [roster, params] = await Promise.all([operatorPinPairings(session), searchParams]);
  const outcome = typeof params.outcome === "string" && Object.hasOwn(OUTCOMES, params.outcome)
    ? OUTCOMES[params.outcome as PinPairingRelease]
    : null;

  return (
    <main className={styles.page}>
      <Link href="/settings/pin/provision" className={styles.back}>Back to Pin activation</Link>
      <h1 className={styles.title}>Pin pairings</h1>
      <p className={styles.intro}>
        Each Pin sets up into the account it is paired to. Wearers pair and remove their own
        Pins; a Pin paired to another account can&rsquo;t be paired again until that account
        removes it. When a Pin is paired to the wrong account, release it here so its owner
        can pair it and set it up.
      </p>
      {outcome ? <StatusMessage tone={outcome.tone}>{outcome.text}</StatusMessage> : null}
      <section className={styles.roster} aria-label="Paired Pins">
        {roster.state !== "live" ? (
          <p className={styles.empty}>
            {roster.state === "unconfigured"
              ? OUTCOMES.unconfigured.text
              : roster.state === "forbidden"
                ? OUTCOMES.forbidden.text
                : "The pairing roster could not be read. Try again."}
          </p>
        ) : roster.pairings.length === 0 ? (
          <p className={styles.empty}>No Pin is paired to an account.</p>
        ) : (
          roster.pairings.map((pairing) => {
            const since = isoDay(pairing.pairedAtEpoch);
            const blockedSince = isoDay(pairing.blockedAtEpoch);
            const blockState = pairing.blocked === true
              ? `Block mode is on${blockedSince ? ` since ${blockedSince}` : ""}: its owner marked it lost.`
              : pairing.blocked === null
                ? "Cosmos could not read whether this Pin is in block mode."
                : null;
            return (
              <form key={pairing.deviceId} className={styles.row} action={releasePairing}>
                <div className={styles.pin}>
                  <span className={styles.deviceId}>{pairing.deviceId}</span>
                  <span className={styles.account}>
                    Account {pairing.accountSub}
                    {since ? `, paired ${since}` : ""}
                  </span>
                  {blockState ? (
                    <span className={styles.blocked}>
                      {blockState} Releasing a blocked Pin lets another account pair it and set
                      it up without block mode.
                    </span>
                  ) : null}
                </div>
                <input type="hidden" name="deviceId" value={pairing.deviceId} />
                {pairing.blocked !== false ? (
                  <label className={styles.confirm}>
                    <input type="checkbox" name="confirmBlocked" value="yes" required />
                    Release it anyway
                  </label>
                ) : null}
                <button type="submit" className={styles.release}>
                  Release pairing
                </button>
              </form>
            );
          })
        )}
      </section>
    </main>
  );
}
