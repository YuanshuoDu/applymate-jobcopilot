import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The PostgreSQL subagent fixture imports the allowlisted Web usage route
    // so it can exercise the real Worker -> route -> broker boundary in-process.
    alias: { "@": path.resolve(workerRoot, "../web/src") },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
