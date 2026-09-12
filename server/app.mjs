import express from 'express';
import { protectHostedRequest, protectRequest } from './middleware/request-protection.mjs';
import { errorHandler, notFound } from './middleware/errors.mjs';
import { practiceRoutes } from './routes/practice.mjs';

/** HTTP composition only: database ownership and listening belong to index.mjs. */
export function createApp({
  pool,
  appOrigin = 'http://127.0.0.1:5173',
  hosted = false,
  executeCode,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.disable('trust proxy');
  app.disable('query parser');
  app.enable('case sensitive routing');
  app.enable('strict routing');

  app.use((request, response, next) => {
    // This no-store interface always returns current JSON, never an empty 304.
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.use(hosted ? protectHostedRequest(appOrigin) : protectRequest(appOrigin));
  app.use(practiceRoutes(pool, executeCode));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
