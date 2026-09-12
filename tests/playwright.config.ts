import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  getTestDatabaseConnection,
  loadTestEnvironment,
  projectRoot,
} from './e2e/database-runtime.mjs';

const offline = process.env.CODE_PRACTICE_E2E_OFFLINE === '1';
if (!offline) {
  loadTestEnvironment();
  getTestDatabaseConnection();
  process.env.CODE_PRACTICE_E2E_RUN_ID ??= randomUUID();
}

export default defineConfig({
  testDir: './e2e',
  testMatch: offline ? 'navigation.spec.ts' : '**/*.spec.ts',
  testIgnore: offline ? [] : ['navigation.spec.ts'],
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  globalTeardown: offline ? undefined : './e2e/global-teardown.mjs',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: offline
      ? 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 5173'
      : 'node tests/e2e/test-server.mjs',
    // Empty inherited values prevent Next from loading real credentials from .env.
    env: offline
      ? { POSTGRES_URL: '', TEST_POSTGRES_URL: '', VERCEL: '', VERCEL_ENV: '' }
      : undefined,
    cwd: projectRoot,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
