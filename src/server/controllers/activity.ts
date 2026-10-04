import type { Context } from 'hono';
import type { ApiEnv } from '../config';
import { readActivity } from '../db/activity';

// GET /api/activity: when each accepted submission happened, for the calendar and streaks.
export async function list(c: Context<ApiEnv>) {
  return c.json(await readActivity(c.var.services.database()));
}
