import { Hono } from 'hono';
import { after } from 'next/server';
import { loadConfig, type ApiEnv } from './config';
import * as activity from './controllers/activity';
import * as catalog from './controllers/catalog';
import * as progress from './controllers/progress';
import * as submissions from './controllers/submissions';
import { errorResponse, jsonBody, jsonResponse, RequestError } from './middleware';

let services: ApiEnv['Variables']['services'] | undefined;
// Keeps work such as the judge's cleanup running after the response is sent.
const keepAlive = (task: Promise<unknown>) =>
  after(async () => {
    await task;
  });

/** Every API endpoint, and what runs before each one. */
export const router = new Hono<ApiEnv>().basePath('/api');

// Before every endpoint: load configuration once, check the request, and parse its JSON body.
router.use(async (c, next) => {
  const request = c.req.raw;
  try {
    services ??= loadConfig(process.env, keepAlive);
  } catch (error) {
    // Configuration messages never include secrets.
    const reason = error instanceof Error ? error.message : 'Unknown configuration error.';
    console.error(`API setup failed: ${reason}`);
    const hosted = process.env.VERCEL === '1';
    return jsonResponse(
      {
        error: hosted
          ? 'Production setup is incomplete. Check deployment protection, database, application origin, and judge configuration.'
          : `Local setup is incomplete: ${reason}`,
        code: 'deployment_not_configured',
      },
      503,
      request.method === 'HEAD',
    );
  }
  services.protect(request);
  c.set('services', services);
  c.set(
    'body',
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await jsonBody(request),
  );
  request.signal.throwIfAborted();
  await next();
});

router.get('/health', async (c) => {
  await c.var.services.database().query('SELECT 1');
  return jsonResponse({ ok: true, executionMode: 'durable' });
});
router.get('/catalog', catalog.list);
router.get('/state', progress.get);
router.put('/state', progress.save);
router.get('/activity', activity.list);
router.post('/run', submissions.run);
router.get('/jobs', submissions.latest);
router.get('/jobs/:id', submissions.status);
router.post('/jobs/:id/cancel', submissions.cancel);

router.notFound(() => errorResponse(new RequestError('Endpoint not found.', 404, 'not_found')));
router.onError((error, c) =>
  c.req.raw.signal.aborted
    ? errorResponse(new RequestError('The request was canceled.', 499, 'canceled'))
    : errorResponse(error, c.req.method === 'HEAD'),
);
