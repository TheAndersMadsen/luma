import { describe, expect, it } from "vitest";
import { connectedPinReport } from "./reporting";

describe("connectedPinReport", () => {
  it("matches the USB serial instead of treating another reporting Pin as evidence", () => {
    const now = 2_000_000;
    const statuses = [
      { serial_number: "OTHER", reported_at_epoch: now / 1000 - 10 },
      { serial_number: "1H4MPA42230112", reported_at_epoch: now / 1000 - 20 },
    ];

    expect(connectedPinReport(statuses, "1h4mpa42230112", now, 60_000)).toEqual({
      reporting: true,
      lastReportAtEpoch: now - 20_000,
    });
    expect(connectedPinReport(statuses, "MISSING", now, 60_000)).toEqual({
      reporting: false,
      lastReportAtEpoch: null,
    });
  });

  it("does not count a stale report as online", () => {
    expect(
      connectedPinReport(
        [{ serial_number: "PIN", reported_at_epoch: 1_000 }],
        "PIN",
        2_000_000,
        60_000,
      ),
    ).toEqual({ reporting: false, lastReportAtEpoch: 1_000_000 });
  });
});
