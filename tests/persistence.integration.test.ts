import http, { type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyFixtureCatalog, fixtureDecks, fixtureExercises } from './database-fixtures';
import { assertTestConnection, createIsolatedTestDatabase } from './e2e/database-runtime.mjs';
import type { Attempt, ProgressData } from '../src/lib/progress';

type StateSnapshot = {
  revision: number;
  progress: ProgressData;
  stars: string[];
  migrations: string[];
  writes: string[];
  code?: string;
};
type Catalog = {
  version: string;
  decks: typeof fixtureDecks;
  exercises: Array<Record<string, unknown> & { id: string; version: string }>;
};
type Backend = {
  initializeDatabase(connectionString: string): Promise<void>;
  startDataServer(options: { connectionString: string; port: number }): Promise<Server>;
};
type IsolatedDatabase = { connectionString: string; cleanup(): Promise<void> };
const ROOT = new URL('../', import.meta.url);
const DATE = '2026-09-08T12:00:00.000Z';
const ID = 'python-core-normalize-text-01';
const ORIGIN = 'http://127.0.0.1:5173';
const EMPTY: ProgressData = { version: 1, exercises: {} };

function attempt(index: number, problemVersion?: string | null): Attempt {
  return {
    id: `integration-attempt-${index}`,
    at: DATE,
    code: `# attempt ${index}\nreturn value`,
    passed: 8,
    total: 8,
    status: 'accepted',
    durationMs: 1.25,
    ...(problemVersion === undefined ? {} : { problemVersion }),
  };
}

function progress(attempts: Attempt[] = [], id = ID): ProgressData {
  return {
    version: 1,
    exercises: {
      [id]: {
        draft:
          '# Preserved Unicode: café 🐍\ndef normalize_text(text):\n    return text.strip().lower()\n',
        updatedAt: DATE,
        solved: attempts.some((item) => item.status === 'accepted'),
        attempts,
      },
    },
  };
}

// Deliberately opt-in: the ordinary unit suite must not need a running database.
// Even when enabled, this suite can mutate only its generated cp_test_ schema.
describe.skipIf(process.env.CODE_PRACTICE_RUN_DB_TESTS !== '1')(
  'real PostgreSQL persistence API',
  { timeout: 30_000 },
  () => {
    let backend: Backend;
    let isolated: IsolatedDatabase;
    let client: pg.Client;
    let server: Server;
    let baseUrl: string;
    let schema: string;

    async function start() {
      server = await backend.startDataServer({
        connectionString: isolated.connectionString,
        port: 0,
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('The isolated API has no TCP address.');
      baseUrl = `http://127.0.0.1:${address.port}`;
    }

    async function close() {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }

    async function request<T>(
      method: string,
      pathname: string,
      body?: string | Buffer,
      overrides: Record<string, string | undefined> = {},
    ) {
      const headers: Record<string, string> = ['PUT', 'POST'].includes(method)
        ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' }
        : {};
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete headers[key];
        else headers[key] = value;
      }
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
          req.setTimeout(15_000, () => req.destroy(new Error('Isolated API request timed out.')));
          req.on('error', reject);
          req.end(body);
        },
      );
    }

    const readState = () => request<StateSnapshot>('GET', '/api/state');
    const writeState = (value: unknown) =>
      request<StateSnapshot>('PUT', '/api/state', JSON.stringify(value));
    const update = (expectedRevision: number, value = progress(), stars: string[] = [ID]) => ({
      expectedRevision,
      progress: value,
      stars,
    });

    beforeAll(async () => {
      backend = (await import(new URL('server/index.mjs', ROOT).href)) as Backend;
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
      await applyFixtureCatalog(client, isolated.connectionString);
      await start();
    }, 120_000);

    beforeEach(async () => {
      await assertTestConnection(client, isolated.connectionString);
      await client.query(
        `TRUNCATE TABLE ${schema}.cp_submissions, ${schema}.cp_migration_receipts, ${schema}.cp_write_receipts`,
      );
      await client.query(
        `UPDATE ${schema}.cp_state SET revision=0, progress=$1::jsonb, stars='[]'::jsonb WHERE profile_id=1`,
        [JSON.stringify(EMPTY)],
      );
      await backend.initializeDatabase(isolated.connectionString);
      await applyFixtureCatalog(client, isolated.connectionString);
    }, 120_000);

    afterAll(async () => {
      try {
        await close();
      } finally {
        try {
          await client?.end();
        } finally {
          await isolated?.cleanup();
        }
      }
    }, 30_000);

    it('serves the synthetic stored catalog and empty revisioned state from PostgreSQL', async () => {
      const health = await request<{ ok: boolean }>('GET', '/api/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
      const catalog = await request<Catalog>('GET', '/api/catalog');
      expect(catalog.status).toBe(200);
      expect(catalog.body.decks).toEqual(fixtureDecks);
      expect(catalog.body.exercises).toHaveLength(2);
      expect(catalog.body.exercises.map((item) => item.id)).toEqual(
        fixtureExercises.map((item) => item.id),
      );
      expect(
        fixtureDecks.map(
          (deck) => catalog.body.exercises.filter((item) => item.deckId === deck.id).length,
        ),
      ).toEqual([1, 1]);
      for (const item of catalog.body.exercises) {
        expect(['browser-python', 'python', 'sql', 'shell', 'javascript']).toContain(item.runtime);
        expect(
          (item.cases as Record<string, unknown>[]).every((test) =>
            Object.keys(test).every((key) => ['name', 'args', 'expected', 'check'].includes(key)),
          ),
          item.id,
        ).toBe(true);
      }
      expect(catalog.body.version).toMatch(/^[a-f0-9]{64}$/);
      expect(catalog.body.exercises.every((item) => /^[a-f0-9]{64}$/.test(item.version))).toBe(
        true,
      );
      expect(catalog.headers['cache-control']).toBe('no-store');
      expect((await readState()).body).toEqual({
        revision: 0,
        progress: EMPTY,
        stars: [],
        migrations: [],
        writes: [],
      });
      expect(
        Number(
          (await client.query(`SELECT count(*) FROM ${schema}.cp_problem_versions`)).rows[0].count,
        ),
      ).toBe(2);
    });

    it('persists drafts/stars through a closed API pool and a completely new listener/connection', async () => {
      const written = await writeState(update(0));
      expect(written.status).toBe(200);
      expect(written.body).toMatchObject({ revision: 1, progress: progress(), stars: [ID] });
      await close();
      await start();
      expect((await readState()).body).toEqual(written.body);
      const fresh = new pg.Client({
        connectionString: isolated.connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
        lock_timeout: 5_000,
      });
      try {
        await fresh.connect();
        await assertTestConnection(fresh, isolated.connectionString);
        const row = (
          await fresh.query(`SELECT progress, stars FROM ${schema}.cp_state WHERE profile_id=1`)
        ).rows[0];
        expect(row).toEqual({ progress: progress(), stars: [ID] });
      } finally {
        await fresh.end();
      }
    });

    it('rejects stale revisions without overwriting the accepted state', async () => {
      const saved = await writeState(update(0));
      const stale = await writeState(update(0, EMPTY, []));
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ ...saved.body, code: 'revision_conflict' });
      expect((await readState()).body).toEqual(saved.body);
    });

    it('serializes simultaneous writers so exactly one revision wins', async () => {
      const results = await Promise.all([
        writeState(update(0, progress(), [ID])),
        writeState(update(0, progress([], 'legacy-other'), [])),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const winner = results.find((result) => result.status === 200)!;
      expect((await readState()).body).toEqual(winner.body);
      expect(winner.body.revision).toBe(1);
    });

    it('archives every supplied submission while the UI keeps only the latest twenty', async () => {
      const version = (await request<Catalog>('GET', '/api/catalog')).body.exercises.find(
        (item) => item.id === ID,
      )!.version;
      const attempts = Array.from({ length: 25 }, (_, index) => attempt(index, version));
      const saved = await writeState(update(0, progress(attempts)));
      expect(saved.status).toBe(200);
      expect(saved.body.progress.exercises[ID].attempts).toEqual(attempts.slice(-20));
      const archived = (
        await client.query(
          `SELECT id, exercise_id, problem_version, grading_source FROM ${schema}.cp_submissions`,
        )
      ).rows;
      expect(archived).toHaveLength(25);
      expect(
        archived.every(
          (row) =>
            row.exercise_id === ID &&
            row.problem_version === version &&
            row.grading_source === 'browser',
        ),
      ).toBe(true);
      expect((await writeState(update(1, EMPTY, []))).status).toBe(200);
      expect(
        Number((await client.query(`SELECT count(*) FROM ${schema}.cp_submissions`)).rows[0].count),
      ).toBe(25);
      await expect(
        client.query(
          `UPDATE ${schema}.cp_submissions SET exercise_id='changed' WHERE id='integration-attempt-0'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects reused submission IDs atomically, including other fresh inserts in that request', async () => {
      const first = attempt(0);
      const saved = await writeState(update(0, progress([first])));
      const conflict = await writeState(
        update(1, progress([attempt(1), { ...first, code: '# different historical payload' }])),
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('submission_conflict');
      expect((await readState()).body).toEqual(saved.body);
      expect((await client.query(`SELECT id FROM ${schema}.cp_submissions`)).rows).toEqual([
        { id: first.id },
      ]);
    });

    it('preserves unknown legacy IDs and applies a migration receipt only once', async () => {
      const legacy = progress([attempt(0, null)], 'legacy-removed-exercise');
      const payload = {
        ...update(0, legacy, ['legacy-star', ID]),
        migrationId: 'legacy-migration-1',
      };
      const migrated = await writeState(payload);
      expect(migrated.status).toBe(200);
      expect(migrated.body).toMatchObject({
        progress: legacy,
        stars: ['legacy-star', ID],
        migrations: ['legacy-migration-1'],
      });
      const unstarred = await writeState(update(1, legacy, []));
      const repeated = await writeState(payload);
      expect(repeated.status).toBe(200);
      expect(repeated.body).toEqual(unstarred.body);
      expect(
        Number(
          (await client.query(`SELECT count(*) FROM ${schema}.cp_migration_receipts`)).rows[0]
            .count,
        ),
      ).toBe(1);
    });

    it('rejects already acknowledged star writes without losing newer accompanying drafts', async () => {
      const starred = await writeState({ ...update(0), writeIds: ['star-write-1'] });
      expect(starred.status).toBe(200);
      expect(starred.body.writes).toEqual(['star-write-1']);
      const unstarred = await writeState({
        ...update(1, progress(), []),
        writeIds: ['unstar-write-2'],
      });
      const newer = progress();
      newer.exercises[ID].draft = '# a newer draft accompanying an obsolete star write';
      const replay = await writeState({
        ...update(2, newer),
        writeIds: ['star-write-1', 'fresh-write-3'],
      });
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({ ...unstarred.body, code: 'revision_conflict' });
      expect((await readState()).body).toEqual(unstarred.body);
      expect(
        (await client.query(`SELECT id FROM ${schema}.cp_write_receipts ORDER BY id`)).rows,
      ).toEqual([{ id: 'star-write-1' }, { id: 'unstar-write-2' }]);
      const rebased = await writeState({ ...update(2, newer, []), writeIds: ['fresh-write-3'] });
      expect(rebased.status).toBe(200);
      expect(rebased.body.progress).toEqual(newer);
      expect(rebased.body.stars).toEqual([]);
      expect(rebased.body.writes).toContain('fresh-write-3');
    });

    it('deliberate fixture edits change active versions without deleting old content or learner state', async () => {
      const before = (await request<Catalog>('GET', '/api/catalog')).body;
      const saved = (await writeState(update(0))).body;
      const updated = fixtureExercises.map((item) =>
        item.id === ID ? { ...item, title: `${item.title} (revision)` } : item,
      );
      await applyFixtureCatalog(client, isolated.connectionString, {
        decks: fixtureDecks,
        exercises: updated,
      });
      const after = (await request<Catalog>('GET', '/api/catalog')).body;
      expect(after.exercises.find((item) => item.id === ID)!.version).not.toBe(
        before.exercises.find((item) => item.id === ID)!.version,
      );
      expect(
        Number(
          (
            await client.query(
              `SELECT count(*) FROM ${schema}.cp_problem_versions WHERE exercise_id=$1`,
              [ID],
            )
          ).rows[0].count,
        ),
      ).toBe(2);
      expect((await readState()).body).toEqual(saved);
      await expect(
        client.query(`DELETE FROM ${schema}.cp_problem_versions WHERE exercise_id=$1`, [ID]),
      ).rejects.toThrow(/append-only/);
    }, 120_000);

    it('reactivates a fixture problem without resetting existing progress, stars, or history', async () => {
      const firstVersion = fixtureExercises.filter((item) => item.runtime === 'browser-python');
      expect(firstVersion).toHaveLength(1);
      await applyFixtureCatalog(client, isolated.connectionString, {
        decks: fixtureDecks,
        exercises: firstVersion,
      });
      const before = (await request<Catalog>('GET', '/api/catalog')).body;
      expect(before.exercises).toHaveLength(1);
      const version = before.exercises.find((item) => item.id === ID)!.version;
      const saved = (await writeState(update(0, progress([attempt(0, version)])))).body;
      await backend.initializeDatabase(isolated.connectionString);
      expect((await request<Catalog>('GET', '/api/catalog')).body).toEqual(before);
      await applyFixtureCatalog(client, isolated.connectionString);
      const after = (await request<Catalog>('GET', '/api/catalog')).body;
      expect(after.exercises).toHaveLength(2);
      expect(after.exercises.find((item) => item.id === ID)!.version).toBe(version);
      expect((await readState()).body).toEqual(saved);
      expect(
        (await client.query(`SELECT id, problem_version FROM ${schema}.cp_submissions`)).rows,
      ).toEqual([{ id: 'integration-attempt-0', problem_version: version }]);
    }, 120_000);

    it('rejects unknown, stale, and oversized execution requests before any container can start', async () => {
      const exercise = (await request<Catalog>('GET', '/api/catalog')).body.exercises.find(
        (item) => item.id === 'algo-search-001-binary-search',
      )!;
      expect(exercise).toBeDefined();
      const body = {
        problemId: exercise.id,
        problemVersion: exercise.version,
        code: '# never executed',
        mode: 'submit',
      };
      const run = (value: unknown) =>
        request<{ code: string }>('POST', '/api/run', JSON.stringify(value));
      expect((await run({ ...body, problemId: 'unknown-problem' })).status).toBe(404);
      expect((await run({ ...body, problemId: 'constructor' })).status).toBe(400);
      const stale = await run({ ...body, problemVersion: '0'.repeat(64) });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('problem_changed');
      expect((await run({ ...body, code: 'a'.repeat(32_769) })).status).toBe(400);
      expect((await run({ ...body, code: '界'.repeat(17_067) })).status).toBe(400);
      expect((await run({ ...body, mode: 'arbitrary-command' })).status).toBe(400);
      expect((await run({ ...body, mode: 'custom', customArgs: 'x'.repeat(8_193) })).status).toBe(
        400,
      );
      expect((await readState()).body).toEqual({
        revision: 0,
        progress: EMPTY,
        stars: [],
        migrations: [],
        writes: [],
      });
      expect(
        Number((await client.query(`SELECT count(*) FROM ${schema}.cp_submissions`)).rows[0].count),
      ).toBe(0);
    });

    it('leaves stored progress and immutable history untouched when writes are rejected', async () => {
      // Exhaustive HTTP guard cases live in http-server.test.ts; this checks the real storage boundary.
      const saved = (await writeState(update(0, progress([attempt(0)])))).body;
      const archived = (
        await client.query(`SELECT id, attempt FROM ${schema}.cp_submissions ORDER BY id`)
      ).rows;
      expect(
        (
          await request('PUT', '/api/state', JSON.stringify(update(saved.revision)), {
            'X-Code-Practice-Client': undefined,
          })
        ).status,
      ).toBe(403);
      expect((await writeState(update(-1))).status).toBe(400);
      expect((await readState()).body).toEqual(saved);
      expect(
        (await client.query(`SELECT id, attempt FROM ${schema}.cp_submissions ORDER BY id`)).rows,
      ).toEqual(archived);
    });

    it('returns an explicit storage-unavailable response instead of inventing successful state', async () => {
      await client.query(
        `ALTER TABLE ${schema}.cp_state RENAME TO cp_state_temporarily_unavailable`,
      );
      try {
        const response = await readState();
        expect(response.status).toBe(503);
        expect(response.body.code).toBe('storage_unavailable');
        expect(response.body).not.toHaveProperty('progress');
      } finally {
        await client.query(
          `ALTER TABLE ${schema}.cp_state_temporarily_unavailable RENAME TO cp_state`,
        );
      }
    });
  },
);
