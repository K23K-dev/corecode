import http, { type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertTestConnection, createIsolatedTestDatabase } from './e2e/database-runtime.mjs';
import type { Attempt, ProgressData } from '../src/lib/progress';

type Activity = { timeZone: string; days: Array<{ date: string; count: number }> };
type Backend = {
  initializeDatabase(connectionString: string): Promise<void>;
  startDataServer(options: { connectionString: string; port: number }): Promise<Server>;
};
type IsolatedDatabase = { connectionString: string; cleanup(): Promise<void> };
const ROOT = new URL('../', import.meta.url);
const ORIGIN = 'http://127.0.0.1:5173';
const EMPTY: ProgressData = { version: 1, exercises: {} };

function attempt(id: string, at = '2024-02-29T12:00:00.000Z'): Attempt {
  return {
    id,
    at,
    code: '# Private learner code must never appear in activity responses.',
    passed: 8,
    total: 8,
    status: 'accepted',
    durationMs: 1,
  };
}

// The ordinary suite skips this file. Every mutation below is guarded by a generated cp_test_ schema.
describe.skipIf(process.env.CODE_PRACTICE_RUN_DB_TESTS !== '1')(
  'archived submission activity API',
  { timeout: 30_000 },
  () => {
    let isolated: IsolatedDatabase;
    let client: pg.Client;
    let server: Server;
    let baseUrl: string;
    let schema: string;

    async function request<T>(
      method: string,
      pathname: string,
      value?: unknown,
      overrides: Record<string, string> = {},
    ) {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const headers: Record<string, string> = ['PUT', 'POST'].includes(method)
        ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' }
        : {};
      Object.assign(headers, overrides);
      if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
      return new Promise<{ status: number; body: T; headers: http.IncomingHttpHeaders }>(
        (resolve, reject) => {
          const req = http.request(baseUrl + pathname, { method, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode!,
                  body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                  headers: response.headers,
                });
              } catch (error) {
                reject(error);
              }
            });
          });
          req.setTimeout(15_000, () =>
            req.destroy(new Error('Isolated activity request timed out.')),
          );
          req.on('error', reject);
          req.end(body);
        },
      );
    }

    const readActivity = (timeZone?: string) =>
      request<Activity>(
        'GET',
        '/api/activity' +
          (timeZone === undefined ? '' : `?timeZone=${encodeURIComponent(timeZone)}`),
      );
    const save = (expectedRevision: number, attempts?: Attempt[]) =>
      request<{ revision: number; progress: ProgressData }>('PUT', '/api/state', {
        expectedRevision,
        stars: [],
        progress:
          attempts === undefined
            ? EMPTY
            : {
                version: 1,
                exercises: {
                  'retired-problem': {
                    draft: '# still private',
                    updatedAt: '2024-02-29T12:00:00.000Z',
                    solved: true,
                    attempts,
                  },
                },
              },
      });

    async function insert(items: Array<Record<string, unknown>>) {
      await assertTestConnection(client, isolated.connectionString);
      await client.query(
        `INSERT INTO ${schema}.cp_submissions(id, exercise_id, attempt)
      SELECT item->>'id', 'retired-problem', item FROM jsonb_array_elements($1::jsonb) item`,
        [JSON.stringify(items)],
      );
    }

    beforeAll(async () => {
      const backend = (await import(new URL('server/index.mjs', ROOT).href)) as Backend;
      isolated = await createIsolatedTestDatabase();
      client = new pg.Client({
        connectionString: isolated.connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
        lock_timeout: 5_000,
      });
      await client.connect();
      schema = await assertTestConnection(client, isolated.connectionString);
      await backend.initializeDatabase(isolated.connectionString);
      server = await backend.startDataServer({
        connectionString: isolated.connectionString,
        port: 0,
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('The isolated activity API has no TCP address.');
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    beforeEach(async () => {
      await assertTestConnection(client, isolated.connectionString);
      await client.query(`TRUNCATE TABLE ${schema}.cp_submissions`);
      await client.query(
        `UPDATE ${schema}.cp_state SET revision=0, progress=$1::jsonb, stars='[]'::jsonb WHERE profile_id=1`,
        [JSON.stringify(EMPTY)],
      );
    }, 30_000);

    afterAll(async () => {
      try {
        if (server?.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        try {
          await client?.end();
        } finally {
          await isolated?.cleanup();
        }
      }
    }, 30_000);

    it('returns an empty UTC history with private, non-cacheable response headers', async () => {
      const response = await readActivity();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ timeZone: 'UTC', days: [] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('uses all immutable history beyond twenty attempts and never double-counts replayed IDs', async () => {
      const attempts = Array.from({ length: 27 }, (_, index) =>
        attempt(
          `activity-${index}`,
          index < 7 ? '2023-12-31T23:00:00.000Z' : '2024-02-29T12:00:00.000Z',
        ),
      );
      const saved = await save(0, attempts);
      expect(saved.status).toBe(200);
      expect(saved.body.progress.exercises['retired-problem'].attempts).toHaveLength(20);
      const expected: Activity = {
        timeZone: 'UTC',
        days: [
          { date: '2023-12-31', count: 7 },
          { date: '2024-02-29', count: 20 },
        ],
      };
      expect((await readActivity()).body).toEqual(expected);
      expect((await save(1, attempts)).status).toBe(200);
      expect((await save(2)).status).toBe(200);
      expect((await readActivity()).body).toEqual(expected);
      expect(
        Number((await client.query(`SELECT count(*) FROM ${schema}.cp_submissions`)).rows[0].count),
      ).toBe(27);
      expect(
        (await request<{ progress: ProgressData }>('GET', '/api/state')).body.progress,
      ).toEqual(EMPTY);
      expect(JSON.stringify((await readActivity()).body)).not.toContain('Private learner');
    });

    it('counts only accepted submissions that passed all of a positive number of tests', async () => {
      await insert([
        attempt('accepted'),
        { ...attempt('failed'), status: 'failed' },
        { ...attempt('error'), status: 'error' },
        { ...attempt('partial'), passed: 7 },
        { ...attempt('empty'), passed: 0, total: 0 },
        { ...attempt('negative'), passed: -1, total: -1 },
        { ...attempt('text-counts'), passed: '8', total: '8' },
        { ...attempt('null-counts'), passed: null, total: null },
        { ...attempt('missing-count'), passed: undefined },
      ]);
      expect((await readActivity()).body).toEqual({
        timeZone: 'UTC',
        days: [{ date: '2024-02-29', count: 1 }],
      });
    });

    it('groups local dates correctly across both daylight-saving transitions', async () => {
      const times = [
        '2024-03-10T04:59:59.999Z',
        '2024-03-10T05:00:00.000Z',
        '2024-03-10T06:59:59.999Z',
        '2024-03-10T07:00:00.000Z',
        '2024-03-11T03:59:59.999Z',
        '2024-03-11T04:00:00.000Z',
        '2024-11-03T03:59:59.999Z',
        '2024-11-03T04:00:00.000Z',
        '2024-11-03T05:30:00.000Z',
        '2024-11-03T06:30:00.000Z',
        '2024-11-04T04:59:59.999Z',
        '2024-11-04T05:00:00.000Z',
      ];
      await insert(times.map((at, index) => attempt(`dst-${index}`, at)));
      expect((await readActivity('America/New_York')).body).toEqual({
        timeZone: 'America/New_York',
        days: [
          { date: '2024-03-09', count: 1 },
          { date: '2024-03-10', count: 4 },
          { date: '2024-03-11', count: 1 },
          { date: '2024-11-02', count: 1 },
          { date: '2024-11-03', count: 4 },
          { date: '2024-11-04', count: 1 },
        ],
      });
    });

    it('handles fractional offsets, leap days, year rollover, and sorted calendar dates', async () => {
      await insert([
        attempt('leap-before', '2024-02-29T18:14:59.999Z'),
        attempt('leap-after', '2024-02-29T18:15:00.000Z'),
        attempt('year-after', '2023-12-31T18:15:00.000Z'),
        attempt('year-before', '2023-12-31T18:14:59.999Z'),
      ]);
      expect((await readActivity('Asia/Kathmandu')).body).toEqual({
        timeZone: 'Asia/Kathmandu',
        days: [
          { date: '2023-12-31', count: 1 },
          { date: '2024-01-01', count: 1 },
          { date: '2024-02-29', count: 1 },
          { date: '2024-03-01', count: 1 },
        ],
      });
    });

    it('skips malformed, normalized-invalid, and future archived timestamps without failing the response', async () => {
      const invalid: unknown[] = [
        'not-a-date',
        '2024-02-30T12:00:00Z',
        '2024-13-01T12:00:00Z',
        '2024-02-29T24:00:00Z',
        '2024-02-29',
        '2024-02-29T12:00:00',
        '9999-12-31T23:59:59.999Z',
        new Date(Date.now() + 86_400_000).toISOString(),
        null,
        0,
        {},
        undefined,
        'x'.repeat(200),
      ];
      await insert([
        attempt('valid'),
        ...invalid.map((at, index) => ({ ...attempt(`bad-date-${index}`), at })),
      ]);
      const before = (
        await client.query(`SELECT id, attempt FROM ${schema}.cp_submissions ORDER BY id`)
      ).rows;
      const response = await readActivity();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ timeZone: 'UTC', days: [{ date: '2024-02-29', count: 1 }] });
      expect(
        (await client.query(`SELECT id, attempt FROM ${schema}.cp_submissions ORDER BY id`)).rows,
      ).toEqual(before);
      expect((await request<{ revision: number }>('GET', '/api/state')).body.revision).toBe(0);
    });

    it('rejects invalid or unbounded time zones with a clear client error', async () => {
      for (const timeZone of [
        '',
        'Not/A_TimeZone',
        'a'.repeat(101),
        '+03:00',
        'UTC\0',
        ' America/New_York',
      ]) {
        const response = await readActivity(timeZone);
        expect(response.status, timeZone).toBe(400);
        expect(response.body).toMatchObject({ code: 'invalid_request' });
      }
      expect((await readActivity('Pacific/Kiritimati')).status).toBe(200);
    });

    it('preserves local-origin protection and exposes no write methods', async () => {
      const disallowedHeaders: Array<Record<string, string>> = [
        { Host: 'evil.example' },
        { Origin: 'https://evil.example' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ];
      for (const headers of disallowedHeaders) {
        expect((await request('GET', '/api/activity', undefined, headers)).status).toBe(403);
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await request(
          method,
          '/api/activity',
          ['POST', 'PUT'].includes(method) ? {} : undefined,
        );
        expect(response.status, method).toBe(405);
        expect(response.body).toMatchObject({ code: 'method_not_allowed' });
      }
      expect((await request<{ revision: number }>('GET', '/api/state')).body.revision).toBe(0);
    });

    it('reports storage failures instead of fabricating an empty history', async () => {
      await assertTestConnection(client, isolated.connectionString);
      await client.query(
        `ALTER TABLE ${schema}.cp_submissions RENAME TO cp_submissions_unavailable`,
      );
      try {
        const response = await readActivity();
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'storage_unavailable' });
        expect(response.body).not.toHaveProperty('days');
      } finally {
        await client.query(
          `ALTER TABLE ${schema}.cp_submissions_unavailable RENAME TO cp_submissions`,
        );
      }
    });
  },
);
