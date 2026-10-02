// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PinClient } from "./client";

describe("PinClient", () => {
  it("keeps no cellular radio control: nothing in Center turns the modem off", () => {
    expect("setCellularEnabled" in PinClient.prototype).toBe(false);
  });
});
