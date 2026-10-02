// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({ createCaptureShareLink: vi.fn() }));

vi.mock("@/server/cosmos", async (importOriginal) => {
  const { CosmosHttpError, SessionExpiredError } =
    await importOriginal<typeof import("@/server/cosmos")>();
  return { CosmosHttpError, SessionExpiredError };
});
vi.mock("@/server/domain/captures", () => ({
  createCaptureShareLink: domain.createCaptureShareLink,
}));

import { CosmosHttpError } from "@/server/cosmos";
import { POST } from "./route";

const UUID = "11111111-2222-4333-8444-555555555555";

/** Share once, with Cosmos answering `status` the way `webapiPost` reports it. */
async function shareWhenCosmosAnswers(status: number) {
  domain.createCaptureShareLink.mockRejectedValueOnce(
    new CosmosHttpError(`/capture/memory/${UUID}/share-link`, status),
  );
  const response = await share("http://center.test");
  return { status: response.status, body: await response.json() };
}

function share(origin: string) {
  return POST(
    new Request(`http://center.test/api/capture/memory/${UUID}/share`, {
      method: "POST",
      headers: { origin },
    }),
    { params: Promise.resolve({ uuid: UUID }) },
  );
}

afterEach(() => vi.clearAllMocks());

describe("POST /api/capture/memory/{uuid}/share", () => {
  it("says sharing is not set up only when Cosmos has no share authority", async () => {
    expect(await shareWhenCosmosAnswers(501)).toEqual({
      status: 200,
      body: { url: null, note: "Sharing isn't set up on this server." },
    });
  });

  it("reports a store outage as a failure worth retrying", async () => {
    expect(await shareWhenCosmosAnswers(503)).toEqual({
      status: 502,
      body: { url: null, note: "We couldn't create a share link right now." },
    });
  });

  it("mints no public link for another site's page", async () => {
    const response = await share("https://evil.test");
    expect(response.status).toBe(403);
    expect(domain.createCaptureShareLink).not.toHaveBeenCalled();
  });

  it("tells a capture Cosmos does not hold apart from both", async () => {
    expect(await shareWhenCosmosAnswers(404)).toEqual({
      status: 200,
      body: { url: null, note: "This capture isn't available to share." },
    });
  });
});
