# Ai Pin Revival operator bundle

This archive contains the small, versioned CLI needed to configure, deploy,
and verify a published Cosmos release. It does not contain application source,
Android/Pin builders, development dependencies, credentials, or operator data.

Install Node.js 22.14 or newer on the Node 22 line and Docker Engine with
Compose 2.34 or newer, extract the archive, then run:

```sh
./revival setup production --help
```

The bundled release descriptor pins the Compose application by OCI digest.
During deployment, Docker Compose shows the remote configuration and local
interpolation values for review. Read those prompts; the CLI never accepts
them automatically.

If the release packages are private, log in first with `docker login ghcr.io`
using an account token that can read packages. Public packages need no registry
login; package visibility is not changed by this bundle.
