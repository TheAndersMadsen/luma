import { REVIVAL_BOOTSTRAP } from "@/lib/pin-setup/generated/bootstrap";

export function GET(): Response {
  return new Response(REVIVAL_BOOTSTRAP, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "content-disposition": 'attachment; filename="revival-bootstrap"',
      "cache-control": "public, max-age=300, s-maxage=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
