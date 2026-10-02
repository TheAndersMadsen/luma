// @vitest-environment node
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterEach, describe, expect, it, vi } from "vitest";

// What Center logged, so a test can read the reason it kept.
const warnings = vi.hoisted(() => [] as unknown[][]);
vi.mock("./log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./log")>()),
  logWarn: (...args: unknown[]) => warnings.push(args),
}));

// A signed-in wearer: the calls below forward their Bearer.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  readTokenCookie: () => "sealed-cookie",
  openTokens: async () => ({
    accessToken: "wearer-access-token",
    refreshToken: "wearer-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

async function cosmosWith(environment: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  return import("./cosmos");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cosmos refusing the wearer's identity", () => {
  it("answers a webapi 401 to the wearer's Bearer as sign in again, not as an outage", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cosmos.webapiGet("/account-service/passcode")).rejects.toBeInstanceOf(cosmos.SessionExpiredError);
    await expect(cosmos.webapiPut("/account-service/passcode", { passcode: "1234" })).rejects.toBeInstanceOf(
      cosmos.SessionExpiredError,
    );
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ authorization: "Bearer wearer-access-token" });
  });

  it("keeps every other refusal an ordinary failure", async () => {
    const cosmos = await cosmosWith({ COSMOS_WEBAPI_BASE_URL: "http://cosmos.test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const error = await cosmos.webapiGet("/account-service/passcode").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(cosmos.SessionExpiredError);
    expect(String(error)).toContain("webapi /account-service/passcode -> 503");

    // Without a Bearer there is no identity of the wearer's to refuse.
    expect(cosmos.webapiError("/x", 401, {})).not.toBeInstanceOf(cosmos.SessionExpiredError);
    expect(cosmos.webapiError("/x", 401, { authorization: "Bearer t" })).toBeInstanceOf(cosmos.SessionExpiredError);
  });

  it("answers gRPC UNAUTHENTICATED the same way, and logs the check Cosmos named", async () => {
    const wire = fileURLToPath(new URL("../../../contracts/wire", import.meta.url));
    const definition = protoLoader.loadSync("humane/contacts.proto", { keepCase: false, includeDirs: [wire] });
    const { humane } = grpc.loadPackageDefinition(definition) as unknown as {
      humane: { contacts: { ContactsRPCService: { service: grpc.ServiceDefinition } } };
    };
    const server = new grpc.Server();
    let authorization: grpc.MetadataValue[] = [];
    server.addService(humane.contacts.ContactsRPCService.service, {
      GetContacts(call: grpc.ServerUnaryCall<unknown, unknown>, done: grpc.sendUnaryData<unknown>) {
        authorization = call.metadata.get("authorization");
        done({ code: grpc.status.UNAUTHENTICATED, details: "missing field `sub` at line 1 column 80" });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) =>
        error ? reject(error) : resolve(bound),
      ),
    );
    try {
      const cosmos = await cosmosWith({ COSMOS_ENDPOINT_CONTACTS: `127.0.0.1:${port}`, COSMOS_CONTRACTS_DIR: wire });
      warnings.length = 0;
      await expect(cosmos.call(cosmos.Services.contacts, "GetContacts", {})).rejects.toBeInstanceOf(
        cosmos.SessionExpiredError,
      );
      expect(authorization).toEqual(["Bearer wearer-access-token"]);
      expect(warnings).toContainEqual([
        "cosmos: humane.contacts.ContactsRPCService.GetContacts refused this session's identity; the wearer must sign in again",
        "missing field `sub` at line 1 column 80",
      ]);
    } finally {
      server.forceShutdown();
    }
  });
});
