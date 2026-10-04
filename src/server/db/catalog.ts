import type { Pool } from 'pg';
import type { Catalog } from '../../schemas/catalog';

// Every active deck, and the current version of every active problem, in display order.
export async function readCatalog(pool: Pool): Promise<Catalog> {
  const [decks, problems] = await Promise.all([
    pool.query<{ content: Catalog['decks'][number] }>(`
      SELECT content
      FROM decks
      WHERE active
      ORDER BY position`),
    pool.query<{ content: Catalog['problems'][number] }>(`
      SELECT v.content
      FROM problems p
      JOIN problem_versions v ON v.problem_id = p.id AND v.version = p.current_version
      WHERE p.active
      ORDER BY p.position`),
  ]);
  return {
    decks: decks.rows.map((row) => row.content),
    problems: problems.rows.map((row) => row.content),
  };
}
