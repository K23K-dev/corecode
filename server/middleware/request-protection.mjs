import { RequestError } from '../validation.mjs';

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

      const origin = request.headers.origin;
      if (
        (origin !== undefined && origin !== appOrigin) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        throw new RequestError('This browser origin is not allowed.', 403, 'forbidden');
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        if (origin !== appOrigin || request.headers['x-code-practice-client'] !== '1') {
          throw new RequestError('Use the local application to save progress.', 403, 'forbidden');
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
      next();
    } catch (error) {
      next(error);
    }
  };
}
