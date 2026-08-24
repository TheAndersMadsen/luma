# Release distribution

Tagged releases publish five linux/amd64 application images, then publish the
production Compose model as an OCI application with every image resolved to a
digest. Operator configuration, secrets, PKI, and durable data are never part
of that artifact.

`build.mjs` creates the separate operator release asset. Its allowlist contains
only the production CLI, templates, and validators needed to configure and run
the OCI application. It deliberately excludes application source, Android/Pin
builders, development dependencies, and generated state.

Every release includes a canonical descriptor binding the source tag and commit
to the exact application digest, five exact image digests, platform, and CLI
archive checksum. The archive's stamped `version.json` gives production deploys
the same immutable OCI application reference while the repository's full
`./revival` remains the developer interface.
