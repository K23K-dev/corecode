import type { Pool } from 'pg';
import type { ActivityHistory } from '../../schemas/activity';
import { Timestamp } from '../../schemas/progress';

/** Accepted-submission times from the full archive, without fetching learner code. */
export async function readActivity(pool: Pool): Promise<ActivityHistory> {
  const { rows } = await pool.query<{ at: string | null }>(`
    SELECT attempt->>'at' AS at
    FROM cp_submissions
    WHERE attempt->>'status' = 'accepted'`);
  const now = Date.now();
  // Imported history may hold malformed or future timestamps; skip those.
  const accepted = rows.flatMap(({ at }) => {
    const parsed = Timestamp.safeParse(at);
    return parsed.success && Date.parse(parsed.data) <= now ? [parsed.data] : [];
  });
  return { accepted };
}
