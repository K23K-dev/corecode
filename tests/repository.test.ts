import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node repository modules are tested through their runtime interface.
import * as repository from '../server/repository.mjs';
// @ts-expect-error Shared runtime validation has no generated declarations.
import { stableJson } from '../server/validation.mjs';

const {
  readExecutionProblem,
  readCatalog,
  initializeSchema,
  initializeDatabase,
  readActivity,
  repairActivity,
} = repository;

const startup = vi.hoisted(() => ({
  allowPool: false,
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      if (!startup.allowPool) throw new Error('Offline repository tests must not open a database.');
    }
    on() {}
    connect = startup.connect;
    end = startup.end;
  },
}));

describe('Neon-only schema startup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    startup.allowPool = true;
    startup.query.mockResolvedValue({ rows: [] });
    startup.connect.mockResolvedValue({ query: startup.query, release: startup.release });
  });

  afterEach(() => {
    startup.allowPool = false;
    vi.restoreAllMocks();
  });

  const connection =
    'postgresql://test:test@ep-example.us-east-1.aws.neon.tech/test?sslmode=require';

  it('initializes schema in a transaction without inserting, rewriting, or deactivating catalog data', async () => {
    await initializeDatabase(connection);
    const queries = startup.query.mock.calls.map(([sql]) => sql as string);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('CREATE TABLE IF NOT EXISTS cp_problems');
    expect(queries[3]).toBe('COMMIT');
    expect(queries.join('\n')).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+cp_(?:decks|problems|problem_versions|grading_specs)\b/i,
    );
    expect(startup.release).toHaveBeenCalledOnce();
    expect(startup.end).toHaveBeenCalledOnce();
  });

  it('rolls back a failed schema initialization and releases its connection', async () => {
    startup.query.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE TABLE')) throw new Error('Schema unavailable');
      return { rows: [] };
    });
    await expect(initializeDatabase(connection)).rejects.toThrow('Schema unavailable');
    expect(startup.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(startup.query).not.toHaveBeenCalledWith('COMMIT');
    expect(startup.release).toHaveBeenCalledOnce();
    expect(startup.end).toHaveBeenCalledOnce();
  });

  it('closes its pool when no connection can be opened', async () => {
    startup.connect.mockRejectedValue(new Error('Database unavailable'));
    await expect(initializeDatabase(connection)).rejects.toThrow('Database unavailable');
    expect(startup.query).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
    expect(startup.end).toHaveBeenCalledOnce();
  });
});

const spec = {
  runtime: 'python',
  cases: [{ name: 'Example', expected: '1', code: 'private scenario' }],
};
const specVersion = createHash('sha256').update(stableJson(spec)).digest('hex');
const problem = {
  id: 'example',
  version: 'a'.repeat(64),
  gradingSpec: spec,
  gradingSpecVersion: specVersion,
};

describe('private Neon grading lookup', () => {
  it('selects only the current active version and returns private data separately', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [problem] });
    expect(await readExecutionProblem({ query }, 'example')).toEqual({
      id: problem.id,
      version: problem.version,
      gradingSpec: spec,
    });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('s.problem_version = p.current_version');
    expect(sql).toContain('p.active');
    expect(values).toEqual(['example']);
  });

  it('does not query for malformed identifiers', async () => {
    const query = vi.fn();
    for (const id of [undefined, {}, '__proto__', ' ']) {
      await expect(readExecutionProblem({ query }, id)).rejects.toMatchObject({ status: 400 });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps absent specs distinguishable from an unknown problem', async () => {
    expect(
      await readExecutionProblem({ query: vi.fn().mockResolvedValue({ rows: [] }) }, 'example'),
    ).toBeNull();
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ ...problem, gradingSpec: null, gradingSpecVersion: null }] });
    expect((await readExecutionProblem({ query }, 'example')).gradingSpec).toBeNull();
  });

  it('rejects inconsistent stored specs without exposing the private scenario', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ ...problem, gradingSpecVersion: 'b'.repeat(64) }] });
    await expect(readExecutionProblem({ query }, 'example')).rejects.toMatchObject({
      status: 503,
      code: 'grading_unavailable',
    });
    await expect(readExecutionProblem({ query }, 'example')).rejects.not.toThrow(
      'private scenario',
    );
  });

  it('never joins private specs into the public catalog', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ decks: [], exercises: [] }] });
    const catalog = await readCatalog({ query });
    expect(query.mock.calls[0][0]).not.toContain('cp_grading_specs');
    expect(Object.keys(catalog).sort()).toEqual(['decks', 'exercises', 'version']);
  });

  it('installs immutable, version-linked specs under the shared migration lock', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await initializeSchema({ query });
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    const ddl = query.mock.calls[1][0];
    expect(ddl).toContain('PRIMARY KEY (exercise_id, problem_version)');
    expect(ddl).toContain('REFERENCES cp_problem_versions(exercise_id, version)');
    expect(ddl).toContain('BEFORE UPDATE OR DELETE ON cp_grading_specs');
    // Membership alone evaluates to SQL NULL for JSON null; CHECK would accept it.
    expect(ddl).toContain("content ? 'runtime'");
    expect(ddl).toContain("jsonb_typeof(content->'runtime') = 'string'");
    expect(ddl).toContain("content->>'runtime' IN ('python', 'javascript', 'sql', 'shell')");
  });
});

describe('practice activity repository', () => {
  const NOW = new Date('2024-03-12T16:00:00.000Z');
  const earnedDates = ['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04', '2024-03-05'];
  const timestampsFor = (dates: string[]) => dates.map((date) => `${date}T16:00:00.000Z`);
  afterEach(() => vi.restoreAllMocks());

  /** A transactional in-memory double; the cp_state lock serializes snapshots and writes. */
  function fixture(
    timestamps: unknown[] = timestampsFor(earnedDates),
    initialRepairs: string[] = [],
    failAt = '',
    onQuery: (sql: string) => void = () => {},
  ) {
    const repairs = new Set(initialRepairs);
    let tail = Promise.resolve();
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const snapshot = (pending: string[] = []) => ({
      rows: [{ timestamps, repairs: [...repairs, ...pending].sort() }],
    });
    const query = vi.fn(async (sql: string) => {
      calls.push({ sql });
      onQuery(sql);
      return snapshot();
    });
    const connect = vi.fn(async () => {
      let pending: string[] = [];
      let unlock: (() => void) | undefined;
      const release = vi.fn(() => unlock?.());
      releases.push(release);
      return {
        release,
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          onQuery(sql);
          if (failAt && sql.includes(failAt)) throw new Error('Synthetic storage failure');
          if (sql.includes('FOR UPDATE')) {
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
            return { rows: [{ profile_id: 1 }] };
          }
          if (sql.includes('AS timestamps')) return snapshot(pending);
          if (sql.startsWith('INSERT INTO cp_streak_repairs')) pending.push(values![0] as string);
          if (sql === 'COMMIT') {
            pending.forEach((date) => repairs.add(date));
            pending = [];
            unlock?.();
          }
          if (sql === 'ROLLBACK') {
            pending = [];
            unlock?.();
          }
          return { rows: [] };
        }),
      };
    });
    return { pool: { query, connect }, repairs, calls, releases };
  }

  describe('fixed Eastern practice activity snapshots', () => {
    it('captures the live clock only after a slow snapshot query finishes', async () => {
      let clock = Date.parse('2024-03-12T23:59:59.999Z');
      const afterReset = Date.parse('2024-03-13T00:00:00.001Z');
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const source = fixture(undefined, [], '', () => {
        clock = afterReset;
      });
      const result = await readActivity(source.pool);
      expect(result.today).toBe('2024-03-13');
      expect(result.serverNow).toBe(new Date(afterReset).toISOString());
      expect(result.resetAt).toBe('2024-03-14T00:00:00.000Z');
    });

    it('reads counts and repairs in one coherent statement without reading submitted code or cp_state', async () => {
      const source = fixture();
      const activity = await readActivity(source.pool, NOW);
      expect(activity).toMatchObject({
        timeZone: 'America/New_York',
        resetHour: 20,
        today: '2024-03-12',
        resetAt: '2024-03-13T00:00:00.000Z',
        serverNow: NOW.toISOString(),
        days: earnedDates.map((date) => ({ date, count: 1 })),
        repairs: [],
        streak: { current: 0, best: 5, hearts: 1, earnedHearts: 1, startedOn: '2024-03-01' },
      });
      expect(source.pool.query).toHaveBeenCalledOnce();
      const sql = source.calls[0].sql;
      expect(sql).toContain('cp_submissions');
      expect(sql).toContain('cp_streak_repairs');
      expect(sql).toContain("attempt->>'status' = 'accepted'");
      expect(sql).toContain("attempt->'passed' = attempt->'total'");
      expect(sql).toContain("attempt->'total' > '0'::jsonb");
      expect(sql).not.toMatch(/cp_state|code|SELECT\s+\*/i);
      expect(source.pool.connect).not.toHaveBeenCalled();
    });

    it.each([
      ['2024-03-10T00:59:59.999Z', '2024-03-09', '2024-03-10T01:00:00.000Z'],
      ['2024-03-10T01:00:00.000Z', '2024-03-10', '2024-03-11T00:00:00.000Z'],
      ['2024-03-11T00:00:00.000Z', '2024-03-11', '2024-03-12T00:00:00.000Z'],
      ['2024-11-03T00:00:00.000Z', '2024-11-03', '2024-11-04T01:00:00.000Z'],
      ['2024-11-04T01:00:00.000Z', '2024-11-04', '2024-11-05T01:00:00.000Z'],
    ])('freezes dates and the next reset consistently at %s', async (instant, today, resetAt) => {
      const source = fixture([instant]);
      const activity = await readActivity(source.pool, new Date(instant));
      expect(activity.today).toBe(today);
      expect(activity.resetAt).toBe(resetAt);
      expect(activity.days).toEqual([{ date: today, count: 1 }]);
      expect(activity.serverNow).toBe(instant);
    });

    it('counts repeated accepted submissions but ignores invalid and future archive timestamps', async () => {
      const source = fixture([
        '2024-03-01T16:00:00Z',
        '2024-03-01T17:00:00.000Z',
        '2024-02-30T16:00:00Z',
        '2024-03-01T24:00:00Z',
        'bad',
        null,
        {},
        7,
        '2024-03-01',
        '2024-03-01T16:00:00',
        '2024-03-12T16:00:00.001Z',
      ]);
      expect((await readActivity(source.pool, NOW)).days).toEqual([
        { date: '2024-03-01', count: 2 },
      ]);
    });

    it('does not fabricate empty history for malformed database responses', async () => {
      await expect(
        readActivity({ query: vi.fn().mockResolvedValue({ rows: [] }) }, NOW),
      ).rejects.toThrow('snapshot');
      const source = fixture([], ['2024-02-30']);
      await expect(readActivity(source.pool, NOW)).rejects.toThrow('repair');
    });
  });

  describe('atomic heart spending', () => {
    it('validates completed dates using the clock after waiting for the profile lock', async () => {
      let clock = Date.parse('2024-03-12T23:59:59.999Z');
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const source = fixture(undefined, [], '', (sql) => {
        if (sql.includes('FOR UPDATE')) clock = Date.parse('2024-03-13T00:00:00.001Z');
      });
      const result = await repairActivity(source.pool, { date: '2024-03-12' });
      expect(result.today).toBe('2024-03-13');
      expect(result.repairs).toEqual(['2024-03-12']);
    });

    it('rereads once on its own connection when commit crosses a reset boundary', async () => {
      let clock = Date.parse('2024-03-12T23:59:59.999Z');
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const source = fixture(undefined, [], '', (sql) => {
        if (sql === 'COMMIT') clock = Date.parse('2024-03-13T00:00:00.001Z');
      });
      const result = await repairActivity(source.pool, { date: '2024-03-06' });
      expect(result).toMatchObject({
        today: '2024-03-13',
        resetAt: '2024-03-14T00:00:00.000Z',
        serverNow: '2024-03-13T00:00:00.001Z',
        repairs: ['2024-03-06'],
      });
      expect(source.calls.filter((call) => call.sql.includes('AS timestamps'))).toHaveLength(2);
      expect(source.pool.connect).toHaveBeenCalledOnce();
      expect(source.releases[0]).toHaveBeenCalledOnce();
    });

    it('spends a heart using the same profile lock as submission writes and changes no learner records', async () => {
      const source = fixture();
      const result = await repairActivity(source.pool, { date: '2024-03-06' }, NOW);
      expect(result.repairs).toEqual(['2024-03-06']);
      expect(result.streak).toMatchObject({ hearts: 0, earnedHearts: 1, best: 6 });
      expect(result.days).toEqual(earnedDates.map((date) => ({ date, count: 1 })));
      expect(source.calls.map((call) => call.sql)).toEqual([
        'BEGIN',
        'SELECT profile_id FROM cp_state WHERE profile_id = 1 FOR UPDATE',
        expect.stringContaining('AS timestamps'),
        'INSERT INTO cp_streak_repairs(date) VALUES($1::date)',
        'COMMIT',
      ]);
      expect(source.calls[3].values).toEqual(['2024-03-06']);
      expect(
        source.calls.some((call) =>
          /(?:UPDATE|INSERT INTO|DELETE FROM)\s+cp_(?:state|submissions)/.test(call.sql),
        ),
      ).toBe(false);
      expect(source.releases[0]).toHaveBeenCalledOnce();
    });

    it('makes same-date retries idempotent even after the last heart is spent', async () => {
      const source = fixture();
      const first = await repairActivity(source.pool, { date: '2024-03-06' }, NOW);
      const second = await repairActivity(source.pool, { date: '2024-03-06' }, NOW);
      expect(second).toEqual(first);
      expect(source.calls.filter((call) => call.sql.startsWith('INSERT'))).toHaveLength(1);
    });

    it('allows just one of two concurrent different-date spends with a single heart', async () => {
      const source = fixture();
      const results = await Promise.allSettled([
        repairActivity(source.pool, { date: '2024-03-06' }, NOW),
        repairActivity(source.pool, { date: '2024-03-07' }, NOW),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { status: 409, code: 'insufficient_hearts' },
      });
      expect(source.repairs.size).toBe(1);
    });

    it('returns success to both simultaneous duplicate requests while spending once', async () => {
      const source = fixture();
      const results = await Promise.all([
        repairActivity(source.pool, { date: '2024-03-06' }, NOW),
        repairActivity(source.pool, { date: '2024-03-06' }, NOW),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(source.repairs.size).toBe(1);
    });

    it.each([
      null,
      [],
      {},
      { date: 'bad' },
      { date: '2024-02-30' },
      { date: '2024-3-06' },
      { date: 20240306 },
      { date: '2024-03-06', hearts: 100 },
      { date: '2024-03-06', extra: true },
    ])('validates a strict date-only body before opening a transaction: %#', async (value) => {
      const source = fixture();
      await expect(repairActivity(source.pool, value, NOW)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      expect(source.pool.connect).not.toHaveBeenCalled();
    });

    it.each(['2024-02-29', '2024-03-01', '2024-03-12', '2024-03-13'])(
      'rejects non-missed or incomplete dates without spending: %s',
      async (date) => {
        const source = fixture();
        await expect(repairActivity(source.pool, { date }, NOW)).rejects.toMatchObject({
          code: 'invalid_repair',
        });
        expect(source.repairs.size).toBe(0);
        expect(source.calls.at(-1)?.sql).toBe('ROLLBACK');
      },
    );

    it('rejects a repair before any real accepted activity exists', async () => {
      const source = fixture([]);
      await expect(repairActivity(source.pool, { date: '2024-03-06' }, NOW)).rejects.toMatchObject({
        code: 'invalid_repair',
      });
    });

    it.each(['AS timestamps', 'INSERT INTO cp_streak_repairs', 'COMMIT'])(
      'rolls back and releases on storage failure at %s',
      async (failAt) => {
        const source = fixture(undefined, [], failAt);
        await expect(repairActivity(source.pool, { date: '2024-03-06' }, NOW)).rejects.toThrow(
          'Synthetic storage failure',
        );
        expect(source.repairs.size).toBe(0);
        expect(source.calls.at(-1)?.sql).toBe('ROLLBACK');
        expect(source.releases[0]).toHaveBeenCalledOnce();
      },
    );

    it('installs only an additive append-only repair table and migration receipt', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      await initializeSchema({ query });
      const ddl = query.mock.calls[1][0];
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS cp_streak_repairs');
      expect(ddl).toContain('date date PRIMARY KEY');
      expect(ddl).toContain('BEFORE UPDATE OR DELETE ON cp_streak_repairs');
      expect(ddl).toContain('cp_schema_migrations(version) VALUES(4)');
      expect(ddl).not.toMatch(
        /(?:UPDATE|DELETE FROM|DROP TABLE|TRUNCATE)\s+cp_(?:state|submissions)/i,
      );
    });
  });
});
