import type { ParsedInstallVersion, VersionComparison } from "./types";

const INSTALL_VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;

function isValidUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseInstallVersion(version: string | null | undefined): ParsedInstallVersion | null {
  if (!version) {
    return null;
  }

  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const match = INSTALL_VERSION_RE.exec(trimmed);
  if (!match) {
    return null;
  }

  // Every INSTALL_VERSION_RE group is required, so a match carries all four.
  const [, yearText = "", monthText = "", dayText = "", incrementText = ""] = match;
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const increment = Number.parseInt(incrementText, 10);

  if (!isValidUtcDate(year, month, day)) {
    return null;
  }

  return {
    raw: trimmed,
    year,
    month,
    day,
    increment,
    dateKey: year * 10000 + month * 100 + day,
  };
}

export function compareParsedInstallVersions(
  left: ParsedInstallVersion,
  right: ParsedInstallVersion,
): -1 | 0 | 1 {
  if (left.dateKey < right.dateKey) {
    return -1;
  }

  if (left.dateKey > right.dateKey) {
    return 1;
  }

  if (left.increment < right.increment) {
    return -1;
  }

  if (left.increment > right.increment) {
    return 1;
  }

  return 0;
}

export function compareInstallVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): -1 | 0 | 1 | null {
  const parsedLeft = parseInstallVersion(left);
  const parsedRight = parseInstallVersion(right);

  if (!parsedLeft || !parsedRight) {
    return null;
  }

  return compareParsedInstallVersions(parsedLeft, parsedRight);
}

export function classifyInstalledVersion(
  installed: string | null | undefined,
  target: string | null | undefined,
): VersionComparison {
  const comparison = compareInstallVersions(installed, target);

  if (comparison === null) {
    return "unreadable";
  }

  if (comparison < 0) {
    return "older";
  }

  if (comparison > 0) {
    return "newer";
  }

  return "equal";
}
