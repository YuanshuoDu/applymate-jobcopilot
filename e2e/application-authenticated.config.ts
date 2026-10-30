import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'application-authenticated.browser.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3100', trace: 'off' },
  reporter: 'list',
})
