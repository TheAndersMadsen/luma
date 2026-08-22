import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

process.env.COSMOS_WEBAPI_BASE_URL = "https://cosmos-backend.test";
process.env.COSMOS_CENTER_PROJECTION_TOKEN = "projection-token-before-rename";
process.env.COSMOS_EDGE_TOKEN = "edge-token-before-rename";
delete process.env.COSMOS_EDGE_TOKEN_HEADER;
delete process.env.COSMOS_PRINCIPAL;

const {
  requestMetadata,
  webapiGetForUser,
} = await import("../src/server/cosmos.ts?carry-header-contracts");
const {
  getCaptureOriginal,
} = await import("../src/server/domain/captures.ts?carry-header-contracts");

test("Center issues the stable Carry projection and edge headers", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(null, { status: 204 });
  };

  await webapiGetForUser("/capture/memory/existing", "wearer-before-rename");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].headers.get("x-carry-web-projection-token"),
    "projection-token-before-rename",
  );
  assert.equal(calls[0].headers.has("x-cosmos-web-projection-token"), false);

  const metadata = await requestMetadata();
  assert.deepEqual(metadata.get("x-carry-edge-token"), ["edge-token-before-rename"]);
  assert.deepEqual(metadata.get("x-cosmos-edge-token"), []);
});

test("capture projection consumes only the authenticated Carry verdict", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(Uint8Array.of(0xff, 0xd8, 0xff), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "x-carry-projection": "opened",
    },
  });
  const opened = await getCaptureOriginal("existing", 0);
  assert.equal(opened?.contentType, "image/jpeg");
  await opened?.body.cancel();

  globalThis.fetch = async () => new Response(Uint8Array.of(0xff, 0xd8, 0xff), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "x-cosmos-projection": "opened",
    },
  });
  await assert.rejects(
    getCaptureOriginal("existing", 0),
    /projection returned sealed or non-image data/u,
  );
});
