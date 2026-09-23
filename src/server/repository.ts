import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Exercise } from '../shared/exercises.ts';
import type { ProgressData } from '../shared/progress.ts';
import { validateNeonConnectionString } from './database-config.ts';
import {
  identifier,
  plainObject,
  RequestError,
  stableJson,
  validateStateUpdate,
} from './validation.ts';
import {
  isDateKey,
  practiceClock,
  practiceDateKey,
  summarizeActivity,
  type ActivityEvent,
  type ActivitySnapshot,
} from '../shared/practice-activity.ts';

export type Catalog = {
  decks: { id: string; name: string }[];
  exercises: Exercise[];
  version: string;
};

export type StoredState = {
  revision: number;
  progress: ProgressData;
  stars: string[];
  migrations: string[];
  writes: string[];
};

// These row shapes describe the existing database schema and JSON projections below.
type CatalogRow = Omit<Catalog, 'version'>;
type StateRow = Omit<StoredState, 'revision'> & { revision: string };
type ActivityRow = {
  timestamps: { at: string | null; receivedAt: number; accepted: boolean | null }[];
  repairs: { date: string; at: number }[];
  joined_at: Date | null;
};
type DatabaseReader = Pool | PoolClient;

export function makePool(connectionString: string): Pool {
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

function digest(value: CatalogRow): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function readCatalog(pool: DatabaseReader): Promise<Catalog> {
  // One statement keeps the current catalog internally consistent during content updates.
  const {
    rows: [row],
  } = await pool.query<CatalogRow>(`SELECT
    COALESCE((SELECT jsonb_agg(content ORDER BY position) FROM cp_decks WHERE active), '[]'::jsonb) AS decks,
    COALESCE((SELECT jsonb_agg(v.content ORDER BY p.position) FROM cp_problems p
      JOIN cp_problem_versions v ON v.exercise_id = p.id AND v.version = p.current_version WHERE p.active), '[]'::jsonb) AS exercises`);
  return { ...row, version: digest(row) };
}

/** Public rendering content only: preview requests never read private grading specifications. */
export async function readPreviewProblem(
  pool: DatabaseReader,
  problemId: unknown,
  problemVersion: unknown,
): Promise<Exercise> {
  const id = identifier(problemId, 'Problem ID');
  const version = identifier(problemVersion, 'Problem version');
  const {
    rows: [row],
  } = await pool.query<{ version: string; content: Exercise }>(
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

export async function readState(client: DatabaseReader): Promise<StoredState> {
  const {
    rows: [row],
  } = await client.query<StateRow>(`SELECT revision::text, progress, stars,
    COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM cp_migration_receipts), '[]'::jsonb) AS migrations,
    COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM cp_write_receipts), '[]'::jsonb) AS writes
    FROM cp_state WHERE profile_id = 1`);
  if (!row || !Number.isSafeInteger(Number(row.revision)))
    throw new Error('Invalid stored profile revision.');
  return { ...row, revision: Number(row.revision) };
}

/** One MVCC snapshot contains timestamps/statuses and immutable repairs, never learner code. */
export async function readActivity(
  pool: DatabaseReader,
  now?: Date | string | number,
): Promise<ActivitySnapshot> {
  const {
    rows: [row],
  } = await pool.query<ActivityRow>(`SELECT
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
  const counts = new Map<string, number>();
  const firstReceipts = new Map<string, number>();
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
  const events: ActivityEvent[] = [
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
export async function repairActivity(
  pool: Pool,
  value: unknown,
  now?: Date | string | number,
): Promise<ActivitySnapshot> {
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
  state: StoredState;

  constructor(state: StoredState, code: string, message: string) {
    super(message, 409, code);
    this.state = state;
  }
}

export async function writeState(pool: Pool, rawValue: unknown): Promise<StoredState> {
  const update = validateStateUpdate(rawValue);
  const client = await pool.connect();
  let current: StoredState | undefined;
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
    if (
      error !== null &&
      typeof error === 'object' &&
      'constraint' in error &&
      error.constraint === 'cp_runner_submission_reserved' &&
      current
    ) {
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
