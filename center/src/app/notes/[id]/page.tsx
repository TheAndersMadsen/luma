"use client";

import { SessionReconnect } from "@/components/SessionReconnect";
import { Shell } from "@/components/Shell";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { SessionExpiredClause, StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import buttons from "@/components/buttons.module.css";
import shell from "@/components/shell.module.css";
import styles from "@/components/views.module.css";
import { BackIcon, ForgetData, NotesEmptyIcon } from "@/icons";
import type { CosmosNoteDto, NoteRecord } from "@/lib/contracts/notes";
import { formatTimestamp } from "@/lib/format";
import { mapCosmosNote } from "@/lib/noteMapping";
import { useNote } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import notes from "../notes.module.css";

/** What the note write routes answer (see api/capture/note/noteWriteResponse.ts). */
interface WriteAnswer {
  ok?: boolean;
  note?: CosmosNoteDto;
  reauthenticate?: boolean;
  tooLong?: boolean;
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" aria-hidden>
      <path
        d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden>
      <path
        d="M5 12.5L10 17.5L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Note detail: read, edit (the recovered `editNote`, `POST /capture/note/{uuid}`)
 * and delete one note.
 *
 * The note is read by its uuid, so a note on any page of /notes opens here.
 * The controls live in this page's OWN fixed header rather than the Shell
 * toolbar, for the same reason DetailView puts the backend badge there: that
 * header is fixed on top of the Shell's, so anything in the toolbar behind it
 * is unclickable.
 */
export default function NoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading, isError, refetch } = useNote(id);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  /** Set only when the note is STILL as it was, and says why. */
  const [notice, setNotice] = useState<{ text: string; reauthenticate: boolean } | null>(null);
  /** The draft while editing; `null` while reading. */
  const [draft, setDraft] = useState<{ title: string; text: string } | null>(null);
  /**
   * Set the moment Cosmos confirms the delete, so the "Note not found" branch
   * below never fires on the way out to /notes for a delete that just worked.
   */
  const [deleted, setDeleted] = useState(false);

  const note = data?.data ?? undefined;
  const dirty = draft !== null && (
    draft.title !== (data?.titleGenerated ? "" : (note?.data.note.title ?? "")) ||
    draft.text !== (note?.data.note.text ?? "")
  );

  /** Every copy of the notes list, and the dashboard's, re-read from Cosmos. */
  async function refreshLists() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notes"], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["memories-dashboard"], refetchType: "all" }),
    ]);
  }

  /**
   * Save the draft. The route answers `ok: true` only when Cosmos stored the
   * edit. Anything else leaves the note as it was, and the sentence says why.
   */
  async function save() {
    if (busy || !draft) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/capture/note/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A blank body is the recovered client's "New note.", which Cosmos applies.
        body: JSON.stringify({
          title: draft.title.trim() ? draft.title : null,
          text: draft.text.trim() ? draft.text : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as WriteAnswer;
      if (!res.ok || !body.ok || !body.note) {
        const reauthenticate = body.reauthenticate === true;
        setNotice({
          text: reauthenticate
            ? "Nothing was saved. Your changes are still here."
            : body.tooLong
              ? "This note is too long to save. Shorten it, then save again."
              : res.status === 404
                ? "This note no longer exists."
                : "Nothing was saved. Try again.",
          reauthenticate,
        });
        return;
      }
      const saved = body.note;
      queryClient.setQueryData<{ data: NoteRecord | null; titleGenerated: boolean }>(
        ["note", id],
        (prev) =>
          prev
            ? { ...prev, data: mapCosmosNote(saved), titleGenerated: saved.titleGenerated === true }
            : prev,
      );
      setDraft(null);
      await refreshLists();
    } catch {
      setNotice({ text: "Nothing was saved. Try again.", reauthenticate: false });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Delete → confirm, then DELETE this note for real.
   *
   * Same contract and same check as the captures Forget: the BFF answers with a
   * `degraded` clause whenever it accepted the request and deleted NOTHING, on a
   * 200 as much as a 502. When that clause is present the note stays, this page
   * stays, and the sentence says why, it is never treated as a delete.
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
        reauthenticate?: boolean;
      };
      const explanation = body.degraded ?? body.note;

      if (!res.ok || body.ok === false || explanation) {
        const reauthenticate = body.reauthenticate === true;
        setNotice({
          text: reauthenticate
            ? "Nothing was deleted — this note is still here."
            : "Nothing was deleted — this note is still here. Try again.",
          reauthenticate,
        });
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
      // Drop it from every cached page so /notes does not paint the note we just
      // deleted, then invalidate: the next read comes from Cosmos, so a note that
      // somehow survived comes back rather than being hidden by this edit.
      queryClient.setQueriesData<{ data: NoteRecord[] }>({ queryKey: ["notes"] }, (prev) =>
        prev ? { ...prev, data: prev.data.filter((n) => n.uuid !== id) } : prev,
      );
      queryClient.removeQueries({ queryKey: ["note", id] });
      router.push("/notes");
      await refreshLists();
    } catch {
      setNotice({ text: "Nothing was deleted — this note is still here. Try again.", reauthenticate: false });
      setBusy(false);
    }
  }

  const editable = note && !note.data.note.sealed;
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
        {draft ? (
          <>
            <button
              className={buttons.circularButton}
              type="button"
              aria-label="Cancel editing"
              title="Cancel"
              onClick={() => {
                if (dirty && !window.confirm("Discard your changes to this note?")) return;
                setDraft(null);
                setNotice(null);
              }}
              disabled={busy}
            >
              <span aria-hidden>✕</span>
            </button>
            <button
              className={`${buttons.circularButton} ${buttons.circularButtonAccent}`}
              type="button"
              aria-label="Save note"
              title="Save"
              onClick={save}
              disabled={busy || !dirty}
            >
              <CheckIcon />
            </button>
          </>
        ) : (
          <>
            {editable ? (
              <button
                className={buttons.circularButton}
                type="button"
                aria-label="Edit note"
                title="Edit this note"
                onClick={() => {
                  setNotice(null);
                  // A derived heading is offered as the placeholder, not as a
                  // title: saving without typing one keeps it derived.
                  setDraft({
                    title: data?.titleGenerated ? "" : (note.data.note.title ?? ""),
                    text: note.data.note.text,
                  });
                }}
                disabled={busy}
              >
                <PencilIcon />
              </button>
            ) : null}
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
          </>
        )}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <Shell showNav={false} showTopBar={false}>
        {header}
        <div className={styles.pageContainer}>
          <CardsSkeleton count={1} />
        </div>
      </Shell>
    );
  }

  /*
   * A note we could not READ is not a note that is GONE.
   *
   * The route answers a plain 200 with no note whenever the read merely failed:
   * Cosmos went quiet, or the wearer's Keycloak grant died behind a still-valid
   * Center cookie. `isError` is false in both cases, so only the read's own
   * state may decide between "gone" and "not loaded". And this page renders
   * <Shell showNav={false} showTopBar={false}>, which suppresses <SourceBadge>, so the sentence
   * below is the only thing on screen that can say which it was.
   *
   * Only a LIVE read is evidence that a note is not there. `deleted` is
   * excluded for the same reason it is excluded below, a delete we just
   * confirmed is not a failed read.
   */
  if (!isError && !deleted && !note && data && data.state !== "live") {
    return (
      <Shell showNav={false} showTopBar={false}>
        {header}
        <div className={styles.pageContainer}>
          {data.reauthenticate ? (
            /* The one degraded cause the wearer can clear themselves, and the
               only one where reloading does nothing: the Center cookie is still
               valid, so nothing redirects them. */
            <StatusMessage tone="warning">
              Your session expired, so this note couldn&rsquo;t be loaded. It has not been
              deleted. <SessionReconnect /> to read it.
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
  if (isError) {
    return (
      <Shell showNav={false} showTopBar={false}>
        {header}
        <div className={styles.pageContainer}>
          <ErrorState title="Couldn't load this note" onRetry={() => refetch()} />
        </div>
      </Shell>
    );
  }

  // A live read with no note: it is not there, and a retry cannot bring it
  // back, so the way forward is the list rather than "Try again".
  if (!note && !deleted) {
    return (
      <Shell showNav={false} showTopBar={false}>
        {header}
        <div className={styles.pageContainer}>
          <EmptyState
            icon={<NotesEmptyIcon size={56} />}
            title="Note not found"
            detail="It may have been deleted."
            action={{ label: "All notes", href: "/notes" }}
          />
        </div>
      </Shell>
    );
  }

  // Deleted, and the router is on its way to /notes. Nothing left to render.
  if (!note) {
    return (
      <Shell showNav={false} showTopBar={false}>
        {header}
        <div className={styles.pageContainer}>
          <CardsSkeleton count={1} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell showNav={false} showTopBar={false}>
      <UnsavedChangesGuard when={dirty && !deleted} message="Leave without saving changes to this note?" />
      {header}
      <div className={`${styles.pageContainer} ${notes.detailContent}`}>
        {draft && busy ? <StatusMessage>Saving note…</StatusMessage> : null}
        {notice ? (
          <div className={notes.notice}>
            <StatusMessage tone="warning">
              {notice.text}
              {notice.reauthenticate ? <SessionExpiredClause onReconnected={() => setNotice(null)} /> : null}
            </StatusMessage>
          </div>
        ) : null}
        {draft ? (
          <div className={styles.notePage} aria-busy={busy}>
            <input
              className={styles.noteInput}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={(data?.titleGenerated && note.data.note.title) || "Title"}
              aria-label="Note title"
              readOnly={busy}
            />
            <textarea
              className={styles.noteTextarea}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder="New note."
              aria-label="Note text"
              readOnly={busy}
              autoFocus
            />
          </div>
        ) : (
          <article className={styles.notePage}>
            {/* A sealed note carries no title and an empty body. Same sentence
                as the grid, which is the reference. */}
            {note.data.note.sealed ? (
              <>
                <h1 className={styles.notePageTitle}>Encrypted note</h1>
                <p className={styles.notePageText}>
                  This note is encrypted and can&rsquo;t be opened in Center.
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
        )}
      </div>
    </Shell>
  );
}
