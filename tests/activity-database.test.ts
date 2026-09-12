import http, { type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertTestConnection, createIsolatedTestDatabase } from './e2e/database-runtime.mjs';
import type { Attempt, ProgressData } from '../src/lib/progress';
import { practiceClock } from '../shared/practice-activity.mjs';

type Activity = {
  timeZone: string;
  resetHour: number;
  today: string;
  resetAt: string;
  serverNow: string;
  days: Array<{ date: string; count: number }>;
  repairs: string[];
  streak: {
    current: number;
    best: number;
    hearts: number;
    earnedHearts: number;
    heartProgress: number;
    startedOn: string | null;
  };
};
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

    async function request<T>(method: string, pathname: string, value?: unknown) {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const headers: Record<string, string> = ['PUT', 'POST'].includes(method)
        ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' }
        : {};
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

    const readActivity = () => request<Activity>('GET', '/api/activity');
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
      await client.query(`TRUNCATE TABLE ${schema}.cp_submissions, ${schema}.cp_streak_repairs`);
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

    it('returns an empty fixed-Eastern history with a consistent clock and private response headers', async () => {
      const response = await readActivity();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        timeZone: 'America/New_York',
        resetHour: 20,
        days: [],
        repairs: [],
        streak: {
          current: 0,
          best: 0,
          hearts: 0,
          earnedHearts: 0,
          heartProgress: 0,
          startedOn: null,
        },
      });
      expect(response.body).toMatchObject(practiceClock(new Date(response.body.serverNow)));
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
      const expected = {
        timeZone: 'America/New_York',
        days: [
          { date: '2023-12-31', count: 7 },
          { date: '2024-02-29', count: 20 },
        ],
      };
      expect((await readActivity()).body).toMatchObject(expected);
      expect((await save(1, attempts)).status).toBe(200);
      expect((await save(2)).status).toBe(200);
      expect((await readActivity()).body).toMatchObject(expected);
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
      expect((await readActivity()).body).toMatchObject({
        timeZone: 'America/New_York',
        days: [{ date: '2024-02-29', count: 1 }],
      });
    });

    it('groups 8 PM practice days correctly across both daylight-saving transitions', async () => {
      const times = [
        '2024-03-10T00:59:59.999Z',
        '2024-03-10T01:00:00.000Z',
        '2024-03-10T06:59:59.999Z',
        '2024-03-10T07:00:00.000Z',
        '2024-03-10T23:59:59.999Z',
        '2024-03-11T00:00:00.000Z',
        '2024-11-02T23:59:59.999Z',
        '2024-11-03T00:00:00.000Z',
        '2024-11-03T05:30:00.000Z',
        '2024-11-03T06:30:00.000Z',
        '2024-11-04T00:59:59.999Z',
        '2024-11-04T01:00:00.000Z',
      ];
      await insert(times.map((at, index) => attempt(`dst-${index}`, at)));
      expect((await readActivity()).body).toMatchObject({
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

    it('handles 8 PM reset boundaries at leap days and year rollover in sorted order', async () => {
      await insert([
        attempt('leap-before', '2024-03-01T00:59:59.999Z'),
        attempt('leap-after', '2024-03-01T01:00:00.000Z'),
        attempt('year-after', '2024-01-01T01:00:00.000Z'),
        attempt('year-before', '2024-01-01T00:59:59.999Z'),
      ]);
      expect((await readActivity()).body).toMatchObject({
        timeZone: 'America/New_York',
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
      expect(response.body).toMatchObject({
        timeZone: 'America/New_York',
        days: [{ date: '2024-02-29', count: 1 }],
      });
      expect(
        (await client.query(`SELECT id, attempt FROM ${schema}.cp_submissions ORDER BY id`)).rows,
      ).toEqual(before);
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

    const earnedAttempts = () =>
      Array.from({ length: 5 }, (_, index) =>
        attempt(`earned-${index}`, `2024-03-0${index + 1}T16:00:00.000Z`),
      );
    const repair = (date: string) => request<Activity>('POST', '/api/activity/repairs', { date });

    it('spends a heart without creating submissions or changing progress, stars, or revision', async () => {
      await save(0, earnedAttempts());
      const state = (await request('GET', '/api/state')).body;
      const archived = (await client.query(`SELECT * FROM ${schema}.cp_submissions ORDER BY id`))
        .rows;
      const result = await repair('2024-03-06');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        repairs: ['2024-03-06'],
        streak: { hearts: 0, earnedHearts: 1, best: 6 },
      });
      expect(result.body.days).toEqual(
        earnedAttempts().map((item) => ({ date: item.at.slice(0, 10), count: 1 })),
      );
      expect((await request('GET', '/api/state')).body).toEqual(state);
      expect(
        (await client.query(`SELECT * FROM ${schema}.cp_submissions ORDER BY id`)).rows,
      ).toEqual(archived);
      expect(JSON.stringify(result.body)).not.toMatch(/Private learner|draft|revision|code/);
      expect(
        (await client.query(`SELECT version FROM ${schema}.cp_schema_migrations WHERE version=4`))
          .rows,
      ).toEqual([{ version: 4 }]);
      await expect(
        client.query(`UPDATE ${schema}.cp_streak_repairs SET date='2024-03-07'`),
      ).rejects.toThrow(/append-only/);
      await expect(client.query(`DELETE FROM ${schema}.cp_streak_repairs`)).rejects.toThrow(
        /append-only/,
      );
    });

    it('serializes different-date concurrent spends against the same single heart', async () => {
      await insert(earnedAttempts());
      const results = await Promise.all([repair('2024-03-06'), repair('2024-03-07')]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)?.body).toMatchObject({
        code: 'insufficient_hearts',
      });
      expect((await readActivity()).body.repairs).toHaveLength(1);
      expect((await readActivity()).body.streak.hearts).toBe(0);
    });

    it('makes simultaneous duplicate-date retries successful while spending just once', async () => {
      await insert(earnedAttempts());
      const results = await Promise.all([repair('2024-03-06'), repair('2024-03-06')]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      for (const result of results)
        expect(result.body).toMatchObject({ repairs: ['2024-03-06'], streak: { hearts: 0 } });
      expect(
        Number(
          (await client.query(`SELECT count(*) FROM ${schema}.cp_streak_repairs`)).rows[0].count,
        ),
      ).toBe(1);
    });

    it('waits for an in-flight submission transaction before deriving the spendable balance', async () => {
      await insert(earnedAttempts().slice(0, 4));
      await assertTestConnection(client, isolated.connectionString);
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT profile_id FROM ${schema}.cp_state WHERE profile_id=1 FOR UPDATE`,
        );
        const result = repair('2024-03-06');
        await client.query(
          `INSERT INTO ${schema}.cp_submissions(id, exercise_id, attempt) VALUES($1, 'retired-problem', $2::jsonb)`,
          ['earned-4', JSON.stringify(earnedAttempts()[4])],
        );
        await client.query('COMMIT');
        const response = await result;
        expect(response.status).toBe(200);
        expect(response.body.streak).toMatchObject({ hearts: 0, earnedHearts: 1 });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });

    it('rejects invalid dates, completed days, and empty balances without a repair row', async () => {
      await insert(earnedAttempts().slice(0, 4));
      const today = (await readActivity()).body.today;
      for (const value of [
        { date: '2024-02-30' },
        { date: '2024-03-06', hearts: 9 },
        { date: today },
        { date: '2024-03-01' },
        { date: '2024-02-29' },
      ]) {
        expect((await request('POST', '/api/activity/repairs', value)).status).toBe(400);
      }
      expect((await repair('2024-03-06')).status).toBe(409);
      expect(
        Number(
          (await client.query(`SELECT count(*) FROM ${schema}.cp_streak_repairs`)).rows[0].count,
        ),
      ).toBe(0);
    });
  },
);
