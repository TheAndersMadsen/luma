import { createAdapterServer } from "./adapter.mjs";
import { loadConfig } from "./config.mjs";

function fail(message) {
  process.stderr.write(`spotify-adapter: ${message}\n`);
  process.exitCode = 1;
}

let config;
try {
  config = loadConfig();
} catch (error) {
  fail(error instanceof Error ? error.message : "configuration is invalid");
}

if (config) {
  const server = createAdapterServer(config);
  server.on("error", () => fail("listener failed"));
  server.listen(config.port, config.bindAddress, () => {
    process.stdout.write(
      `spotify-adapter: listening on ${config.bindAddress}:${config.port}\n`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
