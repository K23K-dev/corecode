import {
  readActivity,
  readCatalog,
  readPreviewProblem,
  readState,
  repairActivity,
  writeState,
} from './repository.ts';
import { errorResponse, jsonBody, jsonResponse, protectRequest } from './http.ts';
import { identifier, plainObject, RequestError } from './validation.ts';
import { createPreviewDocument } from './frontend-preview.ts';
import type { Pool } from 'pg';
import type { JudgeAdapter, JudgeClientResolver } from './judge/adapter.ts';

const METHODS: Record<string, string[]> = {
  '/api/health': ['GET'],
  '/api/catalog': ['GET'],
  '/api/preview': ['GET'],
  '/api/state': ['GET', 'PUT'],
  '/api/activity': ['GET'],
  '/api/activity/repairs': ['POST'],
  '/api/run': ['POST'],
  '/api/jobs': ['GET'],
};

function jobID(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
    throw new RequestError('Provide a UUID submission ID.');
  }
  return value.toLowerCase();
}

function executionRequest(value: unknown) {
  const body = plainObject(value, 'Execution request');
  const submit = body.mode === 'submit';
  const allowed = [
    'problemId',
    'problemVersion',
    'code',
    'mode',
    ...(submit ? ['submissionId', 'completionIntentIds'] : []),
  ];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    (body.mode !== 'example' && body.mode !== 'submit')
  ) {
    throw new RequestError('Invalid execution request.');
  }
  const problemId = identifier(body.problemId, 'Problem ID');
  if (typeof body.problemVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.problemVersion)) {
    throw new RequestError('Provide the current problem version.');
  }
  if (
    typeof body.code !== 'string' ||
    body.code.length > 32768 ||
    Buffer.byteLength(body.code) > 51200 ||
    body.code.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(body.code)
  ) {
    throw new RequestError('Keep code under 32,768 characters and 50 KiB of valid text.');
  }
  const input = { problemId, problemVersion: body.problemVersion, code: body.code };
  if (submit) {
    if (!body.submissionId)
      throw new RequestError('Refresh the website before submitting.', 409, 'refresh_required');
    const submissionId = jobID(body.submissionId);
    if (!Array.isArray(body.completionIntentIds) || body.completionIntentIds.length > 256) {
      throw new RequestError('Provide at most 256 completion intent IDs.');
    }
    const completionIntentIds = body.completionIntentIds.map((id: unknown) =>
      identifier(id, 'Completion intent ID'),
    );
    return { ...input, mode: 'submit' as const, submissionId, completionIntentIds };
  }
  return { ...input, mode: 'example' as const };
}

function jobList(params: URLSearchParams) {
  if (
    [...params.keys()].some(
      (key) =>
        !['problemId', 'pageSize', 'pageToken'].includes(key) || params.getAll(key).length !== 1,
    )
  ) {
    throw new RequestError('Invalid submission list parameters.');
  }
  const problemId = params.get('problemId') ?? '';
  if (problemId) identifier(problemId, 'Problem ID');
  const size = params.get('pageSize') ?? '20';
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 50) {
    throw new RequestError('Page size must be between 1 and 50.');
  }
  const pageToken = params.get('pageToken') ?? '';
  if (pageToken.length > 4096) throw new RequestError('Invalid page token.');
  return { problemId, pageSize: Number(size), pageToken };
}

type AppOptions = {
  appOrigin?: string;
  hosted?: boolean;
  judge?: JudgeAdapter;
  judgeAddress?: string;
  judgeToken?: string;
  resolveJudgeClient?: JudgeClientResolver;
} & (
  | { pool: Pool; getPool?: () => Pool | Promise<Pool> }
  | { pool?: never; getPool: () => Pool | Promise<Pool> }
);

/** The same Web Request handler runs in Next.js and in offline contract tests. */
export function createApp({
  pool,
  getPool = async () => pool!,
  appOrigin = 'http://127.0.0.1:5173',
  hosted = false,
  judge,
  judgeAddress,
  judgeToken,
  resolveJudgeClient,
}: AppOptions) {
  const protect = protectRequest(appOrigin, hosted);
  let transport: Promise<JudgeAdapter> | undefined;
  const getJudge = () => {
    transport ??= judge
      ? Promise.resolve(judge)
      : import('./judge/adapter.ts').then(({ createJudgeAdapter }) =>
          createJudgeAdapter({
            address: judgeAddress,
            token: judgeToken,
            hosted,
            resolveClient: resolveJudgeClient,
          }),
        );
    return transport;
  };
  return async (request: Request) => {
    try {
      protect(request);
      const url = new URL(request.url);
      const path = url.pathname;
      const jobRoute = /^\/api\/jobs\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
      const methods = jobRoute ? [jobRoute[2] === 'cancel' ? 'POST' : 'GET'] : METHODS[path];
      if (!methods) throw new RequestError('Endpoint not found.', 404, 'not_found');
      if (!methods.includes(request.method)) {
        throw new RequestError('Method not allowed.', 405, 'method_not_allowed');
      }
      const body = request.method === 'GET' ? undefined : await jsonBody(request);
      request.signal.throwIfAborted();
      const database = await getPool();
      request.signal.throwIfAborted();
      if (jobRoute) {
        const id = jobID(jobRoute[1]);
        const service = await getJudge();
        request.signal.throwIfAborted();
        if (jobRoute[2] === 'cancel') {
          if (Object.keys(plainObject(body, 'Cancellation request')).length)
            throw new RequestError('Cancellation requires an empty JSON object.');
          return jsonResponse(await service.cancelJob(id));
        }
        if (jobRoute[2] === 'events') {
          return new Response(service.watchJob(id, { signal: request.signal }), {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              'X-Content-Type-Options': 'nosniff',
              'X-Accel-Buffering': 'no',
            },
          });
        }
        return jsonResponse(await service.getJob(id, { signal: request.signal }));
      }
      let result;
      switch (path) {
        case '/api/health':
          await database.query('SELECT 1');
          result = { ok: true, executionMode: 'durable' };
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
          const input = executionRequest(body);
          const service = await getJudge();
          request.signal.throwIfAborted();
          return input.mode === 'submit'
            ? jsonResponse(await service.submit(input), 202)
            : jsonResponse(await service.run(input, { signal: request.signal }));
        }
        case '/api/jobs': {
          const params = jobList(url.searchParams);
          const service = await getJudge();
          result = await service.listJobs(params, { signal: request.signal });
          break;
        }
      }
      return jsonResponse(result);
    } catch (error) {
      if (request.signal.aborted)
        return errorResponse(new RequestError('The request was canceled.', 499, 'canceled'));
      return errorResponse(error, request.method === 'HEAD');
    }
  };
}
