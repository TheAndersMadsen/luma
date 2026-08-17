/*
 * Saving something read off the Pin to the wearer's own disk.
 *
 * The console has three callers now — a fitness export, a log dump, and a
 * capture's stored files — and they were on their way to three copies of the
 * same anchor click. This is the one copy.
 *
 * Note for anyone auditing the CSP: an anchor-triggered download is not
 * governed by any CSP fetch directive — not img-src, not media-src. It works
 * because a download is not a fetch. Do not reuse that reasoning for any other
 * blob: URL; the ones the gallery renders live under `img-src`/`media-src` and
 * are allowed there explicitly.
 *
 * The dependency object exists so the revoke can be asserted without a DOM, and
 * the browser implementation is only constructed when a save actually happens —
 * which is what keeps this module safe for the server to import.
 */

export interface BlobDownloadDependencies {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  clickDownload(url: string, filename: string): void;
  scheduleRevoke(callback: () => void): void;
}

export function browserDownloadDependencies(): BlobDownloadDependencies {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    clickDownload: (url, filename) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
    },
    scheduleRevoke: (callback) => {
      globalThis.setTimeout(callback, 0);
    },
  };
}

/** Hand a blob to the browser's downloader and release its temporary URL. */
export function saveBlobAsFile(
  blob: Blob,
  filename: string,
  dependencies: BlobDownloadDependencies = browserDownloadDependencies(),
) {
  const url = dependencies.createObjectUrl(blob);
  try {
    dependencies.clickDownload(url, filename);
  } finally {
    dependencies.scheduleRevoke(() => dependencies.revokeObjectUrl(url));
  }
}

/**
 * A filename the browser's downloader will not reinterpret.
 *
 * The Pin's stored names are generated (`<uuid>_<burst>_<index>.jpg`) and its
 * media store already rejects separators and control characters, but the value
 * still arrives from the device and lands in a `download` attribute. Reducing
 * it to one printable path segment here means a Pin answering with something
 * unexpected cannot suggest a path.
 */
export function safeDownloadName(filename: string, fallback: string): string {
  const segment = filename.split(/[\\/]/).pop()?.trim() ?? "";
  // Filtered by code point rather than by a regex range, so no literal control
  // character has to appear in this file to describe one.
  const printable = [...segment]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  return printable && printable !== "." && printable !== ".."
    ? printable
    : fallback;
}
