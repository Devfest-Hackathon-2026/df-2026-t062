import { defineConfig, devices } from '@playwright/test'

// iPadは画面寸法・タッチ入力・WebKitの再現。実機Safariの代替とは扱わない。
const ipad = (name: string, viewport: { width: number, height: number }) => ({
  name, use: { ...devices['iPad Pro 11'], viewport, browserName: 'webkit' as const },
})
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4178', actionTimeout: 15_000, navigationTimeout: 30_000,
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'pc-1920', use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } } },
    { name: 'pc-2560', use: { browserName: 'chromium', viewport: { width: 2560, height: 1440 } } },
    ipad('ipad-11-portrait', { width: 834, height: 1194 }),
    ipad('ipad-11-landscape', { width: 1194, height: 834 }),
    ipad('ipad-129-portrait', { width: 1024, height: 1366 }),
    ipad('ipad-129-landscape', { width: 1366, height: 1024 }),
  ],
  webServer: {
    command: 'node e2e/support/server.ts',
    url: 'http://127.0.0.1:4178/api/health.json',
    timeout: 180_000, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
