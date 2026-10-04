# App privacy

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Luma sends no telemetry to its maintainer. It has no external crash reporting
and no analytics. If you turn on **Save diagnostics**, your own server keeps
the latest content-free assistant outcome for you to review in Center.

Production exposes content-free Prometheus metrics for route, transport,
model use and provenance, terminal state, duration, tool outcomes, and the
bounded music-resolution stages. Wearer text, tool arguments, identity, and
provider results are never metric labels.

## What leaves your server, and what stays

- The Pin holds no provider keys. Activation copies only the Cosmos endpoint,
  the operator trust root, and the device identity to it.
- Public endpoints serve no wearer data, with one exception that the wearer
  creates: a capture share link shows that capture's best frame to anyone who
  has the link, for seven days ([What your Center does](center.md)).
  Otherwise, Center's public endpoints are sign-in, the browser-local Wi-Fi QR
  page, Pin release downloads, and the
  [machine surface](operations.md#public-verification-and-agent-discovery),
  which carries only release metadata.
- Center reaches the Pin's Device Services remotely over an Iroh connection
  that is end-to-end encrypted to the Pin's key. The public n0 relay and DNS
  discovery help the connection cross NAT. They carry the traffic but cannot
  read it.
- Once an hour, your server asks its update source for its public
  `/api/version` to learn whether a newer release exists. The source is the
  Center you installed from, or the maintainer's Center
  (`center.andersmadsen.dk`) for a server set up from the release files. The
  request carries nothing about you or your Pin, but the source sees your
  server's IP address. To name another source, run
  `./luma setup production --update-source https://CENTER`
  ([Run your own update source](operations.md#run-your-own-update-source)).
- When Center connects to a Pin over USB, it sends the Pin's 20-byte ADB
  challenge, and nothing else, to PenumbraOS's remote signer
  (`adb.penumbraos.workers.dev`). The signer returns the signature the Pin
  expects.
- A tool server you add in Center
  ([MCP servers](assistant.md#mcp-servers)) is contacted by Cosmos at the
  address you gave, with the request headers or sign-in you gave it. It
  receives the arguments of each tool call the assistant makes to it, which
  can include words from your request. Nothing is sent to a server that is
  switched off, and none is contacted until you add one.
- Secret fields never go back to the browser. Secrets go in through
  `./luma config set NAME --stdin`, never argv or shell history.
