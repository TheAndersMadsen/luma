import type { FitnessSessionFilename } from "@/lib/pin-device";
import {
  browserDownloadDependencies,
  saveBlobAsFile,
  type BlobDownloadDependencies,
} from "./fileDownload";

/*
 * Ported from the retired Setup SPA's `pages/fitnessPresentation.ts`.
 *
 * `fitnessFileLabel` is exhaustive over FitnessSessionFilename on purpose: the
 * three names are an allowlist enforced on the client (`requireFitnessSessionFilename`
 * in @/lib/pin-device) and on the Pin, so a new export cannot be added here
 * without also widening that allowlist — which is the point.
 */

export function formatFitnessTimestampMs(value: number): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

export function formatFitnessDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatFitnessFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) {
    return `${(sizeBytes / 1_024).toFixed(sizeBytes < 10_240 ? 1 : 0)} KB`;
  }
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
}

export function fitnessFileLabel(filename: FitnessSessionFilename): string {
  switch (filename) {
    case "activity-tracking-summary.csv":
      return "Summary CSV";
    case "activity-tracking-location-data.gpx":
      return "Route GPX";
    case "activity-tracking-sensor-data.csv":
      return "Sensor CSV";
  }
}

export type FitnessBlobDownloadDependencies = BlobDownloadDependencies;

/**
 * Download an already-authenticated fitness export.
 *
 * The mechanism — and the CSP reasoning behind it — lives in `./fileDownload`
 * now that the gallery saves a capture's stored files the same way. The
 * `FitnessSessionFilename` parameter type is what stays here: it keeps the
 * three-name allowlist on this call path rather than accepting any string.
 */
export function saveFitnessFileBlob(
  blob: Blob,
  filename: FitnessSessionFilename,
  dependencies?: FitnessBlobDownloadDependencies,
) {
  saveBlobAsFile(blob, filename, dependencies ?? browserDownloadDependencies());
}

/** The same anchor-click download for a plain text payload (server log, logcat). */
export function saveTextFile(fileName: string, text: string) {
  saveBlobAsFile(new Blob([text], { type: "text/plain" }), fileName);
}
