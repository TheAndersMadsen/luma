/*
 * Saving a file read off the Pin (a fitness export, a log dump) to the
 * wearer's disk: the name the device supplies cannot steer the browser's
 * downloader, and the temporary blob URL is always released.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings under Node's type stripping.
import assert from "node:assert/strict";
import test from "node:test";

const { safeDownloadName } = await import(
  "../src/app/settings/pin/_lib/fileDownload.ts?pin-file-download-test"
);

test("a device filename cannot suggest a path to the browser downloader", () => {
  assert.equal(safeDownloadName("uuid_0_0.jpg", "fallback.bin"), "uuid_0_0.jpg");
  assert.equal(safeDownloadName("../../etc/passwd", "fallback.bin"), "passwd");
  assert.equal(safeDownloadName("a/b/c.mp4", "fallback.bin"), "c.mp4");
  assert.equal(safeDownloadName("   ", "fallback.bin"), "fallback.bin");
  assert.equal(safeDownloadName("..", "fallback.bin"), "fallback.bin");
  assert.equal(
    safeDownloadName(`bad${String.fromCharCode(10)}name.jpg`, "fallback.bin"),
    "badname.jpg",
  );
});
