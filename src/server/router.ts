import { Hono } from 'hono';
import { loadConfig, type ApiEnv } from './config';
import * as activity from './controllers/activity';
import * as catalog from './controllers/catalog';
import * as progress from './controllers/progress';
import * as submissions from './controllers/submissions';
import { errorResponse, jsonBody, RequestError } from './middleware';

let services: ApiEnv['Variables']['services'] | undefined;

/** Reads the configuration once per warm function. Its messages never include secrets. */
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

/** Every API endpoint, and what runs before each one. */
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

router.get('/catalog', catalog.list);
router.get('/state', progress.get);
router.put('/state', progress.save);
router.get('/activity', activity.list);
router.post('/run', submissions.run);
router.get('/jobs/:id', submissions.status);
router.post('/jobs/:id/cancel', submissions.cancel);

router.notFound((c) => errorResponse(c, new RequestError('Endpoint not found.', 404, 'not_found')));
router.onError((error, c) =>
  errorResponse(
    c,
    c.req.raw.signal.aborted
      ? new RequestError('The request was canceled.', 499, 'canceled')
      : error,
  ),
);
