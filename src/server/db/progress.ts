import type { Pool, PoolClient } from 'pg';
import {
  applyProgressChanges,
  MAX_PROBLEMS,
  ProgressChangesSchema,
  type Attempt,
  type ProgressState,
} from '../../schemas/progress';
import { RequestError } from '../middleware';

type Draft = { draft: string; updatedAt: string };
// revision is a bigint, which pg returns as a string.
type ProfileRow = { revision: string; drafts: Record<string, Draft>; stars: string[] };
type HistoryRow = { problem_id: string; solved: boolean; attempts: Attempt[] };

/**
 * Drafts and stars come from `profile`. Each problem's solved flag and latest 20 attempts come
 * from submission history, the only place they're stored.
 */
export async function readState(client: Pool | PoolClient): Promise<ProgressState> {
  const {
    rows: [profile],
  } = await client.query<ProfileRow>(
    'SELECT revision::text, drafts, stars FROM profile WHERE id = 1',
  );
  if (!profile || !Number.isSafeInteger(Number(profile.revision)))
    throw new Error('Invalid stored profile revision.');
  const { rows: history } = await client.query<HistoryRow>(`
    SELECT problem_id,
           bool_or(attempt->>'status' = 'accepted') AS solved,
           jsonb_agg(attempt ORDER BY at, id) FILTER (WHERE recent <= 20) AS attempts
    FROM (
      SELECT problem_id, id, attempt, (attempt->>'at')::timestamptz AS at,
             row_number() OVER (PARTITION BY problem_id ORDER BY (attempt->>'at')::timestamptz DESC, id DESC) AS recent
      FROM submissions
    ) ranked
    GROUP BY problem_id`);
  const exercises: ProgressState['progress']['exercises'] = {};
  for (const [id, { draft, updatedAt }] of Object.entries(profile.drafts))
    exercises[id] = { draft, updatedAt, solved: false, attempts: [] };
  // A problem submitted without a saved draft shows its latest submitted code.
  for (const { problem_id: id, solved, attempts } of history) {
    const latest = attempts[attempts.length - 1];
    const saved = exercises[id] ?? { draft: latest.code, updatedAt: latest.at };
    exercises[id] = { ...saved, solved, attempts };
  }
  return {
    revision: Number(profile.revision),
    progress: { version: 1, exercises },
    stars: profile.stars,
  };
}

// Apply autosaved changes under the profile row lock. Only drafts and stars are stored.
export async function writeState(pool: Pool, rawValue: unknown): Promise<ProgressState> {
  const changes = ProgressChangesSchema.parse(rawValue);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM profile WHERE id = 1 FOR UPDATE');
    const next = applyProgressChanges(await readState(client), changes);
    if (
      Object.keys(next.progress.exercises).length > MAX_PROBLEMS ||
      next.stars.length > MAX_PROBLEMS
    )
      throw new RequestError('Progress supports at most 1,000 saved problems and stars.');
    const drafts: Record<string, Draft> = {};
    for (const [id, { draft, updatedAt }] of Object.entries(next.progress.exercises))
      drafts[id] = { draft, updatedAt };
    await client.query(
      'UPDATE profile SET revision = revision + 1, drafts = $1, stars = $2 WHERE id = 1',
      [JSON.stringify(drafts), JSON.stringify(next.stars)],
    );
    const saved = await readState(client);
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
