import path from "node:path";
import { defineConfig } from "vitest/config";

// Manual, paid checks only: `npm run meta:check`. Never part of `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/server-only-stub.ts"),
    },
  },
  test: { include: ["tests/live/*.live.ts"], environment: "node", testTimeout: 120_000 },
});
