import { test as base, expect } from '@playwright/test';
import pg from 'pg';
import { assertTestConnection, readRuntime } from './database-runtime.mjs';
import { loadCatalog, type Catalog } from '../../src/lib/database-client';
import type { Exercise } from '../../src/lib/exercises';

export type TestDatabase = { client: pg.Client; schema: string };
export type TestCatalog = Omit<Catalog, 'exercises'> & {
  exercises: (Exercise & { version: string; cases: NonNullable<Exercise['cases']> })[];
};

export const test = base.extend<{ database: TestDatabase; catalog: TestCatalog }>({
  database: [
    async ({}, use) => {
      const runtime = await readRuntime();
      const client = new pg.Client({
        connectionString: runtime.connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
        lock_timeout: 5_000,
      });
      try {
        await client.connect();
        const schema = await assertTestConnection(client, runtime.connectionString);
        // Only the unique schema created by this test run can reach these exact
        // reset statements. Catalog data stays intact; user/public tables cannot.
        await client.query('BEGIN');
        try {
          await client.query(
            `TRUNCATE TABLE ${schema}.cp_submissions, ${schema}.cp_streak_repairs, ${schema}.cp_migration_receipts, ${schema}.cp_write_receipts`,
          );
          await client.query(
            `UPDATE ${schema}.cp_state SET revision = 0, progress = $1::jsonb, stars = $2::jsonb WHERE profile_id = 1`,
            [JSON.stringify({ version: 1, exercises: {} }), '[]'],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        await use({ client, schema });
      } finally {
        await client.end();
      }
    },
    { auto: true },
  ],
  catalog: async ({ database, request, baseURL }, use) => {
    // This dependency must finish the existing isolated-schema guard before any
    // catalog request. Fixture setup never runs during offline test discovery.
    expect(database.schema).toMatch(/^cp_test_[a-f0-9]{24}$/);
    expect(baseURL).toBe('http://127.0.0.1:5173');
    const catalog = await loadCatalog(async () => {
      const response = await request.get('/api/catalog', { maxRedirects: 0, timeout: 8_000 });
      return new Response(await response.text(), { status: response.status() });
    });
    // loadCatalog verifies versions and nonempty cases for every exercise.
    await use(catalog as TestCatalog);
  },
});

export { expect };
