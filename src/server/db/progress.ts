import type { Pool, PoolClient } from 'pg';
import {
  applyProgressChanges,
  MAX_PROBLEMS,
  ProgressChangesSchema,
  type ProgressState,
} from '../../schemas/progress';
import { RequestError } from '../middleware';

// cp_state's revision column is a bigint, which pg returns as a string.
type StateRow = Omit<ProgressState, 'revision'> & { revision: string };

export async function readState(client: Pool | PoolClient): Promise<ProgressState> {
  const {
    rows: [row],
  } = await client.query<StateRow>(
    'SELECT revision::text, progress, stars FROM cp_state WHERE profile_id = 1',
  );
  if (!row || !Number.isSafeInteger(Number(row.revision)))
    throw new Error('Invalid stored profile revision.');
  return { ...row, revision: Number(row.revision) };
}

/**
 * Apply autosaved changes under the profile row lock. The cp_state trigger rebuilds
 * judge history and records checkmark changes, so an accepted submission that was
 * already grading does not override a newer manual choice.
 */
export async function writeState(pool: Pool, rawValue: unknown): Promise<ProgressState> {
  const changes = ProgressChangesSchema.parse(rawValue);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT profile_id FROM cp_state WHERE profile_id = 1 FOR UPDATE');
    const next = applyProgressChanges(await readState(client), changes);
    if (
      Object.keys(next.progress.exercises).length > MAX_PROBLEMS ||
      next.stars.length > MAX_PROBLEMS
    )
      throw new RequestError('Progress supports at most 1,000 saved problems and stars.');
    await client.query(
      `UPDATE cp_state SET revision = revision + 1, progress = $1, stars = $2, updated_at = now()
      WHERE profile_id = 1`,
      [JSON.stringify(next.progress), JSON.stringify(next.stars)],
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
