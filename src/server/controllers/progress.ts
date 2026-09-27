import type { Context } from 'hono';
import type { ApiEnv } from '../config';
import { readState, writeState } from '../db/progress';
import { jsonResponse } from '../middleware';

/** GET /api/state: saved drafts, stars, and checkmarks. */
export async function get(c: Context<ApiEnv>) {
  return jsonResponse(await readState(c.var.services.database()));
}

/** PUT /api/state: autosave, which applies a batch of draft, star, and checkmark changes. */
export async function save(c: Context<ApiEnv>) {
  return jsonResponse(await writeState(c.var.services.database(), c.var.body));
}
