import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

/*
 * ONE share authority, and it is Cosmos.
 *
 * Center used to mint its own JWE share tokens under COSMOS_SHARE_TOKEN_SECRET
 * and resolve them at `/share/<jwe>` through a privileged projection read,
 * while the Pin's GetMemoryShareLink minted a different Cosmos link nothing
 * served. Now Cosmos mints one stock-shaped link for both, and Center's public
 * page `/humane.center/share/capture/{uuid}?expiry&signature` only hands the
 * link to Cosmos's `/share/capture/{uuid}/thumbnail` and shows what comes back.
 */

const requests = [];
let answer = () => ({ status: 404, headers: {}, body: "" });
const cosmos = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, headers: request.headers });
  const { status, headers, body } = answer(request);
  response.writeHead(status, headers);
  response.end(body);
});
await new Promise((resolve) => cosmos.listen(0, "127.0.0.1", resolve));
test.after(() => cosmos.close());

process.env.COSMOS_WEBAPI_BASE_URL = `http://127.0.0.1:${cosmos.address().port}`;
const { resolveSharedCapture } = await import("../src/server/domain/captures.ts?capture-share");

const UUID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SIGNATURE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test("a share link is resolved by Cosmos with the link's own capability and nothing else", async () => {
  requests.length = 0;
  answer = () => ({
    status: 200,
    headers: { "content-type": "image/jpeg", "x-cosmos-projection": "opened" },
    body: JPEG,
  });
  const shared = await resolveSharedCapture(UUID, "1790000000", SIGNATURE);
  assert.equal(shared.status, "ok");
  assert.deepEqual(shared.bytes, JPEG);
  assert.equal(shared.contentType, "image/jpeg");

  assert.equal(requests.length, 1);
  const [{ method, url, headers }] = requests;
  assert.equal(method, "GET");
  assert.equal(url, `/share/capture/${UUID}/thumbnail?expiry=1790000000&signature=${SIGNATURE}`);
  // The capability is the whole authorization: no wearer identity, no
  // deployment secret, nothing a public visitor could borrow.
  for (const name of [
    "authorization",
    "x-forwarded-client-cert",
    "x-cosmos-web-projection-token",
    "x-cosmos-edge-token",
  ]) {
    assert.equal(headers[name], undefined, `${name} must not travel with a public share read`);
  }
});

test("a link Cosmos refuses is invalid, and one it cannot answer is a retry", async () => {
  answer = () => ({ status: 404, headers: {}, body: "" });
  assert.deepEqual(await resolveSharedCapture(UUID, "1790000000", SIGNATURE), { status: "invalid" });

  // Sharing no longer set up on this server: a fact no retry changes.
  answer = () => ({ status: 501, headers: {}, body: "sharing is not set up on this server" });
  assert.deepEqual(await resolveSharedCapture(UUID, "1790000000", SIGNATURE), { status: "invalid" });

  answer = () => ({ status: 503, headers: {}, body: "the store is unavailable" });
  assert.deepEqual(await resolveSharedCapture(UUID, "1790000000", SIGNATURE), { status: "degraded" });

  // A 200 that is not an opened image is not a picture to publish.
  answer = () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "sealed" });
  assert.deepEqual(await resolveSharedCapture(UUID, "1790000000", SIGNATURE), { status: "degraded" });
});

test("a malformed link is refused before Cosmos is asked", async () => {
  requests.length = 0;
  for (const [uuid, expiry, signature] of [
    ["../../capture/captures", "1790000000", SIGNATURE],
    [UUID, undefined, SIGNATURE],
    [UUID, "tomorrow", SIGNATURE],
    [UUID, "1790000000", undefined],
    [UUID, "1790000000", "short"],
    [UUID, "1790000000", `${SIGNATURE}&memory_uuid=x`],
  ]) {
    assert.deepEqual(await resolveSharedCapture(uuid, expiry, signature), { status: "invalid" });
  }
  assert.equal(requests.length, 0);
});

test("the public page lives at the stock path and Center holds no share key", async () => {
  const page = await readFile(
    new URL("../src/app/humane.center/share/capture/[uuid]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /resolveSharedCapture\(uuid, expiry, signature\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  // A forged, expired, or malformed link is a real 404, not a 200 page.
  assert.match(page, /if \(shared\.status === "invalid"\) notFound\(\);/);
  assert.doesNotMatch(page, /isn&rsquo;t valid/);
  const notFound = await readFile(
    new URL("../src/app/humane.center/share/capture/[uuid]/not-found.tsx", import.meta.url),
    "utf8",
  );
  assert.match(notFound, /This share link isn&rsquo;t valid or has expired\./);

  for (const retired of [
    "../src/server/shareToken.ts",
    "../src/app/share",
    "../src/app/api/share",
  ]) {
    await assert.rejects(access(new URL(retired, import.meta.url)), `${retired} is back`);
  }

  // No Center source mints, verifies or even names the retired secret.
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) await walk(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(child);
    }
  }
  await walk(new URL("../src/", import.meta.url));
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /COSMOS_SHARE_TOKEN_SECRET|mintShareToken|verifyShareToken/, file.pathname);
  }

  const middleware = await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /pathname\.startsWith\("\/humane\.center\/share\/"\)/);
});
