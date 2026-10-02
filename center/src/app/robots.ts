import type { MetadataRoute } from "next";

import { publicOrigin } from "@/lib/public-site";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const allowedAgents = [
    "*",
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-User",
    "Google-Extended",
    "DeepSeekBot",
    "PerplexityBot",
    "Perplexity-User",
    "ora-agent",
  ];
  return {
    rules: allowedAgents.map((userAgent) => ({ userAgent, allow: "/" })),
    sitemap: `${publicOrigin()}/sitemap.xml`,
    host: publicOrigin(),
  };
}
