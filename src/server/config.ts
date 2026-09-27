import { attachDatabasePool } from '@vercel/functions';
import { Pool } from 'pg';
import { createJudge, type JudgeClientResolver } from './judge-client/client';
import { createSandboxJudgeResolver } from './judge-client/sandbox';
import { checkedHostedOrigin, protectRequest } from './middleware';

type Environment = Record<string, string | undefined>;
type KeepAlive = (task: Promise<unknown>) => void;

/** Local development is loopback-only; hosted access relies on Vercel protection. */
function readAppOrigin(environment: Environment, hosted: boolean) {
  if (!hosted) return 'http://127.0.0.1:5173';
  if (environment.VERCEL_ENV !== 'production') {
    throw new Error('The personal data API is enabled only for Vercel production.');
  }
  // Operator acknowledgement, NOT authentication: Vercel must protect All Deployments.
  if (environment.VERCEL_AUTHENTICATION_CONFIRMED !== '1') {
    throw new Error('Enable Vercel Authentication for All Deployments before enabling the API.');
  }
  const origin =
    environment.APP_ORIGIN ??
    (environment.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);
  return checkedHostedOrigin(origin).origin;
}

/** Require a PostgreSQL URL with SSL. Errors never echo the credentials. */
function readDatabaseURL(value: string) {
  if (!value) throw new Error('POSTGRES_URL is required. Add your Neon connection string to .env.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('POSTGRES_URL must be a valid PostgreSQL connection string.');
  }
  if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? ''))
    throw new Error('POSTGRES_URL must enable SSL, for example with sslmode=require.');
  // Without an explicit port, pg would use this machine's PGPORT.
  url.port ||= '5432';
  return url;
}

function openPool(url: URL, hosted: boolean) {
  const pool = new Pool({
    connectionString: url.href,
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: 'code-practice',
  });
  // Idle client failures must not become uncaught EventEmitter exceptions.
  pool.on('error', () => {});
  if (hosted) attachDatabasePool(pool);
  return pool;
}

/** Explicit Vercel credentials, or project-scoped OIDC on Vercel and in linked development. */
function readSandboxCredentials(environment: Environment) {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = environment;
  if (!token) return {};
  if (!teamId || !projectId) {
    throw new Error('Provide VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together.');
  }
  return { token, teamId, projectId };
}

/** Both websites use the same Sandbox judge. */
function readJudge(
  environment: Environment,
  databaseURL: string,
  keepAlive: KeepAlive,
): JudgeClientResolver {
  const token = environment.JUDGE_TOKEN;
  if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) {
    throw new Error('JUDGE_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  }
  const name = environment.JUDGE_SANDBOX_NAME?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('JUDGE_SANDBOX_NAME must be a lowercase sandbox name.');
  }
  const credentials = readSandboxCredentials(environment);
  return createSandboxJudgeResolver({ name, token, databaseURL, credentials, keepAlive });
}

/** Reads private configuration once per warm function; connections open on first use. */
export function loadConfig(environment: Environment, keepAlive: KeepAlive) {
  const hosted = environment.VERCEL === '1';
  const appOrigin = readAppOrigin(environment, hosted);
  const databaseURL = environment.POSTGRES_URL?.trim() ?? '';
  const poolURL = readDatabaseURL(databaseURL);
  const judge = createJudge(readJudge(environment, databaseURL, keepAlive));
  let pool: Pool | undefined;
  return {
    protect: protectRequest(appOrigin, hosted),
    database: () => (pool ??= openPool(poolURL, hosted)),
    judge,
  };
}

/** What the router hands every controller: the configured services and the parsed JSON body. */
export type ApiEnv = { Variables: { services: ReturnType<typeof loadConfig>; body: unknown } };
