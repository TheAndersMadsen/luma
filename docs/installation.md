# Installation

## Source checkout

```sh
git clone https://github.com/TheAndersMadsen/ai-pin-revival.git
cd ai-pin-revival
./revival init
./revival doctor
```

The CLI runs from the repository; there is no separate global install step.

## Dev Container

Open the checkout in a Dev Container-compatible editor. The container provides
the pinned contributor tools while source remains in the normal worktree.
External caches persist across container rebuilds.

## Directory layout

`./revival init` creates:

- configuration under `~/.config/ai-pin-revival`
- secrets under `~/.config/ai-pin-revival/secrets`
- runtime data under `~/.local/share/ai-pin-revival`
- build caches under `~/.local/share/ai-pin-revival/build`

Override these locations with the `REVIVAL_*_DIR` variables documented in
[Configuration](configuration.md).

## Pin tooling

Pin Android builds require Linux/x86-64 Docker. Start with:

```sh
./revival pin doctor --serial SERIAL
./revival pin check
```

Building does not install anything. Device mutation remains a separate,
serial-bound, confirmed operation described in [Pin onboarding](pin-onboarding.md).
