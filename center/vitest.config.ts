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
    environment: "jsdom",
    setupFiles: ["./verify/vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
    // Checks run beside other checks and agents (AGENTS.md "Fast loop"). The
    // 5 s default failed interaction tests on a busy machine, never an idle one.
    testTimeout: 30_000,
  },
});
