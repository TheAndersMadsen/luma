import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const pinRoot = path.join(root, "pin");

/**
 * Every APK in this repository installs to /data/app. None of them can ever be
 * in the platform's privapp-permissions allowlist, because that allowlist lives
 * on a read-only partition and names only packages shipped with the firmware.
 *
 * PermissionManagerService.systemReady() throws IllegalStateException when a
 * package holds a signature|privileged permission it is not allowlisted for, and
 * that throw is inside system_server, before boot completes. So a single word in
 * one of these manifests does not fail a request or degrade a feature, it makes
 * the Pin unbootable, on every boot, with no way in except racing
 * `cmd package uninstall` against the crash loop (adbd cannot run with full administrator control on a
 * production build).
 *
 * That is not a hypothetical: `WRITE_SECURE_SETTINGS` in the server manifest
 * boot-looped a provisioned Pin. It was also unnecessary, these packages share
 * android.uid.system and therefore already hold the system UID's permissions at
 * runtime. Declaring one buys nothing and costs the device.
 *
 * The rule is an ALLOWLIST, not a blocklist of known-privileged names: a
 * permission nobody here has thought about must fail this test and be checked
 * against its protectionLevel, rather than sail through because it was not on
 * someone's list. To add one, confirm its protectionLevel is normal or dangerous
 * (never signature or privileged) and add it below with that evidence.
 */
const PERMITTED = new Map([
  ["android.permission.ACCESS_COARSE_LOCATION", "dangerous"],
  ["android.permission.ACCESS_FINE_LOCATION", "dangerous"],
  ["android.permission.ACCESS_NETWORK_STATE", "normal"],
  ["android.permission.CHANGE_WIFI_MULTICAST_STATE", "normal"],
  ["android.permission.CHANGE_WIFI_STATE", "normal"],
  ["android.permission.FOREGROUND_SERVICE", "normal"],
  ["android.permission.INTERNET", "normal"],
  ["android.permission.READ_PHONE_STATE", "dangerous"],
  ["android.permission.RECEIVE_BOOT_COMPLETED", "normal"],
]);

/**
 * Named individually because each is a live temptation with a comment in the
 * source explaining why the code takes the long way round instead: the hook
 * calls PowerManager.reboot() rather than declaring REBOOT, reads the IMEI
 * through the privileged LPA host rather than declaring
 * READ_PRIVILEGED_PHONE_STATE, and the server writes Settings.Global on the
 * strength of its shared system UID rather than declaring WRITE_SECURE_SETTINGS.
 * A generic "not in the allowlist" failure would not say any of that.
 */
const KNOWN_FATAL = new Map([
  ["android.permission.WRITE_SECURE_SETTINGS", "boot-looped a provisioned Pin; the shared system UID already grants it"],
  ["android.permission.READ_PRIVILEGED_PHONE_STATE", "read the IMEI inside the privileged LPA host instead"],
  ["android.permission.REBOOT", "call PowerManager.reboot() instead"],
  ["android.permission.INSTALL_PACKAGES", "stage through the installer provider instead"],
  ["android.permission.DELETE_PACKAGES", "stage through the installer provider instead"],
  ["android.permission.MANAGE_USERS", "no manifest declaration can grant this to a /data/app package"],
]);

async function findManifests(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "build" || entry.name === "node_modules" || entry.name === ".gradle") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findManifests(full)));
    else if (entry.name === "AndroidManifest.xml") found.push(full);
  }
  return found;
}

test("no device manifest declares a permission that boot-loops the Pin", async () => {
  const manifests = await findManifests(pinRoot);
  assert.ok(manifests.length >= 4, `expected the device manifests to be found, saw ${manifests.length}`);

  const offences = [];
  for (const manifest of manifests) {
    const text = await readFile(manifest, "utf8");
    // Comments in these files quote the forbidden names deliberately, that is
    // how the next person learns why they are absent, so they must not be read
    // as declarations.
    const declarations = text.replace(/<!--[\s\S]*?-->/gu, "");
    for (const match of declarations.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/gu)) {
      const permission = match[1];
      if (PERMITTED.has(permission)) continue;
      const relative = path.relative(root, manifest);
      const known = KNOWN_FATAL.get(permission);
      offences.push(
        known
          ? `${relative}: ${permission} — ${known}`
          : `${relative}: ${permission} — not reviewed. Confirm its protectionLevel is normal or dangerous, then add it to PERMITTED with that evidence. If it is signature or privileged, it cannot be declared here at all.`,
      );
    }
  }

  assert.deepEqual(
    offences,
    [],
    `a /data/app manifest declares a permission the platform allowlist cannot grant:\n  ${offences.join("\n  ")}`,
  );
});

test("the server manifest still carries the warning that explains the absence", async () => {
  const manifest = await readFile(
    path.join(pinRoot, "runtime/android/src/main/AndroidManifest.xml"),
    "utf8",
  );
  // The empty space where WRITE_SECURE_SETTINGS used to be is not self-explanatory,
  // and the obvious "fix" for a Settings.Global SecurityException is to add it back.
  assert.match(manifest, /privapp allowlist/u);
  assert.match(manifest, /android:sharedUserId="android\.uid\.system"/u);
});
