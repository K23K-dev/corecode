import type { Pool } from 'pg';
import type { Catalog } from '../../schemas/catalog';

export async function readCatalog(pool: Pool): Promise<Catalog> {
  // One statement keeps the current catalog internally consistent during content updates.
  const {
    rows: [row],
  } = await pool.query<Catalog>(`SELECT
    COALESCE((SELECT jsonb_agg(content ORDER BY position) FROM cp_decks WHERE active), '[]'::jsonb) AS decks,
    COALESCE((SELECT jsonb_agg(v.content ORDER BY p.position) FROM cp_problems p
      JOIN cp_problem_versions v ON v.exercise_id = p.id AND v.version = p.current_version WHERE p.active), '[]'::jsonb) AS problems`);
  return row;
}
