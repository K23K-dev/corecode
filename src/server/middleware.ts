import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { MAX_PROGRESS_BYTES as MAX_BODY_BYTES } from '../schemas/progress';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'invalid_request',
  ) {
    super(message);
  }
}

/** Host and CSRF checks, not authentication: Vercel Authentication gates the hosted site. */
export function protectRequest(appOrigin: string, hosted: boolean): (request: Request) => void {
  const { host, port } = new URL(appOrigin);
  const hosts = hosted
    ? [host]
    : ['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${port}`);
  return (request) => {
    // Only the app's own host name, which also stops DNS rebinding. Forwarding headers are ignored.
    if (!hosts.includes(request.headers.get('host') ?? '')) {
      throw new RequestError(
        hosted
          ? 'Use the configured production application.'
          : 'This endpoint is available only through the local application.',
        403,
        'forbidden',
      );
    }
    // Refuse other sites' requests, even reads: GET /api/jobs/:id would still reach the judge.
    const origin = request.headers.get('origin');
    if (
      (origin !== null && origin !== appOrigin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    ) {
      throw new RequestError('This browser origin is not allowed.', 403, 'forbidden');
    }
    // A custom header makes any other origin send a CORS preflight, which this API never approves.
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.headers.get('x-code-practice-client') !== '1'
    ) {
      throw new RequestError('Use the application to save progress.', 403, 'forbidden');
    }
  };
}

/** A write's JSON body of at most 10 MiB, checked before reading and again after. */
export async function jsonBody(c: Context): Promise<unknown> {
  const tooLarge = new RequestError(
    'Save request exceeds the 10 MiB limit.',
    413,
    'payload_too_large',
  );
  if (Number(c.req.header('content-length')) > MAX_BODY_BYTES) throw tooLarge;
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError('Save request contains invalid JSON.');
  }
}

/** Every API error has the same shape: { error, code }. */
export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ZodError)
    return c.json(
      { error: error.issues[0]?.message ?? 'Invalid request.', code: 'invalid_request' },
      400,
    );
  if (error instanceof RequestError)
    return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
  return c.json(
    {
      error: 'The database is temporarily unavailable.',
      code: 'storage_unavailable',
    },
    503,
  );
}
