import Link from "next/link";
import type { DashboardContent } from "@/lib/types";
import { callDisplayName, formatTimestamp } from "@/lib/format";
import styles from "./memories.module.css";

interface TimelineItem {
  readonly id: string;
  readonly createdAt: string;
  readonly href: string;
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
}

function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function buildMemoriesTimeline(content: DashboardContent): readonly TimelineItem[] {
  return [
    ...content.photos.map((photo) => ({
      id: `capture-${photo.uuid}`,
      createdAt: photo.userCreatedAt,
      href: `/captures/${photo.uuid}`,
      kind: "Capture",
      title: photo.data.memoryType === "VIDEO" ? "Video" : "Photo",
    })),
    ...content.aiSessions.map((session) => ({
      id: `ai-mic-${session.uuid}`,
      createdAt: session.userCreatedAt,
      href: "/my-data/ai-mic",
      kind: "Ai Mic",
      title: session.data.eventData.request || "Ai Mic request",
    })),
    ...content.notes.map((note) => ({
      id: `note-${note.uuid}`,
      createdAt: note.userLastModified ?? note.userCreatedAt,
      href: `/notes/${note.uuid}`,
      kind: "Note",
      title: note.data.note.sealed ? "Encrypted note" : note.data.note.title || "Note",
      detail: note.data.note.sealed ? undefined : note.data.note.text || undefined,
    })),
    ...content.playTrackEvents.map((track) => ({
      id: `music-${track.uuid}`,
      createdAt: track.userCreatedAt,
      href: "/my-data/music",
      kind: "Music",
      title: track.data.eventData.trackTitle || "Track",
      detail: track.data.eventData.artistName || undefined,
    })),
    ...content.phoneCalls.map((call) => ({
      id: `call-${call.uuid}`,
      createdAt: call.userCreatedAt,
      href: "/my-data/calls",
      kind: "Call",
      title: callDisplayName(call.data.eventData.peers?.[0]),
    })),
  ].sort((left, right) => toTime(right.createdAt) - toTime(left.createdAt));
}

export function MemoriesTimeline({ content }: { content: DashboardContent }) {
  const items = buildMemoriesTimeline(content);
  return (
    <ol className={styles.timeline} aria-label="Memories by date">
      {items.map((item) => (
        <li className={styles.timelineItem} key={item.id}>
          <Link href={item.href} className={styles.timelineLink}>
            <span className={styles.timelineMeta}>
              <span>{item.kind}</span>
              <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time>
            </span>
            <strong className={styles.timelineTitle}>{item.title}</strong>
            {item.detail ? <span className={styles.timelineDetail}>{item.detail}</span> : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}
