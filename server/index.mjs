import { attachDatabasePool } from '@vercel/functions';
import { createApp } from './app.mjs';
import { getDatabaseConnection } from './database-config.mjs';
import { checkedHostedOrigin, errorResponse, jsonResponse } from './http.mjs';
import { initializeDatabase, makePool } from './repository.mjs';
import { readExecutionConfiguration } from './judge/config.mjs';

/** No connection is opened until the deployment's private configuration is checked. */
export function readVercelConfiguration(environment = process.env) {
  if (environment.VERCEL !== '1' || environment.VERCEL_ENV !== 'production') {
    throw new Error('The personal data API is enabled only for Vercel production.');
  }
  // Operator acknowledgement, NOT authentication: Vercel must protect All Deployments.
  if (environment.VERCEL_AUTHENTICATION_CONFIRMED !== '1') {
    throw new Error('Enable Vercel Authentication for All Deployments before enabling the API.');
  }
  const appOrigin =
    environment.APP_ORIGIN ??
    (environment.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);
  checkedHostedOrigin(appOrigin);
  return { appOrigin, ...getDatabaseConnection(environment) };
}

/** Lazy and shared per warm function; building Next never connects or seeds content. */
export function createApiHandler({ environment = process.env, judge, keepAlive } = {}) {
  let app;
  return async (request) => {
    if (!app) {
      const hosted = environment.VERCEL === '1';
      try {
        const configuration = hosted
          ? readVercelConfiguration(environment)
          : {
              appOrigin: 'http://127.0.0.1:5173',
              ...getDatabaseConnection(environment),
            };
        const execution = judge ? undefined : readExecutionConfiguration(environment, hosted);
        let resolveJudgeClient;
        if (execution?.name) {
          const { createSandboxJudgeResolver, sandboxCredentials } =
            await import('./judge/sandbox.mjs');
          resolveJudgeClient = createSandboxJudgeResolver({
            name: execution.name,
            token: execution.token,
            databaseURL: configuration.connectionString,
            credentials: sandboxCredentials(environment),
            keepAlive,
          });
        }
        let ready;
        app = createApp({
          appOrigin: configuration.appOrigin,
          hosted,
          judge,
          judgeAddress: execution?.address,
          judgeToken: execution?.token,
          resolveJudgeClient,
          getPool: () => {
            ready ??= (async () => {
              // Local schema-only setup replaces the former custom dev launcher.
              // Hosted requests never initialize schema or rewrite catalog/history.
              if (!hosted) await initializeDatabase(configuration.connectionString);
              const pool = makePool(configuration.connectionString);
              if (hosted) attachDatabasePool(pool);
              return pool;
            })().catch((error) => {
              ready = undefined;
              throw error;
            });
            return ready;
          },
        });
      } catch (error) {
        if (!hosted) return errorResponse(error, request.method === 'HEAD');
        return jsonResponse(
          {
            error:
              'Production setup is incomplete. Check deployment protection, database, application origin, and judge configuration.',
            code: 'deployment_not_configured',
          },
          503,
          request.method === 'HEAD',
        );
      }
    }
    return app(request);
  };
}
