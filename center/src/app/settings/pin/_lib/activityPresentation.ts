import type { ActivityKind, ActivityMusic, ActivityNote } from "@/lib/pin-device";

/*
 * What each device-local activity tab is, and the sentences that stand between
 * a wearer and data they cannot get back.
 *
 * This is a module rather than literals in the pane for the reason
 * `esimSafety` is: on an irreversible control the copy IS the safeguard, so it
 * has to be somewhere verify/ can assert it. `clearActivityConfirmation`
 * carries the two facts that decide whether a wearer understands what they are
 * about to lose — how many rows, and which category — and it deliberately
 * refuses to state an exact total it does not have.
 *
 * Every kind also names its CLOUD counterpart. Center already renders /notes,
 * /my-data/ai-mic and /my-data/music from Cosmos over @/server/source; those are
 * DIFFERENT stores holding different rows, and neither delete reaches the
 * other. A wearer who cannot tell which one is on screen will eventually delete
 * from the wrong one, so the pane says it on every tab instead of once in a
 * header someone scrolls past.
 */

/**
 * Rows per request.
 *
 * The Pin answers `/api/activity/<kind>` with a `next_before` cursor, and this
 * pane pages rather than asking for everything: these tables are the wearer's
 * whole speech and playback history and can be thousands of rows, which is a
 * long time to hold an ADB socket open before anything renders.
 */
export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivityTab {
  kind: ActivityKind;
  /** Tab strip. */
  label: string;
  /** Section heading. It has to say WHERE these rows are, not just what. */
  title: string;
  /** Singular and plural nouns, for the confirmation sentences below. */
  one: string;
  many: string;
  emptyTitle: string;
  emptyDetail: string;
  /** Standing prose under the heading: what this store is, and is not. */
  help: string;
  /** The cloud-backed Center surface holding the OTHER copy. */
  cloudHref: string;
  cloudLinkLabel: string;
  cloudNote: string;
}

export const ACTIVITY_TABS: readonly ActivityTab[] = [
  {
    kind: "notes",
    label: "Notes",
    title: "Notes on this Pin",
    one: "note",
    many: "notes",
    emptyTitle: "No notes on this Pin",
    emptyDetail:
      "Notes you dictate to the Pin are written to the device first. They appear here as long as the device still holds them.",
    help: "Read straight off the device through Center's active Pin connection. Nothing on this tab is your account's copy, and deleting here does not delete anything in your account.",
    cloudHref: "/notes",
    cloudLinkLabel: "Open Notes",
    cloudNote:
      "Notes in your account are a separate store, held by Cosmos and reachable from any browser.",
  },
  {
    kind: "prompts",
    label: "Prompts",
    title: "Assistant turns on this Pin",
    one: "recorded turn",
    many: "recorded turns",
    emptyTitle: "No assistant turns recorded on this Pin",
    emptyDetail:
      "Ask the Pin a question out loud. The turn is written to the device before anything is sent anywhere.",
    help: "What you asked the Pin and what it answered, as the device recorded it. This is the same table the Assistant & providers pane reads the newest failure from.",
    cloudHref: "/my-data/ai-mic",
    cloudLinkLabel: "Open Ai Mic",
    cloudNote:
      "Ai Mic under My Data is your account's cloud copy, held by Cosmos — a different store with different rows.",
  },
  {
    kind: "music",
    label: "Music",
    title: "Music played on this Pin",
    one: "played track",
    many: "played tracks",
    emptyTitle: "No playback recorded on this Pin",
    emptyDetail:
      "Tracks the Pin plays are logged on the device with when they started and stopped.",
    help: "The device's own playback log. It records what the Pin played, not what your streaming account played anywhere else.",
    cloudHref: "/my-data/music",
    cloudLinkLabel: "Open Music",
    cloudNote:
      "Music under My Data is your account's cloud copy, held by Cosmos — a different store with different rows.",
  },
];

export function activityTab(kind: ActivityKind): ActivityTab {
  const tab = ACTIVITY_TABS.find((candidate) => candidate.kind === kind);
  if (!tab) throw new Error(`Unknown activity kind: ${kind}`);
  return tab;
}

function noun(tab: ActivityTab, count: number): string {
  return count === 1 ? tab.one : tab.many;
}

/**
 * The question asked before a whole category is wiped off the device.
 *
 * `loadedCount` is what this pane has actually read, which is not the same as
 * what the Pin holds: the list pages, and `DELETE /api/activity/<kind>` does
 * not. So when the cursor says there is more, the sentence says "at least" and
 * names the rows it cannot see, because "Delete all 50 notes" while the device
 * holds 800 is a false statement made at the exact moment it matters most.
 */
export function clearActivityConfirmation(
  kind: ActivityKind,
  loadedCount: number,
  hasMore: boolean,
): string {
  const tab = activityTab(kind);
  if (hasMore) {
    return `Delete every ${tab.one} on this Pin? At least ${loadedCount} ${noun(tab, loadedCount)} are loaded here, and the device still holds older ones this page has not read. Clearing removes all of them. They are stored only on this Pin — Center holds no copy of them — so this cannot be undone.`;
  }
  const stored =
    loadedCount === 1
      ? "It is stored only on this Pin — Center holds no copy of it"
      : "They are stored only on this Pin — Center holds no copy of them";
  return `Delete all ${loadedCount} ${noun(tab, loadedCount)} on this Pin? ${stored} — so this cannot be undone.`;
}

/**
 * The question asked before ONE row is deleted.
 *
 * `itemLabel` is written by the tab because only it knows what identifies a row
 * to the person looking at it — a timestamp for a note, a track name for
 * playback. Everything around it is shared, and takes no kind, so that all
 * three tabs make the same promise and the "only on this Pin" clause cannot be
 * dropped from one of them by someone editing a single tab.
 */
export function deleteActivityItemConfirmation(itemLabel: string): string {
  return `Delete ${itemLabel}? It is stored only on this Pin — Center holds no copy — so this cannot be undone.`;
}

/** The armed button's own label, which must restate the count and category. */
export function clearActivityConfirmLabel(
  kind: ActivityKind,
  loadedCount: number,
  hasMore: boolean,
): string {
  const tab = activityTab(kind);
  if (hasMore) return `Delete every ${tab.one}`;
  return `Delete all ${loadedCount} ${noun(tab, loadedCount)}`;
}

/** Anything the device returns from an activity table, reduced to its key. */
export interface ActivityItemLike {
  id: string | number;
}

/**
 * Drop one row so it leaves the screen before the Pin has answered.
 *
 * Optimistic, because a delete over ADB takes long enough that a wearer who
 * gets no feedback presses the button again. The pair below is what makes that
 * safe: if the device refuses, `withActivityItemRestored` puts the row back
 * where it was, so the list never quietly disagrees with the Pin about what is
 * still on it.
 */
export function withoutActivityItemAt<T extends ActivityItemLike>(
  items: readonly T[],
  index: number,
): T[] {
  if (index < 0 || index >= items.length) return [...items];
  return [...items.slice(0, index), ...items.slice(index + 1)];
}

/**
 * Undo the removal above.
 *
 * Two guards, both for the case where the list moved on while the delete was in
 * flight — a reload landed, or another page was appended. The identity check
 * refuses to insert a row that is already there, and the index is clamped, so a
 * rejected delete can never duplicate a row or throw a hole in the order.
 */
export function withActivityItemRestored<T extends ActivityItemLike>(
  items: readonly T[],
  index: number,
  item: T,
): T[] {
  if (items.some((candidate) => candidate.id === item.id)) return [...items];
  const at = Math.min(Math.max(index, 0), items.length);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/**
 * Where a note was written, in the most human form the device gave us.
 *
 * The Pin sends whichever of these it managed to resolve, so the order is a
 * preference and not a fallback chain over one field: a reverse-geocoded place
 * name beats a street address beats raw coordinates. Coordinates are still
 * shown rather than dropped — a note containing a location the wearer cannot see
 * is worse than one showing numbers.
 */
export function activityNoteLocation(note: ActivityNote): string | null {
  const location = note.location;
  if (!location) return null;
  const readable = location.human_readable?.trim();
  if (readable) return readable;
  const address = location.full_address?.trim();
  if (address) return address;
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
}

/** "Artist A, Artist B", or nothing at all when the device recorded none. */
export function activityMusicArtists(item: ActivityMusic): string | null {
  const artists = item.artists.map((artist) => artist.trim()).filter(Boolean);
  return artists.length > 0 ? artists.join(", ") : null;
}
