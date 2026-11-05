import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 8_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'], browserName: 'chromium' } },
  ],
  webServer: {
    command: 'node ../../scripts/serve-web.mjs',
    url: 'http://127.0.0.1:4173/',
    timeout: 30_000,
    reuseExistingServer: !process.env['CI'],
  },
});
