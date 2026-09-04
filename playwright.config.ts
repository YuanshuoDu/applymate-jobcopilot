import { defineConfig, devices } from "@playwright/test";

const hasExternalTarget = Boolean(process.env.E2E_BASE_URL);
const shouldStartWeb = !hasExternalTarget;

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "apps/web/tests/e2e/**/*.e2e.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  outputDir: "apps/web/tests/e2e/__artifacts__",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  webServer: shouldStartWeb
    ? {
        command: "pnpm --filter @jobcopilot/agent-protocol build && pnpm --filter @jobcopilot/shared build && pnpm --filter @jobcopilot/agent-model build && pnpm --filter @jobcopilot/agent-policy build && pnpm --filter web exec prisma generate && pnpm --filter web dev",
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
      name: "desktop-en",
      metadata: { appLocale: "en" },
      use: { ...devices["Desktop Chrome"], locale: "en-US" },
    },
    {
      name: "desktop-zh",
      metadata: { appLocale: "zh" },
      use: { ...devices["Desktop Chrome"], locale: "zh-CN" },
    },
    {
      name: "mobile-en",
      metadata: { appLocale: "en" },
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        locale: "en-US",
      },
    },
    {
      name: "mobile-zh",
      metadata: { appLocale: "zh" },
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      },
    },
  ],
});
