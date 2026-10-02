import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { evaluateYoutubePlayerScript } from "../src/server/youtubePlayerEvaluator.ts";
import { youtubeContentProofToken } from "../src/server/youtubePoToken.ts";

// INFERRED runtime boundary checks: provider scripts may fail to terminate,
// return malformed data, or exceed memory. These synthetic inputs never reach
// a provider and contain no credentials or recovered player code.
test("YouTube player worker terminates CPU-bound evaluation without blocking Center", async () => {
  let parentTimerFired = false;
  const timer = setTimeout(() => { parentTimerFired = true; }, 50);
  const started = Date.now();
  await assert.rejects(
    () => evaluateYoutubePlayerScript({ output: "while (true) {}" }, {}),
    /YouTube player (evaluation timed out|evaluation failed)/,
  );
  clearTimeout(timer);
  assert.equal(parentTimerFired, true);
  assert.ok(Date.now() - started < 2500);
});

test("YouTube player worker validates results before returning them", async () => {
  for (const output of ["return null;", "return { n: 7 };", "return { sig: '\\n' };"]) {
    await assert.rejects(
      () => evaluateYoutubePlayerScript({ output }, {}),
      /YouTube player (result was invalid|evaluation failed)/,
    );
  }
  assert.deepEqual(await evaluateYoutubePlayerScript({ output: "return { n, sig };" }, { n: "abc_-", sig: "xyz" }), { n: "abc_-", sig: "xyz" });
});

test("aborted YouTube proof work releases the queue even if its fetch ignores cancellation", async () => {
  const controller = new AbortController();
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const first = youtubeContentProofToken("SD4yRDY9mek", async () => {
    notifyStarted();
    return new Promise(() => {});
  }, controller.signal);
  await started;
  controller.abort(new Error("owner cancelled"));
  await assert.rejects(first, /owner cancelled/);
  const second = youtubeContentProofToken("SD4yRDY9mek", async () => new Response("[]", { status: 503 }));
  let deadline;
  try {
    await assert.rejects(Promise.race([
      second,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("proof queue stayed blocked")), 10_000); }),
    ]), /YouTube integrity request failed/);
  } finally { clearTimeout(deadline); }
});

test("YouTube proof responses bound the challenge body before interpreting it", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? 8 * 1024 * 1024 : 1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  await assert.rejects(() => youtubeContentProofToken("SD4yRDY9mek", async () => response), /YouTube integrity response was oversized/);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test("YouTube proof worker preserves content binding and caches only the minter", async () => {
  // A synthetic interpreter returns meaningless test bytes, never a provider
  // proof. It exercises the existing callback contract and IPC byte ordering.
  const script = `console.log("harmless provider diagnostic");
  window.fixtureGuard = { a(_program, setup) {
    setup((snapshot, args) => {
      args[2].push(async () => async binding => {
        const bytes = new Uint8Array(60);
        bytes.set(binding, 49);
        return bytes;
      });
      snapshot("fixture-snapshot");
    });
    return [() => {}];
  } };`;
  const calls = [];
  const fetchFixture = async (input, init) => {
    calls.push(String(input));
    assert.ok(init.signal instanceof AbortSignal);
    if (String(input).endsWith("/Create")) {
      return Response.json([["message", [script], [], "hash", "program", "fixtureGuard"]]);
    }
    assert.ok(String(input).endsWith("/GenerateIT"));
    return Response.json([Buffer.alloc(32).toString("base64"), 300, 30]);
  };
  for (const id of ["SD4yRDY9mek", "dQw4w9WgXcQ"]) {
    const token = await youtubeContentProofToken(id, fetchFixture);
    assert.equal(Buffer.from(token, "base64url").subarray(49).toString(), id);
  }
  assert.equal(calls.length, 2, "reusing a minter does not reuse the per-video proof");
});

test("YouTube proof worker terminates CPU-bound attestation and permits another request", async () => {
  const controller = new AbortController();
  let parentTimerFired = false;
  let challengeDeliveredAt;
  const fetchFixture = async () => {
    challengeDeliveredAt = Date.now();
    setTimeout(() => {
      parentTimerFired = true;
      controller.abort(new Error("proof cancelled"));
    }, 100);
    return Response.json([["message", ["while (true) {}"], [], "hash", "program", "fixtureGuard"]]);
  };
  await assert.rejects(() => youtubeContentProofToken("SD4yRDY9mek", fetchFixture, controller.signal), /proof cancelled/);
  assert.equal(parentTimerFired, true);
  assert.ok(Date.now() - challengeDeliveredAt < 2500);
  await assert.rejects(() => youtubeContentProofToken("SD4yRDY9mek", async () => new Response("[]", { status: 503 })), /YouTube integrity request failed/);
});


test("YouTube Disconnect aborts the real SDK bootstrap fetch in an isolated no-network process", () => {
  const script = `
    import assert from "node:assert/strict";
    process.env.COSMOS_WEBAPI_BASE_URL = "http://cosmos.test:8081";
    process.env.COSMOS_EDGE_TOKEN = "fixture-edge";
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let providerSignal;
    // Install the mock BEFORE importing the gateway. No native fetch survives
    // and every unmodeled URL fails rather than contacting a provider.
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "http://cosmos.test:8081" && url.pathname === "/account-service/music-providers/credentials") {
        return request.method === "GET" ? Response.json({ revision: 0, accounts: {} }) : Response.json({ revision: 1 });
      }
      if (url.origin === "https://www.youtube.com" && url.pathname === "/youtubei/v1/config") return Response.json({});
      assert.equal(url.href, "https://www.youtube.com/tv", "unmodeled provider request");
      providerSignal = request.signal;
      started.resolve();
      await release.promise;
      return new Response("", { status: 503 });
    };
    const youtube = await import("./src/server/youtubeMusic.ts");
    const connect = youtube.startYoutubeConnection("bootstrap-fixture").catch(error => error);
    assert.equal(await Promise.race([started.promise.then(() => true), connect]), true);
    try {
      await youtube.disconnectYoutube("bootstrap-fixture");
      assert.equal(providerSignal.aborted, true, "Disconnect must cancel OAuth bootstrap HTTP work");
      const error = await connect;
      assert.equal(error.status, 401);
    } finally {
      release.resolve();
      await connect;
    }
  `;
  const result = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
