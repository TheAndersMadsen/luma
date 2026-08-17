"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { Page } from "@/components/Page";
import { EmptyState, ErrorState, GridSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { CaptureGallery, CaptureGalleryToolbar, CapturesEmptyIcon } from "./CaptureGallery";
import { useCaptures } from "@/lib/queries";
import { formatTimestamp } from "@/lib/format";
import type { CaptureRecord } from "@/lib/types";
import styles from "./captures.module.css";

export default function CapturesPage() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useCaptures();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** A delete that deleted nothing, in the wearer's terms. */
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  // Server-side search results (GET /api/capture/search). Null means "use the
  // local filter" — either no query, or the search endpoint isn't available.
  const [serverResults, setServerResults] = useState<CaptureRecord[] | null>(null);
  /**
   * Set when the SEARCH call did not come back live and the local filter is
   * standing in for it. Null means the results on screen are the server's.
   *
   * This replaces a `searchUnavailable` boolean that was written true and never
   * written false — see the effect below.
   */
  const [searchFallback, setSearchFallback] = useState<{
    state: "absent" | "degraded";
    reason?: string;
  } | null>(null);
  const rankingAttempted = useRef(new Set<string>());

  // New stock photo memories arrive as a three-frame burst. Rank unselected
  // uploads in small batches so Center naturally settles on the best frame even
  // if the wearer never opens the detail view. Carry caches each answer.
  useEffect(() => {
    if (data?.state !== "live") return;
    const pending = data.data
      .filter(
        (capture) =>
          capture.data.memoryType === "PHOTO" &&
          capture.data.uploadComplete === true &&
          (capture.data.frameCount ?? 0) > 1 &&
          capture.data.bestFrameIndex === undefined &&
          !rankingAttempted.current.has(capture.uuid),
      )
      .slice(0, 6);
    if (pending.length === 0) return;
    pending.forEach((capture) => rankingAttempted.current.add(capture.uuid));
    let cancelled = false;
    void Promise.allSettled(
      pending.map((capture) =>
        fetch(`/api/capture/memory/${encodeURIComponent(capture.uuid)}/best-photo`, {
          method: "POST",
        }).then((response) => {
          if (!response.ok) throw new Error(`selection -> ${response.status}`);
        }),
      ),
    ).then((outcomes) => {
      if (!cancelled && outcomes.some((outcome) => outcome.status === "fulfilled")) {
        void queryClient.invalidateQueries({ queryKey: ["captures"] });
        void queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [data, queryClient]);

  /**
   * Real server-side search, backed by the webapi. Debounced, and it degrades to
   * the client-side filter below when the endpoint does not answer live.
   *
   * WHAT THIS USED TO DO TO A WEARER. The fallback was silent and permanent. Any
   * non-live answer set a `searchUnavailable` flag that had no code path back to
   * false, so one blip disabled the server search for as long as the page stayed
   * mounted — including long after the backend recovered, at which point the
   * grid's own provenance was live again and no banner rendered anywhere. The
   * local filter matches only uuid and the FORMATTED timestamp, while the server
   * also matches memoryType and the raw ISO date, so "photo" or "2026-08" —
   * exactly the sort of thing an open-ended "Search captures" box invites —
   * returned "No matching captures" with the wearer's photos sitting one line
   * above in the very same component's data. The wearer was told their search
   * found nothing, when the truth was that their captures were never searched.
   *
   * So: no sticky flag. Every debounced query re-asks, which is how the search
   * recovers the moment the backend does; what the fallback IS gets held in
   * state and said out loud beside the grid.
   *
   * Branching on `x-data-state`, not the `x-data-source` alias — src/server/
   * headers.ts is explicit that state is the one to branch on, and `carry` is
   * only accidentally equivalent to `live` today.
   *
   * `dataUpdatedAt` is a dependency because these results are a SEPARATE list
   * that nothing else refreshes. When a capture is deleted — from the selection
   * bar here, or from the detail lightbox, which invalidates the captures query
   * and leaves this page mounted underneath it — the grid's own list reloads and
   * this one would keep rendering a tile of something that no longer exists.
   * Any change to the capture list re-asks the search; so does the retry on the
   * fallback banner, which is why that banner's Try again can actually work.
   */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setServerResults(null);
      setSearchFallback(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/capture/search?query=${encodeURIComponent(q)}&size=200`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`search -> ${res.status}`);
        const results = (await res.json()) as CaptureRecord[];
        if (res.headers.get("x-data-state") === "live") {
          setServerResults(results);
          setSearchFallback(null);
        } else {
          // The search did not run. Hand back to the local filter and remember
          // that it IS the local filter, so the grid can say so.
          setServerResults(null);
          setSearchFallback({
            state: res.headers.get("x-data-state") === "absent" ? "absent" : "degraded",
            reason: res.headers.get("x-data-degraded") ?? undefined,
          });
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setServerResults(null);
          setSearchFallback({ state: "degraded", reason: (e as Error).message });
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, dataUpdatedAt]);

  const captures = useMemo(() => {
    const all = data?.data ?? [];
    const q = query.trim();

    // Server search answered: use its results.
    if (q && serverResults) return serverResults;
    if (!q) return all;
    // Fallback: the local filter, unchanged.
    const needle = q.toLowerCase();
    return all.filter(
      (c) =>
        c.uuid.toLowerCase().includes(needle) ||
        formatTimestamp(c.userCreatedAt).toLowerCase().includes(needle),
    );
  }, [data, query, serverResults]);

  function toggleSelected(uuid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  }

  /**
   * Mirrors POST /capture/memory/bulk-delete — a real, confirmed delete.
   *
   * The BFF answers 200 with a `degraded` clause when it accepted the request
   * and deleted NOTHING. This used to fire and forget through `allSettled`, so
   * every tile left the selection and the wearer watched them all come back on
   * the refetch. Now a capture that is still there stays selected and the bar
   * says how many, and why.
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

    const outcomes = await Promise.all(
      ids.map(async (uuid) => {
        try {
          const res = await fetch(`/api/capture/memory/${encodeURIComponent(uuid)}`, {
            method: "DELETE",
          });
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            degraded?: string;
            note?: string;
          };
          const explanation = body.degraded ?? body.note;
          // `degraded` on a 200 means the request was accepted and nothing was
          // deleted — the capture is still on the server.
          if (!res.ok || body.ok === false || explanation) {
            return {
              uuid,
              kept: true,
              why: explanation && /session expired|sign in/i.test(explanation)
                ? "sign in again and try"
                : "the request could not be completed",
            };
          }
          return { uuid, kept: false, why: undefined };
        } catch {
          return { uuid, kept: true, why: "the request could not be completed" };
        }
      }),
    );

    const kept = outcomes.filter((o) => o.kept);
    // Keep exactly the captures that are still there selected; release the rest.
    setSelected(new Set(kept.map((o) => o.uuid)));
    setDeleteNotice(
      kept.length === 0
        ? null
        : kept.length === ids.length
          ? `Nothing was deleted — ${
              ids.length === 1 ? "this capture is" : "these captures are"
            } still here. ${kept[0].why}`
          : `${kept.length} of ${ids.length} couldn't be forgotten and are still here. ${kept[0].why}`,
    );

    // The tiles the backend confirmed are gone leave NOW rather than at the end
    // of the refetch — including out of the server-search results, which are a
    // list of their own and would otherwise keep showing a deleted capture until
    // the search re-ran.
    const gone = new Set(outcomes.filter((o) => !o.kept).map((o) => o.uuid));
    if (gone.size > 0) {
      setServerResults((prev) => (prev ? prev.filter((c) => !gone.has(c.uuid)) : prev));
      // The Memories dashboard renders the same captures from its own cache
      // entry; without this the deleted tiles stay on the home page. The detail
      // lightbox's Forget already does both — this half was missing.
      void queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
    }
    void refetch();
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

  if (isError || !data) {
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
  // When the server search answered, the tiles on screen came from THAT call
  // (and only when it reported `x-data-source: carry`), so the dashboard
  // payload's provenance is not theirs to report.
  const showingServerSearch = Boolean(query.trim() && serverResults);

  const provenance = showingServerSearch
    ? null
    : data.state === "degraded" ? (
      <StatusMessage tone="warning" onRetry={() => refetch()}>
        Captures couldn&rsquo;t be loaded.
      </StatusMessage>
    ) : null;

  /*
   * The wearer is typing into a search box that is not searching. Say so, in the
   * same place they are looking, and say what the fallback can still match — a
   * limited match is a different answer from "nothing matched", and the wearer
   * is the only one who can tell whether it is good enough.
   *
   * `refetch()` bumps `dataUpdatedAt`, which is a dependency of the search
   * effect, so this Try again genuinely re-asks the search rather than only
   * reloading the grid.
   */
  const searching = Boolean(query.trim());

  /*
   * The grid holds one capped page — the backend clamps every capture list to
   * two hundred rows and nothing in this app asks for a second page — and it
   * never said so. The older half of a wearer's library was simply unreachable
   * and unsearchable, including through the server search, which filters this
   * same capped list. `total` is the backend's own count of what they have.
   */
  const cappedNotice =
    typeof data.total === "number" && data.total > data.data.length ? (
      <StatusMessage tone="info">
        Showing your {data.data.length} most recent captures of {data.total}. Older ones
        aren&rsquo;t loaded here, and search only looks at the ones that are.
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
          selected={selected.size}
          total={captures.length}
          onSelectAll={() =>
            setSelected((current) =>
              current.size === captures.length ? new Set() : new Set(captures.map((capture) => capture.uuid)),
            )
          }
          onClear={() => setSelected(new Set())}
          onForget={() => void bulkDelete()}
        />
        {/* No "Try again" here: the captures that survived are still selected,
            so the Forget button in the selection bar IS the retry. */}
        {deleteNotice ? <StatusMessage tone="warning">{deleteNotice}</StatusMessage> : null}

        {provenance}
        {cappedNotice}
        {searchFallbackNotice}

        {captures.length === 0 ? (
          /*
           * The filter case comes first. A search that
           * matches nothing is a fact about the filter, not about the backend —
           * and the retry the provenance check used to show here could never
           * change the result, only the filter can. The unfiltered cases below
           * are the only ones where "you have none" is even a candidate.
           *
           * …but only while the filter is the one the wearer asked for. Once the
           * server search has failed and the local filter is standing in, "No
           * matching captures" is a claim about a search that never ran, so the
           * notice above is left to speak for itself.
           */
          searching && searchFallback ? null : query.trim() ? (
            <EmptyState
              icon={<CapturesEmptyIcon size={56} />}
              title="No matching captures"
              action={{ label: "Clear search", onClick: () => setQuery("") }}
            />
          ) : data.state === "live" ? (
            /* "You have none" is only true when a live backend said so. */
            <EmptyState
              icon={<CapturesEmptyIcon size={56} />}
              title="No captures yet"
              detail="Take a photo on your Pin and it will appear here after the upload completes."
            />
          ) : /* Degraded: the banner above already carries the failure and the
                 retry, so the empty grid says nothing a second time. */
          data.state === "degraded" ? null : (
            /* Absent: nothing is configured to answer and nothing stood in for
               it. Not a failure, so no retry — a retry cannot configure a Pin. */
            <StatusMessage tone="info">
              Connect your Pin to view captures.
            </StatusMessage>
          )
        ) : (
          <CaptureGallery captures={captures} selected={selected} onToggle={toggleSelected} />
        )}
      </Page>
    </Shell>
  );
}
