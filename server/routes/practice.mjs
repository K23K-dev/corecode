import { Router } from 'express';
import { readActivity, readCatalog, readState, writeState } from '../repository.mjs';
import { methodNotAllowed } from '../middleware/errors.mjs';
import { jsonBody } from '../middleware/json.mjs';

export function practiceRoutes(pool) {
  const router = Router({ caseSensitive: true, strict: true });

  // Explicit HEAD/all handlers preserve the existing allowed-method contract.
  router
    .route('/api/health')
    .head(methodNotAllowed)
    .get(async (_request, response) => {
      await pool.query('SELECT 1');
      response.json({ ok: true });
    })
    .all(methodNotAllowed);

  router
    .route('/api/catalog')
    .head(methodNotAllowed)
    .get(async (_request, response) => response.json(await readCatalog(pool)))
    .all(methodNotAllowed);

  router
    .route('/api/state')
    .head(methodNotAllowed)
    .get(async (_request, response) => response.json(await readState(pool)))
    .put(jsonBody, async (request, response) => response.json(await writeState(pool, request.body)))
    .all(methodNotAllowed);

  router
    .route('/api/activity')
    .head(methodNotAllowed)
    .get(async (request, response) => {
      const timeZone = request.practiceUrl.searchParams.get('timeZone') ?? 'UTC';
      response.json(await readActivity(pool, timeZone));
    })
    .all(methodNotAllowed);

  return router;
}
