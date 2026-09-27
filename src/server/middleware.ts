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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkedOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.origin !== value) {
    throw new Error('The browser origin must be an exact loopback HTTP origin.');
  }
  return url;
}

export function checkedHostedOrigin(value: string | undefined): URL {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error('The production browser origin must be an exact public HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local)$/.test(url.hostname)
  ) {
    throw new Error('The production browser origin must be an exact public HTTPS origin.');
  }
  return url;
}

/** Host/CSRF checks, not authentication. Hosted access is gated by Vercel upstream. */
export function protectRequest(appOrigin: string, hosted = false): (request: Request) => void {
  const browser = hosted ? checkedHostedOrigin(appOrigin) : checkedOrigin(appOrigin);
  const authorities = hosted
    ? new Set([browser.host])
    : new Set(
        [...LOOPBACK_HOSTS].map((host) => `${host}${browser.port ? `:${browser.port}` : ''}`),
      );
  return (request) => {
    // Never trust forwarding headers. Next's local CLI must also bind to loopback:
    // Web Requests intentionally do not expose the underlying TCP peer address.
    if (!authorities.has(request.headers.get('host') ?? '')) {
      throw new RequestError(
        hosted
          ? 'Use the configured production application.'
          : 'This endpoint is available only through the local application.',
        403,
        'forbidden',
      );
    }
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (
      (origin !== null && origin !== appOrigin) ||
      site === 'cross-site' ||
      (hosted && site === 'same-site')
    ) {
      throw new RequestError('This browser origin is not allowed.', 403, 'forbidden');
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      if (origin !== appOrigin || request.headers.get('x-code-practice-client') !== '1') {
        throw new RequestError('Use the application to save progress.', 403, 'forbidden');
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get('content-type') ?? '',
        )
      ) {
        throw new RequestError(
          'Save requests must use application/json.',
          415,
          'unsupported_media_type',
        );
      }
    }
  };
}

/** Parse a JSON request body of at most 10 MiB. */
export async function jsonBody(request: Request): Promise<unknown> {
  const tooLarge = new RequestError(
    'Save request exceeds the 10 MiB limit.',
    413,
    'payload_too_large',
  );
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw tooLarge;
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new RequestError('Save request was interrupted.');
  }
  if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError('Save request contains invalid JSON.');
  }
}

export function jsonResponse(value: unknown, status = 200, head = false): Response {
  return new Response(head ? null : JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function errorResponse(error: unknown, head = false): Response {
  if (error instanceof ZodError)
    return jsonResponse(
      { error: error.issues[0]?.message ?? 'Invalid request.', code: 'invalid_request' },
      400,
      head,
    );
  if (error instanceof RequestError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status, head);
  }
  return jsonResponse(
    {
      error:
        'Database storage is temporarily unavailable. Your browser draft has not been replaced.',
      code: 'storage_unavailable',
    },
    503,
    head,
  );
}
