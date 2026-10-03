# Questions

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


<details>
<summary><strong>Is this Humane?</strong></summary>

No. Luma is an independent community project. It is not affiliated with or
endorsed by Humane or HP. “Humane” and “Ai Pin” belong to their owners.

</details>

<details>
<summary><strong>Why does my Pin need Penumbra?</strong></summary>

A stock Pin runs only signed, Humane-approved software.
[Penumbra](https://github.com/PenumbraOS) is the device foundation that lets
Luma's Device Services and Compatibility Layer load. You install them through
the USB interposer, which reaches the Pin's service contacts.

</details>

<details>
<summary><strong>What happens when my server is offline?</strong></summary>

The Pin does not fall back to anyone else's cloud. The Compatibility Layer
fails closed: stock cloud calls go only to your activated Cosmos server, so
they fail while that server is unreachable.

</details>

<details>
<summary><strong>What does it cost?</strong></summary>

The software is free. You pay for your own server and for any providers you
connect, under your own accounts.

</details>

<details>
<summary><strong>Can I use my existing accounts?</strong></summary>

Yes. Bring an OpenAI-compatible API or Codex subscription for the assistant,
SearXNG or SerpAPI for search, and Azure Speech for the voice. Optionally add
Google Maps, Pirate Weather, Wolfram, Perplexity, Open Food Facts, Rabbit OS3,
and the music providers.

</details>

<details>
<summary><strong>Which servers are supported?</strong></summary>

64-bit Ubuntu 24.04 on `amd64/x86_64` or `arm64/aarch64`, with at least 8 GiB
of free disk. Every project image in a release is published as a
multi-platform, digest-pinned manifest.

</details>

<details>
<summary><strong>Do I have to modify the Pin?</strong></summary>

No soldering. You need the USB interposer described in the
[interposer guide](https://github.com/PenumbraOS/interposer). Installation and
activation happen over USB from Center.

</details>


## Can an AI coding assistant install it for me?

Yes. If you use Claude Code, Codex, or a similar tool, give it the prompt below.
It states the result you want and the rules to follow, and leaves the commands
to the tool. Copy the release folder to the server first, fill in the bracketed
values, and run the tool there.

<details>
<summary><strong>Agent setup prompt</strong></summary>

```text
Install or update Luma on this 64-bit Ubuntu 24.04 server (amd64/x86_64 or
arm64/aarch64) from the release files in [RELEASE_FOLDER]: the operator
archive, the Pin archive, the release descriptor, SHA256SUMS, and
SHA256SUMS.sigstore.json.

Outcome:
- Cosmos and Center run at https://[DOMAIN].
- https://[DOMAIN]/api/version reports environment "production" and this
  release's ID.
- The pin, search, and spotify profiles are enabled.
- An update keeps my existing Luma configuration, data, and provider settings.

Inputs:
- Domain: [DOMAIN]
- ACME email: [ACME_EMAIL]
- First operator email: [OPERATOR_EMAIL]
- Public IPv4: [PUBLIC_IPV4]
- I will connect assistant, search, maps, and speech providers in Center after
  deployment. Do not ask for or place provider secrets on the Pin.

Rules:
- Follow the Luma README: "Get Luma" for a new server, "Update Luma" for an
  update. The README is the human guide; the bundled ./luma commands and their
  --help output are the authority.
- Check SHA256SUMS before unpacking. Deploy only the extracted operator
  release; do not clone, build, or deploy source.
- Pass the release's Pin archive to setup with --pin-release-archive. On an
  update, run ./luma backup production from the new release before setup.
- Never print, log, commit, or place a secret in argv or shell history.
- Treat Center as the provider control plane and Cosmos as the runtime
  authority. Provision the Pin only with the Cosmos endpoint, trust root, and
  device identity.
- Do not invent compatibility, migration, or alternate deployment paths.
- Run one narrow diagnostic after a failure; fix the cause and resume.
- The release and its images are public: do not ask for a GitHub token or
  run ./luma registry login.
- Ask me only for a missing input, DNS change, firewall change, or device
  interaction you cannot perform. I type every password, token, and other
  credential myself.

Success evidence:
- sha256sum --check SHA256SUMS passes.
- ./luma config check passes.
- ./luma doctor production passes.
- ./luma deploy production --dry-run passes before confirmation.
- ./luma verify production passes after deployment.
- GET https://[DOMAIN]/api/version returns the expected release and
  environment "production".
- After deployment, https://[DOMAIN]/llms.txt, /openapi.json, /sitemap.xml,
  and /robots.txt return successful machine-readable responses.

Continue until all success evidence is green or report one exact blocker and
the command/output that proves it.
```

For a new Pin, follow with: “Confirm with `./luma pin release acquire --check`
that setup staged the release's Pin apps, guide me through Center's USB
installer, and activate the exact connected Pin directly in Center. Use an
activation file only as a recovery fallback.”

</details>

