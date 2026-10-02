/*
 * What this browser remembers for the operator's update banner (INFERRED:
 * Luma's own surface). Both facts are device-local or per-reader, so they
 * live in this browser's storage and never in Cosmos:
 *
 *   - the Luma release Software & updates last read from the Pin over USB
 *     (`installedLumaRelease` of its inspection), so the banner can say when
 *     the server offers newer Pin apps without reaching the Pin itself;
 *   - which notice the reader dismissed, keyed by the versions it named, so a
 *     newer release shows again.
 *
 * Storage can be absent or refuse writes (private windows, tests). Every
 * function then behaves as if nothing were remembered.
 */

const PIN_RELEASE_KEY = "luma.updates.pinRelease";
const DISMISSED_KEY = "luma.updates.dismissed";
const MAX_VALUE_CHARS = 128;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    const value = storage()?.getItem(key) ?? null;
    return value && value.length <= MAX_VALUE_CHARS ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value.slice(0, MAX_VALUE_CHARS));
  } catch {
    // Storage refused the write. The banner simply knows less.
  }
}

/** Remember the Luma release Software & updates just read from the Pin. */
export function rememberPinRelease(version: string | null): void {
  if (version) write(PIN_RELEASE_KEY, version);
}

/** The Luma release last read from the Pin in this browser, or `null`. */
export function rememberedPinRelease(): string | null {
  return read(PIN_RELEASE_KEY);
}

export function dismissedNotice(): string | null {
  return read(DISMISSED_KEY);
}

export function dismissNotice(key: string): void {
  write(DISMISSED_KEY, key);
}
