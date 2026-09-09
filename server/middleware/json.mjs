import express from 'express';
import { MAX_BODY_BYTES, RequestError } from '../validation.mjs';

const parseJson = express.json({
  limit: MAX_BODY_BYTES,
  inflate: false,
  strict: false,
  // Content type and charset have already passed protectRequest.
  type: () => true,
  verify(_request, _response, buffer) {
    try {
      if (!buffer.length) throw new Error('Empty body');
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new RequestError('Save request contains invalid JSON.');
    }
  },
});

// A zero-length request may bypass Express's parser entirely.
export const jsonBody = [
  (request, _response, next) => {
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      request.resume();
      throw new RequestError('Save request exceeds the 10 MiB limit.', 413, 'payload_too_large');
    }
    next();
  },
  parseJson,
  (request, _response, next) => {
    if (request.body === undefined) throw new RequestError('Save request contains invalid JSON.');
    next();
  },
];
