import type { Context } from 'hono';
import type { ApiEnv } from '../config';
import { readCatalog } from '../db/catalog';

/** GET /api/catalog: the decks and the current version of every problem. */
export async function list(c: Context<ApiEnv>) {
  return c.json(await readCatalog(c.var.services.database()));
}
