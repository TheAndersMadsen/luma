import Link from "next/link";
import styles from "./notes.module.css";

/** How many notes one page of the grid holds. */
export const NOTES_PAGE_SIZE = 60;

/** The zero-based page a `?page=` value names. The URL counts from 1. */
export function pageFromParam(value: string | null): number {
  const page = Number.parseInt(value ?? "", 10);
  return Number.isFinite(page) && page > 1 ? page - 1 : 0;
}

/**
 * Newer / Older links between pages of notes. Plain links, so paging works
 * without JavaScript and every page has its own URL.
 */
export function NotesPager({
  pageNumber,
  totalPages,
  hrefFor,
}: {
  pageNumber: number;
  totalPages: number;
  /** The URL of a zero-based page. */
  hrefFor: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className={styles.pager} aria-label="Note pages">
      {pageNumber > 0 ? (
        <Link className={`${styles.pagerLink} ${styles.pagerNewer}`} href={hrefFor(pageNumber - 1)}>
          Newer
        </Link>
      ) : (
        <span />
      )}
      <span className={styles.pagerPosition}>
        Page {Math.min(pageNumber + 1, totalPages)} of {totalPages}
      </span>
      {pageNumber + 1 < totalPages ? (
        <Link className={`${styles.pagerLink} ${styles.pagerOlder}`} href={hrefFor(pageNumber + 1)}>
          Older
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
