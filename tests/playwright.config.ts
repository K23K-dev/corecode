import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  getTestDatabaseConnection,
  loadTestEnvironment,
  projectRoot,
} from './e2e/database-runtime.mjs';

loadTestEnvironment();
getTestDatabaseConnection();
process.env.CODE_PRACTICE_E2E_RUN_ID ??= randomUUID();

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  globalTeardown: './e2e/global-teardown.mjs',
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
    command: 'node tests/e2e/test-server.mjs',
    cwd: projectRoot,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
