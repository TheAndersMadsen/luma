/*
 * When a turn happened, in the words a person uses.
 *
 * Every page render starts in UTC so the list reads with JavaScript off, then
 * the viewer's own zone and clock replace it after hydration. Both spellings
 * come from these pure functions, so the rule is one place and testable.
 */

const utcStamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const utcDay = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });
const localStamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const localClock = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" });
const localDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const localDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });
const MINUTE = 60000;
const DAY = 86400000;

/** Turns of the same calendar day share a key: UTC before hydration, the viewer's day after it. */
export const dayKey = (at: number, local: boolean) =>
  local ? new Date(at).toDateString() : new Date(at).toISOString().slice(0, 10);

/** Whole days between two instants in the given calendar; 0 is today, 1 is yesterday. */
function daysApart(at: number, now: number, local: boolean): number {
  const start = (value: number) => {
    const date = new Date(value);
    return local ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };
  return Math.round((start(now) - start(at)) / DAY);
}

/** The heading over one day of turns: "Today", "Yesterday", then the day by name. */
export function dayHeading(at: number, now: number, local: boolean): string {
  if (!local) return utcDay.format(at);
  const apart = daysApart(at, now, true);
  if (apart <= 0) return "Today";
  if (apart === 1) return "Yesterday";
  return apart < 7 ? localDay.format(at) : localDate.format(at);
}

/** The time on one row: "Just now", "12 minutes ago", "22:41", "Yesterday 22:41". */
export function relativeTime(at: number, now: number, local: boolean): string {
  if (!local) return `${utcStamp.format(at)} UTC`;
  const elapsed = now - at;
  if (elapsed >= 0 && elapsed < MINUTE) return "Just now";
  if (elapsed >= 0 && elapsed < 60 * MINUTE) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const apart = daysApart(at, now, true);
  if (apart <= 0) return localClock.format(at);
  if (apart === 1) return `Yesterday ${localClock.format(at)}`;
  return localStamp.format(at);
}

/** The exact instant, for the row's tooltip and its machine-readable stamp. */
export const exactTime = (at: number, local: boolean) => local ? localStamp.format(at) : `${utcStamp.format(at)} UTC`;
