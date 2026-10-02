import { LUMA_CLOUD_INIT } from "@/lib/pin-setup/generated/cloud-init";
import { publicOrigin } from "@/lib/public-site";

export const dynamic = "force-dynamic";

// The unattended-install template, with this Center's own address as the
// installer source, so the operator fills in only their domain, emails, and
// tokens. The template file itself keeps the REPLACE_ME_CENTER_HOST placeholder.
export function GET(): Response {
  const body = LUMA_CLOUD_INIT.replaceAll(
    "https://REPLACE_ME_CENTER_HOST/install.sh", `${publicOrigin()}/install.sh`,
  );
  return new Response(body, {
    headers: {
      "content-type": "text/cloud-config; charset=utf-8",
      "content-disposition": 'attachment; filename="luma-cloud-init.yaml"',
      "cache-control": "public, max-age=300, s-maxage=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
