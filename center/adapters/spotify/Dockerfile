FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
ENV NODE_ENV=production DO_NOT_TRACK=1
RUN groupadd --system --gid 1001 luma
# This adapter has no third-party dependencies.
COPY --chown=1000:1001 package.json ./
COPY --chown=1000:1001 src ./src
USER 1000:1001
EXPOSE 18081
HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 \
  CMD ["bun", "--no-env-file", "src/healthcheck.mjs"]
CMD ["bun", "--no-env-file", "src/server.mjs"]
