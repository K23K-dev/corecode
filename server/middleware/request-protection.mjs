import { RequestError } from '../validation.mjs';
import { isIP } from 'node:net';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

function protectBrowserRequest(request, appOrigin, hosted = false) {
  const origin = request.headers.origin;
  if (
    (origin !== undefined && origin !== appOrigin) ||
    request.headers['sec-fetch-site'] === 'cross-site' ||
    (hosted && request.headers['sec-fetch-site'] === 'same-site')
  ) {
    throw new RequestError('This browser origin is not allowed.', 403, 'forbidden');
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    if (origin !== appOrigin || request.headers['x-code-practice-client'] !== '1') {
      throw new RequestError(
        hosted
          ? 'Use the application to save progress.'
          : 'Use the local application to save progress.',
        403,
        'forbidden',
      );
    }
    if (
      typeof request.headers['content-type'] !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])
    ) {
      throw new RequestError(
        'Save requests must use application/json.',
        415,
        'unsupported_media_type',
      );
    }
  }

  if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
    throw new RequestError('Invalid request path.');
  }
  request.practiceUrl = new URL(request.url, appOrigin);
  // Express must route the same normalized path as the original HTTP handler.
  request.url = request.practiceUrl.pathname + request.practiceUrl.search;
}

/** CSRF/host checks only. Vercel Authentication must protect all deployments upstream. */
export function protectHostedRequest(appOrigin) {
  const browser = checkedHostedOrigin(appOrigin);
  return (request, _response, next) => {
    try {
      // Never derive trusted origins from Host, forwarded headers, or client auth headers.
      if (request.headers.host !== browser.host) {
        throw new RequestError('Use the configured production application.', 403, 'forbidden');
      }
      protectBrowserRequest(request, appOrigin, true);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function protectRequest(appOrigin) {
  const browser = checkedOrigin(appOrigin);
  return (request, response, next) => {
    try {
      const port = request.socket.localPort;
      const authorities = new Set([
        browser.host,
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
      ]);
      if (
        !LOOPBACK_PEERS.has(request.socket.remoteAddress) ||
        typeof request.headers.host !== 'string' ||
        !authorities.has(request.headers.host)
      ) {
        throw new RequestError(
          'This endpoint is available only through the local application.',
          403,
          'forbidden',
        );
      }

      protectBrowserRequest(request, appOrigin);
      next();
    } catch (error) {
      next(error);
    }
  };
}
