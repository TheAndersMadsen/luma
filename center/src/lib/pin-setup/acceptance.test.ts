import { describe, expect, it } from "vitest";
import {
  setupAcceptanceConfirmed,
  setupAcceptanceRequest,
  setupAcceptanceTarget,
} from "./acceptance";

const releaseId = "a".repeat(64);

describe("setup physical acceptance", () => {
  it("binds the acknowledgment to the exact Pin, release, and Cosmos edge", () => {
    expect(
      setupAcceptanceTarget(
        " pin-1 ",
        releaseId,
        " 2026-08-27.1 ",
        "203.0.113.9",
      ),
    ).toEqual({
      deviceSerial: "PIN-1",
      releaseId,
      releaseVersion: "2026-08-27.1",
      edgeIpv4: "203.0.113.9",
    });
    expect(setupAcceptanceTarget(null, releaseId, "2026-08-27.1", "203.0.113.9")).toBeNull();
    expect(setupAcceptanceTarget("PIN-1", "bad", "2026-08-27.1", "203.0.113.9")).toBeNull();
    expect(setupAcceptanceTarget("PIN-1", releaseId, null, "203.0.113.9")).toBeNull();
    expect(setupAcceptanceTarget("PIN-1", releaseId, "2026-08-27.1", null)).toBeNull();
    expect(
      setupAcceptanceTarget("PIN-1", releaseId, "2026-08-27.1", "203.0.113.009"),
    ).toBeNull();
  });

  it("requires Pin readback for the exact current identity", () => {
    const target = setupAcceptanceTarget(
      "PIN-1",
      releaseId,
      "2026-08-27.1",
      "203.0.113.9",
    )!;
    const confirmation = {
      schema_version: 1 as const,
      device_serial: target.deviceSerial,
      release_id: target.releaseId,
      release_version: target.releaseVersion,
      edge_ipv4: target.edgeIpv4,
      confirmed_at_epoch_ms: 1_788_000_000_000,
    };
    const response = {
      schema_version: 1 as const,
      current: {
        device_serial: target.deviceSerial,
        release_version: target.releaseVersion,
        edge_ipv4: target.edgeIpv4,
      },
      confirmation,
    };

    expect(setupAcceptanceConfirmed(response, target)).toBe(true);
    expect(setupAcceptanceConfirmed({ ...response, confirmation: null }, target)).toBe(false);
    expect(
      setupAcceptanceConfirmed(
        { ...response, current: { ...response.current, edge_ipv4: "203.0.113.10" } },
        target,
      ),
    ).toBe(false);
    expect(
      setupAcceptanceConfirmed(
        { ...response, confirmation: { ...confirmation, release_id: "b".repeat(64) } },
        target,
      ),
    ).toBe(false);
    expect(() => setupAcceptanceConfirmed({ schema_version: 1, current: null }, target)).not.toThrow();
    expect(setupAcceptanceConfirmed({ schema_version: 1, current: null }, target)).toBe(false);
  });

  it("sends only an explicit all-three wearer observation", () => {
    const target = setupAcceptanceTarget(
      "PIN-1",
      releaseId,
      "2026-08-27.1",
      "203.0.113.9",
    )!;
    expect(setupAcceptanceRequest(target)).toEqual({
      schema_version: 1,
      device_serial: "PIN-1",
      release_id: releaseId,
      release_version: "2026-08-27.1",
      edge_ipv4: "203.0.113.9",
      checks: { microphone: true, speaker: true, gesture: true },
    });
  });
});
