import { centerOpenApi } from "@/lib/openapi";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(centerOpenApi(), {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
}
