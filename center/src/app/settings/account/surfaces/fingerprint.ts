/** Four lines of four 4-character groups, the way the device shows its fingerprint and the owner compares it by eye. */
export function fingerprintLines(hex: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < hex.length; start += 16) lines.push((hex.slice(start, start + 16).match(/.{1,4}/g) ?? []).join(" "));
  return lines;
}
