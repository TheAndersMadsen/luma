FROM node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b

WORKDIR /app
ENV NODE_ENV=production

# The official Node image already supplies UID 1000 (`node`). Give the runtime
# the same GID as Center without trying to create a duplicate UID.
RUN addgroup -g 1001 revival

COPY --chown=1000:1001 package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=1000:1001 src ./src

USER 1000:1001
EXPOSE 18081

HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.mjs"]

CMD ["node", "src/server.mjs"]
