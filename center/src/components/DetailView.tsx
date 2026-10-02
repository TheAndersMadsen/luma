"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "./views.module.css";
import buttons from "./buttons.module.css";
import { SessionExpiredClause, StatusMessage } from "./Status";
import { Downvote, ForgetData, Upvote } from "@/icons";

/**
 * The My Data detail views (Ai Mic, Calls, Music, Translation) rendered over a
 * dialog-style background with a back button and centred title.
 *
 * Not wrapped in the Shell: this is the whole page, a <main> with only the back
 * button, so the Shell's "Sign in" badge is not on screen here. A view that
 * cannot read because the session expired links to sign-in itself
 * (`DomainView`). Every recovered testid (`dialog-background`, `top-toolbar-*`,
 * `top-back-button`, `table-row`) stays exactly where it was.
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

/** The rating Cosmos holds for an Ai Mic answer. */
type Vote = "up" | "down";

/** A row action that did not happen; `reauthenticate` is the route's typed flag. */
interface RowNotice {
  text: string;
  reauthenticate: boolean;
}

export function DataRow({
  uuid,
  eventIds,
  icon,
  primary,
  secondary,
  timestamp,
  votable = false,
  vote = null,
  onForgotten,
  onVoted,
}: {
  /** The NotableEvent's own identifier, what `DELETE /notable-events/event/{id}` is scoped by. */
  uuid: string;
  /**
   * Every event this row stands for, when it stands for several (a call:
   * Cosmos pairs the event that ended it with the one that started it).
   * Forget erases them all.
   */
  eventIds?: string[];
  icon: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  timestamp: string;
  votable?: boolean;
  /** The wearer's current vote on this answer, `null` when they gave none. */
  vote?: Vote | null;
  /**
   * Called ONLY after cosmos confirms the row is gone, so the list can drop it.
   * Required, not optional: a Forget that deletes server-side and leaves the row
   * on screen is the same lie in the other direction.
   */
  onForgotten: (uuid: string) => void | Promise<void>;
  /** Called after Cosmos stored a vote, so the list can re-read it. */
  onVoted?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  /** Set only when the row is STILL THERE, and says why. */
  const [notice, setNotice] = useState<RowNotice | null>(null);
  /** The vote on screen: Cosmos's, until the wearer changes it. */
  const [shownVote, setShownVote] = useState<Vote | null>(vote);
  const [voting, setVoting] = useState(false);
  useEffect(() => setShownVote(vote), [vote]);

  /**
   * Forget → confirm, then DELETE the event for real, every event the row
   * stands for.
   *
   * The BFF answers with a `degraded` clause whenever it accepted the request
   * and deleted NOTHING, cosmos unconfigured, cosmos silent, or cosmos truthfully
   * reporting that no such event is this account's. In every one of those
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
    const ids = eventIds && eventIds.length > 0 ? eventIds : [uuid];
    let forgotten = 0;
    try {
      for (const id of ids) {
        const res = await fetch(`/api/notable-events/mydata/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          degraded?: string;
          note?: string;
          reauthenticate?: boolean;
        };
        const explanation = body.degraded ?? body.note;

        if (!res.ok || body.ok === false || explanation) {
          const reauthenticate = body.reauthenticate === true;
          setNotice({
            text:
              forgotten > 0
                ? "Only part of this entry was deleted."
                : "Nothing was deleted — this entry is still here.",
            reauthenticate,
          });
          setBusy(false);
          return;
        }
        forgotten += 1;
      }

      // Confirmed gone. Stay busy: this row is on its way out of the list and
      // must not take a second click on the way.
      await onForgotten(uuid);
    } catch {
      setNotice({
        text:
          forgotten > 0
            ? "Only part of this entry was deleted."
            : "Nothing was deleted — this entry is still here.",
        reauthenticate: false,
      });
      setBusy(false);
    }
  }

  /**
   * Up or down → Cosmos stores it beside the event. Pressing the same vote
   * again withdraws it. The thumb shows the new vote only once Cosmos has it.
   */
  async function castVote(next: Vote) {
    if (voting) return;
    const withdraw = shownVote === next;
    setVoting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/notable-events/mydata/${encodeURIComponent(uuid)}/feedback`, {
        method: withdraw ? "DELETE" : "POST",
        headers: withdraw ? undefined : { "content-type": "application/json" },
        body: withdraw ? undefined : JSON.stringify({ vote: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; vote?: Vote | null };
      if (!res.ok || body.ok !== true) {
        setNotice({ text: "Your vote wasn’t saved.", reauthenticate: res.status === 401 });
        return;
      }
      setShownVote(body.vote ?? null);
      await onVoted?.();
    } catch {
      setNotice({ text: "Your vote wasn’t saved.", reauthenticate: false });
    } finally {
      setVoting(false);
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
            Actions sit under the text: votes left, Forget pushed right. Keep
            the recovered testids/structure.
          */}
          <div className={styles.buttons}>
            {votable ? (
              <div className={styles.voteGroup}>
                <button
                  className={styles.myDataRowButton}
                  data-testid="upvote-button"
                  aria-label="Upvote"
                  aria-pressed={shownVote === "up"}
                  type="button"
                  title={shownVote === "up" ? "Remove your upvote" : "Upvote this answer"}
                  onClick={() => castVote("up")}
                  disabled={voting || busy}
                >
                  <Upvote size={15} />
                </button>
                <button
                  className={styles.myDataRowButton}
                  data-testid="downvote-button"
                  aria-label="Downvote"
                  aria-pressed={shownVote === "down"}
                  type="button"
                  title={shownVote === "down" ? "Remove your downvote" : "Downvote this answer"}
                  onClick={() => castVote("down")}
                  disabled={voting || busy}
                >
                  <Downvote size={15} />
                </button>
              </div>
            ) : null}
            <button
              className={`${styles.myDataRowButton} ${styles.forgetButton}`}
              aria-label="Forget this entry"
              type="button"
              title="Forget this entry"
              onClick={forget}
              disabled={busy}
            >
              <ForgetData size={17} />
            </button>
          </div>

          {/* Sits under the control that produced it, in the failure colour,
              never in the caption grey the row's own text uses. */}
          {notice ? (
            <StatusMessage tone="warning" inline>
              {notice.text}
              {notice.reauthenticate ? (
                <SessionExpiredClause onReconnected={() => setNotice(null)} />
              ) : (
                " Try again."
              )}
            </StatusMessage>
          ) : null}
        </div>

        <span className={styles.contentDate}>{timestamp}</span>
      </div>
    </div>
  );
}
