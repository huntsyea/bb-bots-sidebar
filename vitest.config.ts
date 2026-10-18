import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) }, dedupe: ["react", "react-dom"] },
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], restoreMocks: true,
    // The SDK harness uses durable SQLite and filesystem exports. Bound parallel
    // workers and allow disk contention without weakening behavioral assertions.
    maxWorkers: 4, testTimeout: 20_000,
  },
});
