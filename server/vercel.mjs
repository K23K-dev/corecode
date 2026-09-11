import { attachDatabasePool } from '@vercel/functions';
import express from 'express';
import { createApp } from './app.mjs';
import { validateNeonConnectionString } from './database-config.mjs';
import { checkedHostedOrigin } from './middleware/request-protection.mjs';
import { makePool } from './repository.mjs';

/** No connection is opened until the deployment's private configuration is checked. */
export function readVercelConfiguration(environment = process.env) {
  if (environment.VERCEL !== '1' || environment.VERCEL_ENV !== 'production') {
    throw new Error('The personal data API is enabled only for Vercel production.');
  }
  // This is an operator acknowledgement, NOT authentication. The Vercel access
  // gate must be enabled for All Deployments before this switch is set to 1.
  if (environment.VERCEL_AUTHENTICATION_CONFIRMED !== '1') {
    throw new Error('Enable Vercel Authentication for All Deployments before enabling the API.');
  }
  const appOrigin =
    environment.APP_ORIGIN ??
    (environment.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);
  checkedHostedOrigin(appOrigin);
  validateNeonConnectionString(environment.POSTGRES_URL);
  return { appOrigin, connectionString: environment.POSTGRES_URL.trim() };
}

/** Reuse one pool/app per warm function. Never initialize or seed the database here. */
export function createVercelHandler({
  environment = process.env,
  createPool = makePool,
  attachPool = attachDatabasePool,
  executeCode,
} = {}) {
  let app;
  // Export an actual Express app. Vercel then leaves the request body and response
  // helpers alone, preserving our strict JSON parser and uncached error contract.
  const handler = express();
  handler.disable('x-powered-by');
  handler.disable('etag');
  handler.use((request, response, next) => {
    if (!app) {
      try {
        const { appOrigin, connectionString } = readVercelConfiguration(environment);
        const pool = createPool(connectionString);
        attachPool(pool);
        app = createApp({ pool, appOrigin, hosted: true, executeCode });
      } catch {
        // Avoid Vercel's HTML exception page and never disclose secrets/errors.
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(
          JSON.stringify({
            error:
              'Production setup is incomplete. Check deployment protection, POSTGRES_URL, and the configured application origin.',
            code: 'deployment_not_configured',
          }),
        );
        return;
      }
    }
    return app(request, response, next);
  });
  return handler;
}
