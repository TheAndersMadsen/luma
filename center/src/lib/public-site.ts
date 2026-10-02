export const PUBLIC_SITE_NAME = "Luma Center";
export const PUBLIC_PROJECT_NAME = "Luma";

/**
 * When the sitemap's content last changed: its `lastmod`. Update it with the
 * content, so crawlers see a date that means something instead of the request
 * time. The public surface links only to what a visitor can open: this
 * deployment's own routes and files.
 */
export const PUBLIC_CONTENT_UPDATED = "2026-09-29";

export type PublicRepresentation = "html" | "markdown" | null;

/** Choose between the two public representations using q-value and specificity order. */
export function preferredPublicRepresentation(accept: string | null): PublicRepresentation {
  if (!accept?.trim()) return "html";
  const ranges = accept
    .split(",")
    .map((raw, order) => {
      const [media = "", ...parameters] = raw.trim().toLowerCase().split(";");
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/u.exec(parameter);
        if (/^\s*q\s*=/u.test(parameter)) quality = match ? Number(match[1]) : 0;
      }
      const specificity = media === "*/*" ? 0 : media.endsWith("/*") ? 1 : 2;
      return { media, quality, specificity, order };
    });

  function preference(media: "text/html" | "text/markdown") {
    return ranges
      .filter((range) =>
        range.media === media || range.media === "text/*" || range.media === "*/*",
      )
      .sort((left, right) => right.specificity - left.specificity || left.order - right.order)[0] ?? null;
  }

  const candidates = [
    { representation: "html" as const, match: preference("text/html"), fallback: 0 },
    { representation: "markdown" as const, match: preference("text/markdown"), fallback: 1 },
  ]
    .filter((candidate) => candidate.match && candidate.match.quality > 0)
    .sort((left, right) =>
      right.match!.quality - left.match!.quality ||
      right.match!.specificity - left.match!.specificity ||
      left.match!.order - right.match!.order ||
      left.fallback - right.fallback,
    );
  return candidates[0]?.representation ?? null;
}

export function publicOrigin(environment: Record<string, string | undefined> = process.env): string {
  const candidate = environment.LUMA_PUBLIC_ORIGIN?.trim() || "http://localhost:4000";
  try {
    const url = new URL(candidate);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "") {
      return url.origin;
    }
  } catch {
    // The production configuration validator owns the operator-facing error.
  }
  return "http://localhost:4000";
}
