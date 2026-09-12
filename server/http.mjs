import { isIP } from 'node:net';
import { StateConflict } from './repository.mjs';
import { MAX_BODY_BYTES, RequestError } from './validation.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function checkedOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error('The browser origin must be an exact loopback HTTP origin.');
  }
  return url;
}

export function checkedHostedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The production browser origin must be an exact public HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local)$/.test(url.hostname)
  ) {
    throw new Error('The production browser origin must be an exact public HTTPS origin.');
  }
  return url;
}

/** Host/CSRF checks, not authentication. Hosted access is gated by Vercel upstream. */
export function protectRequest(appOrigin, hosted = false) {
  const browser = hosted ? checkedHostedOrigin(appOrigin) : checkedOrigin(appOrigin);
  const authorities = hosted
    ? new Set([browser.host])
    : new Set(
        [...LOOPBACK_HOSTS].map((host) => `${host}${browser.port ? `:${browser.port}` : ''}`),
      );
  return (request) => {
    // Never trust forwarding headers. Next's local CLI must also bind to loopback:
    // Web Requests intentionally do not expose the underlying TCP peer address.
    if (!authorities.has(request.headers.get('host'))) {
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

/** Read bounded raw bytes, rejecting compression and invalid UTF-8 before JSON parsing. */
export async function jsonBody(request) {
  const tooLarge = () =>
    new RequestError('Save request exceeds the 10 MiB limit.', 413, 'payload_too_large');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw tooLarge();
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new RequestError(
      'Save requests must use uncompressed UTF-8 application/json.',
      415,
      'unsupported_media_type',
    );
  }
  if (!request.body) throw new RequestError('Save request contains invalid JSON.');

  const reader = request.body.getReader();
  const timeout = AbortSignal.timeout(20_000);
  const signal = AbortSignal.any([request.signal, timeout]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (length !== null && size !== Number(length)) throw new Error('Length mismatch');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      signal.aborted ? 'Save request was interrupted.' : 'Save request contains invalid JSON.',
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function jsonResponse(value, status = 200, head = false) {
  return new Response(head ? null : JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function errorResponse(error, head = false) {
  if (error instanceof StateConflict) {
    return jsonResponse({ ...error.state, error: error.message, code: error.code }, 409, head);
  }
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
