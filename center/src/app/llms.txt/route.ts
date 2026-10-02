import {
  PUBLIC_SITE_NAME,
  publicOrigin,
} from "@/lib/public-site";

export const dynamic = "force-dynamic";

function llmsText(origin = publicOrigin()): string {
  return `# ${PUBLIC_SITE_NAME}

> Self-hosted Center and Cosmos services for the Humane Ai Pin. Not affiliated with Humane.

Use this site when an owner or operator needs to deploy, verify, install, activate, configure, or develop Luma. Only the documented public read operations work without authentication; wearer and operator data stays behind this deployment's own session and authorization boundaries. There are no public content pages: the root path is the app itself, the dashboard for a signed-in session and sign-in for everyone else.

To install a new server, run the bootstrap at ${origin}/install.sh on a fresh Ubuntu 24.04 host. Production always runs a checksum-verified release, never a source checkout. An agent should pass secrets through standard input, preserve existing configuration, and finish by verifying that /api/version returns the intended release with environment production.

## Machine-readable resources

- [OpenAPI](${origin}/openapi.json): OpenAPI 3.1 description of the public read operations.
- [Sitemap](${origin}/sitemap.xml): Public, indexable pages on this deployment.
- [Deployment identity](${origin}/api/version): Current release, runtime environment, release version, Pin release, and release notes. Other Luma Centers poll it as their update manifest.
- [Server setup](${origin}/install.sh): The guided bootstrap for Ubuntu 24.04.
- [Unattended server setup](${origin}/cloud-init.yaml): cloud-init user data that runs the same bootstrap on a new Ubuntu 24.04 server without SSH; fill every REPLACE_ME value first.
`;
}

export function GET(): Response {
  return new Response(llmsText(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
}
