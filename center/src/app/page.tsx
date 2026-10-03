"use client";

import Link from "next/link";
import { useState } from "react";
import { CaptureThumbnail, frameState } from "@/components/CaptureThumbnail";
import { MemoriesTimeline } from "@/components/MemoriesTimeline";
import { MusicArtwork } from "@/components/MusicArtwork";
import { MusicProviderIcon } from "@/components/MusicProviderIcon";
import { Shell } from "@/components/Shell";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import styles from "@/components/memories.module.css";
import viewStyles from "@/components/views.module.css";
import {
  AiMicIcon,
  HealthIcon,
  PhoneIcon,
} from "@/icons";
import { albumTint, callDisplayName, formatTimestamp, isSealedEvent } from "@/lib/format";
import { musicPresentation, musicProviderLabel } from "@/lib/musicActivityPresentation";
import { useDashboard } from "@/lib/queries";
import type { DashboardProvenance } from "@/lib/contracts/dashboard";

/**
 * Memories, the root route.
 *
 * Card composition is not a guess: getDashboardContent() → GET /capture/memories
 * returns { photos, aiSessions, playTrackEvents, notes, phoneCalls, health } and
 * the original rendered fixed slots, photos[0], aiSessions[0], playTrackEvents[0..1],
 * notes[0..2], phoneCalls[0], health[0]. Humane's own press image of this view
 * shows exactly that arrangement.
 */

/*
 * The health tile was gated in the real .Center behind the per-user `healthPage`
 * feature-flag allowlist (staff-only beta), most wearers never saw it. Default
 * OFF so it no longer shows to everyone. Enable with NEXT_PUBLIC_FEATURE_HEALTH=1.
 */
const HEALTH_PAGE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_HEALTH === "1";

/**
 * The five independently-failing parts, in the wearer's words.
 *
 * This is the one view that renders all five, and its banner used to be a single
 * fixed sentence read off the AGGREGATE state: "Some memories couldn't be loaded
 * because the Pin backend isn't answering." When the music gRPC leg alone went
 * quiet, the music slots simply vanished from the grid, indistinguishable from a
 * wearer who had listened to nothing, and the banner would not say which of the
 * eight tiles was missing. The BFF has computed exactly that answer all along
 * (`DashboardProvenance`, "A page that renders one part must branch on that
 * part"), shipped it in the body on every five-second poll, and nothing read it.
 *
 * Naming the parts in the banner rather than putting a message in each card is
 * deliberate: four of the five parts are `.map()`ed slots, so a failed part
 * renders zero elements and there is no card left to hang a sentence on.
 */
const PART_LABELS: Record<keyof DashboardProvenance, string> = {
  captures: "Photos",
  notes: "Notes",
  aiMic: "Ai Mic",
  music: "Music",
  calls: "Calls",
};

/** "Music", "Music and Calls", "Notes, Music and Calls". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function partsInState(
  provenance: DashboardProvenance | undefined,
  state: "degraded" | "absent",
): string[] {
  if (!provenance) return [];
  return (Object.keys(PART_LABELS) as Array<keyof DashboardProvenance>)
    .filter((part) => provenance[part]?.state === state)
    .map((part) => PART_LABELS[part]);
}

/**
 * The Memories domain glyph, the tile mosaic this page IS. The empty state
 * used to render `NotesEmptyIcon`, the notes page's document-with-arrow, so the
 * one screen that is not Notes announced itself as Notes.
 */
function MemoriesEmptyIcon({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden>
      <rect x="3" y="3" width="8.4" height="8.4" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="13.6" y="3" width="7.4" height="5.2" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="3" y="13.6" width="8.4" height="7.4" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect
        x="13.6"
        y="10.4"
        width="7.4"
        height="10.6"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export default function MemoriesPage() {
  const { data, isLoading, isError, error, refetch } = useDashboard();
  const [view, setView] = useState<"grid" | "timeline">("grid");

  if (isLoading) {
    return (
      <Shell>
        <div className={viewStyles.pageContainer}>
          <h1 className={viewStyles.srOnly}>Memories</h1>
          {/* the SAME 4-column grid the cards land in, so the page stops
              re-flowing the instant the dashboard answers */}
          <CardsSkeleton variant="dashboard" count={8} />
        </div>
      </Shell>
    );
  }

  if (isError || !data) {
    return (
      <Shell>
        <div className={viewStyles.pageContainer}>
          <h1 className={viewStyles.srOnly}>Memories</h1>
          <ErrorState
            title="Couldn't load your memories"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => refetch()}
          />
        </div>
      </Shell>
    );
  }

  const { photos, aiSessions, playTrackEvents, notes, phoneCalls, health } = data.data;
  const degradedParts = partsInState(data.data.provenance, "degraded");
  const absentParts = partsInState(data.data.provenance, "absent");

  const photoData = photos?.[0] ?? null;
  const aiSessionsData = (aiSessions ?? []).slice(0, 1);
  const musicSlots = (playTrackEvents ?? []).slice(0, 2);
  const presentedMusicSlots = musicSlots.map(musicPresentation);
  const noteSlots = (notes ?? []).slice(0, 3);
  const phoneCallData = phoneCalls?.[0] ?? null;
  // Only a shown tile makes a reading count as something on screen.
  const healthData = HEALTH_PAGE_ENABLED ? (health?.[0] ?? null) : null;

  const isDashboardEmpty =
    !photoData &&
    aiSessionsData.length === 0 &&
    musicSlots.length === 0 &&
    noteSlots.length === 0 &&
    !phoneCallData &&
    !healthData;

  if (isDashboardEmpty) {
    return (
      <Shell>
        <div className={viewStyles.pageContainer}>
          <h1 className={viewStyles.srOnly}>Memories</h1>
          {/* "You have none yet" is only true when a live backend said so, and
              a backend that did not answer and one that was never configured are
              still two different sentences, only one of which can be retried. */}
          {data.state === "live" ? (
            <EmptyState
              icon={<MemoriesEmptyIcon size={56} />}
              title="No memories yet"
              detail="Photos, notes, music, and calls from your Pin will appear here. New to Luma? Start by setting up your Pin."
              action={{ label: "Set up a Pin", href: "/settings/pin/setup" }}
            />
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Couldn&rsquo;t load your memories right now.
            </StatusMessage>
          ) : (
            <StatusMessage tone="info">
              Connect your Pin to see memories.
            </StatusMessage>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className={viewStyles.pageContainer}>
        <h1 className={viewStyles.srOnly}>Memories</h1>
        {/* Say why the view is incomplete without replacing missing wearer data,
            and say WHICH part — a missing card should be attributable rather than
            merely absent. */}
        {data.state === "degraded" ? (
          <StatusMessage tone="warning" onRetry={() => refetch()}>
            {degradedParts.length > 0
              ? `${nameList(degradedParts)} couldn’t be loaded right now.`
              : "Some memories couldn’t be loaded right now."}
          </StatusMessage>
        ) : data.state === "absent" ? (
          /* Not a failure and not retryable, at least one source is absent. */
          <StatusMessage tone="info">
            {absentParts.length > 0
              ? `Not set up on your server yet: ${nameList(absentParts)}.`
              : "Some Pin data isn’t available yet."}
          </StatusMessage>
        ) : null}

        <div className={styles.viewControls} role="group" aria-label="Memories view">
          <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")}>Grid</button>
          <button type="button" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button>
        </div>

        {view === "timeline" ? (
          <MemoriesTimeline content={{ photos, aiSessions, playTrackEvents, notes, phoneCalls, health }} />
        ) : (
        <div className={styles.dashboardGrid}>
          {photoData ? (
            <Link href={`/captures/${photoData.uuid}`} className={`${styles.card} ${styles.photoCard}`}>
              {photoData.data.uploadComplete && (photoData.data.thumbnailCount ?? 0) > 0 ? (
                <CaptureThumbnail
                  uuid={photoData.uuid}
                  index={photoData.data.bestFrameIndex ?? 0}
                  imgClassName={styles.photoImage}
                  fallbackClassName={styles.photoMissing}
                  frame={photoData.data}
                />
              ) : (
                /* the same shared sentence set the captures grid uses, this
                   used to re-implement it, minus the `sealed` case */
                <div className={styles.photoMissing}>
                  <span>{frameState(photoData.data)}</span>
                </div>
              )}
              <span className={styles.photoCaption}>{formatTimestamp(photoData.userCreatedAt)}</span>
            </Link>
          ) : null}

          {aiSessionsData.map((session) => (
            <Link key={session.uuid} href="/my-data/ai-mic" className={`${styles.card} ${styles.aiCard}`}>
              <div className={styles.cardHead}>
                <AiMicIcon size={16} />
                Ai Mic
              </div>
              <span className={styles.aiRequest}>
                {isSealedEvent(session) ? "Encrypted request" : session.data.eventData.request}
              </span>
              <span className={styles.cardTimestamp}>{formatTimestamp(session.userCreatedAt)}</span>
            </Link>
          ))}

          {noteSlots.map((note) => (
            <Link key={note.uuid} href={`/notes/${note.uuid}`} className={`${styles.card} ${styles.noteCard}`}>
              <div className={styles.cardHead}>Note</div>
              {/* A note the backend returned sealed has no title and an empty
                  body, so this used to render a blank card — existing encrypted
                  content, spelled exactly like data loss. Same sentence /notes
                  uses, so the tile and the card agree. */}
              {note.data.note.sealed ? (
                <>
                  <span className={styles.noteTitle}>Encrypted note</span>
                  <span className={styles.noteText}>
                    This note is encrypted and can&rsquo;t be opened in Center.
                  </span>
                </>
              ) : (
                <>
                  {note.data.note.title ? (
                    <span className={styles.noteTitle}>{note.data.note.title}</span>
                  ) : null}
                  <span className={styles.noteText}>{note.data.note.text}</span>
                </>
              )}
              <span className={styles.cardTimestamp}>
                {formatTimestamp(note.userLastModified ?? note.userCreatedAt)}
              </span>
            </Link>
          ))}

          {presentedMusicSlots.map(({ record: track, provider, artwork }) => {
            const e = track.data.eventData;
            return (
              <Link key={track.uuid} href="/my-data/music" className={styles.card}>
                <div className={styles.cardHead}>
                  <MusicProviderIcon provider={provider} />
                  Music
                </div>
                <div className={styles.musicRow}>
                  <MusicArtwork
                    className={styles.albumArt}
                    src={artwork}
                    tint={albumTint(e.albumArtHexcode)}
                    alt={`${e.albumName || e.trackTitle || "Music"} cover`}
                  />
                  <span>
                    <span className={styles.trackTitle}>
                      {isSealedEvent(track) ? "Encrypted track" : e.trackTitle}
                    </span>
                    <br />
                    <span className={styles.trackArtist}>{e.artistName}</span>
                  </span>
                </div>
                <span className={styles.serviceTag}>
                  {formatTimestamp(track.userCreatedAt)} · {musicProviderLabel(provider)}
                </span>
              </Link>
            );
          })}

          {phoneCallData ? (
            <Link href="/my-data/calls" className={styles.card}>
              <div className={styles.cardHead}>
                <PhoneIcon size={16} />
                Call
              </div>
              <span className={styles.callName}>
                {isSealedEvent(phoneCallData)
                  ? "Encrypted call"
                  : callDisplayName(phoneCallData.data.eventData.peers?.[0])}
              </span>
              <span className={styles.cardTimestamp}>
                {formatTimestamp(phoneCallData.userCreatedAt)}
              </span>
            </Link>
          ) : null}

          {HEALTH_PAGE_ENABLED ? (
            <div className={`${styles.card} ${styles.healthCard}`}>
              <div className={styles.cardHead}>
                <HealthIcon size={16} />
                Health
              </div>
              <span className={styles.healthTitle}>Track your health</span>
              <span className={styles.comingSoon}>Coming soon</span>
            </div>
          ) : null}
        </div>
        )}
      </div>
    </Shell>
  );
}
