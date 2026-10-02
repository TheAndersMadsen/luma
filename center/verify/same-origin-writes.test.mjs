import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { balanced, maskSource, sourceFiles } from "./sourceScan.mjs";

/*
 * Every browser write refuses another site's page.
 *
 * The session cookie is SameSite=lax, so it rides along on a simple POST from
 * any page on the same site, including another hostname the owner routes
 * through Luma's Traefik. A route that changes the wearer's data must check the
 * request's Origin itself (`isSameOriginRequest`, or the Spotify routes'
 * `requireSameOrigin`), in the handler or in a helper in the same file.
 *
 * This is a PROPERTY over every mutating handler under app/api, found by
 * scanning, so a new write route is covered on the day it is written. The only
 * exemptions are named here with the reason no browser Origin applies.
 */

const API = new URL("../src/app/api/", import.meta.url);
const GATE = /\b(?:isSameOriginRequest|requireSameOrigin)\s*\(/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EXEMPT = new Map([
  // Signing in is how a browser gets a session. It has none to abuse yet.
  ["auth/login/route.ts POST", "sign-in"],
  // Clearing the caller's own cookies. At worst a sign-out.
  ["auth/logout/route.ts POST", "sign-out"],
  // Called by Cosmos with the internal music token, never by a browser.
  ["internal/music/query/route.ts POST", "internal caller"],
  // Called by the Pin with its device credential, never by a browser.
  ["music-gateway/playback/route.ts POST", "device caller"],
  ["music-gateway/query/route.ts POST", "device caller"],
  ["music-gateway/save/route.ts POST", "device caller"],
]);

/** The body of `function name(…) { … }` in the masked source, or null. */
function functionBody(masked, name) {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(masked);
  if (!declaration) return null;
  const parameters = balanced(masked, declaration.index + declaration[0].length - 1);
  if (!parameters) return null;
  const open = masked.indexOf("{", parameters.end);
  return open < 0 ? null : (balanced(masked, open)?.text ?? null);
}

/** Does this body check the Origin, itself or through a helper in the file? */
function gated(masked, body, seen = new Set()) {
  if (GATE.test(body)) return true;
  for (const [, callee] of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (seen.has(callee)) continue;
    seen.add(callee);
    const inner = functionBody(masked, callee);
    if (inner !== null && gated(masked, inner, seen)) return true;
  }
  return false;
}

/** Each mutating method a route file exports, with the local function behind it. */
function mutatingHandlers(masked) {
  const handlers = [];
  for (const match of masked.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/g)) {
    if (MUTATING.has(match[1])) handlers.push({ method: match[1], local: match[1] });
  }
  // `export { handle as POST, … }`
  for (const list of masked.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const binding of list[1].split(",")) {
      const [local, exported = local] = binding.trim().split(/\s+as\s+/);
      if (MUTATING.has(exported)) handlers.push({ method: exported, local });
    }
  }
  for (const match of masked.matchAll(/export\s+const\s+([A-Z]+)\b/g)) {
    if (MUTATING.has(match[1])) handlers.push({ method: match[1], local: null });
  }
  return handlers;
}

test("every mutating API route refuses a cross-site request", async () => {
  const routes = (await sourceFiles(API, readdir)).filter((file) => file.pathname.endsWith("/route.ts"));
  const ungated = [];
  const exempted = new Set();
  let checked = 0;

  for (const file of routes) {
    const relative = decodeURIComponent(file.pathname).split("/app/api/").pop();
    const masked = maskSource(await readFile(file, "utf8"));
    for (const { method, local } of mutatingHandlers(masked)) {
      const key = `${relative} ${method}`;
      if (EXEMPT.has(key)) {
        exempted.add(key);
        continue;
      }
      checked += 1;
      const body = local === null ? null : functionBody(masked, local);
      if (body === null || !gated(masked, body)) ungated.push(key);
    }
  }

  assert.deepEqual(ungated, [], `these writes accept another site's request: ${ungated.join(", ")}`);
  // The scan must find the writes it vouches for, and every exemption must
  // still name a real handler, or a rename would quietly widen it.
  assert.ok(checked >= 50, `only ${checked} mutating handlers were found; the scan has stopped seeing them`);
  assert.deepEqual([...EXEMPT.keys()].filter((key) => !exempted.has(key)), [], "an exemption names no handler");
});
