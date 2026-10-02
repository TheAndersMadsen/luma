import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { sourceFiles } from "./sourceScan.mjs";

/*
 * A signal nobody reads is not a signal.
 *
 * This deployment has now shipped the same shape twice. The BFF learned to tell
 * an expired Keycloak grant apart from a backend outage, `SessionExpiredError`,
 * 401 + `reauthenticate: true` across a dozen routes, `x-data-reauthenticate: 1`
 * on the responses that answer with a bare JSON array, and a `reauthenticate`
 * field computed by /api/health, and then NOTHING on the client read any of it.
 * `fetchJson` read four headers and not the fifth; `useBackendHealth` copied
 * eight fields and dropped the ninth. The badge picked its words from `state`
 * alone. So a wearer whose session had lapsed was told "Your Pin couldn't be
 * reached just now", which is a claim about hardware that is fine, and whoever
 * was on call was sent to a Cosmos that was answering perfectly.
 *
 * Every emitter and consumer test in this repo would have passed throughout.
 * The property that was missing is the one below: the two halves have to be
 * connected, and a new signal that lands on only one side fails on the day it
 * is written.
 */

const SRC = new URL("../src/", import.meta.url);

/** Where a wire signal is produced. */
const EMITTER_TREES = ["server/", "app/api/"];

/** Where something can act on it: the client data layer and the UI. */
const READER_TREES = ["lib/", "components/"];

async function textUnder(trees) {
  const files = [];
  for (const tree of trees) {
    for (const file of await sourceFiles(new URL(tree, SRC), readdir)) {
      files.push({
        relative: decodeURIComponent(file.pathname).split("/src/").pop(),
        source: await readFile(file, "utf8"),
      });
    }
  }
  return files;
}

test("every x-data-* header the BFF emits is read on the client", async () => {
  const emitted = new Set();
  for (const { source } of await textUnder(EMITTER_TREES)) {
    for (const [, name] of source.matchAll(/"(x-data-[a-z-]+)"/g)) emitted.add(name);
  }

  const readers = await textUnder(READER_TREES);
  const unread = [...emitted].filter(
    (name) => !readers.some(({ source }) => source.includes(`"${name}"`)),
  );

  assert.deepEqual(
    unread,
    [],
    `${unread.join(", ")} is emitted by the BFF and read by nothing under src/lib or src/components, so whatever it says never reaches the wearer`,
  );

  // Anti-vacuity: a regex that matched nothing would pass the assertion above
  // without connecting anything, which is the exact failure being tested for.
  for (const required of ["x-data-state", "x-data-degraded", "x-data-reauthenticate"]) {
    assert.ok(emitted.has(required), `the emitter scan never found ${required}`);
  }
});

test("the expired session the BFF flags is what the wearer is actually told", async () => {
  const routes = (await textUnder(["app/api/"])).filter(({ relative }) =>
    /route\.ts$/.test(relative),
  );
  const flagging = routes.filter(({ source }) => /sessionExpiredResponse\(|reauthenticate: true/.test(source));
  assert.ok(
    flagging.length >= 8,
    `only ${flagging.length} routes flag an expired session; the emitter half is missing`,
  );

  // 1. The data layer has to contain it, from BOTH transports: a header for the
  //    routes that answer with a bare array and have nowhere in the body to put
  //    it, and the body field /api/health computes for the chrome badge.
  const queries = await readFile(new URL("lib/queries.ts", SRC), "utf8");
  assert.match(
    queries,
    /x-data-reauthenticate/,
    "fetchJson does not read x-data-reauthenticate, so a pane fed by a bare array cannot tell an expiry from an outage",
  );
  assert.match(
    queries,
    /healthInfoSchema\.safeParse/,
    "useBackendHealth must validate and retain the shared health response, including reauthenticate",
  );
  assert.match(
    queries,
    /reauthenticate\?: true/,
    "SourceInfo/HealthInfo do not declare the field, so no consumer can branch on it",
  );

  // 2. …and something on screen has to change because of it. The badge is the
  //    one control the wearer sees on every page.
  const status = await readFile(new URL("components/Status.tsx", SRC), "utf8");
  assert.match(
    status,
    /data\.reauthenticate === true/,
    "SourceBadge still picks its words from `state` alone, so an expiry renders as an outage",
  );
  assert.match(
    status,
    /Reconnect to Center/,
    "SourceBadge branches on the expiry without telling the wearer what to do about it",
  );
  // Reloading cannot fix this case, the Center cookie is still valid, so
  // middleware has no reason to redirect, which is why the way out has to be
  // on screen.
  assert.match(
    status,
    /SessionReconnect/,
    "SourceBadge names the remedy but offers no way to reach it",
  );
});
