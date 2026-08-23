# Architecture

Ai Pin Revival is one product with three runtime tiers.

```text
Pin stock apps + Hook
        │ stock protobuf / HTTPS
        ▼
      Cosmos ─────────── Center
        │                  │
        └── PostgreSQL     └── wearer and provider sessions
```

## Center

Center is the Next.js web app. It owns wearer-facing settings, account login,
provider sessions, Pin release presentation, and projections of Cosmos data.

## Cosmos

Cosmos is the Rust backend. It implements the Pin's device services, enrollment,
assistant and tool routing, search, speech adapters, persistence, and Center
gateway endpoints.

## Pin

The Pin tier contains:

- a Rust Server APK
- the injected Hook used by stock Humane apps
- the Hook injector
- the installer
- the bootstrap package

The signed release contract always contains the complete five-role set even
when a particular install changes fewer roles.

## Protocols

The Pin speaks stock protobuf and encryption contracts. The canonical wire
trees are:

- `contracts/wire/humane/`
- `pin/runtime/core/proto/`

`contracts/wire-divergence.json` records intentional differences and their
evidence. Field numbers and wire types are compatibility boundaries.

## Development boundaries

- Center changes use `./revival check center`.
- Cosmos changes use `./revival check cosmos`.
- Platform changes use `./revival check platform`.
- Pin changes use `./revival pin check`.

`./revival check changed` maps a worktree diff to those boundaries.

## Runtime data

Configuration, credentials, generated output, databases, and device artifacts
live outside the source tree. Local Compose uses named volumes for service
state. Production is deployed through the single direct Cosmos deployment
interface.
