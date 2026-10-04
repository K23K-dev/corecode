import type { Context } from 'hono';
import type { ApiEnv } from '../config';
import { readState, writeState } from '../db/progress';

// GET /api/state: drafts, stars, solved flags, and recent attempts.
export async function get(c: Context<ApiEnv>) {
  return c.json(await readState(c.var.services.database()));
}

// PUT /api/state: autosave, applying a batch of draft and star changes.
export async function save(c: Context<ApiEnv>) {
  return c.json(await writeState(c.var.services.database(), c.var.body));
}
