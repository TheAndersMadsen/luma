import type { MetadataRoute } from "next";

import { PUBLIC_PAGES, publicOrigin } from "@/lib/public-site";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  const lastModified = new Date();
  return Object.keys(PUBLIC_PAGES).map((path) => ({
    url: new URL(path, origin).toString(),
    lastModified,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : path === "/developers" ? 0.9 : 0.7,
  }));
}
