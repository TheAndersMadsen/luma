import {
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SITE_NAME,
  publicOrigin,
} from "@/lib/public-site";

export const dynamic = "force-dynamic";

function llmsText(origin = publicOrigin()): string {
  return `# ${PUBLIC_SITE_NAME}

> Owner-operated Center and Cosmos services that bring a Humane Ai Pin back online. This project is not affiliated with Humane.

Use this site when an owner or operator needs to deploy, verify, install, activate, configure, or develop Ai Pin Revival. Call only the documented public read operations without authentication. Wearer and operator data stays behind the deployment's own session and authorization boundaries.

A production setup agent should use a checksum-verified GitHub release, preserve external configuration, pass secrets through standard input, avoid deploying a source checkout, and finish by verifying that /api/version returns the intended release with environment production.

## Product and trust

- [Overview](${origin}/index.md): What Ai Pin Revival does, how Center and Cosmos fit together, and how to start.
- [About](${origin}/about.md): Project identity, independence from Humane, architecture, and operator ownership.
- [Privacy](${origin}/privacy.md): Data boundaries for the public project and self-hosted deployments.
- [Contact](${origin}/contact.md): Public support, deployment-specific support, and private security reporting.

## Developers and agents

- [Developer index](${origin}/developers.md): CLI deployment, public HTTP operations, authentication boundaries, and when agents should use the project.
- [OpenAPI](${origin}/openapi.json): OpenAPI 3.1 description with unique operation IDs and typed response schemas.
- [Sitemap](${origin}/sitemap.xml): Public, indexable pages on this deployment.
- [Deployment identity](${origin}/api/version): Current immutable release and explicit runtime environment.
- [Source and releases](${PUBLIC_REPOSITORY_URL}): Source, README, issue tracker, and checksum-verified releases.
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
