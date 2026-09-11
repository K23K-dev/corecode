import { Router } from 'express';
import {
  readActivity,
  readCatalog,
  readState,
  repairActivity,
  writeState,
} from '../repository.mjs';
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
    .get(async (_request, response) => response.json(await readActivity(pool)))
    .all(methodNotAllowed);

  router
    .route('/api/activity/repairs')
    .head(methodNotAllowed)
    .post(jsonBody, async (request, response) =>
      response.json(await repairActivity(pool, request.body)),
    )
    .all(methodNotAllowed);

  return router;
}
