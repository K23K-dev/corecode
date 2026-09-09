import { StateConflict } from '../repository.mjs';
import { RequestError } from '../validation.mjs';

function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  return response.status(status).json(value);
}

export function notFound(request, response) {
  return send(response, 404, { error: 'Endpoint not found.', code: 'not_found' });
}

export function methodNotAllowed(request, response) {
  return send(response, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
}

export function errorHandler(error, request, response, next) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) return next(error);

  if (error instanceof StateConflict) {
    return send(response, 409, { ...error.state, error: error.message, code: error.code });
  }
  if (error instanceof RequestError) {
    return send(response, error.status, { error: error.message, code: error.code });
  }

  // Parser messages may contain submitted code. Return only fixed, safe descriptions.
  switch (error?.type) {
    case 'entity.too.large':
      return send(response, 413, {
        error: 'Save request exceeds the 10 MiB limit.',
        code: 'payload_too_large',
      });
    case 'entity.parse.failed':
    case 'entity.verify.failed':
    case 'request.size.invalid':
      return send(response, 400, {
        error: 'Save request contains invalid JSON.',
        code: 'invalid_request',
      });
    case 'request.aborted':
      return send(response, 400, {
        error: 'Save request was interrupted.',
        code: 'invalid_request',
      });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return send(response, 415, {
        error: 'Save requests must use uncompressed UTF-8 application/json.',
        code: 'unsupported_media_type',
      });
    default:
      return send(response, 503, {
        error:
          'Database storage is temporarily unavailable. Your browser draft has not been replaced.',
        code: 'storage_unavailable',
      });
  }
}
