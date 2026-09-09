import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyCatalogToTestDatabase,
  readCatalogSnapshot,
  readGradingSnapshot,
} from './grading-data.mjs';

const { stableJson } = (await import(
  new URL('../server/validation.mjs', import.meta.url).href
)) as {
  stableJson(value: unknown): string;
};

type Row = {
  id: string;
  problem_version: string;
  problem?: Record<string, unknown>;
  spec_version: string | null;
  spec: Record<string, unknown> | null;
};

const mocks = vi.hoisted(() => ({
  pools: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  sourceRows: [] as Row[],
  targetPopulated: false,
  publicOverrides: {} as Record<string, unknown>,
  identityOverrides: {} as Record<string, unknown>,
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(private config: { connectionString: string }) {
      mocks.pools(config);
    }
    on() {}
    async connect() {
      return {
        query: (sql: string, values?: unknown[]) => mocks.query(this.config, sql, values),
        release: mocks.release,
      };
    }
    async end() {
      mocks.end();
    }
  },
  default: {
    Client: class {
      constructor() {
        throw new Error('Grading data helpers must use the mocked pool.');
      }
    },
  },
}));

// Synthetic credentials only. All PostgreSQL connections and queries are mocked.
const applicationUrl =
  'postgresql://owner:synthetic@ep-normal-123-pooler.us-east-1.aws.neon.tech/practice?sslmode=require';
const testUrl =
  'postgresql://tester:synthetic@ep-testing-456.us-east-1.aws.neon.tech/practice_test?sslmode=require';
const schema = 'cp_test_0123456789abcdef01234567';
const isolatedUrl = `${testUrl}&options=-csearch_path%3D${schema}`;

function hash(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sourceRow(runtime = 'python', id = 'python-core-normalize-text-01'): Row {
  const content = {
    id,
    runtime,
    deckId: 'python',
    deck: 'Python',
    referenceCode: 'class Solution: pass',
  };
  const version = hash(content);
  const spec = {
    runtime: runtime === 'browser-python' ? 'python' : runtime,
    cases: [{ name: 'Trusted example', expected: '6', code: 'assert solution.answer(3) == 6' }],
  };
  return {
    id: content.id,
    problem_version: version,
    problem: { ...content, version },
    spec_version: hash(spec),
    spec,
  };
}

function statements(destination = false) {
  return mocks.query.mock.calls
    .filter(([config]) => config.connectionString.includes('options=') === destination)
    .map(([, sql]) => sql as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('POSTGRES_URL', applicationUrl);
  vi.stubEnv('TEST_POSTGRES_URL', testUrl);
  mocks.sourceRows = [sourceRow()];
  mocks.targetPopulated = false;
  mocks.publicOverrides = {};
  mocks.identityOverrides = {};
  mocks.query.mockImplementation(async ({ connectionString }, sql: string) => {
    const url = new URL(connectionString);
    if (sql.startsWith('SELECT current_database()')) {
      return {
        rows: [
          {
            database: decodeURIComponent(url.pathname.slice(1)),
            username: decodeURIComponent(url.username),
            schema,
            search_path: schema,
            schemas: [schema],
            ...mocks.identityOverrides,
          },
        ],
      };
    }
    if (sql.startsWith('SELECT p.id')) {
      return { rows: mocks.sourceRows };
    }
    if (sql.includes('AS decks'))
      return {
        rows: [
          {
            decks: [{ id: 'python', name: 'Python' }],
            exercises: mocks.sourceRows.map((row) => row.problem),
            ...mocks.publicOverrides,
          },
        ],
      };
    if (sql.includes(' AS populated')) return { rows: [{ populated: mocks.targetPopulated }] };
    return { rows: [] };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('read-only Neon grading snapshots', () => {
  it('reads only current public content and private specs in one read-only repeatable-read transaction', async () => {
    const snapshot = await readGradingSnapshot();
    expect(snapshot).toEqual([
      {
        problem: mocks.sourceRows[0].problem,
        spec: mocks.sourceRows[0].spec,
        specVersion: mocks.sourceRows[0].spec_version,
      },
    ]);
    const queries = statements();
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries[1]).toContain('g.problem_version = p.current_version');
    expect(queries[1]).toContain('WHERE p.active');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.join('\n')).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|cp_state|cp_submissions/);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('keeps the browser-Python to native-Python verification mapping', async () => {
    mocks.sourceRows = [sourceRow('browser-python')];
    const [snapshot] = await readGradingSnapshot();
    expect(snapshot.problem.runtime).toBe('browser-python');
    expect(snapshot.spec.runtime).toBe('python');
  });

  it.each(['missing', 'wrong digest', 'wrong runtime', 'empty cases'])(
    'fails closed for %s grading cases',
    async (failure) => {
      const row = mocks.sourceRows[0];
      if (failure === 'missing') row.spec = null;
      if (failure === 'wrong digest') row.spec_version = 'f'.repeat(64);
      if (failure === 'wrong runtime') row.spec!.runtime = 'javascript';
      if (failure === 'empty cases') row.spec!.cases = [];
      await expect(readGradingSnapshot()).rejects.toThrow('missing or do not match');
      expect(statements().at(-1)).toBe('ROLLBACK');
      expect(statements()).not.toContain('COMMIT');
    },
  );

  it.each(['empty', 'duplicate', 'wrong version', 'changed public content'])(
    'rejects an %s catalog snapshot',
    async (failure) => {
      if (failure === 'empty') mocks.sourceRows = [];
      if (failure === 'duplicate') mocks.sourceRows.push(mocks.sourceRows[0]);
      if (failure === 'wrong version') mocks.sourceRows[0].problem!.version = 'f'.repeat(64);
      if (failure === 'changed public content') mocks.sourceRows[0].problem!.title = 'Changed';
      await expect(readGradingSnapshot()).rejects.toThrow(/empty|inconsistent|stored version/);
      expect(statements()).not.toContain('COMMIT');
    },
  );

  it('redacts connection errors and releases the connection', async () => {
    mocks.query.mockRejectedValue(new Error(`Connection failed: ${applicationUrl}`));
    const failure = await readGradingSnapshot().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('synthetic');
    expect(String(failure)).toContain('Connection details were not printed');
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('does not connect when the normal Neon connection is missing or invalid', async () => {
    vi.stubEnv('POSTGRES_URL', '');
    await expect(readGradingSnapshot()).rejects.toThrow('Could not read');
    expect(mocks.pools).not.toHaveBeenCalled();
  });
});

describe('read-only public Neon catalog snapshots', () => {
  it('returns only the public catalog without querying private specs or learner records', async () => {
    const catalog = await readCatalogSnapshot();
    expect(catalog.decks).toEqual([{ id: 'python', name: 'Python' }]);
    expect(catalog.exercises).toEqual([mocks.sourceRows[0].problem]);
    expect(catalog.version).toMatch(/^[a-f0-9]{64}$/);
    expect(statements()[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements().join('\n')).not.toMatch(
      /cp_grading_specs|cp_state|cp_submissions|INSERT|UPDATE|DELETE/,
    );
  });

  it('preserves an honest empty public catalog', async () => {
    mocks.publicOverrides = { decks: [], exercises: [] };
    expect(await readCatalogSnapshot()).toMatchObject({ decks: [], exercises: [] });
  });

  it.each(['changed content', 'missing deck', 'duplicate deck', 'duplicate problem'])(
    'rejects %s before returning an inconsistent snapshot',
    async (failure) => {
      if (failure === 'changed content') mocks.sourceRows[0].problem!.title = 'Changed';
      if (failure === 'missing deck') mocks.publicOverrides.decks = [];
      if (failure === 'duplicate deck')
        mocks.publicOverrides.decks = [
          { id: 'python', name: 'Python' },
          { id: 'python', name: 'Python' },
        ];
      if (failure === 'duplicate problem') mocks.sourceRows.push(mocks.sourceRows[0]);
      await expect(readCatalogSnapshot()).rejects.toThrow(/inconsistent|does not match/);
      expect(statements().at(-1)).toBe('ROLLBACK');
    },
  );
});

describe('isolated test catalog preparation', () => {
  it('copies only catalog tables after checking the separate database identity and exact empty schema', async () => {
    await expect(copyCatalogToTestDatabase(isolatedUrl)).resolves.toBe(1);
    const queries = statements(true);
    expect(queries[0]).toMatch(/^SELECT current_database/);
    expect(queries[1]).toBe('BEGIN');
    expect(queries[2]).toMatch(/^SELECT current_database/);
    const writes = mocks.query.mock.calls.filter(([, sql]) => sql.startsWith('INSERT'));
    expect(writes).toHaveLength(4);
    expect(writes[0][0].connectionString).toContain('ep-testing-456');
    expect(writes.map(([, sql]) => sql.match(/INSERT INTO (\S+)\(/)?.[1])).toEqual([
      `${schema}.cp_decks`,
      `${schema}.cp_problem_versions`,
      `${schema}.cp_problems`,
      `${schema}.cp_grading_specs`,
    ]);
    expect(JSON.parse(writes[3][2][0])).toEqual([
      {
        exercise_id: mocks.sourceRows[0].id,
        problem_version: mocks.sourceRows[0].problem_version,
        spec_version: mocks.sourceRows[0].spec_version,
        content: mocks.sourceRows[0].spec,
      },
    ]);
    expect(writes.every(([, sql]) => sql.includes('jsonb_to_recordset($1::jsonb)'))).toBe(true);
    expect(statements().join('\n')).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/);
    expect(queries.join('\n')).not.toMatch(/cp_state|cp_submissions|UPDATE|DELETE|TRUNCATE/);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite any pre-existing test catalog', async () => {
    mocks.targetPopulated = true;
    await expect(copyCatalogToTestDatabase(isolatedUrl)).rejects.toThrow('nonempty');
    expect(statements(true).join('\n')).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(statements(true).at(-1)).toBe('ROLLBACK');
  });

  it('batches every current row while preserving problem and deck ordering', async () => {
    mocks.sourceRows.push(
      sourceRow('python', 'second-problem'),
      sourceRow('python', 'third-problem'),
    );
    await expect(copyCatalogToTestDatabase(isolatedUrl)).resolves.toBe(3);
    const writes = mocks.query.mock.calls.filter(([, sql]) => sql.startsWith('INSERT'));
    expect(writes).toHaveLength(4);
    expect(writes.every(([, sql]) => !sql.includes('ON CONFLICT'))).toBe(true);
    expect(JSON.parse(writes[3][2][0])).toEqual(
      mocks.sourceRows.map((row) => ({
        exercise_id: row.id,
        problem_version: row.problem_version,
        spec_version: row.spec_version,
        content: row.spec,
      })),
    );
    expect(JSON.parse(writes[2][2][0])).toEqual(
      mocks.sourceRows.map((row, position) => ({
        id: row.id,
        version: row.problem_version,
        position,
      })),
    );
  });

  it('rejects mismatched public and private snapshots before opening the destination', async () => {
    mocks.publicOverrides.exercises = [];
    await expect(copyCatalogToTestDatabase(isolatedUrl)).rejects.toThrow('snapshots do not match');
    expect(statements(true)).toEqual([]);
    expect(statements().at(-1)).toBe('ROLLBACK');
  });

  it.each(['normal URL', 'missing test URL', 'same endpoint', 'wrong schema', 'unconfigured URL'])(
    'refuses %s before opening any connection',
    async (failure) => {
      let destination = isolatedUrl;
      if (failure === 'normal URL') destination = applicationUrl;
      if (failure === 'missing test URL') vi.stubEnv('TEST_POSTGRES_URL', '');
      if (failure === 'same endpoint') {
        vi.stubEnv('TEST_POSTGRES_URL', applicationUrl.replace('-pooler', ''));
      }
      if (failure === 'wrong schema') destination = isolatedUrl.replace(schema, 'public');
      if (failure === 'unconfigured URL')
        destination = isolatedUrl.replace('ep-testing', 'ep-other');
      await expect(copyCatalogToTestDatabase(destination)).rejects.toThrow();
      expect(mocks.pools).not.toHaveBeenCalled();
    },
  );

  it.each(['database', 'username', 'schema', 'search_path', 'schemas'])(
    'checks actual %s identity before test writes',
    async (field) => {
      mocks.identityOverrides[field] = field === 'schemas' ? ['public'] : 'public';
      await expect(copyCatalogToTestDatabase(isolatedUrl)).rejects.toThrow(
        'identity does not match',
      );
      expect(statements(true).join('\n')).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/);
      expect(statements(true)).not.toContain('BEGIN');
    },
  );

  it.each(['missing spec', 'changed version', 'conflicting spec', 'duplicate problem'])(
    'rejects %s without opening the destination',
    async (failure) => {
      if (failure === 'missing spec') mocks.sourceRows[0].spec = null;
      if (failure === 'changed version') mocks.sourceRows[0].problem_version = 'f'.repeat(64);
      if (failure === 'conflicting spec') mocks.sourceRows[0].spec_version = 'f'.repeat(64);
      if (failure === 'duplicate problem') mocks.sourceRows.push(mocks.sourceRows[0]);
      await expect(copyCatalogToTestDatabase(isolatedUrl)).rejects.toThrow(/match|inconsistent/);
      expect(statements(true)).toEqual([]);
      expect(statements().at(-1)).toBe('ROLLBACK');
    },
  );

  it('rolls back write failures without exposing either connection string', async () => {
    const query = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (config, sql, values) => {
      if (sql.startsWith('INSERT')) throw new Error(`Could not write: ${isolatedUrl}`);
      return query(config, sql, values);
    });
    const failure = await copyCatalogToTestDatabase(isolatedUrl).catch((error: Error) => error);
    expect(String(failure)).not.toContain('synthetic');
    expect(String(failure)).toContain('Connection details were not printed');
    expect(statements(true).at(-1)).toBe('ROLLBACK');
    expect(statements(true)).not.toContain('COMMIT');
  });
});
