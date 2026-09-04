import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/operator", () => ({ currentSession: mocks.session }));
vi.mock("@/server/auth", () => ({ AUTH_ENABLED: true }));
vi.mock("./Surfaces", () => ({ Surfaces: () => null }));
import Page from "./page";
it("page has its own verified session gate independent of middleware", async () => {
  mocks.session.mockResolvedValue(null);
  await expect(Page()).rejects.toThrow("redirect");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fsettings%2Faccount%2Fsurfaces");
  mocks.session.mockResolvedValue({ sub: "owner" });
  await expect(Page()).resolves.toBeTruthy();
});
