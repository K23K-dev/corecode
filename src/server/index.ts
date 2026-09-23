import { attachDatabasePool } from '@vercel/functions';
import { createApp } from './app.ts';
import { getDatabaseConnection } from './database-config.ts';
import { checkedHostedOrigin, errorResponse, jsonResponse } from './http.ts';
import { makePool } from './repository.ts';
import { readExecutionConfiguration } from './judge/config.ts';
import type { Pool } from 'pg';
import type { JudgeAdapter, JudgeClientResolver } from './judge/adapter.ts';

/** No connection is opened until the deployment's private configuration is checked. */
export function readVercelConfiguration(
  environment: Record<string, string | undefined> = process.env,
) {
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
  const origin = checkedHostedOrigin(appOrigin);
  return { appOrigin: origin.origin, ...getDatabaseConnection(environment) };
}

/** Lazy and shared per warm function; the existing database is never initialized here. */
export function createApiHandler({
  environment = process.env,
  judge,
  keepAlive,
}: {
  environment?: Record<string, string | undefined>;
  judge?: JudgeAdapter;
  keepAlive?: (task: Promise<unknown>) => void;
} = {}) {
  const hosted = environment.VERCEL === '1';
  let app: Promise<ReturnType<typeof createApp>> | undefined;
  async function initialize() {
    const configuration = hosted
      ? readVercelConfiguration(environment)
      : { appOrigin: 'http://127.0.0.1:5173', ...getDatabaseConnection(environment) };
    const execution = judge ? undefined : readExecutionConfiguration(environment, hosted);
    let resolveJudgeClient: JudgeClientResolver | undefined;
    if (execution && 'name' in execution) {
      const { createSandboxJudgeResolver, sandboxCredentials } = await import('./judge/sandbox.ts');
      resolveJudgeClient = createSandboxJudgeResolver({
        name: execution.name,
        token: execution.token,
        databaseURL: configuration.connectionString,
        credentials: sandboxCredentials(environment),
        keepAlive,
      });
    }
    let pool: Pool | undefined;
    return createApp({
      appOrigin: configuration.appOrigin,
      hosted,
      judge,
      judgeAddress: execution && 'address' in execution ? execution.address : undefined,
      judgeToken: execution?.token,
      resolveJudgeClient,
      getPool: () => {
        if (!pool) {
          const connection = makePool(configuration.connectionString);
          if (hosted) attachDatabasePool(connection);
          pool = connection;
        }
        return pool;
      },
    });
  }
  return async (request: Request) => {
    let handle;
    try {
      app ??= initialize().catch((error) => {
        app = undefined;
        throw error;
      });
      handle = await app;
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
    return handle(request);
  };
}
