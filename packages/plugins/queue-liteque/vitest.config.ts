import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Filesystem-only queue tests; no Restate or Redis containers are required.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { include: ["queue-liteque/src/tests/**/*.test.ts"] },
});
