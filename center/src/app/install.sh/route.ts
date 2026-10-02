import { bootstrapForOrigin } from "@/lib/pin-setup/generated/bootstrap";
import { publicOrigin } from "@/lib/public-site";

export const dynamic = "force-dynamic";

// The installer names this Center as the update source it offers the new
// server, so a server installed from a Center keeps getting its releases.
export function GET(): Response {
  return new Response(bootstrapForOrigin(publicOrigin()), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "content-disposition": 'attachment; filename="luma-bootstrap"',
      "cache-control": "public, max-age=300, s-maxage=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
