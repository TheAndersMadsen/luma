import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.COSMOS_WEBAPI_BASE_URL = "http://cosmos.example.test";
process.env.KEYCLOAK_BASE_URL = "";
process.env.COSMOS_PRINCIPAL = "U:synthetic-wearer";

const cosmos = await import("../src/server/cosmos.ts");
const notes = await import("../src/server/domain/notes.ts");
const account = await import("../src/server/domain/account.ts");
const events = await import("../src/server/domain/events.ts");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test("HTTP status survives changes to the diagnostic message", async () => {
  const cases = [
    [404, () => notes.editNote("synthetic-note", { text: "Edit" }), "not_found"],
    [413, () => notes.createNote({ text: "Edit" }), "too_large"],
    [400, () => account.saveAccountDetails({ preferredName: "Ada", pronunciation: "" }), "invalid"],
    [409, () => account.pairDevice("synthetic-pin"), "conflict"],
    [409, () => account.deleteAccount(), "conflict"],
  ];
  for (const [status, operation, refusal] of cases) {
    const error = cosmos.webapiError("/synthetic", status, {});
    assert.ok(error instanceof cosmos.CosmosHttpError);
    assert.equal(error.status, status);
    error.message = "A diagnostic sentence without a status code.";
    globalThis.fetch = async () => { throw error; };
    const result = await operation();
    assert.equal(result.refusal, refusal);
    assert.equal(result.data, null);
  }
  const missing = cosmos.webapiError("/synthetic", 404, {});
  missing.message = "The wording changed.";
  globalThis.fetch = async () => { throw missing; };
  assert.equal((await notes.getNote("synthetic-note")).state, "live");
  assert.equal((await events.setEventVote("synthetic-event", "up")).state, "live");
});

test("ordinary errors that end in an HTTP-looking number are outages, not refusals", async () => {
  for (const [status, operation] of [
    [404, () => notes.getNote("synthetic-note")],
    [413, () => notes.createNote({ text: "Edit" })],
    [400, () => account.saveAccountDetails({ preferredName: "Ada", pronunciation: "" })],
    [409, () => account.pairDevice("synthetic-pin")],
    [404, () => events.setEventVote("synthetic-event", "up")],
  ]) {
    globalThis.fetch = async () => { throw new Error(`Unrelated failure -> ${status}`); };
    const result = await operation();
    assert.equal(result.state, "degraded");
    assert.equal(result.refusal, undefined);
  }
});

test("a rejected wearer bearer retains the dedicated session-expired outcome", async () => {
  globalThis.fetch = async () => { throw cosmos.webapiError("/synthetic", 401, { authorization: "Bearer synthetic" }); };
  const result = await notes.createNote({ text: "Edit" });
  assert.equal(result.reauthenticate, true);
  assert.equal(result.refusal, undefined);
});
