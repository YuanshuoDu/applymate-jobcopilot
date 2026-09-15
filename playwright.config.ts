import { defineConfig, devices } from "@playwright/test";

const hasExternalTarget = Boolean(process.env.E2E_BASE_URL);
const shouldStartWeb = !hasExternalTarget;
const localE2EBaseURL = "http://127.0.0.1:3100";

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
    baseURL: process.env.E2E_BASE_URL ?? localE2EBaseURL,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  webServer: shouldStartWeb
    ? {
        command: "pnpm --filter @jobcopilot/agent-protocol build && pnpm --filter @jobcopilot/shared build && pnpm --filter @jobcopilot/agent-model build && pnpm --filter @jobcopilot/agent-policy build && pnpm --filter web build && pnpm --filter web exec next start --hostname 127.0.0.1 --port 3100",
        url: localE2EBaseURL,
        env: {
          ...process.env,
          AUTH_SECRET: "applymate-e2e-secret-change-me-32-bytes",
          AUTH_URL: localE2EBaseURL,
          NEXTAUTH_URL: localE2EBaseURL,
          DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture",
          DIRECT_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture",
          AGENT_PREVIEW_FIXTURE: "1",
        },
        reuseExistingServer: false,
        timeout: 300_000,
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
