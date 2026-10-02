"use client";

import { Page } from "@/components/Page";
import { Shell } from "@/components/Shell";
import { EmptyState, ErrorState, GridSkeleton } from "@/components/States";
import { SessionExpiredClause, StatusMessage } from "@/components/Status";
import type { CaptureRecord, PendingCapture } from "@/lib/contracts/captures";
import { formatTimestamp } from "@/lib/format";
import { useCaptures } from "@/lib/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CaptureGallery, CaptureGalleryToolbar, CapturesEmptyIcon, PendingCaptures } from "./CaptureGallery";
import styles from "./captures.module.css";

/**
 * Captures the Pin has taken and not uploaded yet (recovered
 * `getPendingMemoryCreates`). Polled while the page is open, so a capture moves
 * from this list into the grid when its upload lands.
 */
function usePendingCaptures() {
  return useQuery({
    queryKey: ["pending-captures"],
    queryFn: async () => {
      const res = await fetch("/api/capture/pending-memory-creates", { cache: "no-store" });
      if (!res.ok) throw new Error("Try again in a moment.");
      return {
        items: (await res.json()) as PendingCapture[],
        state: res.headers.get("x-data-state"),
      };
    },
    refetchInterval: 15000,
    staleTime: 5000,
  });
}

/**
 * A selection action that changed nothing (or not everything), in the
 * wearer's terms. `reauthenticate` is the route's typed flag
 * (`sessionExpiredResponse`). The sentence never decides it.
 */
interface SelectionNotice {
  text: string;
  reauthenticate: boolean;
}

export default function CapturesPage() {
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCaptures({ favorites: favoritesOnly });
  const pendingQuery = usePendingCaptures();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** A selection action that changed nothing, in the wearer's terms. */
  const [deleteNotice, setDeleteNotice] = useState<SelectionNotice | null>(null);
  const [clearingPending, setClearingPending] = useState(false);
  // Server-side search results (GET /api/capture/search). Null means "use the
  // local filter", either no query, or the search endpoint isn't available.
  const [serverResults, setServerResults] = useState<CaptureRecord[] | null>(null);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [visualIndex, setVisualIndex] = useState<{
    state: "building" | "unavailable";
    pending: number;
  } | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  /**
   * Set when the SEARCH call did not come back live and the local filter is
   * standing in for it. Null means the results on screen are the server's.
   *
   * This replaces a `searchUnavailable` boolean that was written true and never
   * written false, see the effect below.
   */
  const [searchFallback, setSearchFallback] = useState<{
    state: "absent" | "degraded";
    reason?: string;
  } | null>(null);

  const pending = useMemo(() => pendingQuery.data?.items ?? [], [pendingQuery.data]);
  // A capture leaving the waiting list is a capture arriving in the grid.
  const pendingCount = useRef(pending.length);
  useEffect(() => {
    if (pending.length < pendingCount.current) {
      void queryClient.invalidateQueries({ queryKey: ["captures"] });
    }
    pendingCount.current = pending.length;
  }, [pending.length, queryClient]);

  /**
   * Real server-side search, backed by the webapi. Debounced, and it degrades to
   * the client-side filter below when the endpoint does not answer live.
   *
   * No sticky flag. Every debounced query re-asks, which is how the search
   * recovers the moment Cosmos does. What the fallback IS gets held in state
   * and said out loud beside the grid.
   *
   * `dataUpdatedAt` is a dependency because these results are a SEPARATE list
   * that nothing else refreshes. Any change to the capture list re-asks the
   * search. So does the retry on the fallback banner.
   */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setServerResults(null);
      setSearchTotal(null);
      setVisualIndex(null);
      setSearchFallback(null);
      return;
    }
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/capture/search?query=${encodeURIComponent(q)}&size=200${favoritesOnly ? "&favorites=1" : ""}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`search -> ${res.status}`);
        const results = (await res.json()) as CaptureRecord[];
        if (res.headers.get("x-data-state") === "live") {
          setServerResults(results);
          setSearchTotal(Number.parseInt(res.headers.get("x-total-count") ?? "0", 10) || 0);
          setSearchFallback(null);
          const indexState = res.headers.get("x-visual-index");
          const pendingIndex = Number.parseInt(res.headers.get("x-visual-pending") ?? "0", 10) || 0;
          if (indexState === "building") {
            setVisualIndex({ state: "building", pending: pendingIndex });
            refreshTimer = setTimeout(() => setSearchRevision((revision) => revision + 1), 5000);
          } else if (indexState === "unavailable") {
            setVisualIndex({ state: "unavailable", pending: pendingIndex });
          } else {
            setVisualIndex(null);
          }
        } else {
          // The search did not run. Hand back to the local filter and remember
          // that it IS the local filter, so the grid can say so.
          setServerResults(null);
          setSearchTotal(null);
          setVisualIndex(null);
          setSearchFallback({
            state: res.headers.get("x-data-state") === "absent" ? "absent" : "degraded",
            reason: res.headers.get("x-data-degraded") ?? undefined,
          });
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setServerResults(null);
          setSearchTotal(null);
          setVisualIndex(null);
          setSearchFallback({ state: "degraded", reason: (e as Error).message });
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      if (refreshTimer) clearTimeout(refreshTimer);
      controller.abort();
    };
  }, [query, favoritesOnly, dataUpdatedAt, searchRevision]);

  /** The first page carries the library's provenance and its total. */
  const head = data?.pages[0];
  const loaded = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);

  const captures = useMemo(() => {
    const q = query.trim();

    // Server search answered: use its results, already narrowed by Cosmos,
    // to the matches, and to the favourites when the filter is on.
    if (q && serverResults) {
      return serverResults;
    }
    if (!q) return loaded;
    // Fallback: the local filter, unchanged.
    const needle = q.toLowerCase();
    return loaded.filter(
      (c) =>
        c.uuid.toLowerCase().includes(needle) ||
        formatTimestamp(c.userCreatedAt).toLowerCase().includes(needle),
    );
  }, [loaded, query, serverResults]);

  function toggleSelected(uuid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  }

  /** Every other surface that renders these captures reads again. */
  async function refreshEverywhere() {
    await queryClient.invalidateQueries({ queryKey: ["captures"] });
    // The Memories dashboard renders the same captures from its own cache entry.
    void queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
  }

  /**
   * Mirrors POST /capture/memory/bulk-delete, a real, confirmed delete.
   *
   * Cosmos says what happened to each capture. A capture that is still there
   * stays selected and the bar says how many, and why. One that is gone leaves
   * the grid now, including the server-search results, which are a list of
   * their own.
   */
  async function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Forget ${ids.length} capture${ids.length === 1 ? "" : "s"}? This permanently deletes ${
          ids.length === 1 ? "it" : "them"
        } — it can't be undone.`,
      )
    ) {
      return;
    }
    setDeleteNotice(null);

    let kept: string[] = ids;
    let reauthenticate = false;
    try {
      const res = await fetch("/api/capture/memory/bulk-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryUUIDs: ids }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        degraded?: string;
        failed?: string[];
        reauthenticate?: boolean;
      };
      if (res.ok && body.ok === true && !body.degraded) {
        // `deleted` and `notFound` are both gone. Only `failed` is still stored.
        kept = ids.filter((uuid) => body.failed?.includes(uuid));
      } else {
        reauthenticate = body.reauthenticate === true;
      }
    } catch {
      // Nothing is known to be deleted. Every capture stays selected.
    }

    setSelected(new Set(kept));
    setDeleteNotice(
      kept.length === 0
        ? null
        : {
            text:
              kept.length === ids.length
                ? `Nothing was deleted — ${
                    ids.length === 1 ? "this capture is" : "these captures are"
                  } still here.`
                : `${kept.length} of ${ids.length} couldn’t be forgotten and are still here.`,
            reauthenticate,
          },
    );

    const gone = new Set(ids.filter((uuid) => !kept.includes(uuid)));
    if (gone.size > 0) {
      setServerResults((prev) => (prev ? prev.filter((c) => !gone.has(c.uuid)) : prev));
    }
    await refreshEverywhere();
  }

  /** Recovered bulk-favorite / bulk-unfavorite over the whole selection. */
  async function bulkFavorite(favorite: boolean) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setDeleteNotice(null);
    try {
      const res = await fetch(`/api/capture/memory/${favorite ? "bulk-favorite" : "bulk-unfavorite"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryUUIDs: ids }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reauthenticate?: boolean };
      if (res.ok && body.ok === true) {
        setSelected(new Set());
        setServerResults((prev) =>
          prev
            ? prev.map((c) => (selected.has(c.uuid) ? { ...c, data: { ...c.data, favorite } } : c))
            : prev,
        );
      } else {
        setDeleteNotice({ text: "Favorites weren’t changed.", reauthenticate: body.reauthenticate === true });
      }
    } catch {
      setDeleteNotice({ text: "Favorites weren’t changed.", reauthenticate: false });
    }
    await refreshEverywhere();
  }

  /** Recovered deletePendingMemoryCreate: the list clears. The Pin keeps its captures. */
  async function clearPending() {
    if (
      !window.confirm(
        "Clear this list? The captures stay on your Pin and still upload when they can.",
      )
    ) {
      return;
    }
    setClearingPending(true);
    try {
      const res = await fetch("/api/capture/pending-memory-creates", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reauthenticate?: boolean };
      if (!res.ok || body.ok !== true) {
        setDeleteNotice({ text: "The list wasn’t cleared.", reauthenticate: body.reauthenticate === true });
      }
    } catch {
      setDeleteNotice({ text: "The list wasn’t cleared.", reauthenticate: false });
    } finally {
      setClearingPending(false);
      void pendingQuery.refetch();
    }
  }

  if (isLoading) {
    return (
      <Shell>
        <Page>
          <GridSkeleton count={12} />
        </Page>
      </Shell>
    );
  }

  if (isError || !head) {
    return (
      <Shell>
        <Page>
          <ErrorState
            title="Couldn't load your captures"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => refetch()}
          />
        </Page>
      </Shell>
    );
  }

  /* Report the capture plane's own provenance. Missing data stays empty. */
  // When the server search answered, the tiles on screen came from THAT call,
  // so the grid's provenance is not theirs to report.
  const showingServerSearch = Boolean(query.trim() && serverResults);

  const provenance = showingServerSearch
    ? null
    : head.state === "degraded" ? (
      <StatusMessage tone="warning" onRetry={() => refetch()}>
        Couldn&rsquo;t load your captures right now.
      </StatusMessage>
    ) : null;

  /*
   * The wearer is typing into a search box that is not searching. Say so, in the
   * same place they are looking, and say what the fallback can still match.
   *
   * `refetch()` bumps `dataUpdatedAt`, which is a dependency of the search
   * effect, so this Try again genuinely re-asks the search.
   */
  const searching = Boolean(query.trim());

  const cappedNotice =
    !searching && typeof head.total === "number" && head.total > loaded.length ? (
      <StatusMessage tone="info">
        Showing your {loaded.length} most recent captures of {head.total}. Search checks your
        full library.
      </StatusMessage>
    ) : null;
  const searchCountNotice =
    searching && searchTotal !== null && searchTotal > captures.length ? (
      <StatusMessage tone="info">
        Showing {captures.length} of {searchTotal} matches. Refine your search to narrow them down.
      </StatusMessage>
    ) : null;
  const visualIndexNotice =
    searching && visualIndex?.state === "building" ? (
      <StatusMessage tone="info">
        Preparing {visualIndex.pending} older photo{visualIndex.pending === 1 ? "" : "s"} for
        search&hellip;
      </StatusMessage>
    ) : searching && visualIndex?.state === "unavailable" ? (
      <StatusMessage tone="warning">
        Connect a vision-capable assistant to search what&rsquo;s in older photos.
      </StatusMessage>
    ) : null;
  const searchFallbackNotice =
    searching && searchFallback ? (
      searchFallback.state === "degraded" ? (
        <StatusMessage tone="warning" onRetry={() => refetch()}>
          Search is temporarily unavailable. Showing matches by date and ID only.
        </StatusMessage>
      ) : (
        <StatusMessage tone="info">
          Connect your Pin to search captures. Showing matches by date and ID only.
        </StatusMessage>
      )
    ) : null;

  return (
    <Shell>
      <Page>
        <h1 className={styles.srOnly}>Captures</h1>

        <CaptureGalleryToolbar
          query={query}
          onQueryChange={setQuery}
          favoritesOnly={favoritesOnly}
          onFavoritesOnlyChange={(value) => {
            setSelected(new Set());
            setFavoritesOnly(value);
          }}
          selected={selected.size}
          total={captures.length}
          onSelectAll={() =>
            setSelected((current) =>
              current.size === captures.length ? new Set() : new Set(captures.map((capture) => capture.uuid)),
            )
          }
          onClear={() => setSelected(new Set())}
          onFavorite={() => void bulkFavorite(true)}
          onUnfavorite={() => void bulkFavorite(false)}
          onForget={() => void bulkDelete()}
        />
        {/* No "Try again" here: the captures that survived are still selected,
            so the selection bar IS the retry. */}
        {deleteNotice ? (
          <StatusMessage tone="warning">
            {deleteNotice.text}
            {deleteNotice.reauthenticate ? (
              <SessionExpiredClause onReconnected={() => setDeleteNotice(null)} />
            ) : (
              " Try again."
            )}
          </StatusMessage>
        ) : null}

        {searching || favoritesOnly ? null : (
          <PendingCaptures pending={pending} clearing={clearingPending} onClear={() => void clearPending()} />
        )}

        {provenance}
        {cappedNotice}
        {searchCountNotice}
        {visualIndexNotice}
        {searchFallbackNotice}

        {captures.length === 0 ? (
          /*
           * The filter case comes first. A search that matches nothing is a
           * fact about the filter, not about the wearer's library, and the
           * retry the provenance check shows could never change the result.
           *
           * …but only while the filter is the one the wearer asked for. Once the
           * server search has failed and the local filter is standing in, "No
           * matching captures" is a claim about a search that never ran, so the
           * notice above is left to speak for itself.
           */
          searching && (searchFallback || visualIndex?.state === "building") ? null : query.trim() ? (
            <EmptyState
              icon={<CapturesEmptyIcon size={56} />}
              title="No matching captures"
              action={{ label: "Clear search", onClick: () => setQuery("") }}
            />
          ) : head.state === "live" && favoritesOnly ? (
            <EmptyState
              icon={<CapturesEmptyIcon size={56} />}
              title="No favorites yet"
              detail="Select captures and choose Favorite to keep them here."
              action={{ label: "Show all captures", onClick: () => setFavoritesOnly(false) }}
            />
          ) : head.state === "live" ? (
            /* "You have none" is only true when a live read said so. */
            pending.length > 0 ? null : (
              <EmptyState
                icon={<CapturesEmptyIcon size={56} />}
                title="No captures yet"
                detail="Take a photo on your Pin and it will appear here after the upload completes."
              />
            )
          ) : /* Degraded: the banner above already carries the failure and the
                 retry, so the empty grid says nothing a second time. */
          head.state === "degraded" ? null : (
            /* Absent: nothing is configured to answer and nothing stood in for
               it. Not a failure, so no retry — a retry cannot configure a Pin. */
            <StatusMessage tone="info">
              Connect your Pin to see captures.
            </StatusMessage>
          )
        ) : (
          <>
            <CaptureGallery captures={captures} selected={selected} onToggle={toggleSelected} />
            {!searching && hasNextPage ? (
              <div className={styles.more}>
                <button
                  type="button"
                  className={styles.moreButton}
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? "Loading…" : "Show more captures"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </Page>
    </Shell>
  );
}
