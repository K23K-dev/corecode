import { Router } from 'express';
import { executeProblem } from '../../runner/execution.mjs';
import {
  readActivity,
  readCatalog,
  readExecutionProblem,
  readState,
  repairActivity,
  writeState,
} from '../repository.mjs';
import { methodNotAllowed } from '../middleware/errors.mjs';
import { jsonBody } from '../middleware/json.mjs';

export function practiceRoutes(pool, executeCode = executeProblem) {
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
    .post(jsonBody, async (request, response) =>
      response.json(await repairActivity(pool, request.body)),
    )
    .all(methodNotAllowed);

  router
    .route('/api/run')
    .post(jsonBody, async (request, response) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once('close', cancel);
      try {
        if (response.destroyed) return;
        const problem = await readExecutionProblem(pool, request.body?.problemId);
        if (controller.signal.aborted || response.destroyed) return;
        const result = await executeCode(request.body, problem, { signal: controller.signal });
        if (!response.destroyed && !response.writableEnded) response.json(result);
      } finally {
        response.off('close', cancel);
      }
    })
    .all(methodNotAllowed);

  return router;
}
