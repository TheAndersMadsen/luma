/**
 * Return request leaf NAMES without retaining any setting values.
 *
 * This is what the panes hand to `logInfo`, so a save can be traced without the
 * credential it carried ever reaching a log line.
 */
export function changedSettingFields(request: object): string[] {
  const fields: string[] = [];
  for (const [section, value] of Object.entries(request)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const field of Object.keys(value)) {
        fields.push(`${section}.${field}`);
      }
    } else {
      fields.push(section);
    }
  }
  return fields.sort();
}
