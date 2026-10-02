"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Page, PageHeader } from "@/components/Page";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/views.module.css";
import { NotesEmptyIcon, PlusIcon, SearchIcon } from "@/icons";
import { useNotes } from "@/lib/queries";
import { formatTimestamp } from "@/lib/format";
import { NOTES_PAGE_SIZE, NotesPager, pageFromParam } from "./NotesPager";

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

function Notes() {
  const pageNumber = pageFromParam(useSearchParams().get("page"));
  const { data, isLoading, isError, error, refetch } = useNotes({
    page: pageNumber,
    size: NOTES_PAGE_SIZE,
  });

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
   * The count this page prints is about the wearer's notes, not the rows on
   * screen. `total` is the Spring envelope's `totalElements`, which Cosmos
   * counts separately from the page it returns, so when there is more than one
   * page say where this one sits among all of them.
   */
  const paged = typeof data.total === "number" && data.total > notes.length;
  const first = pageNumber * NOTES_PAGE_SIZE + 1;
  const last = first + notes.length - 1;

  return (
    <Shell toolbarRight={toolbarRight}>
      <Page>
        <PageHeader
          title="Notes"
          description="Thoughts and lists saved from your Pin or written here."
          meta={
            paged && notes.length > 0
              ? `${first}–${last} of ${data.total} notes`
              : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`
          }
        />
        {notes.length === 0 ? (
          data.state === "live" ? (
            (data.total ?? 0) > 0 ? (
              /* A page past the end, the wearer deleted notes, or followed an
                 old link. Their notes are all still there. */
              <EmptyState
                icon={<NotesEmptyIcon size={56} />}
                title="Nothing on this page"
                action={{ label: "Newest notes", href: "/notes" }}
              />
            ) : (
              /* RECOVERED, VERBATIM: the string "No notes yet" and the
                 document-with-arrow icon are both from the Feb-2025 bundle. They
                 pass through <EmptyState> as props and are not reworded. */
              <EmptyState
                icon={<NotesEmptyIcon size={56} />}
                title="No notes yet"
                action={{ label: "New note", href: "/notes/new" }}
              />
            )
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Couldn&rsquo;t load your notes right now.
            </StatusMessage>
          ) : (
            /* Absent is not a failure and not retryable: nothing is configured
               to answer, and no amount of "Try again" can change that. */
            <StatusMessage tone="info">
              Connect your Pin to see notes.
            </StatusMessage>
          )
        ) : (
          <>
            <div className={styles.noteMasonryGrid}>
              {notes.map((note) => (
                <div key={note.uuid} className={styles.noteGrid}>
                  <Link href={`/notes/${note.uuid}`} className={styles.noteTileLinkWrap}>
                    <article
                      className={`${styles.noteTile} ${note.data.note.sealed ? styles.noteTileSealed : ""}`}
                    >
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
            <NotesPager
              pageNumber={pageNumber}
              totalPages={data.totalPages ?? 1}
              hrefFor={(page) => (page > 0 ? `/notes?page=${page + 1}` : "/notes")}
            />
          </>
        )}
      </Page>
    </Shell>
  );
}

export default function NotesPage() {
  return (
    <Suspense>
      <Notes />
    </Suspense>
  );
}
