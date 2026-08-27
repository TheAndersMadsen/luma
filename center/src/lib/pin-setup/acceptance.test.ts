import { describe, expect, it } from "vitest";
import {
  loadSetupAcceptance,
  saveSetupAcceptance,
  setupAcceptanceIdentity,
} from "./acceptance";

describe("setup physical acceptance", () => {
  it("binds the acknowledgment to the exact Pin, release, and Cosmos edge", () => {
    expect(setupAcceptanceIdentity(" pin-1 ", " 2026-08-27.1 ", "203.0.113.9")).toBe(
      '["PIN-1","2026-08-27.1","203.0.113.9"]',
    );
    expect(setupAcceptanceIdentity(null, "2026-08-27.1", "203.0.113.9")).toBeNull();
    expect(setupAcceptanceIdentity("PIN-1", null, "203.0.113.9")).toBeNull();
    expect(setupAcceptanceIdentity("PIN-1", "2026-08-27.1", null)).toBeNull();
  });

  it("survives a page reload but not a software or target change", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const identity = setupAcceptanceIdentity("PIN-1", "2026-08-27.1", "203.0.113.9")!;

    expect(loadSetupAcceptance(storage, identity)).toBe(false);
    expect(saveSetupAcceptance(storage, identity)).toBe(true);
    expect(loadSetupAcceptance(storage, identity)).toBe(true);
    expect(
      loadSetupAcceptance(
        storage,
        setupAcceptanceIdentity("PIN-1", "2026-08-28.1", "203.0.113.9")!,
      ),
    ).toBe(false);
  });

  it("fails closed when browser storage is unavailable", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("blocked");
      },
    };
    expect(loadSetupAcceptance(storage, "identity")).toBe(false);
    expect(saveSetupAcceptance(storage, "identity")).toBe(false);
  });
});
