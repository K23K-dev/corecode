import { Hono } from 'hono';
import { z } from 'zod';
import { ExecutionRequest, JobID } from '../schemas/submissions';
import { loadConfig, type ApiEnv } from './config';
import { readCatalog } from './db/catalog';
import { readState, writeState } from './db/progress';
import { errorResponse, jsonBody, RequestError } from './middleware';

let services: ApiEnv['Variables']['services'] | undefined;

// Reads the configuration once per warm function. Its messages never include secrets.
function loadServices() {
  try {
    return (services ??= loadConfig(process.env));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown configuration error.';
    console.error(`API setup failed: ${reason}`);
    throw new RequestError(
      process.env.VERCEL === '1'
        ? 'Production setup is incomplete. Check the Vercel environment variables.'
        : `Local setup is incomplete: ${reason}`,
      503,
      'deployment_not_configured',
    );
  }
}

// Every API endpoint, and what runs before each one.
export const router = new Hono<ApiEnv>().basePath('/api');

// Before every endpoint: keep the response out of caches, load configuration, check the
// request, and parse a write's JSON body once, like Express's json().
router.use(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const loaded = loadServices();
  loaded.protect(c.req.raw);
  c.set('services', loaded);
  if (c.req.method === 'POST' || c.req.method === 'PUT') c.set('body', await jsonBody(c));
  c.req.raw.signal.throwIfAborted();
  await next();
});

// The decks and the current version of every problem.
router.get('/catalog', async (c) => c.json(await readCatalog(c.var.services.database())));

// Drafts, stars, solved flags, and recent attempts; autosave PUTs a batch of draft and star changes.
router.get('/state', async (c) => c.json(await readState(c.var.services.database())));
router.put('/state', async (c) => c.json(await writeState(c.var.services.database(), c.var.body)));

// Run grades the first example right away; Submit queues a durable job (202).
router.post('/run', async (c) => {
  const input = ExecutionRequest.parse(c.var.body);
  const { judge } = c.var.services;
  return input.mode === 'submit'
    ? c.json(await judge.submit(input), 202)
    : c.json(await judge.run(input, { signal: c.req.raw.signal }));
});

// One submission's status; the browser polls this every second.
router.get('/jobs/:id', async (c) => {
  const jobId = JobID.parse(c.req.param('id'));
  return c.json(await c.var.services.judge.getJob(jobId, { signal: c.req.raw.signal }));
});

// Stop: a queued submission ends at once, a running one after cleanup.
router.post('/jobs/:id/cancel', async (c) => {
  const jobId = JobID.parse(c.req.param('id'));
  z.strictObject({}).parse(c.var.body);
  return c.json(await c.var.services.judge.cancelJob(jobId));
});

router.notFound((c) => errorResponse(c, new RequestError('Endpoint not found.', 404, 'not_found')));
router.onError((error, c) =>
  errorResponse(
    c,
    c.req.raw.signal.aborted
      ? new RequestError('The request was canceled.', 499, 'canceled')
      : error,
  ),
);
