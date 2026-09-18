import {
  readActivity,
  readCatalog,
  readExecutionProblem,
  readPreviewProblem,
  readState,
  repairActivity,
  writeState,
} from './repository.mjs';
import { errorResponse, jsonBody, jsonResponse, protectRequest } from './http.mjs';
import { RequestError } from './validation.mjs';
import { createPreviewDocument } from './frontend-preview.mjs';

const METHODS = {
  '/api/health': ['GET'],
  '/api/catalog': ['GET'],
  '/api/preview': ['GET'],
  '/api/state': ['GET', 'PUT'],
  '/api/activity': ['GET'],
  '/api/activity/repairs': ['POST'],
  '/api/run': ['POST'],
};

/** The same Web Request handler runs in Next.js and in offline contract tests. */
export function createApp({
  pool,
  getPool = async () => pool,
  appOrigin = 'http://127.0.0.1:5173',
  hosted = false,
  executeCode = async (...args) => {
    const { executeProblem } = await import('../runner/execution.mjs');
    return executeProblem(...args);
  },
}) {
  const protect = protectRequest(appOrigin, hosted);
  return async (request) => {
    try {
      protect(request);
      const path = new URL(request.url).pathname;
      const methods = METHODS[path];
      if (!methods) throw new RequestError('Endpoint not found.', 404, 'not_found');
      if (!methods.includes(request.method)) {
        throw new RequestError('Method not allowed.', 405, 'method_not_allowed');
      }
      const body = request.method === 'GET' ? undefined : await jsonBody(request);
      request.signal.throwIfAborted();
      const database = await getPool();
      request.signal.throwIfAborted();
      let result;
      switch (path) {
        case '/api/health':
          await database.query('SELECT 1');
          result = { ok: true };
          break;
        case '/api/catalog':
          result = await readCatalog(database);
          break;
        case '/api/preview': {
          const params = new URL(request.url).searchParams;
          const problem = await readPreviewProblem(
            database,
            params.get('problemId'),
            params.get('problemVersion'),
          );
          request.signal.throwIfAborted();
          result = { document: await createPreviewDocument(problem) };
          break;
        }
        case '/api/state':
          result =
            request.method === 'GET' ? await readState(database) : await writeState(database, body);
          break;
        case '/api/activity':
          result = await readActivity(database);
          break;
        case '/api/activity/repairs':
          result = await repairActivity(database, body);
          break;
        case '/api/run': {
          const problem = await readExecutionProblem(database, body?.problemId);
          // Next aborts the request signal when its client disconnects. A pending
          // database read must not start a runner after the user has pressed Stop.
          request.signal.throwIfAborted();
          result = await executeCode(body, problem, { signal: request.signal });
          break;
        }
      }
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error, request.method === 'HEAD');
    }
  };
}
