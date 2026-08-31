Ai Pin Revival operator bundle

This archive deploys one immutable Cosmos release. It contains the operator
CLI and digest-pinned application descriptor, not application source.

Requirements: 64-bit Ubuntu 24.04 on amd64/x86_64 or arm64/aarch64,
Node.js 22.14+ on Node 22, Docker Engine, and Docker Compose 2.34+.

Fresh server:

  ./revival setup production \
    --domain center.example.com \
    --acme-email admin@example.com \
    --operator-email owner@example.com \
    --public-ip 203.0.113.10 \
    --profile pin --profile search
  ./revival doctor production
  ./revival deploy production --dry-run
  ./revival deploy production --confirm
  ./revival verify production
  ./revival eval assistant production --repeat 2

Use `./revival config list` to discover settings. Pass secret values through
`./revival config set NAME --stdin`; do not put them in shell history.

If GHCR packages are private, first run:

  ./revival registry login --username GITHUB_USER

When the pin profile is selected, production setup authenticates, acquires,
verifies, and stages the exact signed Pin archive bound into this operator
release. An explicit offline copy can be supplied with
`--pin-release-archive FILE`. Verify the staged or active release with:

  ./revival pin release acquire --check

For a private GitHub release, keep the read-only `GH_TOKEN` exported in this
shell until `setup production` finishes. The token is sent only to GitHub's
release API and is not written to the operator configuration.

For an offline host, pass that exact archive through the same command:

  ./revival pin release acquire --archive FILE

Center then serves the verified five-APK set to its browser installer. Download
the activation document from Center and run the exact `pin activate` plan and
confirmation commands it shows on the computer connected to the Pin.

Configuration, secrets, runtime data, and build caches live outside this
archive. Rerunning setup preserves existing nonblank values. `deploy --confirm`
pulls prebuilt images and verifies the running release; it does not compile.

Project guide: https://github.com/TheAndersMadsen/ai-pin-revival#readme
