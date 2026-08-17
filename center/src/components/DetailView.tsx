"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./views.module.css";
import buttons from "./buttons.module.css";
import { ABSENT_TITLE, absentControlClass, StatusMessage } from "./Status";
import { Downvote, ForgetData, Upvote } from "@/icons";

/**
 * The My Data detail views (Ai Mic, Calls, Music, Translation) rendered over a
 * dialog-style background with a back button and centred title.
 *
 * Wrapped in the Shell (nav hidden, exactly as the capture and note detail
 * routes already do) so these four routes stop being trapdoors: they were a
 * bare <div> with nothing but a back arrow — no bottom system bar, no account
 * menu, no Ai Mic. Every recovered testid (`dialog-background`,
 * `top-toolbar-*`, `top-back-button`, `table-row`) stays exactly where it was,
 * inside the wrapped subtree.
 */
export function DetailView({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);

  function close() {
    if (closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      router.push("/my-data");
      return;
    }
    setClosing(true);
    window.setTimeout(() => router.push("/my-data"), 180);
  }

  return (
    <main
      className={`${styles.detailOverlay} ${closing ? styles.detailOverlayClosing : ""}`}
      data-testid="dialog-background"
    >
      <header className={styles.detailHeader}>
        <span aria-hidden />
        <h1 className={styles.detailTitle}>{title}</h1>
        <button
          type="button"
          aria-label="Close and return to My Data"
          data-testid="top-back-button"
          className={`${buttons.circularButton} ${styles.detailClose}`}
          onClick={close}
          disabled={closing}
        >
          <CloseIcon />
        </button>
      </header>

      <div className={styles.detailContent}>
        <div className={styles.myDataRows}>{children}</div>
      </div>
    </main>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function DataRow({
  uuid,
  icon,
  primary,
  secondary,
  timestamp,
  votable = false,
  onForgotten,
}: {
  /** The NotableEvent's own identifier — what `DELETE /event/:id` is scoped by. */
  uuid: string;
  icon: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  timestamp: string;
  votable?: boolean;
  /**
   * Called ONLY after carry confirms the row is gone, so the list can drop it.
   * Required, not optional: a Forget that deletes server-side and leaves the row
   * on screen is the same lie in the other direction.
   */
  onForgotten: (uuid: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  /** Set only when the row is STILL THERE, and says why. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Forget → confirm, then DELETE the event for real.
   *
   * The BFF answers with a `degraded` clause whenever it accepted the request
   * and deleted NOTHING — carry unconfigured, carry silent, or carry truthfully
   * reporting that no such event is this account's (which is exactly what
   * pressing this on recovered sample data looks like). In every one of those
   * cases the row stays and the sentence below says so. Same contract, same
   * check, as the captures Forget.
   */
  async function forget() {
    if (busy) return;
    if (
      !window.confirm("Forget this entry? This permanently deletes it — it can't be undone.")
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/notable-events/mydata/${encodeURIComponent(uuid)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        degraded?: string;
        note?: string;
      };
      const explanation = body.degraded ?? body.note;

      if (!res.ok || body.ok === false || explanation) {
        setNotice(
          explanation && /session expired|sign in/i.test(explanation)
            ? "Nothing was deleted — this entry is still here. Sign in again, then try."
            : "Nothing was deleted — this entry is still here. Try again.",
        );
        setBusy(false);
        return;
      }

      // Confirmed gone. Stay busy: this row is on its way out of the list and
      // must not take a second click on the way.
      await onForgotten(uuid);
    } catch {
      setNotice("Couldn't forget this entry. Nothing was deleted. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.myDataRow} data-testid="table-row">
      <div className={styles.iconWrap}>{icon}</div>

      <div className={styles.content}>
        <div className={styles.contentColumn}>
          <span className={styles.rowRequest}>{primary}</span>
          {secondary ? <span className={styles.rowResponse}>{secondary}</span> : null}

          {/*
            Actions sit under the text: votes left, Forget pushed right.

            The VOTES stay disabled, and for the original reason: there is no
            feedback RPC anywhere in the recovered protos, so a live-looking
            thumb would silently do nothing. They say it in the app's ONE
            sentence for absence ("Not in this backend.") with the shared reduced
            opacity.

            FORGET is no longer one of them. It was disabled because events.proto
            exposes only QueryEvents / IngestBatch / Ingest and there was nothing
            to call; the clone's webapi now serves `DELETE /event/:id`, so the
            control does what it says. Keep the recovered testids/structure.
          */}
          <div className={styles.buttons}>
            {votable ? (
              <div className={styles.voteGroup}>
                <button
                  className={`${styles.myDataRowButton} ${absentControlClass}`}
                  data-testid="upvote-button"
                  aria-label="Upvote"
                  type="button"
                  disabled
                  title={ABSENT_TITLE}
                >
                  <Upvote size={15} />
                </button>
                <button
                  className={`${styles.myDataRowButton} ${absentControlClass}`}
                  data-testid="downvote-button"
                  aria-label="Downvote"
                  type="button"
                  disabled
                  title={ABSENT_TITLE}
                >
                  <Downvote size={15} />
                </button>
              </div>
            ) : null}
            <button
              className={`${styles.myDataRowButton} ${styles.forgetButton}`}
              aria-label="Forget"
              type="button"
              title="Forget this entry"
              onClick={forget}
              disabled={busy}
            >
              <ForgetData size={17} />
            </button>
          </div>

          {/* Sits under the control that produced it, in the failure colour —
              never in the caption grey the row's own text uses. */}
          {notice ? (
            <StatusMessage tone="warning" inline>
              {notice}
            </StatusMessage>
          ) : null}
        </div>

        <span className={`${styles.contentDate} ${styles.hideOnMobile}`}>{timestamp}</span>
      </div>
    </div>
  );
}
