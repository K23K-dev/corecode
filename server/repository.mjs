import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { validateNeonConnectionString } from './database-config.mjs';
import { identifier, RequestError, stableJson, validateStateUpdate } from './validation.mjs';

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS cp_schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS cp_decks (
    id text PRIMARY KEY,
    content jsonb NOT NULL,
    position integer NOT NULL,
    active boolean NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS cp_problem_versions (
    exercise_id text NOT NULL,
    version text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (exercise_id, version)
  );
  CREATE TABLE IF NOT EXISTS cp_grading_specs (
    exercise_id text NOT NULL,
    problem_version text NOT NULL,
    spec_version text NOT NULL CHECK (spec_version ~ '^[a-f0-9]{64}$'),
    content jsonb NOT NULL CHECK (
      jsonb_typeof(content) = 'object'
      AND content ? 'runtime' AND jsonb_typeof(content->'runtime') = 'string'
      AND content->>'runtime' IN ('python', 'javascript', 'sql', 'shell')
      AND content ? 'cases' AND jsonb_typeof(content->'cases') = 'array'
      AND jsonb_array_length(content->'cases') BETWEEN 1 AND 32
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (exercise_id, problem_version),
    FOREIGN KEY (exercise_id, problem_version) REFERENCES cp_problem_versions(exercise_id, version)
  );
  CREATE TABLE IF NOT EXISTS cp_problems (
    id text PRIMARY KEY,
    current_version text NOT NULL,
    position integer NOT NULL,
    active boolean NOT NULL DEFAULT true,
    FOREIGN KEY (id, current_version) REFERENCES cp_problem_versions(exercise_id, version)
  );
  CREATE TABLE IF NOT EXISTS cp_state (
    profile_id integer PRIMARY KEY CHECK (profile_id = 1),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    progress jsonb NOT NULL DEFAULT '{"version":1,"exercises":{}}',
    stars jsonb NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS cp_submissions (
    id text PRIMARY KEY,
    exercise_id text NOT NULL,
    problem_version text,
    attempt jsonb NOT NULL,
    grading_source text NOT NULL DEFAULT 'browser' CHECK (grading_source = 'browser'),
    received_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS cp_submissions_exercise_idx ON cp_submissions(exercise_id, received_at);
  CREATE TABLE IF NOT EXISTS cp_migration_receipts (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS cp_write_receipts (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION cp_reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Historical practice records are append-only';
  END;
  $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cp_problem_versions_immutable' AND tgrelid = 'cp_problem_versions'::regclass) THEN
      CREATE TRIGGER cp_problem_versions_immutable BEFORE UPDATE OR DELETE ON cp_problem_versions
        FOR EACH ROW EXECUTE FUNCTION cp_reject_immutable_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cp_submissions_immutable' AND tgrelid = 'cp_submissions'::regclass) THEN
      CREATE TRIGGER cp_submissions_immutable BEFORE UPDATE OR DELETE ON cp_submissions
        FOR EACH ROW EXECUTE FUNCTION cp_reject_immutable_change();
    END IF;
  END $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cp_grading_specs_immutable' AND tgrelid = 'cp_grading_specs'::regclass) THEN
      CREATE TRIGGER cp_grading_specs_immutable BEFORE UPDATE OR DELETE ON cp_grading_specs
        FOR EACH ROW EXECUTE FUNCTION cp_reject_immutable_change();
    END IF;
  END $$;
  INSERT INTO cp_state(profile_id) VALUES(1) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
`;

export function makePool(connectionString) {
  const url = validateNeonConnectionString(connectionString);
  // A connection without an explicit port must not inherit a machine's PGPORT.
  url.port ||= '5432';
  const pool = new Pool({
    connectionString: url.href,
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: 'code-practice',
  });
  // Idle client failures must not become uncaught EventEmitter exceptions.
  pool.on('error', () => {});
  return pool;
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Caller owns the transaction. Serialize schema migrations. */
export async function initializeSchema(client) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 739175)');
  await client.query(MIGRATION_SQL);
}

/** Prepare the schema without changing the catalog or existing learner records. */
export async function initializeDatabase(connectionString) {
  const pool = makePool(connectionString);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await initializeSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function readCatalog(pool) {
  // One statement keeps the current catalog internally consistent during content updates.
  const {
    rows: [row],
  } = await pool.query(`SELECT
    COALESCE((SELECT jsonb_agg(content ORDER BY position) FROM cp_decks WHERE active), '[]'::jsonb) AS decks,
    COALESCE((SELECT jsonb_agg(v.content ORDER BY p.position) FROM cp_problems p
      JOIN cp_problem_versions v ON v.exercise_id = p.id AND v.version = p.current_version WHERE p.active), '[]'::jsonb) AS exercises`);
  return { ...row, version: digest(row) };
}

/** Private execution lookup. Never include this result in public catalog/state routes. */
export async function readExecutionProblem(pool, problemId) {
  const id = identifier(problemId, 'Problem ID');
  const {
    rows: [row],
  } = await pool.query(
    `SELECT p.id, p.current_version AS version,
      s.content AS "gradingSpec", s.spec_version AS "gradingSpecVersion"
     FROM cp_problems p
     LEFT JOIN cp_grading_specs s ON s.exercise_id = p.id AND s.problem_version = p.current_version
     WHERE p.id = $1 AND p.active`,
    [id],
  );
  if (!row) return null;
  if (row.gradingSpec && digest(row.gradingSpec) !== row.gradingSpecVersion) {
    throw new RequestError(
      'Grading data is unavailable for this problem version.',
      503,
      'grading_unavailable',
    );
  }
  return { id: row.id, version: row.version, gradingSpec: row.gradingSpec };
}

export async function readState(client) {
  const {
    rows: [row],
  } = await client.query(`SELECT revision::text, progress, stars,
    COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM cp_migration_receipts), '[]'::jsonb) AS migrations,
    COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM cp_write_receipts), '[]'::jsonb) AS writes
    FROM cp_state WHERE profile_id = 1`);
  if (!row || !Number.isSafeInteger(Number(row.revision)))
    throw new Error('Invalid stored profile revision.');
  return { ...row, revision: Number(row.revision) };
}

/** Counts immutable accepted submissions, independently of the twenty-attempt UI snapshot. */
export async function readActivity(pool, timeZone = 'UTC') {
  if (
    typeof timeZone !== 'string' ||
    timeZone.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timeZone)
  ) {
    throw new RequestError('Activity time zone must be a valid IANA time zone.');
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new RequestError('Activity time zone must be a valid IANA time zone.');
  }

  const now = Date.now();
  // Fetch only timestamps, never submitted code. JSON comparisons avoid casts that could fail on legacy data.
  const { rows } = await pool.query(`SELECT attempt->>'at' AS at FROM cp_submissions
    WHERE attempt->>'status' = 'accepted'
      AND jsonb_typeof(attempt->'passed') = 'number' AND jsonb_typeof(attempt->'total') = 'number'
      AND attempt->'passed' = attempt->'total' AND attempt->'total' > '0'::jsonb`);
  const counts = new Map();
  for (const { at } of rows) {
    // Use the same UTC ISO format as saved progress; reject normalized invalid dates and future clock skew.
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at))
      continue;
    const timestamp = new Date(at);
    if (
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.getTime() > now ||
      timestamp.getUTCFullYear() < 1 ||
      timestamp.toISOString().slice(0, 19) !== at.slice(0, 19)
    )
      continue;
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, part.value]),
    );
    const date = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return {
    timeZone,
    days: [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, count]) => ({ date, count })),
  };
}

export class StateConflict extends RequestError {
  constructor(state, code, message) {
    super(message, 409, code);
    this.state = state;
  }
}

export async function writeState(pool, rawValue) {
  const update = validateStateUpdate(rawValue);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT profile_id FROM cp_state WHERE profile_id = 1 FOR UPDATE');
    const current = await readState(client);
    if (update.migrationId && current.migrations.includes(update.migrationId)) {
      await client.query('COMMIT');
      return current;
    }
    const acknowledged = new Set(current.writes);
    if (update.writeIds.some((id) => acknowledged.has(id))) {
      // Do not return success: this request may also contain newer drafts or submissions.
      throw new StateConflict(
        current,
        'revision_conflict',
        'Some changes are already saved. Reconcile them before retrying.',
      );
    }
    if (current.revision !== update.expectedRevision) {
      throw new StateConflict(
        current,
        'revision_conflict',
        'Newer progress is already saved. Review it before saving again.',
      );
    }
    if (update.migrationId && current.migrations.length >= 1000)
      throw new RequestError('Migration receipt limit reached.');
    if (update.submissions.length) {
      const encoded = JSON.stringify(update.submissions);
      await client.query(
        `INSERT INTO cp_submissions(id, exercise_id, problem_version, attempt)
        SELECT item->'attempt'->>'id', item->>'exerciseId', item->'attempt'->>'problemVersion', item->'attempt'
        FROM jsonb_array_elements($1::jsonb) item ON CONFLICT(id) DO NOTHING`,
        [encoded],
      );
      const conflict = await client.query(
        `SELECT 1 FROM jsonb_array_elements($1::jsonb) item
        JOIN cp_submissions saved ON saved.id = item->'attempt'->>'id'
        WHERE saved.exercise_id <> item->>'exerciseId' OR saved.attempt <> item->'attempt' LIMIT 1`,
        [encoded],
      );
      if (conflict.rowCount)
        throw new StateConflict(
          current,
          'submission_conflict',
          'A submission ID is already associated with different immutable history.',
        );
    }
    await client.query(
      `UPDATE cp_state SET revision = revision + 1, progress = $1, stars = $2, updated_at = now()
      WHERE profile_id = 1`,
      [JSON.stringify(update.progress), JSON.stringify(update.stars)],
    );
    if (update.migrationId)
      await client.query('INSERT INTO cp_migration_receipts(id) VALUES($1)', [update.migrationId]);
    if (update.writeIds.length) {
      await client.query('INSERT INTO cp_write_receipts(id) SELECT unnest($1::text[])', [
        update.writeIds,
      ]);
    }
    const result = await readState(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
