import type { Client } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFixtureCatalog, fixtureDecks, fixtureExercises } from './database-fixtures';

const mocks = vi.hoisted(() => ({ assertTestConnection: vi.fn() }));
vi.mock('./e2e/database-runtime.mjs', () => ({ assertTestConnection: mocks.assertTestConnection }));

const schema = 'cp_test_0123456789abcdef01234567';
const connection = 'mock-isolated-connection';
const query = vi.fn();
const client = { query } as unknown as Client;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertTestConnection.mockResolvedValue(schema);
  query.mockResolvedValue({ rows: [] });
});

describe('synthetic database fixture authoring', () => {
  it('checks the isolated connection before starting and again before any catalog writes', async () => {
    await applyFixtureCatalog(client, connection);
    expect(mocks.assertTestConnection).toHaveBeenNthCalledWith(1, client, connection);
    expect(mocks.assertTestConnection).toHaveBeenNthCalledWith(2, client, connection);
    expect(mocks.assertTestConnection.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[0],
    );
    expect(query.mock.calls[0][0]).toBe('BEGIN');
    expect(mocks.assertTestConnection.mock.invocationCallOrder[1]).toBeLessThan(
      query.mock.invocationCallOrder[1],
    );
    const writes = query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/.test(sql));
    expect(writes.every(([sql]) => sql.includes(`${schema}.cp_`))).toBe(true);
    expect(writes.map(([sql]) => sql).join('\n')).not.toMatch(
      /cp_state|cp_submissions|cp_write_receipts|cp_migration_receipts/,
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('never starts a write transaction if the first safety guard rejects', async () => {
    mocks.assertTestConnection.mockRejectedValueOnce(new Error('Unsafe destination'));
    await expect(applyFixtureCatalog(client, connection)).rejects.toThrow('Unsafe destination');
    expect(query).not.toHaveBeenCalled();
  });

  it('rolls back without catalog writes when the in-transaction safety check rejects', async () => {
    mocks.assertTestConnection
      .mockResolvedValueOnce(schema)
      .mockRejectedValueOnce(new Error('Identity changed'));
    await expect(applyFixtureCatalog(client, connection)).rejects.toThrow('Identity changed');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('creates new content versions deliberately without updating historical records', async () => {
    await applyFixtureCatalog(client, connection);
    const firstVersion = query.mock.calls.find(([sql]) =>
      sql.includes('.cp_problem_versions('),
    )?.[1][1];
    query.mockClear();
    await applyFixtureCatalog(client, connection, {
      decks: fixtureDecks,
      exercises: fixtureExercises.map((item, index) =>
        index === 0 ? { ...item, title: 'Revised fixture' } : item,
      ),
    });
    const secondVersion = query.mock.calls.find(([sql]) =>
      sql.includes('.cp_problem_versions('),
    )?.[1][1];
    expect(firstVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(secondVersion).not.toBe(firstVersion);
    for (const [sql] of query.mock.calls.filter(
      ([sql]) => sql.includes('.cp_problem_versions(') || sql.includes('.cp_grading_specs('),
    )) {
      expect(sql).toContain('DO NOTHING');
      expect(sql).not.toContain('DO UPDATE');
    }
  });

  it('rolls back a failed catalog insertion', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('.cp_problem_versions(')) throw new Error('Insert failed');
      return { rows: [] };
    });
    await expect(applyFixtureCatalog(client, connection)).rejects.toThrow('Insert failed');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });
});
