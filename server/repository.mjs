import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { validateNeonConnectionString } from './database-config.mjs';
import {
  identifier,
  plainObject,
  RequestError,
  stableJson,
  validateStateUpdate,
} from './validation.mjs';
import {
  isDateKey,
  practiceClock,
  practiceDateKey,
  summarizeActivity,
} from '../shared/practice-activity.mjs';

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
    received_at timestamptz NOT NULL DEFAULT statement_timestamp()
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
  CREATE TABLE IF NOT EXISTS cp_streak_repairs (
    date date PRIMARY KEY CHECK (date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
    repaired_at timestamptz NOT NULL DEFAULT statement_timestamp()
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
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cp_streak_repairs_immutable' AND tgrelid = 'cp_streak_repairs'::regclass) THEN
      CREATE TRIGGER cp_streak_repairs_immutable BEFORE UPDATE OR DELETE ON cp_streak_repairs
        FOR EACH ROW EXECUTE FUNCTION cp_reject_immutable_change();
    END IF;
  END $$;
  INSERT INTO cp_state(profile_id) VALUES(1) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
  INSERT INTO cp_schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
  ALTER TABLE cp_state ADD COLUMN IF NOT EXISTS joined_at timestamptz;
  UPDATE cp_state SET joined_at = LEAST(
    updated_at,
    (SELECT min(applied_at) FROM cp_schema_migrations),
    (SELECT min(received_at) FROM cp_submissions)
  ) WHERE joined_at IS NULL;
  ALTER TABLE cp_state ALTER COLUMN joined_at SET DEFAULT now();
  ALTER TABLE cp_state ALTER COLUMN joined_at SET NOT NULL;
  ALTER TABLE cp_submissions ALTER COLUMN received_at SET DEFAULT statement_timestamp();
  ALTER TABLE cp_streak_repairs ALTER COLUMN repaired_at SET DEFAULT statement_timestamp();
  INSERT INTO cp_schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
  CREATE UNIQUE INDEX IF NOT EXISTS cp_grading_specs_version_idx
    ON cp_grading_specs(exercise_id, problem_version, spec_version);
  CREATE TABLE IF NOT EXISTS cp_execution_jobs (
    id uuid PRIMARY KEY,
    problem_id text NOT NULL,
    problem_version text NOT NULL,
    spec_version text NOT NULL,
    code text NOT NULL,
    runtime text NOT NULL CHECK (runtime IN ('python', 'javascript', 'sql', 'shell')),
    image_id text NOT NULL,
    completion_intent_ids text[] NOT NULL DEFAULT '{}',
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    state text NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'running', 'canceling', 'completed', 'failed', 'canceled')),
    result jsonb,
    error text,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    owner_token uuid,
    lease_until timestamptz,
    container_name text,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
    cancel_requested boolean NOT NULL DEFAULT false,
    FOREIGN KEY (problem_id, problem_version, spec_version)
      REFERENCES cp_grading_specs(exercise_id, problem_version, spec_version),
    CHECK ((state IN ('running', 'canceling')) =
      (owner_token IS NOT NULL AND lease_until IS NOT NULL AND container_name IS NOT NULL)),
    CHECK ((state IN ('completed', 'failed', 'canceled')) = (finished_at IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS cp_execution_jobs_queue_idx
    ON cp_execution_jobs(created_at, id) WHERE state = 'queued';
  CREATE INDEX IF NOT EXISTS cp_execution_jobs_lease_idx
    ON cp_execution_jobs(lease_until) WHERE state IN ('running', 'canceling');
  CREATE INDEX IF NOT EXISTS cp_execution_jobs_problem_idx
    ON cp_execution_jobs(problem_id, created_at DESC, id DESC);
  INSERT INTO cp_schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
  ALTER TABLE cp_state ADD COLUMN IF NOT EXISTS completion_choices jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE cp_execution_jobs ADD COLUMN IF NOT EXISTS completion_choice_id text;
  ALTER TABLE cp_submissions ADD COLUMN IF NOT EXISTS execution_job_id uuid UNIQUE
    REFERENCES cp_execution_jobs(id);
  ALTER TABLE cp_submissions DROP CONSTRAINT IF EXISTS cp_submissions_grading_source_check;
  ALTER TABLE cp_submissions ADD CONSTRAINT cp_submissions_grading_source_check CHECK (
    grading_source IN ('browser', 'runner') AND
    (grading_source = 'runner') = (execution_job_id IS NOT NULL)
  );

  CREATE OR REPLACE FUNCTION cp_protect_runner_submission() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.grading_source = 'browser' AND NEW.id LIKE 'judge:%' AND NOT EXISTS (
      SELECT 1 FROM cp_submissions saved WHERE saved.id = NEW.id
        AND saved.exercise_id = NEW.exercise_id AND saved.attempt = NEW.attempt
    ) THEN
      RAISE EXCEPTION 'Judge submission IDs are reserved for canonical history'
        USING ERRCODE = '23514', CONSTRAINT = 'cp_runner_submission_reserved';
    END IF;
    IF NEW.grading_source = 'runner' AND NOT EXISTS (
      SELECT 1 FROM cp_execution_jobs job WHERE job.id = NEW.execution_job_id
        AND NEW.id = 'judge:' || job.id::text AND job.state = 'completed' AND job.result IS NOT NULL
        AND NEW.exercise_id = job.problem_id AND NEW.problem_version = job.problem_version
        AND NEW.attempt->>'code' = job.code AND NEW.attempt->>'problemVersion' = job.problem_version
    ) THEN
      RAISE EXCEPTION 'Judge history must refer to its completed execution'
        USING ERRCODE = '23514', CONSTRAINT = 'cp_runner_submission_reserved';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE OR REPLACE TRIGGER cp_submissions_runner_guard BEFORE INSERT ON cp_submissions
    FOR EACH ROW EXECUTE FUNCTION cp_protect_runner_submission();

  CREATE OR REPLACE FUNCTION cp_preserve_runner_progress() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    problem text;
    entry jsonb;
    attempts jsonb;
  BEGIN
    -- Hosted clients still send entire snapshots. They can replay canonical
    -- attempts, but cannot alter or move a judge attempt between exercises.
    IF EXISTS (
      SELECT 1 FROM jsonb_each(NEW.progress->'exercises') exercise
      CROSS JOIN LATERAL jsonb_array_elements(exercise.value->'attempts') item
      WHERE item->>'id' LIKE 'judge:%' AND NOT EXISTS (
        SELECT 1 FROM cp_submissions saved WHERE saved.id = item->>'id'
          AND saved.exercise_id = exercise.key AND saved.attempt = item
      )
    ) THEN
      RAISE EXCEPTION 'Judge history cannot be changed by a progress snapshot'
        USING ERRCODE = '23514', CONSTRAINT = 'cp_runner_submission_reserved';
    END IF;
    FOR problem IN SELECT DISTINCT exercise_id FROM cp_submissions WHERE grading_source = 'runner' LOOP
      entry := COALESCE(NEW.progress->'exercises'->problem, OLD.progress->'exercises'->problem);
      IF entry IS NULL THEN
        SELECT jsonb_build_object('draft', attempt->>'code', 'updatedAt', attempt->>'at',
          'solved', false, 'attempts', '[]'::jsonb) INTO entry
          FROM cp_submissions WHERE exercise_id = problem ORDER BY received_at DESC, id DESC LIMIT 1;
      END IF;
      SELECT jsonb_agg(recent.attempt ORDER BY recent.at, recent.id) INTO attempts FROM (
        SELECT id, attempt, (attempt->>'at')::timestamptz AS at FROM cp_submissions
        WHERE exercise_id = problem ORDER BY at DESC, id DESC LIMIT 20
      ) recent;
      entry := jsonb_set(entry, '{attempts}', attempts);
      NEW.progress := jsonb_set(NEW.progress, ARRAY['exercises', problem], entry);
    END LOOP;
    -- Older hosted clients lack explicit intent metadata. Preserve their real
    -- boolean transitions; merely saving a first draft is not a solved choice.
    FOR problem, entry IN SELECT key, value FROM jsonb_each(NEW.progress->'exercises') LOOP
      IF (entry->>'solved')::boolean IS DISTINCT FROM
           COALESCE((OLD.progress->'exercises'->problem->>'solved')::boolean, false)
         AND NEW.completion_choices->>problem IS NOT DISTINCT FROM OLD.completion_choices->>problem THEN
        NEW.completion_choices := jsonb_set(NEW.completion_choices, ARRAY[problem], to_jsonb(gen_random_uuid()::text));
      END IF;
    END LOOP;
    RETURN NEW;
  END;
  $$;
  CREATE OR REPLACE TRIGGER cp_state_runner_guard BEFORE UPDATE OF progress ON cp_state
    FOR EACH ROW EXECUTE FUNCTION cp_preserve_runner_progress();

  CREATE OR REPLACE FUNCTION cp_finish_execution(
    p_id uuid, p_token uuid, p_result jsonb, p_failure text, p_retry boolean
  ) RETURNS SETOF cp_execution_jobs LANGUAGE plpgsql AS $$
  DECLARE
    profile cp_state%ROWTYPE;
    job cp_execution_jobs%ROWTYPE;
    finished timestamptz;
    at_text text;
    expected integer;
    passed integer;
    case_count integer;
    has_error boolean;
    verdict text;
    attempt jsonb;
    entry jsonb;
    choices jsonb;
    current_choice text;
  BEGIN
    -- Browser saves and streak repairs lock this same row first. Keep archive
    -- inserts behind that lock to avoid deadlocks and partially saved results.
    SELECT * INTO profile FROM cp_state WHERE profile_id = 1 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The practice profile is unavailable'; END IF;
    SELECT * INTO job FROM cp_execution_jobs WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    IF job.state IN ('completed', 'failed', 'canceled') THEN
      RETURN NEXT job;
      RETURN;
    END IF;
    IF job.state NOT IN ('running', 'canceling') OR job.owner_token IS DISTINCT FROM p_token
      OR job.lease_until <= clock_timestamp() THEN RETURN; END IF;

    finished := clock_timestamp();
    IF job.cancel_requested OR p_result IS NULL THEN
      UPDATE cp_execution_jobs SET
        state = CASE WHEN cancel_requested THEN 'canceled'
          WHEN p_retry AND attempts < 2 THEN 'queued' ELSE 'failed' END,
        result = NULL,
        error = CASE WHEN cancel_requested OR (p_retry AND attempts < 2) THEN NULL ELSE p_failure END,
        finished_at = CASE WHEN NOT cancel_requested AND p_retry AND attempts < 2 THEN NULL ELSE finished END,
        owner_token = NULL, lease_until = NULL, container_name = NULL, revision = revision + 1
        WHERE id = p_id RETURNING * INTO job;
      RETURN NEXT job;
      RETURN;
    END IF;

    SELECT jsonb_array_length(content->'cases') INTO expected FROM cp_grading_specs
      WHERE exercise_id = job.problem_id AND problem_version = job.problem_version AND spec_version = job.spec_version;
    IF jsonb_typeof(p_result) <> 'object' OR expected IS NULL
      OR jsonb_typeof(COALESCE(p_result->'cases', '[]'::jsonb)) <> 'array'
      OR (p_result ? 'durationMs' AND jsonb_typeof(p_result->'durationMs') <> 'number')
      OR COALESCE((p_result->>'durationMs')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'Invalid judge result' USING ERRCODE = '23514';
    END IF;
    case_count := jsonb_array_length(COALESCE(p_result->'cases', '[]'::jsonb));
    IF case_count > expected OR (case_count <> expected AND COALESCE(p_result->>'error', '') = '') THEN
      RAISE EXCEPTION 'Judge result does not match its grading cases' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) FILTER (WHERE item->'passed' = 'true'::jsonb),
      COALESCE(bool_or(COALESCE(item->>'error', '') <> ''), false)
      INTO passed, has_error FROM jsonb_array_elements(COALESCE(p_result->'cases', '[]'::jsonb)) item;
    has_error := has_error OR COALESCE(p_result->>'error', '') <> '';
    verdict := CASE WHEN has_error THEN 'error' WHEN passed = expected THEN 'accepted' ELSE 'failed' END;
    at_text := to_char(finished AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    attempt := jsonb_build_object('id', 'judge:' || job.id::text, 'at', at_text,
      'code', job.code, 'problemVersion', job.problem_version, 'passed', passed,
      'total', expected, 'status', verdict, 'durationMs', COALESCE((p_result->>'durationMs')::numeric, 0));
    UPDATE cp_execution_jobs SET state = 'completed', result = p_result, error = NULL,
      finished_at = finished, owner_token = NULL, lease_until = NULL, container_name = NULL, revision = revision + 1
      WHERE id = p_id RETURNING * INTO job;
    INSERT INTO cp_submissions(id, exercise_id, problem_version, attempt, grading_source, execution_job_id, received_at)
      VALUES(attempt->>'id', job.problem_id, job.problem_version, attempt, 'runner', job.id, finished);

    entry := COALESCE(profile.progress->'exercises'->job.problem_id,
      jsonb_build_object('draft', job.code,
        'updatedAt', to_char(job.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'solved', false, 'attempts', '[]'::jsonb));
    choices := profile.completion_choices;
    current_choice := choices->>job.problem_id;
    IF verdict = 'accepted' THEN
      IF current_choice IS NOT DISTINCT FROM job.completion_choice_id OR current_choice = ANY(job.completion_intent_ids) THEN
        entry := jsonb_set(entry, '{solved}', 'true'::jsonb);
        choices := jsonb_set(choices, ARRAY[job.problem_id], to_jsonb('judge:' || job.id::text));
      END IF;
      INSERT INTO cp_write_receipts(id) SELECT unnest(job.completion_intent_ids) ON CONFLICT DO NOTHING;
    END IF;
    UPDATE cp_state SET progress = jsonb_set(profile.progress, ARRAY['exercises', job.problem_id], entry),
      completion_choices = choices, revision = revision + 1, updated_at = finished WHERE profile_id = 1;
    RETURN NEXT job;
  END;
  $$;
  INSERT INTO cp_schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS cp_judge_runtime (
    id smallint PRIMARY KEY CHECK (id = 1),
    engine_id text NOT NULL CHECK (length(engine_id) BETWEEN 1 AND 256)
  );
  INSERT INTO cp_schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
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

/** Public rendering content only: preview requests never read private grading specifications. */
export async function readPreviewProblem(pool, problemId, problemVersion) {
  const id = identifier(problemId, 'Problem ID');
  const version = identifier(problemVersion, 'Problem version');
  const {
    rows: [row],
  } = await pool.query(
    `SELECT p.current_version AS version, v.content
     FROM cp_problems p
     JOIN cp_problem_versions v ON v.exercise_id = p.id AND v.version = p.current_version
     WHERE p.id = $1 AND p.active`,
    [id],
  );
  if (!row) throw new RequestError('Problem not found.', 404, 'not_found');
  if (row.version !== version) {
    throw new RequestError(
      'This problem has changed. Refresh it to see the rendered example.',
      409,
      'problem_changed',
    );
  }
  return { ...row.content, id, version: row.version };
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

/** One MVCC snapshot contains timestamps/statuses and immutable repairs, never learner code. */
export async function readActivity(pool, now) {
  const {
    rows: [row],
  } = await pool.query(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'at', attempt->>'at', 'receivedAt', extract(epoch from received_at) * 1000,
      'accepted', attempt->>'status' = 'accepted'
        AND jsonb_typeof(attempt->'passed') = 'number' AND jsonb_typeof(attempt->'total') = 'number'
        AND attempt->'passed' = attempt->'total' AND attempt->'total' > '0'::jsonb
      )) FROM cp_submissions), '[]'::jsonb) AS timestamps,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('date', to_char(date, 'YYYY-MM-DD'), 'at', extract(epoch from repaired_at) * 1000) ORDER BY repaired_at, date) FROM cp_streak_repairs), '[]'::jsonb) AS repairs,
    (SELECT joined_at FROM cp_state WHERE profile_id = 1) AS joined_at`);
  // Capture the response clock after database latency, not when the HTTP request began.
  const frozenNow = new Date(now === undefined ? Date.now() : now);
  const clock = practiceClock(frozenNow);
  if (!row || !Array.isArray(row.timestamps) || !Array.isArray(row.repairs)) {
    throw new Error('Invalid stored activity snapshot.');
  }
  const counts = new Map();
  const firstReceipts = new Map();
  if (!row.joined_at || !Number.isFinite(new Date(row.joined_at).getTime()))
    throw new Error('Invalid stored profile creation date.');
  let joinedOn = practiceDateKey(new Date(row.joined_at));
  for (const record of row.timestamps) {
    const at = record?.at;
    // Use the same UTC ISO format as saved progress; reject normalized invalid dates and future clock skew.
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at))
      continue;
    const timestamp = new Date(at);
    if (
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.getTime() > frozenNow.getTime() ||
      timestamp.getUTCFullYear() < 1 ||
      timestamp.toISOString().slice(0, 19) !== at.slice(0, 19)
    )
      continue;
    let date;
    try {
      date = practiceDateKey(timestamp);
    } catch (error) {
      if (error instanceof RangeError) continue;
      throw error;
    }
    // A failed or imported attempt still proves the profile existed on that day.
    if (date < joinedOn) joinedOn = date;
    if (record.accepted !== true) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
    const receivedAt = record.receivedAt;
    if (!Number.isFinite(receivedAt)) throw new Error('Invalid stored activity receipt.');
    // Replayed/offline submissions can arrive after a repair. Credit them when
    // the archive first knew about them, without rewriting earlier wallet caps.
    const availableAt = Math.max(timestamp.getTime(), receivedAt);
    firstReceipts.set(date, Math.min(firstReceipts.get(date) ?? Infinity, availableAt));
  }
  const days = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, count]) => ({ date, count }));
  const repairs = row.repairs.map((repair) => repair?.date).sort();
  if (!repairs.every(isDateKey) || row.repairs.some((repair) => !Number.isFinite(repair.at)))
    throw new Error('Invalid stored streak repair.');
  const events = [
    ...[...firstReceipts].map(([date, at]) => ({ date, at })),
    ...row.repairs.map(({ date, at }) => ({ date, at, repair: true })),
  ];
  return {
    timeZone: 'America/New_York',
    resetHour: 20,
    today: clock.today,
    resetAt: clock.resetAt,
    serverNow: frozenNow.toISOString(),
    days,
    repairs,
    streak: summarizeActivity(days, repairs, clock.today, { joinedOn, events }),
  };
}

/** Spend one derived heart without modifying progress, revisions, or the submission archive. */
export async function repairActivity(pool, value, now) {
  const body = plainObject(value, 'Streak repair');
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'date') || !isDateKey(body.date)) {
    throw new RequestError('Provide only a valid repair date in YYYY-MM-DD format.');
  }
  const date = body.date;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Share the progress writer's lock so submissions and competing spends cannot race this balance.
    const locked = await client.query(
      'SELECT profile_id FROM cp_state WHERE profile_id = 1 FOR UPDATE',
    );
    if (!locked.rows[0]) throw new Error('The practice profile is unavailable.');
    const current = await readActivity(client, now);
    let result = current;
    if (!current.repairs.includes(date)) {
      if (
        !current.streak.startedOn ||
        date < current.streak.startedOn ||
        date >= current.today ||
        current.days.some((day) => day.date === date)
      ) {
        throw new RequestError(
          'Choose a missed, completed practice day since you joined.',
          400,
          'invalid_repair',
        );
      }
      if (current.streak.hearts < 1) {
        throw new RequestError(
          'Earn a heart by completing five days in a row before repairing a missed day.',
          409,
          'insufficient_hearts',
        );
      }
      await client.query('INSERT INTO cp_streak_repairs(date) VALUES($1::date)', [date]);
      result = await readActivity(client, now);
    }
    await client.query('COMMIT');
    // A slow commit can cross 8 PM. Refresh once on the same released-lock connection,
    // retaining a single coherent snapshot without holding another pool connection.
    if (now === undefined && Date.now() >= Date.parse(result.resetAt)) {
      return await readActivity(client);
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  let current;
  try {
    await client.query('BEGIN');
    await client.query('SELECT profile_id FROM cp_state WHERE profile_id = 1 FOR UPDATE');
    current = await readState(client);
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
    const completionChoices = Object.fromEntries(
      Object.entries(update.solvedChanges).map(([id, change]) => [id, change.id]),
    );
    await client.query(
      `UPDATE cp_state SET revision = revision + 1, progress = $1, stars = $2,
        completion_choices = completion_choices || $3::jsonb, updated_at = now()
      WHERE profile_id = 1`,
      [
        JSON.stringify(update.progress),
        JSON.stringify(update.stars),
        JSON.stringify(completionChoices),
      ],
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
    if (error.constraint === 'cp_runner_submission_reserved' && current) {
      throw new StateConflict(
        current,
        'submission_conflict',
        'Judge submission history cannot be changed by a browser save.',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
