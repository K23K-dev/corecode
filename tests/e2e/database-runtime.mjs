import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateNeonConnectionString } from '../../server/database-config.mjs';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeDirectory = path.join(projectRoot, 'tests', '.local', 'e2e-runtime');

export class TestDatabaseSafetyError extends Error {}

export function loadTestEnvironment() {
  const environmentPath = path.join(projectRoot, '.env');
  try {
    // Node keeps inherited variables when loading a private environment file.
    if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);
  } catch {
    throw new TestDatabaseSafetyError('Could not load the private database test settings.');
  }
}

function checkedUrl(value, variableName) {
  try {
    const url = validateNeonConnectionString(value, variableName);
    // PostgreSQL URLs are non-special URLs, so URL does not normalize DNS case.
    url.hostname = url.hostname.toLowerCase();
    // pg otherwise inherits PGPORT when a connection URL omits the default port.
    url.port ||= '5432';
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate connection options.');
    decodeURIComponent(url.pathname);
    decodeURIComponent(url.username);
    return url;
  } catch {
    throw new TestDatabaseSafetyError(
      `${variableName} must be a valid, secure Neon connection string.`,
    );
  }
}

function databaseIdentity(url) {
  return `${url.hostname.replace(/-pooler(?=\.)/, '')}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function getTestDatabaseConnection() {
  if (!process.env.TEST_POSTGRES_URL?.trim()) {
    throw new TestDatabaseSafetyError(
      'Set TEST_POSTGRES_URL to a direct Neon connection for a separate test database or branch. Database tests never use POSTGRES_URL as a fallback.',
    );
  }
  if (!process.env.POSTGRES_URL?.trim()) {
    throw new TestDatabaseSafetyError(
      'POSTGRES_URL is also required so database tests can reject the normal application database.',
    );
  }
  const test = checkedUrl(process.env.TEST_POSTGRES_URL, 'TEST_POSTGRES_URL');
  const application = checkedUrl(process.env.POSTGRES_URL, 'POSTGRES_URL');
  if (test.hostname.split('.')[0].endsWith('-pooler')) {
    throw new TestDatabaseSafetyError(
      'TEST_POSTGRES_URL must use a direct Neon endpoint, not a pooled endpoint; tests require a persistent search_path.',
    );
  }
  if ([...test.searchParams.keys()].some((key) => key.toLowerCase() === 'options')) {
    throw new TestDatabaseSafetyError('TEST_POSTGRES_URL must not include custom startup options.');
  }
  if (databaseIdentity(test) === databaseIdentity(application)) {
    throw new TestDatabaseSafetyError(
      'TEST_POSTGRES_URL must select a different Neon endpoint or database from POSTGRES_URL. Credentials, pooling, and query options do not provide isolation.',
    );
  }
  return { connectionString: test.href };
}

export function runtimePath() {
  const runId = process.env.CODE_PRACTICE_E2E_RUN_ID;
  if (!/^[a-f0-9-]{36}$/.test(runId ?? '')) throw new Error('Missing isolated E2E run identifier.');
  return path.join(runtimeDirectory, `${runId}.json`);
}

export function testSchema(connectionString) {
  const url = checkedUrl(connectionString, 'Isolated test connection');
  const expected = new URL(getTestDatabaseConnection().connectionString);
  const match = /^-csearch_path=(cp_test_[a-f0-9]{24})$/.exec(
    url.searchParams.get('options') ?? '',
  );
  if (!match || url.searchParams.getAll('options').length !== 1) {
    throw new TestDatabaseSafetyError(
      'Refusing database work outside an isolated cp_test_ schema.',
    );
  }
  url.searchParams.delete('options');
  url.searchParams.sort();
  expected.searchParams.sort();
  if (url.href !== expected.href) {
    throw new TestDatabaseSafetyError(
      'The isolated connection must exactly match TEST_POSTGRES_URL apart from its generated schema.',
    );
  }
  return match[1];
}

async function withTestClient(connectionString, operation) {
  testSchema(connectionString);
  const client = new pg.Client({
    connectionString: checkedUrl(connectionString, 'Isolated test connection').href,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
  });
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    if (error instanceof TestDatabaseSafetyError) throw error;
    throw new TestDatabaseSafetyError(
      'The isolated Neon database operation failed. Verify the separate test connection and its schema permissions; connection details were not printed.',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function dropTestSchema(connectionString) {
  await withTestClient(connectionString, async (client) => {
    const schema = await assertTestConnection(client, connectionString, true);
    await client.query("SET lock_timeout = '5s'; SET statement_timeout = '10s'");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
}

export async function createIsolatedTestDatabase() {
  const url = new URL(getTestDatabaseConnection().connectionString);
  const schema = `cp_test_${randomBytes(12).toString('hex')}`;
  url.searchParams.set('options', `-csearch_path=${schema}`);
  const connectionString = url.href;
  await withTestClient(connectionString, async (client) => {
    // A not-yet-created search path resolves to no schema, never public.
    await assertTestConnection(client, connectionString, true);
    // No IF NOT EXISTS: an improbable name collision must not reuse another schema.
    await client.query(`CREATE SCHEMA ${schema}`);
    await assertTestConnection(client, connectionString);
  });
  return { connectionString, cleanup: () => dropTestSchema(connectionString) };
}

export async function readRuntime() {
  let raw;
  try {
    raw = await readFile(runtimePath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new TestDatabaseSafetyError('Could not read the private isolated E2E runtime manifest.');
  }
  let runtime;
  try {
    runtime = JSON.parse(raw);
  } catch {
    // JSON parser errors can echo manifest contents, including credentials.
    throw new TestDatabaseSafetyError('Invalid isolated E2E runtime manifest.');
  }
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    Array.isArray(runtime) ||
    runtime.runId !== process.env.CODE_PRACTICE_E2E_RUN_ID ||
    runtime.schema !== testSchema(runtime.connectionString) ||
    !Number.isSafeInteger(runtime.serverPid) ||
    runtime.serverPid <= 0
  ) {
    throw new TestDatabaseSafetyError('Invalid isolated E2E runtime manifest.');
  }
  return runtime;
}

export async function assertTestConnection(client, connectionString, allowMissingSchema = false) {
  const schema = testSchema(connectionString);
  const url = new URL(connectionString);
  const {
    rows: [actual],
  } = await client.query(
    "SELECT current_database() AS database, current_user AS username, current_schema() AS schema, current_setting('search_path') AS search_path, current_schemas(false) AS schemas",
  );
  if (
    !actual ||
    actual.database !== decodeURIComponent(url.pathname.slice(1)) ||
    actual.username !== decodeURIComponent(url.username) ||
    actual.search_path !== schema ||
    !Array.isArray(actual.schemas) ||
    !(
      (actual.schema === schema && actual.schemas.length === 1 && actual.schemas[0] === schema) ||
      (allowMissingSchema && actual.schema === null && actual.schemas.length === 0)
    )
  ) {
    throw new TestDatabaseSafetyError(
      'Database identity does not match the isolated test database and schema; no data was reset.',
    );
  }
  return schema;
}

export async function cleanupRuntime() {
  let runtime;
  try {
    runtime = await readRuntime();
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await dropTestSchema(runtime.connectionString);
  await unlink(runtimePath());
}
