import type { Context } from 'hono';
import { z } from 'zod';
import { ExecutionRequest, JobID } from '../../schemas/submissions';
import type { ApiEnv } from '../config';

// POST /api/run: Run grades the first example right away; Submit queues a durable job (202).
export async function run(c: Context<ApiEnv>) {
  const input = ExecutionRequest.parse(c.var.body);
  const { judge } = c.var.services;
  return input.mode === 'submit'
    ? c.json(await judge.submit(input), 202)
    : c.json(await judge.run(input, { signal: c.req.raw.signal }));
}

// GET /api/jobs/:id: one submission's status; the browser polls this every second.
export async function status(c: Context<ApiEnv>) {
  const jobId = JobID.parse(c.req.param('id'));
  return c.json(await c.var.services.judge.getJob(jobId, { signal: c.req.raw.signal }));
}

// POST /api/jobs/:id/cancel: Stop. A queued submission ends at once; a running one after cleanup.
export async function cancel(c: Context<ApiEnv>) {
  const jobId = JobID.parse(c.req.param('id'));
  z.strictObject({}).parse(c.var.body);
  return c.json(await c.var.services.judge.cancelJob(jobId));
}
