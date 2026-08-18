# Run Ai Pin Revival locally

This tutorial starts Center and Cosmos from a clean source checkout. By the end,
you will have the wearer dashboard at `http://127.0.0.1:4000` and a saved setup
track whose evidence tells you what to do next.

## What you need

- macOS or Linux.
- Docker with Compose 2.33.1 or newer.
- Node.js 22.14.0 or newer on the Node 22 line for the source-based CLI.
- A checkout created by following [installation](installation.md#install-from-source).

Rust, Java, the Android SDK, provider keys, and a physical Pin are not required
for this local track.

## Step 1: Choose the local track

```sh
./revival setup local
```

This stores only the selected journey and recomputable evidence under your
external state directory. It does not run Docker, contact a server, or inspect a
device. The final line names the next action.

## Step 2: Initialize external state

```sh
./revival init
```

`init` creates owner-only configuration, secret, data, build, and backup roots
outside the checkout. It creates a protected `runtime.env` and fills blank local
secrets once. Running `init` again preserves the existing values.

## Step 3: Start Center and Cosmos

```sh
./revival doctor
./revival build
./revival up
./revival status
```

Open <http://127.0.0.1:4000>. Center should load and `status` should show the
Compose services. The default local authentication mode is permitted only on
loopback.

## Stop and resume

```sh
./revival down
./revival setup status
./revival setup --resume
```

`down` preserves volumes. Setup status recomputes evidence instead of trusting
an old checklist, and `--resume` prints the current next action.

## Optional providers

The product starts without third-party provider credentials. Add only the
capability you want to the protected runtime file:

```sh
./revival config path
./revival config template --group provider
./revival config check
```

See [configuration](configuration.md) before setting a secret. Do not pass
provider secrets as command arguments.

## Troubleshooting

- If `doctor` reports Node, install the pinned Node 22 line and rerun it.
- If it reports Docker or Compose, start Docker and verify `docker compose
  version` is at least 2.33.1.
- If an external directory already exists with broad permissions, fix or move
  it yourself. `init` refuses to take ownership of an unmarked directory or
  silently change its permissions.
- Create a redacted local diagnostic archive with `./revival support-bundle`.
  Review it before sharing it.

## What you built

You now have a local Center/Cosmos stack whose source, runtime secrets, state,
and generated output are separate. Continue with [contributing](../CONTRIBUTING.md),
[Pin onboarding](pin-onboarding.md), or the [CLI reference](cli-reference.md).
