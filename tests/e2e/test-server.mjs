import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { initializeDatabase } from '../../server/repository.mjs';
import { copyCatalogToTestDatabase } from '../grading-data.mjs';
import {
  createIsolatedTestDatabase,
  cleanupRuntime,
  loadTestEnvironment,
  TestDatabaseSafetyError,
  projectRoot,
  runtimeDirectory,
  runtimePath,
  testSchema,
} from './database-runtime.mjs';

let child;
let childExited;
let isolated;
let stopping;

async function stop(exitCode = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await childExited;
    }
    await cleanupRuntime();
    await isolated?.cleanup();
    process.exitCode = exitCode;
  })();
  return stopping;
}

try {
  loadTestEnvironment();
  // A second regular app must never be reused for tests. Playwright also checks
  // the frontend port before launching this process (reuseExistingServer:false).
  isolated = await createIsolatedTestDatabase();
  const schema = testSchema(isolated.connectionString);
  try {
    await initializeDatabase(isolated.connectionString);
    await copyCatalogToTestDatabase(isolated.connectionString);
    await mkdir(runtimeDirectory, { recursive: true });
    child = spawn(process.execPath, ['server/start.mjs'], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: 'inherit',
      // Only this child uses the isolated connection as its application database.
      // The test controller retains normal POSTGRES_URL for separation guards.
      env: {
        ...process.env,
        POSTGRES_URL: isolated.connectionString,
      },
    });
    childExited = new Promise((resolve) => {
      child.once('exit', (code) => resolve(code ?? 1));
      child.once('error', () => resolve(1));
    });
    if (!child.pid) throw new Error('The isolated test server did not start.');
    await writeFile(
      runtimePath(),
      JSON.stringify({
        runId: process.env.CODE_PRACTICE_E2E_RUN_ID,
        connectionString: isolated.connectionString,
        schema,
        serverPid: child.pid,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    process.once('SIGINT', () => {
      void stop();
    });
    process.once('SIGTERM', () => {
      void stop();
    });
    console.log('Isolated test app is starting in the separate Neon test database.');
    await stop(await childExited);
  } catch (error) {
    await stop(1);
    throw error;
  }
} catch (error) {
  console.error(
    error instanceof TestDatabaseSafetyError
      ? error.message
      : 'The isolated test server could not start. No normal application database was reset.',
  );
  process.exitCode = 1;
}
