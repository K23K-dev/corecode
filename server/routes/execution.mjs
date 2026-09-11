import { Router } from 'express';
import { executeProblem } from '../../runner/execution.mjs';
import { readExecutionProblem } from '../repository.mjs';
import { methodNotAllowed } from '../middleware/errors.mjs';
import { jsonBody } from '../middleware/json.mjs';

export function executionRoutes(pool, executeCode = executeProblem) {
  const router = Router({ caseSensitive: true, strict: true });
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
