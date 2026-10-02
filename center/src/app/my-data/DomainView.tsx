"use client";

import { DataRow, DetailView } from "@/components/DetailView";
import { MusicArtwork } from "@/components/MusicArtwork";
import { MusicProviderIcon } from "@/components/MusicProviderIcon";
import { SessionReconnect } from "@/components/SessionReconnect";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/views.module.css";
import { AiMicIcon, MusicIcon, PhoneIcon, SearchIcon, TranslationIcon } from "@/icons";
import type { AiMicRecord, MusicRecord, PhoneCallRecord, TranslationRecord } from "@/lib/contracts/events";
import { albumTint, callDisplayName, callSummary, formatTimestamp, isSealedEvent } from "@/lib/format";
import { musicPresentation, musicProviderLabel } from "@/lib/musicActivityPresentation";
import { useMyData, useMyDataSearch, type SearchableDomain } from "@/lib/queries";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import search from "./myDataSearch.module.css";

type Domain = "AI_MIC" | "MUSIC" | "TRANSLATION" | "CALL";

const TITLES: Record<Domain, string> = {
  AI_MIC: "Ai Mic",
  MUSIC: "Music",
  TRANSLATION: "Translation",
  CALL: "Calls",
};

const ICONS: Record<Domain, React.ReactNode> = {
  AI_MIC: <AiMicIcon size={20} />,
  MUSIC: <MusicIcon size={20} />,
  TRANSLATION: <TranslationIcon size={20} />,
  CALL: <PhoneIcon size={20} />,
};

/** The same four glyphs at empty-state size, each view's OWN domain icon. */
const EMPTY_ICONS: Record<Domain, React.ReactNode> = {
  AI_MIC: <AiMicIcon size={48} />,
  MUSIC: <MusicIcon size={48} />,
  TRANSLATION: <TranslationIcon size={48} />,
  CALL: <PhoneIcon size={48} />,
};

/** What a row Cosmos could not open says instead of its content. */
const SEALED_DETAIL = "This entry is encrypted and can’t be opened in Center.";

/** "Only Ai Mic and Music events are searchable", Humane's words, Cosmos's rule. */
function isSearchable(domain: Domain): domain is SearchableDomain {
  return domain === "AI_MIC" || domain === "MUSIC";
}

/** Cosmos's bound on one search, in characters. */
const MAX_SEARCH_CHARS = 256;

/**
 * Pages are fetched by offset while the list refreshes every few seconds, so
 * an event that arrives between two page reads shifts the next page by one and
 * repeats a row. Keep each event once, where it first appears.
 */
function uniqueRows<T extends { uuid: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.uuid)) return false;
    seen.add(row.uuid);
    return true;
  });
}

/**
 * The wearer's Keycloak grant expired behind a still-valid Center cookie. Only
 * signing in again helps, so this offers that and no retry.
 */
const SESSION_EXPIRED = (
  <StatusMessage tone="warning">
    Your session expired. <SessionReconnect /> to see this.
  </StatusMessage>
);

/**
 * One component for all four My Data detail views. Cosmos hands every row in
 * the recovered `{uuid, userCreatedAt, data: {eventData}}` shape, already
 * filtered, opened, renamed and grouped. Each view only lays it out.
 */
export function DomainView({ domain }: { domain: Domain }) {
  const searchable = isSearchable(domain);
  const [typed, setTyped] = useState("");
  // What Cosmos is asked: the trimmed words, once typing pauses.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const next = typed.trim();
    if (next === term) return;
    const timer = setTimeout(() => setTerm(next), 250);
    return () => clearTimeout(timer);
  }, [typed, term]);
  const searching = searchable && term !== "";

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMyData(domain, { enabled: !searching });
  const matches = useMyDataSearch(searchable ? domain : null, searching ? term : "");
  const queryClient = useQueryClient();
  const title = TITLES[domain];

  /**
   * A row the backend confirmed is gone.
   *
   * Drop it from the cache so it leaves the screen at once, THEN invalidate so
   * the next read comes from cosmos rather than from this optimistic edit, if
   * the event somehow survived, it reappears, which is the honest outcome and
   * the reason this is an invalidate and not a permanent local filter.
   *
   * Four caches hold this event: the domain list, its searches, the My Data
   * overview counts, and the Memories dashboard (which renders Ai Mic, music
   * and calls). Leaving any of them would show a deleted event somewhere else
   * in the app.
   */
  async function onForgotten(uuid: string) {
    const without = (prev: InfiniteData<{ data: Array<{ uuid: string }> }> | undefined) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              data: page.data.filter((row) => row.uuid !== uuid),
            })),
          }
        : prev;
    queryClient.setQueryData(["mydata", domain], without);
    queryClient.setQueriesData({ queryKey: ["mydata-search", domain] }, without);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mydata", domain] }),
      queryClient.invalidateQueries({ queryKey: ["mydata-search", domain] }),
      queryClient.invalidateQueries({ queryKey: ["mydata-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] }),
    ]);
  }

  /** A vote Cosmos stored: re-read the lists so every view shows it. */
  async function onVoted() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mydata", domain] }),
      queryClient.invalidateQueries({ queryKey: ["mydata-search", domain] }),
    ]);
  }

  const searchField = searchable ? (
    <div className={search.bar} role="search">
      <span className={search.icon} aria-hidden>
        <SearchIcon size={18} />
      </span>
      <input
        className={search.input}
        type="search"
        value={typed}
        maxLength={MAX_SEARCH_CHARS}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={`Search ${title}`}
        aria-label={`Search ${title}`}
        data-testid="search-mydata-field"
      />
    </div>
  ) : null;

  if (searching) {
    const pages = matches.data?.pages ?? [];
    const head = pages[0];
    const found = uniqueRows(pages.flatMap((page) => page.data));
    return (
      <DetailView title={title}>
        {searchField}
        {matches.isError ? (
          <ErrorState
            title={`Couldn't search ${title}`}
            detail={matches.error instanceof Error ? matches.error.message : undefined}
            onRetry={() => matches.refetch()}
          />
        ) : !head ? (
          <RowsSkeleton count={4} />
        ) : found.length === 0 ? (
          /* The read's own state first: a search that never ran matched nothing
             only because it never ran. */
          head.reauthenticate ? (
            SESSION_EXPIRED
          ) : head.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => matches.refetch()}>
              {title} couldn&rsquo;t be searched just now.
            </StatusMessage>
          ) : head.state !== "live" ? (
            <StatusMessage tone="info">Activity history isn’t configured on this Center.</StatusMessage>
          ) : (
            <EmptyState
              icon={EMPTY_ICONS[domain]}
              title="No matches"
              detail={`All your ${title} entries were searched.`}
              action={{
                label: "Clear search",
                onClick: () => {
                  setTyped("");
                  setTerm("");
                },
              }}
            />
          )
        ) : (
          <>
            <p className={search.count} data-testid="search-mydata-count">
              {head.total} {head.total === 1 ? "match" : "matches"}
            </p>
            {found.map(renderRow)}
            {matches.hasNextPage ? (
              <button
                type="button"
                className={buttons.secondaryButton}
                disabled={matches.isFetchingNextPage}
                onClick={() => void matches.fetchNextPage()}
              >
                {matches.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            ) : null}
          </>
        )}
      </DetailView>
    );
  }

  // The search field appears with the rows it searches: not over a list that
  // is still loading, failed, or empty.
  if (isLoading) {
    return (
      <DetailView title={title}>
        <RowsSkeleton count={6} />
      </DetailView>
    );
  }

  // A settled infinite query always holds its first page.
  const head = data?.pages[0];
  if (isError || !data || !head) {
    return (
      <DetailView title={title}>
        <ErrorState
          title={`Couldn't load ${title}`}
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => refetch()}
        />
      </DetailView>
    );
  }

  const rows = uniqueRows(data.pages.flatMap((page) => page.data));

  if (rows.length === 0) {
    return (
      <DetailView title={title}>
        {head.reauthenticate ? (
          SESSION_EXPIRED
        ) : head.state === "live" ? (
          <EmptyState icon={EMPTY_ICONS[domain]} title="Nothing here yet" />
        ) : head.state === "degraded" ? (
          <StatusMessage tone="warning" onRetry={() => refetch()}>
            Couldn&rsquo;t load your {title} right now.
          </StatusMessage>
        ) : (
          /* Absent is not a failure and not retryable: a wearer on a Center
             with nothing configured must not be handed a "Try again" that can
             only ever produce the same screen. */
          <StatusMessage tone="info">
            Activity history isn’t configured on this Center.
          </StatusMessage>
        )}
      </DetailView>
    );
  }

  return (
    <DetailView title={title}>
      {searchField}
      {rows.map(renderRow)}
      {hasNextPage ? (
        <button
          type="button"
          className={buttons.secondaryButton}
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? "Loading…" : "Show older"}
        </button>
      ) : null}
    </DetailView>
  );

  /** One row, laid out for this view's domain. */
  function renderRow(record: MyDataRecord) {
    const timestamp = formatTimestamp(record.userCreatedAt);
    const icon = ICONS[domain];
    const sealed = isSealedEvent(record);

    if (domain === "AI_MIC") {
      const row = record as AiMicRecord;
      return (
        <DataRow
          key={row.uuid}
          uuid={row.uuid}
          icon={icon}
          primary={sealed ? "Encrypted request" : (row.data.eventData.request ?? "—")}
          secondary={
            sealed ? (
              SEALED_DETAIL
            ) : row.data.typedInCenter ? (
              <>
                <span>{row.data.eventData.response}</span>
                <br />
                <span data-testid="typed-in-center">Typed in Center</span>
              </>
            ) : (
              row.data.eventData.response
            )
          }
          timestamp={timestamp}
          votable
          vote={row.data.vote ?? null}
          onForgotten={onForgotten}
          onVoted={onVoted}
        />
      );
    }

    if (domain === "MUSIC") {
      const { provider, artwork } = musicPresentation(record as MusicRecord);
      const e = (record as MusicRecord).data.eventData;
      return (
        <DataRow
          key={record.uuid}
          uuid={record.uuid}
          icon={
            <span className={styles.musicArtworkWrap}>
              <MusicArtwork
                className={styles.rowAlbumArt}
                src={artwork}
                tint={albumTint(e.albumArtHexcode)}
                alt={`${e.albumName || e.trackTitle || "Music"} cover`}
              />
              <span
                className={styles.musicProviderBadge}
                aria-label={musicProviderLabel(provider)}
              >
                <MusicProviderIcon provider={provider} size={12} />
              </span>
            </span>
          }
          primary={
            <span data-testid="track-title">
              {sealed ? "Encrypted track" : (e.trackTitle ?? "—")}
            </span>
          }
          secondary={
            sealed ? (
              SEALED_DETAIL
            ) : (
              <>
                <span>{e.artistName}</span>
                {e.albumName ? (
                  <>
                    <br />
                    <span>{e.albumName}</span>
                  </>
                ) : null}
                <br />
                <span>{musicProviderLabel(provider)}</span>
              </>
            )
          }
          timestamp={timestamp}
          onForgotten={onForgotten}
        />
      );
    }

    if (domain === "TRANSLATION") {
      const e = (record as TranslationRecord).data.eventData;
      return (
        <DataRow
          key={record.uuid}
          uuid={record.uuid}
          icon={icon}
          primary={
            sealed
              ? "Encrypted translation"
              : `${e.sourceLanguage || "Unknown language"} → ${e.targetLanguage || "Unknown language"}`
          }
          secondary={sealed ? SEALED_DETAIL : undefined}
          timestamp={timestamp}
          onForgotten={onForgotten}
        />
      );
    }

    const call = (record as PhoneCallRecord).data.eventData;
    const peers = call.peers ?? [];
    const extra = peers.length > 1 ? ` +${peers.length - 1}` : "";
    const summary = callSummary(call);
    return (
      <DataRow
        key={record.uuid}
        uuid={record.uuid}
        eventIds={call.eventIds}
        icon={icon}
        primary={sealed ? "Encrypted call" : `${callDisplayName(peers[0])}${extra}`}
        secondary={sealed ? SEALED_DETAIL : summary || undefined}
        timestamp={timestamp}
        onForgotten={onForgotten}
      />
    );
  }
}

type MyDataRecord = AiMicRecord | MusicRecord | TranslationRecord | PhoneCallRecord;
