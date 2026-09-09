import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node repository modules are tested through their runtime interface.
import * as repository from '../server/repository.mjs';
// @ts-expect-error Shared runtime validation has no generated declarations.
import { stableJson } from '../server/validation.mjs';

const { readExecutionProblem, readCatalog, initializeSchema, initializeDatabase } = repository;

const startup = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: class {
    on() {}
    connect = startup.connect;
    end = startup.end;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  startup.query.mockResolvedValue({ rows: [] });
  startup.connect.mockResolvedValue({ query: startup.query, release: startup.release });
});

describe('Neon-only schema startup', () => {
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
