import type { MetadataRoute } from "next";

import { PUBLIC_CONTENT_UPDATED, publicOrigin } from "@/lib/public-site";

// Dynamic only for the origin, which production supplies at runtime.
export const dynamic = "force-dynamic";

// One indexable URL: the app itself. `/` is the dashboard for a signed-in
// session and sign-in for everyone else. Everything wearer-owned is
// authenticated and stays out of the index.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", publicOrigin()).toString(),
      lastModified: PUBLIC_CONTENT_UPDATED,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
