# Trademarks

Luma is an independent, community project. It is **not affiliated with,
sponsored by, authorized by, or endorsed by Humane Inc. or HP Inc.**

## Names that are not Luma's

"Humane", "Ai Pin", and "CosmOS" are names and/or trademarks of their respective
owners. Following Humane's sale of substantially all of its assets in 2025,
ownership of some of these marks may rest with HP Inc. or its affiliates. "HP",
"Android", "Qualcomm", "Spotify", "TIDAL", "YouTube", and other third-party
product names are likewise the property of their respective owners.

Luma uses these names only **nominatively**, that is, descriptively, to state
truthfully what hardware, protocols, and services Luma interoperates with (for
example, "a recreation of the Humane Ai Pin cloud"). Luma does not use any of
them as its own product name, source identifier, or brand, and nothing in this
project should be read as a claim of origin, sponsorship, affiliation, or
endorsement.

### Why some original names appear verbatim

An unmodified Ai Pin speaks a fixed protocol and checks fixed identities. For the
device to work at all, certain strings must match the original byte-for-byte.
These appear in the repository as **interface and compatibility identifiers
only**, never as branding:

- the `humane.*` gRPC package, service, and method names;
- installed Android package identities and the five stock APK roles;
- the device's own `Build` manufacturer ("Humane") and model ("Ai Pin")
  strings, which Luma reads to recognize a genuine Pin;
- the `humane.center/share/...` capture-share link path the stock Messages app
  recognizes.

Changing any of these would simply break interoperability with hardware the
owner already paid for. Their presence is a technical necessity, not a trademark
use in commerce.

## Names that are Luma's own

Everything project-owned is named by Luma: the project **Luma**; its server
component **Cosmos** and web component **Center**; and the `LUMA_` and `COSMOS_`
configuration prefixes. These are ordinary words chosen by this project and are
not a reference to, or imitation of, any Humane or HP mark. The Luma logo and
visual presentation are the project's own and are designed not to resemble
Humane's or HP's branding.

## Scope and contact

Luma distributes no Humane or HP software, firmware, fonts, or design assets
(see [NOTICE](NOTICE)). It is offered free of charge, with no commercial
purpose, for owners operating hardware they lawfully possess after the original
cloud service was permanently discontinued on 28 February 2025.

If you are a rights-holder and believe a specific use of a name or mark in this
project is confusing or improper, please open contact with
[@TheAndersMadsen](https://github.com/TheAndersMadsen) and it will be addressed
promptly.
