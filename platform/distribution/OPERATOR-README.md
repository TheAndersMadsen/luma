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

## Optional Spotify bridge

Enable the Pin's Iroh remote-Center feature, then fetch
`/api/iroh/ticket` from its loopback Setup API (directly or through an ADB port
forward). Save only the response's `ticket` value as one line and pass that file
to `setup production --profile spotify --iroh-ticket-file FILE`.

After the Pin is paired, bind the bridge to that one account and device. The
owner value is the first operator's `REVIVAL_FIRST_OPERATOR_ID`; the device
value is the paired hexadecimal `device_id` shown by Center:

```sh
./revival config get REVIVAL_FIRST_OPERATOR_ID
./revival config set REVIVAL_PIN_BRIDGE_OWNER_SUB VALUE_FROM_ABOVE
./revival config set REVIVAL_PIN_BRIDGE_DEVICE_ID HEX_DEVICE_ID
./revival config check
```

Redeploy after changing those values. Core remains healthy when this optional
profile is disabled or the Pin is offline.
