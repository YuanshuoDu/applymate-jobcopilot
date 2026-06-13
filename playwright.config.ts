import { defineConfig, devices } from "@playwright/test";

const hasExternalTarget = Boolean(process.env.E2E_BASE_URL);
const hasDatabase = Boolean(process.env.DATABASE_URL);
const shouldStartWeb = !hasExternalTarget && hasDatabase;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: shouldStartWeb
    ? {
        command: "pnpm --filter web exec prisma generate && pnpm --filter web dev",
        url: "http://127.0.0.1:3000",
        env: {
          ...process.env,
          AUTH_SECRET: process.env.AUTH_SECRET ?? "applymate-e2e-secret-change-me-32-bytes",
          AUTH_URL: process.env.AUTH_URL ?? "http://127.0.0.1:3000",
          NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://127.0.0.1:3000",
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
