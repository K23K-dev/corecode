import { createHash } from 'node:crypto';
import { makePool, readCatalog } from '../server/repository.mjs';
import { stableJson } from '../server/validation.mjs';
import {
  assertTestConnection,
  testSchema,
  TestDatabaseSafetyError,
} from './e2e/database-runtime.mjs';

class GradingDataError extends Error {}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkedSnapshot(rows) {
  if (!rows.length) throw new GradingDataError('The Neon grading catalog is empty.');
  const seen = new Set();
  return rows.map(({ id, problem_version, problem, spec_version, spec }) => {
    if (
      typeof id !== 'string' ||
      seen.has(id) ||
      !validObject(problem) ||
      problem.id !== id ||
      problem.version !== problem_version ||
      !/^[a-f0-9]{64}$/.test(problem_version ?? '')
    ) {
      throw new GradingDataError('The Neon grading catalog has inconsistent problem versions.');
    }
    seen.add(id);
    const { version: _version, ...content } = problem;
    if (digest(content) !== problem_version) {
      throw new GradingDataError('The Neon problem content does not match its stored version.');
    }
    if (
      !validObject(spec) ||
      !['python', 'javascript', 'sql', 'shell'].includes(spec.runtime) ||
      spec.runtime !== (problem.runtime === 'browser-python' ? 'python' : problem.runtime) ||
      !Array.isArray(spec.cases) ||
      spec.cases.length < 1 ||
      spec.cases.length > 32 ||
      !/^[a-f0-9]{64}$/.test(spec_version ?? '') ||
      digest(spec) !== spec_version
    ) {
      throw new GradingDataError(
        'Current Neon grading cases are missing or do not match their digest.',
      );
    }
    return { problem, spec, specVersion: spec_version };
  });
}

function checkedCatalog(catalog) {
  if (!validObject(catalog) || !Array.isArray(catalog.decks) || !Array.isArray(catalog.exercises)) {
    throw new GradingDataError('The Neon public catalog is invalid.');
  }
  const decks = new Map();
  for (const deck of catalog.decks) {
    if (
      !validObject(deck) ||
      typeof deck.id !== 'string' ||
      typeof deck.name !== 'string' ||
      decks.has(deck.id)
    ) {
      throw new GradingDataError('The Neon public deck catalog is inconsistent.');
    }
    decks.set(deck.id, deck);
  }
  const seen = new Set();
  for (const problem of catalog.exercises) {
    if (
      !validObject(problem) ||
      typeof problem.id !== 'string' ||
      seen.has(problem.id) ||
      !/^[a-f0-9]{64}$/.test(problem.version ?? '')
    ) {
      throw new GradingDataError('The Neon public problem catalog is inconsistent.');
    }
    seen.add(problem.id);
    const { version, ...content } = problem;
    if (digest(content) !== version || decks.get(problem.deckId)?.name !== problem.deck) {
      throw new GradingDataError(
        'The Neon public problem content does not match its version or deck.',
      );
    }
  }
  return catalog;
}

async function readCurrentGrading(client) {
  const { rows } = await client.query(`SELECT p.id, p.current_version AS problem_version,
    v.content AS problem, g.spec_version, g.content AS spec
    FROM cp_problems p
    JOIN cp_problem_versions v ON v.exercise_id = p.id AND v.version = p.current_version
    LEFT JOIN cp_grading_specs g ON g.exercise_id = p.id AND g.problem_version = p.current_version
    WHERE p.active ORDER BY p.position`);
  return checkedSnapshot(rows);
}

async function readSnapshot(operation) {
  let pool;
  let client;
  try {
    pool = makePool(process.env.POSTGRES_URL);
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await operation(client);
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    if (error instanceof GradingDataError) throw error;
    throw new GradingDataError(
      'Could not read the current Neon grading catalog. Connection details were not printed.',
    );
  } finally {
    client?.release();
    await pool?.end().catch(() => {});
  }
}

/** Both readers are inert until called, and never read profile state or submissions. */
export function readGradingSnapshot() {
  return readSnapshot(readCurrentGrading);
}

export function readCatalogSnapshot() {
  return readSnapshot(async (client) => checkedCatalog(await readCatalog(client)));
}

/** Copy only catalog data into an initialized, empty, guarded temporary test schema. */
export async function copyCatalogToTestDatabase(connectionString) {
  // Reject the normal URL before even opening either connection.
  testSchema(connectionString);
  const { catalog, grading } = await readSnapshot(async (client) => {
    const catalog = checkedCatalog(await readCatalog(client));
    const grading = await readCurrentGrading(client);
    const byId = new Map(grading.map((row) => [row.problem.id, row.problem]));
    if (
      catalog.exercises.length !== grading.length ||
      catalog.exercises.some((problem) => stableJson(problem) !== stableJson(byId.get(problem.id)))
    ) {
      throw new GradingDataError('The Neon public and private catalog snapshots do not match.');
    }
    return { catalog, grading };
  });
  let pool;
  let client;
  try {
    pool = makePool(connectionString);
    client = await pool.connect();
    const schema = await assertTestConnection(client, connectionString);
    await client.query('BEGIN');
    await assertTestConnection(client, connectionString);
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 739175)');
    const {
      rows: [target],
    } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM ${schema}.cp_decks)
      OR EXISTS(SELECT 1 FROM ${schema}.cp_problems)
      OR EXISTS(SELECT 1 FROM ${schema}.cp_problem_versions)
      OR EXISTS(SELECT 1 FROM ${schema}.cp_grading_specs) AS populated`);
    if (!target || target.populated !== false) {
      throw new GradingDataError('Refusing to replace a nonempty isolated test catalog.');
    }
    await client.query(
      `INSERT INTO ${schema}.cp_decks(id, content, position, active)
        SELECT id, content, position, true FROM jsonb_to_recordset($1::jsonb)
        AS decks(id text, content jsonb, position integer)`,
      [
        JSON.stringify(
          catalog.decks.map((content, position) => ({ id: content.id, content, position })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO ${schema}.cp_problem_versions(exercise_id, version, content)
        SELECT id, version, content FROM jsonb_to_recordset($1::jsonb)
        AS versions(id text, version text, content jsonb)`,
      [
        JSON.stringify(
          catalog.exercises.map((content) => ({
            id: content.id,
            version: content.version,
            content,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO ${schema}.cp_problems(id, current_version, position, active)
        SELECT id, version, position, true FROM jsonb_to_recordset($1::jsonb)
        AS problems(id text, version text, position integer)`,
      [
        JSON.stringify(
          catalog.exercises.map((problem, position) => ({
            id: problem.id,
            version: problem.version,
            position,
          })),
        ),
      ],
    );
    await client.query(
      `INSERT INTO ${schema}.cp_grading_specs(exercise_id, problem_version, spec_version, content)
        SELECT exercise_id, problem_version, spec_version, content
        FROM jsonb_to_recordset($1::jsonb) AS grading(
          exercise_id text, problem_version text, spec_version text, content jsonb
        )`,
      [
        JSON.stringify(
          grading.map(({ problem, spec, specVersion }) => ({
            exercise_id: problem.id,
            problem_version: problem.version,
            spec_version: specVersion,
            content: spec,
          })),
        ),
      ],
    );
    await client.query('COMMIT');
    return catalog.exercises.length;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    if (error instanceof GradingDataError || error instanceof TestDatabaseSafetyError) throw error;
    throw new GradingDataError(
      'Could not prepare isolated Neon grading cases. Connection details were not printed.',
    );
  } finally {
    client?.release();
    await pool?.end().catch(() => {});
  }
}
