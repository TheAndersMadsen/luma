/*
 * The write-only secret model, ported verbatim from the retired Setup SPA's
 * `settingsFormState.ts`.
 *
 * The Pin's settings response never returns a credential value — only a
 * `has_*` boolean. Every credential field in these panes is therefore edited as
 * a SecretEdit rather than a string: "unchanged" sends nothing, "set" sends the
 * new value, "clear" sends the empty string. A plain string field would make
 * "the user left it alone" and "the user wants it cleared" indistinguishable.
 */

export type SecretEdit =
  | { kind: "unchanged" }
  | { kind: "set"; value: string }
  | { kind: "clear" };

export const UNCHANGED_SECRET_EDIT: SecretEdit = { kind: "unchanged" };

export function secretEditFromInput(value: string): SecretEdit {
  return value === "" ? UNCHANGED_SECRET_EDIT : { kind: "set", value };
}

export function secretEditInputValue(edit: SecretEdit): string {
  return edit.kind === "set" ? edit.value : "";
}

export function secretEditRequestValue(edit: SecretEdit): string | undefined {
  switch (edit.kind) {
    case "unchanged":
      return undefined;
    case "set":
      return edit.value;
    case "clear":
      return "";
  }
}

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
