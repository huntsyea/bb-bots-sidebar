import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// The fake SDK host creates its database below os.tmpdir(). On macOS /var
// aliases /private/var; private exports deliberately reject symlink ancestors.
// Use the real temp root in test workers without weakening that safety check.
const testTempRoot = realpathSync(tmpdir());
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = testTempRoot;

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
