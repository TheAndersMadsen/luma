import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Center's default protocol-definitions path must point at protos that exist.
 *
 * It pointed at `../cosmos/contracts` for as long as this module has existed —
 * a directory that has never been in this tree; the wire contracts live in
 * `contracts/wire`. Only the container ever set the `COSMOS_CONTRACTS_DIR`
 * override, so the documented developer flow (`npm ci && npm run dev`) loaded
 * nothing, `protoLoader.loadSync` threw ENOENT inside the first gRPC call, and
 * every pane that reads a workload — contacts, account details, my-data, note
 * creation, memory delete — reported "cosmos error: …", the wording reserved for
 * a backend outage. A stale path inside Center rendered as an outage in Cosmos.
 *
 * Nothing caught it because nothing ever asked whether the path resolved. This
 * asks.
 */

const CENTER = new URL("../", import.meta.url);

/** Exactly the entry points `loadPackage()` passes to proto-loader. */
const LOADED = [
  "humane/capture.proto",
  "humane/events.proto",
  "humane/contacts.proto",
  "humane/account.proto",
  "humane/privacy/grpc/pub.proto",
];

test("the default contracts directory exists and holds every proto Center loads", async () => {
  const cosmos = await readFile(new URL("src/server/cosmos.ts", CENTER), "utf8");

  // The fallback is a `path.join(process.cwd(), …)` beside the env override, and
  // `process.cwd()` is this directory when Center runs from source.
  const fallback = /path\.join\(process\.cwd\(\),\s*([^)]*)\)/.exec(cosmos);
  assert.ok(fallback, "src/server/cosmos.ts no longer derives a default contracts path");
  const segments = fallback[1]
    .split(",")
    .map((part) => part.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter(Boolean);
  assert.deepEqual(segments, ["..", "contracts", "wire"]);

  const root = new URL(`${segments.join("/")}/`, CENTER);
  for (const proto of LOADED) {
    await access(new URL(proto, root));
  }
});

test("a contracts directory Center cannot read is reported as Center's problem", async () => {
  const [cosmos, source] = await Promise.all([
    readFile(new URL("src/server/cosmos.ts", CENTER), "utf8"),
    readFile(new URL("src/server/domain/provenance.ts", CENTER), "utf8"),
  ]);

  // Typed at the throw site and named at the description site: a missing
  // contracts directory must never reach a wearer as "cosmos error", which sends
  // every reader to look at a backend that is fine.
  assert.match(cosmos, /class ContractsUnavailableError extends Error/);
  assert.match(cosmos, /throw new ContractsUnavailableError\(PROTO_ROOT, error\)/);
  assert.match(cosmos, /set COSMOS_CONTRACTS_DIR/);
  assert.match(source, /error instanceof ContractsUnavailableError/);
});
