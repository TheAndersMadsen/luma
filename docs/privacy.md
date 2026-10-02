# App privacy

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


**Luma sends no telemetry to its maintainer.** There is no external crash
reporting or analytics. If you enable **Save diagnostics**, your own server
keeps the latest content-free assistant outcome for you to review in Center.
Production exposes content-free Prometheus metrics for route,
transport, model use and provenance, terminal state, duration, tool outcomes,
and the bounded music-resolution stages; wearer text, tool arguments,
identity, and provider results are never metric labels.

- The Pin holds no provider keys. Activation copies only the Cosmos endpoint,
  the operator trust root, and the device identity.
- Public endpoints serve no wearer data, with one exception the wearer
  creates: a capture share link shows that capture's best frame to anyone
  holding it for seven days ([What your Center does](center.md)). Otherwise
  Center's public surface is sign-in, the browser-local Wi-Fi QR page, Pin
  release downloads, and the
  [machine surface](operations.md#public-verification-and-agent-discovery),
  which carries release metadata only.
- Center reaches the Pin's Device Services remotely over an Iroh connection
  that is end-to-end encrypted to the Pin's key. The public n0 relay and DNS
  discovery help it cross NAT; they carry the traffic but cannot read it.
- Once an hour your server asks its update source for its public
  `/api/version` to learn whether a newer release exists. The source is the
  Center you installed from, or the maintainer's Center
  (`center.andersmadsen.dk`) for a server set up from the release files. The
  request carries nothing about you or your Pin, but the source sees your
  server's IP address. `./luma setup production --update-source https://CENTER`
  names another source ([Run your own update source](operations.md#run-your-own-update-source)).
- When Center connects to a Pin over USB, it sends the Pin's 20-byte ADB
  challenge, and nothing else, to PenumbraOS's remote signer
  (`adb.penumbraos.workers.dev`), which returns the signature the Pin expects.
- Secret fields never return to the browser, and secrets go in through
  `./luma config set NAME --stdin`, never argv or shell history.

