import { defineConfig, devices } from '@playwright/test'

const origin = 'http://127.0.0.1:3173'
export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  workers: 1,
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /probe\.spec\.ts$/ },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' }, testIgnore: /probe\.spec\.ts$/ },
    { name: 'probe', use: { ...devices['Desktop Chrome'] }, testMatch: /probe\.spec\.ts$/ },
  ],
  webServer: [{ command: 'bun e2e/model.ts', url: 'http://127.0.0.1:3174', reuseExistingServer: false, timeout: 60000 }, {
    command: 'umask 077 && bun --bun vite dev --host 127.0.0.1 --port 3173 --strictPort',
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NORI_ORIGIN: origin,
      NORI_LLM_BASE_URL: 'http://127.0.0.1:3174/v1',
      NORI_LLM_MODEL: 'fixture',
      NORI_DATABASE_PATH: '.tmp/e2e/nori.sqlite',
    },
  }],
})
