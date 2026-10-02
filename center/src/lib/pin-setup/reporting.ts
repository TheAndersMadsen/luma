export interface PinStatusReport {
  readonly serial_number: string;
  readonly reported_at_epoch: number;
}

export interface ConnectedPinReport {
  readonly reporting: boolean;
  readonly lastReportAtEpoch: number | null;
}

/** Match cloud evidence to the exact Pin currently attached over USB. */
export function connectedPinReport(
  statuses: readonly PinStatusReport[],
  serial: string | null,
  nowEpochMs: number,
  freshnessMs: number,
): ConnectedPinReport {
  const canonicalSerial = serial?.trim().toLowerCase();
  if (!canonicalSerial) return { reporting: false, lastReportAtEpoch: null };

  const matching = statuses.filter(
    (status) => status.serial_number.trim().toLowerCase() === canonicalSerial,
  );
  const latestEpoch = matching.reduce<number | null>(
    (latest, status) =>
      latest === null || status.reported_at_epoch > latest
        ? status.reported_at_epoch
        : latest,
    null,
  );
  const lastReportAtEpoch = latestEpoch === null ? null : latestEpoch * 1000;
  return {
    reporting:
      lastReportAtEpoch !== null &&
      nowEpochMs - lastReportAtEpoch < freshnessMs,
    lastReportAtEpoch,
  };
}
