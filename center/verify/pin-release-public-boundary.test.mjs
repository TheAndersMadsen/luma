import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (filename) => readFile(new URL(filename, root), "utf8");

test("middleware exposes only the exact read-only Pin release prefix", async () => {
  const middleware = await source("src/middleware.ts");
  const match = middleware.match(
    /export function isPublicPinReleaseRequest[\s\S]*?\n}/,
  );
  assert.ok(match, "public Pin release predicate must remain source-visible");
  const executable = match[0]
    .replace(/^export /, "")
    .replaceAll(": string", "")
    .replace(": boolean", "");
  const isPublicPinReleaseRequest = Function(
    `"use strict"; ${executable}; return isPublicPinReleaseRequest;`,
  )();

  for (const pathname of [
    "/api/pin/releases/current",
    `/api/pin/releases/${"a".repeat(64)}/installer.apk`,
  ]) {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      assert.equal(isPublicPinReleaseRequest(pathname, method), true, `${method} ${pathname}`);
    }
  }
  for (const pathname of [
    "/api/pin/releases",
    "/api/pin/releasesish/current",
    "/api/pin/release/current",
    "/api/pin/status",
    "/api/pin",
  ]) {
    assert.equal(isPublicPinReleaseRequest(pathname, "GET"), false, pathname);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"]) {
    assert.equal(
      isPublicPinReleaseRequest("/api/pin/releases/current", method),
      false,
      method,
    );
  }
  assert.match(
    middleware,
    /isPublicPinReleaseRequest\(pathname, request\.method\)/,
  );
});

test("Pin release route modules export no mutation handlers", async () => {
  const routes = await Promise.all([
    source("src/app/api/pin/releases/current/route.ts"),
    source("src/app/api/pin/releases/[releaseId]/[asset]/route.ts"),
  ]);
  for (const route of routes) {
    assert.match(route, /export (?:async )?function GET\b/);
    assert.match(route, /export (?:async )?function HEAD\b/);
    assert.match(route, /export (?:async )?function OPTIONS\b/);
    for (const mutation of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.doesNotMatch(
        route,
        new RegExp(`export (?:async )?function ${mutation}\\b`),
      );
    }
  }
});
