"use client";

import { useQueryClient } from "@tanstack/react-query";
import { DataRow, DetailView } from "@/components/DetailView";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { AiMicIcon, MusicIcon, PhoneIcon, TranslationIcon } from "@/icons";
import { useMyData } from "@/lib/queries";
import { callDisplayName, formatTimestamp } from "@/lib/format";

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

/** The same four glyphs at empty-state size — each view's OWN domain icon. */
const EMPTY_ICONS: Record<Domain, React.ReactNode> = {
  AI_MIC: <AiMicIcon size={48} />,
  MUSIC: <MusicIcon size={48} />,
  TRANSLATION: <TranslationIcon size={48} />,
  CALL: <PhoneIcon size={48} />,
};

/**
 * One component for all four My Data detail views. Each maps a NotableEvent's
 * eventData onto the row shape the original rendered.
 */
export function DomainView({ domain }: { domain: Domain }) {
  const { data, isLoading, isError, error, refetch } = useMyData(domain);
  const queryClient = useQueryClient();
  const title = TITLES[domain];

  /**
   * A row the backend confirmed is gone.
   *
   * Drop it from the cache so it leaves the screen at once, THEN invalidate so
   * the next read comes from cosmos rather than from this optimistic edit — if
   * the event somehow survived, it reappears, which is the honest outcome and
   * the reason this is an invalidate and not a permanent local filter.
   *
   * Three caches hold this event: the domain list, the My Data overview counts,
   * and the Memories dashboard (which renders Ai Mic, music and calls). Leaving
   * any of them would show a deleted event somewhere else in the app.
   */
  async function onForgotten(uuid: string) {
    queryClient.setQueryData<{ data: Array<{ uuid: string }> }>(["mydata", domain], (prev) =>
      prev ? { ...prev, data: prev.data.filter((row) => row.uuid !== uuid) } : prev,
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mydata", domain] }),
      queryClient.invalidateQueries({ queryKey: ["mydata-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] }),
    ]);
  }

  if (isLoading) {
    return (
      <DetailView title={title}>
        <RowsSkeleton count={6} />
      </DetailView>
    );
  }

  if (isError || !data) {
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

  const rows = data.data;

  if (rows.length === 0) {
    return (
      <DetailView title={title}>
        {data.state === "live" ? (
          <EmptyState icon={EMPTY_ICONS[domain]} title="Nothing here yet" />
        ) : data.state === "degraded" ? (
          <StatusMessage tone="warning" onRetry={() => refetch()}>
            Couldn&rsquo;t load activity from your Pin.
          </StatusMessage>
        ) : (
          /* Absent is not a failure and not retryable, and this two-way branch
             used to collapse it into the degraded sentence: a wearer on a Center
             with no gRPC endpoint configured was told the backend had gone quiet
             and handed a "Try again" that could only ever produce the same
             screen, forever. The overview one level up (my-data/page.tsx) has
             carried the third arm all along, so the two pages contradicted each
             other about the same deployment. */
          <StatusMessage tone="info">
            Connect your Pin to see activity.
          </StatusMessage>
        )}
      </DetailView>
    );
  }

  return (
    <DetailView title={title}>
      {rows.map((record) => {
        const timestamp = formatTimestamp(record.userCreatedAt);
        const icon = ICONS[domain];

        if (domain === "AI_MIC") {
          const e = (record as { data: { eventData: { request?: string; response?: string } } }).data
            .eventData;
          return (
            <DataRow
              key={record.uuid}
              uuid={record.uuid}
              icon={icon}
              primary={e.request ?? "—"}
              secondary={e.response}
              timestamp={timestamp}
              votable
              onForgotten={onForgotten}
            />
          );
        }

        if (domain === "MUSIC") {
          const e = (
            record as {
              data: {
                eventData: {
                  trackTitle?: string;
                  artistName?: string;
                  albumName?: string;
                };
              };
            }
          ).data.eventData;
          return (
            <DataRow
              key={record.uuid}
              uuid={record.uuid}
              // The uniform Music-note glyph led every recovered row. The Tidal
              // album-art thumbnail / albumArtHexcode tint was an invention —
              // removed.
              icon={icon}
              // track-title, artist, and album as three separate stacked spans,
              // not a single "{artist} · {album}" line.
              primary={<span data-testid="track-title">{e.trackTitle ?? "—"}</span>}
              secondary={
                <>
                  <span>{e.artistName}</span>
                  {e.albumName ? (
                    <>
                      <br />
                      <span>{e.albumName}</span>
                    </>
                  ) : null}
                </>
              }
              timestamp={timestamp}
              onForgotten={onForgotten}
            />
          );
        }

        if (domain === "TRANSLATION") {
          const e = (
            record as { data: { eventData: { sourceLanguage?: string; targetLanguage?: string } } }
          ).data.eventData;
          return (
            <DataRow
              key={record.uuid}
              uuid={record.uuid}
              icon={icon}
              primary={`${e.sourceLanguage ?? "?"} → ${e.targetLanguage ?? "?"}`}
              timestamp={timestamp}
              onForgotten={onForgotten}
            />
          );
        }

        const e = (
          record as {
            data: { eventData: { peers?: Array<{ displayName: string; phoneNumber: string }> } };
          }
        ).data.eventData;
        const peers = e.peers ?? [];
        const extra = peers.length > 1 ? ` +${peers.length - 1}` : "";
        return (
          <DataRow
            key={record.uuid}
            uuid={record.uuid}
            icon={icon}
            primary={`${callDisplayName(peers[0])}${extra}`}
            timestamp={timestamp}
            onForgotten={onForgotten}
          />
        );
      })}
    </DetailView>
  );
}
