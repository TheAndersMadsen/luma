# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Ai Pin Revival Center. Build tooling and source stay in the builder; the final
# image contains only Next's traced standalone runtime, public assets, and the
# protocol definitions loaded dynamically by the Cosmos bridge.
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

# The supported inner loop uses this target through the development Compose
# override. Source is present for the initial start and then updated in place by
# Compose Watch. Dependencies stay in the image and Next output is mounted on a
# named volume, so neither is ever written into the source checkout.
FROM base AS development
ENV NODE_ENV=development \
    HOSTNAME=0.0.0.0 \
    PORT=4000 \
    COSMOS_CONTRACTS_DIR=/app/contracts
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
COPY --from=wire_contracts --chown=node:node . ./contracts
RUN mkdir -p /app/.next /data \
    && chown node:node /app /app/.next /data
USER node
EXPOSE 4000
CMD ["npm", "run", "dev"]

# No second Pin console is built into this image, and none may be.
#
# One used to be: a standalone Vite SPA was compiled here and copied to
# `public/setup`, so Center served a whole second Pin console at `/setup`. That
# console carried an interactive ADB PTY — a ROOT shell on the wearer's device —
# and `/setup` is a plain wearer path, so every signed-in wearer could reach it.
# Center's own console deliberately routes that shell to `/admin/pin/terminal`,
# behind `isOperatorPath` and the `app/admin/pin` layout guard; shipping the SPA
# alongside it left the old ungated door standing next to the new gated one.
#
# The SPA is gone. The console is native: `/settings/pin` (wearer) and
# `/admin/pin` (operator), with the installer and ADB stack in
# `src/lib/pin-install` and `src/lib/pin-device`. The Pin's own on-device setup
# page is a separate thing and is unaffected — it ships from committed static
# assets under `pin/runtime/core/assets/setup-page`, packed by
# `platform/containers/pin-builder/embed-setup-assets.mjs`, and has never been
# part of this image.
FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# One source manifest must always produce one Center build identity. The value is
# deliberately a build argument: it is not a secret and is not retained by the
# final runtime stage, which receives the same release id from Compose at start.
ARG REVIVAL_RELEASE_ID
RUN npm run build

FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=4000 \
    COSMOS_CONTRACTS_DIR=/app/contracts \
    COSMOS_CHANNEL_KEY_FILE=/data/channel-key.json

RUN groupadd --system --gid 1001 center \
    && usermod --gid center --home /app node \
    && mkdir -p /data \
    && chown 1000:1001 /data

COPY --from=builder --chown=1000:1001 /app/.next/standalone ./
COPY --from=builder --chown=1000:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1000:1001 /app/public ./public
COPY --from=wire_contracts --chown=1000:1001 . ./contracts

# Next traces its optional configuration compiler whenever TypeScript is present
# in the build stage. The generated server does not load it at runtime.
RUN rm -rf /app/node_modules/typescript

USER 1000:1001

EXPOSE 4000
CMD ["node", "server.js"]
