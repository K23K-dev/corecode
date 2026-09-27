import type { Context } from 'hono';
import { z } from 'zod';
import { Identifier } from '../../schemas/progress';
import { ExecutionRequest, JobID } from '../../schemas/submissions';
import type { ApiEnv } from '../config';
import { jsonResponse, RequestError } from '../middleware';

/** POST /api/run: Run grades the first example right away; Submit queues a durable job (202). */
export async function run(c: Context<ApiEnv>) {
  const input = ExecutionRequest.parse(c.var.body);
  const { judge } = c.var.services;
  return input.mode === 'submit'
    ? jsonResponse(await judge.submit(input), 202)
    : jsonResponse(await judge.run(input, { signal: c.req.raw.signal }));
}

/** GET /api/jobs?problemId=…: the problem's unfinished submission, or else its latest one. */
export async function latest(c: Context<ApiEnv>) {
  const search = new URL(c.req.url).searchParams;
  if (search.size !== 1) throw new RequestError('Provide one problem ID.');
  const problemId = Identifier.parse(search.get('problemId'));
  const job = await c.var.services.judge.recoverJob(problemId, { signal: c.req.raw.signal });
  return jsonResponse({ job });
}

/** GET /api/jobs/:id: one submission's status; the browser polls this every second. */
export async function status(c: Context<ApiEnv>) {
  const jobId = JobID.parse(c.req.param('id'));
  return jsonResponse(await c.var.services.judge.getJob(jobId, { signal: c.req.raw.signal }));
}

/** POST /api/jobs/:id/cancel: Stop. A queued submission ends at once; a running one after cleanup. */
export async function cancel(c: Context<ApiEnv>) {
  const jobId = JobID.parse(c.req.param('id'));
  z.strictObject({}).parse(c.var.body);
  return jsonResponse(await c.var.services.judge.cancelJob(jobId));
}
