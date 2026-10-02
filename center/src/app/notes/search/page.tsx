"use client";

import { Suspense, useEffect, useState } from "react";
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
import { NOTES_PAGE_SIZE, NotesPager, pageFromParam } from "../NotesPager";

/**
 * `/notes/search?q=`, a recovered .Center route. Cosmos searches every note
 * the wearer has, by title and text, and pages the matches. The query is kept
 * in the URL so a search is shareable and survives a reload.
 */
function NotesSearch() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = params.get("q") ?? "";
  const pageNumber = pageFromParam(params.get("page"));
  const [q, setQ] = useState(initial);
  /*
   * Follow the URL, but do not fight the person typing.
   *
   * The effect below writes the TRIMMED query into the URL 250ms after the last
   * keystroke, and `initial` is read straight back out of that URL. So a wearer
   * who typed "shopping " and paused, which is exactly what a pause between two
   * words is, had the round trip hand back "shopping" and this effect delete
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

  // The URL's query is the debounced one, so it is also what Cosmos searches.
  const { data, isLoading, isError, error, refetch } = useNotes({
    query: initial,
    page: pageNumber,
    size: NOTES_PAGE_SIZE,
  });

  // Keep the URL in sync (debounced). A new query starts again at page one.
  useEffect(() => {
    if (q.trim() === initial) return;
    const t = setTimeout(() => {
      const usp = new URLSearchParams();
      if (q.trim()) usp.set("q", q.trim());
      const qs = usp.toString();
      router.replace(qs ? `/notes/search?${qs}` : "/notes/search");
    }, 250);
    return () => clearTimeout(t);
  }, [q, initial, router]);

  const results = data?.data ?? [];
  const hrefFor = (page: number) => {
    const usp = new URLSearchParams();
    if (initial) usp.set("q", initial);
    if (page > 0) usp.set("page", String(page + 1));
    const qs = usp.toString();
    return qs ? `/notes/search?${qs}` : "/notes/search";
  };

  const back = (
    <Link href="/notes" aria-label="Back to notes" className={search.back}>
      <span>
        <BackIcon size={20} />
      </span>
    </Link>
  );

  return (
    <Shell toolbarLeft={back}>
      <div className={styles.pageContainer}>
        <h1 className={styles.srOnly}>Search notes</h1>
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
          /* The read's own state first: a search that never ran matched nothing
             only because it never ran. */
          data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Notes couldn&rsquo;t be searched just now.
            </StatusMessage>
          ) : data.state !== "live" ? (
            /* Absent: nothing is configured to answer, which no retry can fix. */
            <StatusMessage tone="info">
              Connect your Pin to see notes.
            </StatusMessage>
          ) : initial ? (
            <EmptyState
              icon={<NotesEmptyIcon size={56} />}
              title="No matching notes"
              detail="All your notes were searched."
              action={{ label: "Clear search", onClick: () => setQ("") }}
            />
          ) : (
            /* the recovered notes string and icon, unchanged */
            <EmptyState icon={<NotesEmptyIcon size={56} />} title="No notes yet" />
          )
        ) : (
          <>
            {initial ? (
              <p className={search.count}>
                {data.total ?? results.length} {(data.total ?? results.length) === 1 ? "note" : "notes"}
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
                          included. The /notes grid is the reference; same
                          treatment, same words. */}
                      {note.data.note.sealed ? (
                        <>
                          <h2 className={styles.noteTitle}>Encrypted note</h2>
                          <p className={styles.noteText}>
                            This note is encrypted and can&rsquo;t be opened in Center.
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
            <NotesPager pageNumber={pageNumber} totalPages={data.totalPages ?? 1} hrefFor={hrefFor} />
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
