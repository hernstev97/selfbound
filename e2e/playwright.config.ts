import { defineConfig, devices } from '@playwright/test';

// Playwright against its own local backend (ports 13470/13471) and the production build of the
// app in test mode (vite preview on 5472). globalSetup starts both, globalTeardown stops them.
// The tests change data, so they run serially on a fresh seed. Files run in alphabetical order;
// specs that create teams start with "z-" so they run last.
export const APP_URL = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 5472}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  use: {
    baseURL: APP_URL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    colorScheme: 'dark',
    // The service worker only in pwa.spec.ts; elsewhere it would disturb counts of loaded files.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec/ },
    { name: 'iphone', testMatch: /mobile\.spec/, use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', browserName: 'chromium' } },
    { name: 'pixel', testMatch: /mobile\.spec/, use: { ...devices['Pixel 7'] } },
  ],
});
