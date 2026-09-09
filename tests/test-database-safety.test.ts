import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTestConnection,
  cleanupRuntime,
  createIsolatedTestDatabase,
  getTestDatabaseConnection,
  testSchema,
} from './e2e/database-runtime.mjs';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
  construct: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  connectionString: '',
  schemaExists: false,
  actual: {} as Record<string, unknown>,
}));

vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = mocks.connect;
      end = mocks.end;
      query = mocks.query;
      constructor(config: { connectionString: string }) {
        mocks.construct(config);
        mocks.connectionString = config.connectionString;
      }
    },
  },
}));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, unlink: mocks.unlink }));

// Synthetic connection strings only. Every pg client and manifest read is mocked.
const applicationUrl =
  'postgresql://owner:private@ep-normal-123-pooler.us-east-1.aws.neon.tech/practice?sslmode=require';
const testUrl =
  'postgresql://tester:private-test@ep-testing-456.us-east-1.aws.neon.tech/practice_test?sslmode=require';
const schema = 'cp_test_0123456789abcdef01234567';
const runId = '12345678-1234-1234-1234-123456789abc';

function isolatedUrl(base = testUrl, targetSchema = schema) {
  const url = new URL(base);
  url.searchParams.set('options', `-csearch_path=${targetSchema}`);
  return url.href;
}

function explicitPort(connectionString: string) {
  const url = new URL(connectionString);
  url.port = '5432';
  return url.href;
}

function identity(connectionString = isolatedUrl(), exists = true) {
  const url = new URL(connectionString);
  const targetSchema = url.searchParams.get('options')!.slice('-csearch_path='.length);
  return {
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    schema: exists ? targetSchema : null,
    search_path: targetSchema,
    schemas: exists ? [targetSchema] : [],
  };
}

beforeEach(() => {
  vi.stubEnv('POSTGRES_URL', applicationUrl);
  vi.stubEnv('TEST_POSTGRES_URL', testUrl);
  vi.stubEnv('CODE_PRACTICE_E2E_RUN_ID', runId);
  vi.clearAllMocks();
  mocks.connectionString = '';
  mocks.schemaExists = false;
  mocks.actual = {};
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT current_database()'))
      return {
        rows: [{ ...identity(mocks.connectionString, mocks.schemaExists), ...mocks.actual }],
      };
    if (sql.startsWith('CREATE SCHEMA ')) mocks.schemaExists = true;
    if (sql.startsWith('DROP SCHEMA IF EXISTS ')) mocks.schemaExists = false;
    return { rows: [] };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('explicit isolated Neon test configuration', () => {
  it.each([undefined, '', '   '])(
    'rejects missing TEST_POSTGRES_URL (%s) before connecting',
    async (value) => {
      vi.stubEnv('TEST_POSTGRES_URL', value);
      await expect(createIsolatedTestDatabase()).rejects.toThrow('Set TEST_POSTGRES_URL');
      expect(mocks.construct).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );

  it('requires the normal application URL for a separation check', () => {
    vi.stubEnv('POSTGRES_URL', undefined);
    expect(getTestDatabaseConnection).toThrow('POSTGRES_URL is also required');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    applicationUrl.replace('-pooler', ''),
    applicationUrl.replace('-pooler', '').replace('owner:private', 'other:credentials'),
    applicationUrl.replace('ep-normal-123-pooler', 'EP-NORMAL-123'),
    applicationUrl.replace('-pooler', '').replace('/practice?', '/%70ractice?') +
      '&application_name=test',
  ])('rejects the application endpoint/database despite cosmetic changes', (url) => {
    vi.stubEnv('TEST_POSTGRES_URL', url);
    expect(getTestDatabaseConnection).toThrow('different Neon endpoint or database');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('accepts a separate direct branch or database without changing inherited application settings', () => {
    expect(getTestDatabaseConnection()).toEqual({ connectionString: explicitPort(testUrl) });
    const separateDatabase = applicationUrl
      .replace('-pooler', '')
      .replace('/practice?', '/separate_test?');
    vi.stubEnv('TEST_POSTGRES_URL', separateDatabase);
    expect(getTestDatabaseConnection()).toEqual({
      connectionString: explicitPort(separateDatabase),
    });
    expect(process.env.POSTGRES_URL).toBe(applicationUrl);
  });

  it('pins the default Neon port for creation, downstream clients, and cleanup despite PGPORT', async () => {
    vi.stubEnv('PGPORT', '54329');
    const isolated = await createIsolatedTestDatabase();
    expect(new URL(isolated.connectionString).port).toBe('5432');
    expect(testSchema(isolated.connectionString)).toMatch(/^cp_test_[a-f0-9]{24}$/);
    await isolated.cleanup();
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    for (const [config] of mocks.construct.mock.calls) {
      expect(new URL(config.connectionString).port).toBe('5432');
    }
    expect(process.env.TEST_POSTGRES_URL).toBe(testUrl);
  });

  it.each([
    testUrl.replace('ep-testing-456.', 'ep-testing-456-pooler.'),
    testUrl.replace('ep-testing-456.', 'EP-TESTING-456-POOLER.'),
    testUrl.replace('sslmode=require', 'sslmode=disable'),
    testUrl + '&sslmode=disable',
    testUrl + '&options=-csearch_path%3Dpublic',
    testUrl + '&host=127.0.0.1',
    'postgresql://tester:secret@127.0.0.1:54329/code_practice',
  ])('rejects pooled, unsafe, overridden, or local test connections', (url) => {
    vi.stubEnv('TEST_POSTGRES_URL', url);
    expect(getTestDatabaseConnection).toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe('test schema and destructive-operation guards', () => {
  it('accepts only the configured test URL plus one strict generated schema', () => {
    expect(testSchema(isolatedUrl())).toBe(schema);
  });

  it.each([
    testUrl,
    isolatedUrl(testUrl, 'public'),
    isolatedUrl(testUrl, `${schema},public`),
    isolatedUrl(testUrl, 'cp_test_short'),
    isolatedUrl(testUrl, 'cp_test_0123456789ABCDEF01234567'),
    isolatedUrl(testUrl.replace('private-test', 'changed-credentials')),
    isolatedUrl(testUrl.replace('/practice_test?', '/another_test?')),
    isolatedUrl(testUrl + '&application_name=unapproved'),
    isolatedUrl() + '&options=-csearch_path%3Dpublic',
    isolatedUrl(applicationUrl.replace('-pooler', '')),
  ])('rejects unapproved connection/schema input before any query', async (url) => {
    const client = { query: vi.fn() } as unknown as pg.Client;
    await expect(assertTestConnection(client, url)).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    { database: 'wrong_database' },
    { username: 'wrong_role' },
    { schema: 'public', schemas: ['public'] },
    { search_path: `${schema}, public`, schemas: [schema, 'public'] },
    { schema: null, schemas: [] },
  ])('refuses reset eligibility when actual database identity differs', async (actual) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...identity(), ...actual }] });
    const client = { query } as unknown as pg.Client;
    await expect(assertTestConnection(client, isolatedUrl())).rejects.toThrow('Database identity');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatch(/^SELECT /);
  });

  it('permits a missing generated schema only when explicitly checking creation/cleanup', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [identity(isolatedUrl(), false)] }),
    } as unknown as pg.Client;
    await expect(assertTestConnection(client, isolatedUrl(), true)).resolves.toBe(schema);
    await expect(assertTestConnection(client, isolatedUrl())).rejects.toThrow('Database identity');
  });

  it('creates a new random schema without reusing existing names, then guards its exact cleanup', async () => {
    const isolated = await createIsolatedTestDatabase();
    const createdSchema = testSchema(isolated.connectionString);
    expect(createdSchema).toMatch(/^cp_test_[a-f0-9]{24}$/);
    expect(mocks.query).toHaveBeenCalledWith(`CREATE SCHEMA ${createdSchema}`);
    expect(mocks.query.mock.calls.filter(([sql]) => /IF NOT EXISTS/.test(sql))).toEqual([]);
    expect(process.env.POSTGRES_URL).toBe(applicationUrl);
    mocks.query.mockClear();
    await isolated.cleanup();
    expect(mocks.query.mock.calls[0][0]).toMatch(/^SELECT current_database\(\)/);
    expect(mocks.query).toHaveBeenCalledWith(`DROP SCHEMA IF EXISTS ${createdSchema} CASCADE`);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it('does not drop a schema when cleanup reaches an unexpected database', async () => {
    const isolated = await createIsolatedTestDatabase();
    mocks.actual = { database: 'normal_application' };
    mocks.query.mockClear();
    await expect(isolated.cleanup()).rejects.toThrow('Database identity');
    expect(mocks.query.mock.calls.some(([sql]) => /DROP|TRUNCATE|DELETE|UPDATE/.test(sql))).toBe(
      false,
    );
  });

  it('rechecks configuration before cleanup rather than trusting an old captured connection', async () => {
    const isolated = await createIsolatedTestDatabase();
    mocks.construct.mockClear();
    vi.stubEnv('TEST_POSTGRES_URL', testUrl.replace('ep-testing-456', 'ep-different-789'));
    await expect(isolated.cleanup()).rejects.toThrow('exactly match TEST_POSTGRES_URL');
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it('does not connect or remove a runtime manifest pointing outside configured test settings', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        runId,
        schema,
        connectionString: isolatedUrl(testUrl.replace('/practice_test?', '/unapproved?')),
        serverPid: 123,
      }),
    );
    await expect(cleanupRuntime()).rejects.toThrow('exactly match TEST_POSTGRES_URL');
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('sanitizes connection failures rather than reporting credentials', async () => {
    mocks.connect.mockRejectedValue(new Error(testUrl));
    let message = '';
    try {
      await createIsolatedTestDatabase();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('isolated Neon database operation failed');
    expect(message).not.toContain('private-test');
    expect(message).not.toContain('postgresql://');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not echo malformed private manifest contents in JSON parse errors', async () => {
    mocks.readFile.mockResolvedValue(`{"connectionString":"${testUrl}",broken`);
    await expect(cleanupRuntime()).rejects.toThrow('Invalid isolated E2E runtime manifest.');
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
