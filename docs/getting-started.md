# Getting started

## Prerequisites

- Node.js 22.14 or newer on the Node 22 line
- Docker with Compose 2.34.0 or newer
- Git

Check the host:

```sh
./revival doctor
```

## Start Center

```sh
./revival init
./revival dev center
```

Open <http://127.0.0.1:4000>. Center uses Turbopack and Compose Watch, so source
edits appear without rebuilding the whole product.

Stop it with:

```sh
./revival dev down
```

## Start everything

```sh
./revival up
./revival status
```

Useful follow-ups:

```sh
./revival logs
./revival config
./revival down
```

## Check a change

```sh
./revival check changed
```

Or run one component:

```sh
./revival check center
./revival check cosmos
./revival check platform
```

See [Contributing](../CONTRIBUTING.md) for the complete development loop.
