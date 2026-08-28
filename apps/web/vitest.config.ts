import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    // Bound file concurrency so dynamic module resets and hoisted mocks do not
    // race under high-core local runners, causing false timeout/mock failures.
    maxWorkers: 2,
    minWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
})
