import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getTestDatabaseConnection,
  loadTestEnvironment,
  TestDatabaseSafetyError,
} from './e2e/database-runtime.mjs';

try {
  loadTestEnvironment();
  getTestDatabaseConnection();
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'tests/vitest.config.ts',
      'tests/persistence.integration.test.ts',
      'tests/activity-database.test.ts',
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, CODE_PRACTICE_RUN_DB_TESTS: '1' },
    },
  );
  child.once('error', () => {
    console.error('Could not start the isolated database checks.');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof TestDatabaseSafetyError
      ? error.message
      : 'Could not initialize the isolated Neon database checks.',
  );
  process.exitCode = 1;
}
