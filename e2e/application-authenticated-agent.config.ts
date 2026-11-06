// Collected separately from the standard Playwright configuration.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'application-authenticated-agent.browser.ts',
  workers: 1, retries: 0, timeout: 180_000, reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3100', trace: 'off' },
})
