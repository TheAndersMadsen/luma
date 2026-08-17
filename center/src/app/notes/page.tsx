"use client";

import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Page, PageHeader } from "@/components/Page";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/views.module.css";
import { NotesEmptyIcon, PlusIcon, SearchIcon } from "@/icons";
import { useNotes } from "@/lib/queries";
import { formatTimestamp } from "@/lib/format";

export default function NotesPage() {
  const { data, isLoading, isError, error, refetch } = useNotes();

  const toolbarRight = (
    <>
      <Link href="/notes/search" aria-label="Search notes">
        <span className={buttons.circularButton}>
          <SearchIcon size={20} />
        </span>
      </Link>
      <Link href="/notes/new" aria-label="New note">
        <span className={`${buttons.circularButton} ${buttons.circularButtonAccent}`}>
          <PlusIcon size={22} />
        </span>
      </Link>
    </>
  );

  if (isLoading) {
    return (
      <Shell toolbarRight={toolbarRight}>
        <Page>
          {/* the CSS-columns masonry the notes land in, not the generic grid */}
          <CardsSkeleton variant="notes" count={6} />
        </Page>
      </Shell>
    );
  }

  if (isError || !data) {
    return (
      <Shell toolbarRight={toolbarRight}>
        <Page>
          <ErrorState
            title="Couldn't load your notes"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => refetch()}
          />
        </Page>
      </Shell>
    );
  }

  const notes = data.data;
  /*
   * The count this page prints is a count of ROWS ON SCREEN, and the backend
   * clamps every list to two hundred of them with no page beyond the first
   * anywhere in this app. So a wearer with three hundred notes read "200 notes"
   * as the number of notes they have — a number that is really the page size,
   * stated as a fact about their own writing, and it stopped moving no matter
   * how many more they wrote.
   *
   * `total` is the Spring envelope's `totalElements`, which the backend counts
   * separately from the rows it returns. When it is larger, say both numbers.
   * My Data has done this for its capped counters for a long time ("at least N
   * — totals are counted up to that point and no further"); notes never did.
   */
  const capped = typeof data.total === "number" && data.total > notes.length;

  return (
    <Shell toolbarRight={toolbarRight}>
      <Page>
        <PageHeader
          title="Notes"
          description="Thoughts and lists saved from your Pin or written here."
          meta={
            capped
              ? `${notes.length} of ${data.total} notes — the most recent ${notes.length} are shown here`
              : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`
          }
        />
        {notes.length === 0 ? (
          data.state === "live" ? (
            /* RECOVERED, VERBATIM: the string "No notes yet" and the
               document-with-arrow icon are both from the Feb-2025 bundle. They
               pass through <EmptyState> as props and are not reworded. */
            <EmptyState
              icon={<NotesEmptyIcon size={56} />}
              title="No notes yet"
              action={{ label: "New note", href: "/notes/new" }}
            />
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Couldn&rsquo;t load notes from your Pin.
            </StatusMessage>
          ) : (
            /* Absent is not a failure and not retryable. This branch used to
               stop at "live or not", so a Center with no CARRY_WEBAPI_BASE_URL
               told the wearer their backend had gone quiet and gave them a "Try
               again" that no amount of pressing could change — while
               /notes/search, one tap away and reading the very same
               `useNotes()` cache entry, said the opposite and correctly. */
            <StatusMessage tone="info">
              Connect your Pin to see notes.
            </StatusMessage>
          )
        ) : (
          <div className={styles.noteMasonryGrid}>
            {notes.map((note) => (
              <div key={note.uuid} className={styles.noteGrid}>
                <Link href={`/notes/${note.uuid}`} className={styles.noteTileLinkWrap}>
                  <article className={`${styles.noteTile} ${note.data.note.sealed ? styles.noteTileSealed : ""}`}>
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
        )}
      </Page>
    </Shell>
  );
}
