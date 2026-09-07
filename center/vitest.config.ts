import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Dates and day grouping read the same here as they do in CI.
    env: { TZ: "UTC" },
    environment: "jsdom",
    setupFiles: ["./verify/vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
  },
});
