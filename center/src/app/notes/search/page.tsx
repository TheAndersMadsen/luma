"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import styles from "@/components/views.module.css";
import search from "./notesSearch.module.css";
import { BackIcon, NotesEmptyIcon, SearchIcon } from "@/icons";
import { useNotes } from "@/lib/queries";
import { formatTimestamp } from "@/lib/format";

/**
 * `/notes/search?q=` — a recovered .Center route that had no counterpart in the
 * restore. A search bar over the note grid; filtering is client-side over the
 * loaded notes (sealed notes are excluded — their text can't be read here). The
 * query is mirrored into the URL so a search is shareable/deep-linkable.
 */
function NotesSearch() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = params.get("q") ?? "";
  const [q, setQ] = useState(initial);
  /*
   * Follow the URL — but do not fight the person typing.
   *
   * The effect below writes the TRIMMED query into the URL 250ms after the last
   * keystroke, and `initial` is read straight back out of that URL. So a wearer
   * who typed "shopping " and paused — which is exactly what a pause between two
   * words is — had the round trip hand back "shopping" and this effect delete
   * the space they had just typed. Type "list" after that and the search reads
   * "shoppinglist", which matches nothing, and Center answers with "No matching
   * notes" about a note that is sitting right there.
   *
   * Comparing against the trimmed value keeps a genuine navigation (back,
   * forward, a shared link) authoritative while making the trim round-trip the
   * no-op it was always meant to be.
   */
  useEffect(() => {
    setQ((current) => (current.trim() === initial ? current : initial));
  }, [initial]);

  const { data, isLoading, isError, error, refetch } = useNotes();

  // Keep the URL in sync (debounced) so the search is shareable.
  useEffect(() => {
    const t = setTimeout(() => {
      const usp = new URLSearchParams();
      if (q.trim()) usp.set("q", q.trim());
      const qs = usp.toString();
      router.replace(qs ? `/notes/search?${qs}` : "/notes/search");
    }, 250);
    return () => clearTimeout(t);
  }, [q, router]);

  const notes = data?.data ?? [];
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => {
      if (note.data.note.sealed) return false;
      const title = (note.data.note.title ?? "").toLowerCase();
      const text = (note.data.note.text ?? "").toLowerCase();
      return title.includes(needle) || text.includes(needle);
    });
  }, [notes, q]);

  const back = (
    <Link href="/notes" aria-label="Back to notes" className={search.back}>
      <span>
        <BackIcon size={20} />
      </span>
    </Link>
  );

  return (
    <Shell toolbarRight={back}>
      <div className={styles.pageContainer}>
        <div className={search.bar}>
          <span className={search.icon} aria-hidden>
            <SearchIcon size={18} />
          </span>
          <input
            className={search.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            data-testid="search-notes-field"
            autoFocus
          />
        </div>

        {isLoading ? (
          <CardsSkeleton variant="notes" count={6} />
        ) : isError || !data ? (
          <ErrorState
            title="Couldn't load your notes"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => refetch()}
          />
        ) : results.length === 0 ? (
          /* The SEARCH case comes first: a query that matches nothing is a fact
             about the query, and the retry the state check used to show here
             could not change the result — only clearing the search can. */
          q.trim() ? (
            <EmptyState
              icon={<NotesEmptyIcon size={56} />}
              title="No matching notes"
              /* This filter only ever sees the notes the list route returned,
                 and that list is capped at two hundred with no way to ask for
                 the next page. "No matching notes" was therefore said about a
                 note the wearer wrote six months ago and still owns, in the same
                 words used for a note that does not exist. Say what was actually
                 searched. */
              detail={
                typeof data.total === "number" && data.total > notes.length
                  ? `Only the most recent ${notes.length} of your ${data.total} notes were searched.`
                  : undefined
              }
              action={{ label: "Clear search", onClick: () => setQ("") }}
            />
          ) : data.state === "live" ? (
            /* the recovered notes string and icon, unchanged */
            <EmptyState icon={<NotesEmptyIcon size={56} />} title="No notes yet" />
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Notes couldn&rsquo;t be loaded.
            </StatusMessage>
          ) : (
            /* Absent: nothing is configured to answer, which no retry can fix. */
            <StatusMessage tone="info">
              Connect your Pin to view notes.
            </StatusMessage>
          )
        ) : (
          <>
            {q.trim() ? (
              <p className={search.count}>
                {results.length} {results.length === 1 ? "note" : "notes"}
              </p>
            ) : null}
            <div className={styles.noteMasonryGrid}>
              {results.map((note) => (
                <div key={note.uuid} className={styles.noteGrid}>
                  <Link href={`/notes/${note.uuid}`} className={styles.noteTileLinkWrap}>
                    <article
                      className={`${styles.noteTile} ${
                        note.data.note.sealed ? styles.noteTileSealed : ""
                      }`}
                    >
                      {/* With no query every note is listed, sealed ones
                          included — and a sealed note has no title and an empty
                          body, so these used to be blank tiles. The /notes grid
                          is the reference; same treatment, same words. */}
                      {note.data.note.sealed ? (
                        <>
                          <h2 className={styles.noteTitle}>Encrypted note</h2>
                          <p className={styles.noteText}>
                            Sealed under the wearer&rsquo;s channel key. The dashboard holds no key
                            material, so this note cannot be read here.
                          </p>
                        </>
                      ) : (
                        <>
                          {note.data.note.title ? (
                            <h2 className={styles.noteTitle}>{note.data.note.title}</h2>
                          ) : null}
                          <p className={styles.noteText}>{note.data.note.text}</p>
                        </>
                      )}
                      <span className={styles.noteDate}>
                        {formatTimestamp(note.userLastModified ?? note.userCreatedAt)}
                      </span>
                    </article>
                  </Link>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

export default function NotesSearchPage() {
  return (
    <Suspense>
      <NotesSearch />
    </Suspense>
  );
}
