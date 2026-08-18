"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { CardsSkeleton, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import shell from "@/components/shell.module.css";
import styles from "@/components/views.module.css";
import { BackIcon, ForgetData } from "@/icons";
import { useNotes } from "@/lib/queries";
import { formatTimestamp } from "@/lib/format";

/**
 * Note detail.
 *
 * Humane's docs describe a "…" menu containing Delete. The menu is gone and its
 * one implementable item is here as a control of its own: Edit has no backend
 * (there is no note-update RPC in the recovered protos and no webapi route for
 * one), so a "…" would have opened onto a single entry — and until the clone's
 * webapi grew `DELETE /notes/:uuid` it opened onto nothing at all. The delete
 * lives in this page's OWN fixed header rather than the Shell toolbar, for the
 * same reason DetailView puts the backend badge there: that header is fixed on
 * top of the Shell's, so anything in the toolbar behind it is unclickable.
 */
export default function NoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading, isError, refetch } = useNotes();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  /** Set only when the note is STILL THERE, and says why. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Set the moment cosmos confirms the delete. The note leaves the cache before
   * this page unmounts, and without this the "Note not found" branch below would
   * fire on the way out — an error screen shown to a wearer whose delete just
   * worked.
   */
  const [deleted, setDeleted] = useState(false);

  /**
   * Delete → confirm, then DELETE this note for real.
   *
   * Same contract and same check as the captures Forget: the BFF answers with a
   * `degraded` clause whenever it accepted the request and deleted NOTHING, on a
   * 200 as much as a 502. When that clause is present the note stays, this page
   * stays, and the sentence says why — it is never treated as a delete.
   */
  async function forget() {
    if (busy) return;
    if (
      !window.confirm("Delete this note? This permanently deletes it — it can't be undone.")
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/capture/notes/${encodeURIComponent(id)}`, {
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
            ? "Nothing was deleted — this note is still here. Sign in again, then try."
            : "Nothing was deleted — this note is still here. Try again.",
        );
        setBusy(false);
        return;
      }

      // A five-second notes poll may already be in flight. Cancel it before the
      // cache edit, or its stale pre-delete response can put this row straight
      // back after Cosmos has confirmed the delete.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["notes"] }),
        queryClient.cancelQueries({ queryKey: ["memories-dashboard"] }),
      ]);
      setDeleted(true);
      // Drop it from the grid's cache so /notes does not paint the note we just
      // deleted, then invalidate: the next read comes from cosmos, so a note that
      // somehow survived comes back rather than being hidden by this edit. The
      // Memories dashboard carries its own copy of the notes list.
      queryClient.setQueryData<{ data: Array<{ uuid: string }> }>(["notes"], (prev) =>
        prev ? { ...prev, data: prev.data.filter((n) => n.uuid !== id) } : prev,
      );
      router.push("/notes");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notes"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["memories-dashboard"], refetchType: "all" }),
      ]);
    } catch {
      setNotice("Couldn't delete this note. Nothing was deleted. Try again.");
      setBusy(false);
    }
  }

  const header = (
    <div className={styles.detailHeader}>
      <div data-testid="top-toolbar-left">
        <div data-testid="top-back-button">
          <Link href="/notes" aria-label="Back to Notes">
            <span className={buttons.circularButton}>
              <BackIcon size={20} />
            </span>
          </Link>
        </div>
      </div>
      <div />
      <div className={shell.right} data-testid="top-toolbar-right">
        <button
          className={buttons.circularButton}
          type="button"
          aria-label="Delete note"
          title="Delete this note"
          onClick={forget}
          disabled={busy}
        >
          <ForgetData size={17} />
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <Shell showNav={false}>
        {header}
        <div className={styles.pageContainer}>
          <CardsSkeleton count={1} />
        </div>
      </Shell>
    );
  }

  const note = data?.data.find((n) => n.uuid === id);

  /*
   * A note we could not READ is not a note that is GONE.
   *
   * This page resolves the note out of the notes LIST, and that list answers a
   * plain 200 with an empty page whenever the read merely failed: the webapi
   * went quiet, or the wearer's Keycloak grant died behind a still-valid Center
   * cookie. `isError` is false in both cases and `find()` returns undefined, so
   * the not-found arm below used to fire and tell the wearer "Note not found —
   * It may have been deleted." That is a positive claim that the wearer's own
   * writing is gone, made at the exact moment Center knew least, about a note
   * that was sitting intact on the backend.
   *
   * Two things make it worse here than anywhere else in the app. The list polls
   * every five seconds, so a wearer who was simply READING their note watched it
   * be replaced by "it may have been deleted" without touching anything. And
   * this page renders <Shell showNav={false}>, which suppresses <SourceBadge> —
   * the one piece of chrome that would have said "your Pin couldn't be reached"
   * is switched off on precisely the screen that makes the deletion claim, so
   * the false sentence was the only thing on the wearer's screen.
   *
   * So the list's own state chooses the sentence, the way /notes and
   * /notes/search already do: only a LIVE list is evidence that a note is not
   * there. `deleted` is excluded for the same reason it is excluded below — a
   * delete we just confirmed is not a failed read.
   */
  if (!isError && !deleted && !note && data && data.state !== "live") {
    return (
      <Shell showNav={false}>
        {header}
        <div className={styles.pageContainer}>
          {data.reauthenticate ? (
            /* The one degraded cause the wearer can clear themselves, and the
               only one where reloading does nothing: the Center cookie is still
               valid, so nothing redirects them. */
            <StatusMessage tone="warning">
              Your session expired, so this note couldn&rsquo;t be loaded. It has not been
              deleted. <Link href="/login">Sign in again</Link> to read it.
            </StatusMessage>
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              This note couldn&rsquo;t be loaded. It has not been deleted.
            </StatusMessage>
          ) : (
            /* Absent: nothing is configured to answer, which no retry can fix. */
            <StatusMessage tone="info">
              Connect your Pin to open this note.
            </StatusMessage>
          )}
        </div>
      </Shell>
    );
  }

  // `deleted` is excluded deliberately: a note that is missing because we just
  // deleted it is not a note that could not be found.
  if (isError || (!note && !deleted)) {
    return (
      <Shell showNav={false}>
        {header}
        <div className={styles.pageContainer}>
          <ErrorState
            title="Note not found"
            detail="It may have been deleted, or this id doesn't exist in the current data source."
            onRetry={() => refetch()}
          />
        </div>
      </Shell>
    );
  }

  // Deleted, and the router is on its way to /notes. Nothing left to render.
  if (!note) {
    return (
      <Shell showNav={false}>
        {header}
        <div className={styles.pageContainer}>
          <CardsSkeleton count={1} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell showNav={false}>
      {header}
      <div className={styles.pageContainer}>
        {notice ? <StatusMessage tone="warning">{notice}</StatusMessage> : null}
        <article className={styles.notePage}>
          {/* A sealed note carries no title and an empty body, so opening one
              from the /notes grid used to land on a page holding nothing but a
              date — the list said "Encrypted note" and its own detail page
              contradicted it. Same sentence as the grid, which is the reference. */}
          {note.data.note.sealed ? (
            <>
              <h1 className={styles.notePageTitle}>Encrypted note</h1>
              <p className={styles.notePageText}>
                Sealed under the wearer&rsquo;s channel key. The dashboard holds no key
                material, so this note cannot be read here.
              </p>
            </>
          ) : (
            <>
              {note.data.note.title ? (
                <h1 className={styles.notePageTitle}>{note.data.note.title}</h1>
              ) : null}
              <p className={styles.notePageText}>{note.data.note.text}</p>
            </>
          )}
          <span className={styles.notePageDate}>
            {formatTimestamp(note.userLastModified ?? note.userCreatedAt)}
          </span>
        </article>
      </div>
    </Shell>
  );
}
