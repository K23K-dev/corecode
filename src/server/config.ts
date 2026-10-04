import { attachDatabasePool } from '@vercel/functions';
import { Pool } from 'pg';
import { createJudge } from './judge-client/client';
import { protectRequest } from './middleware';

type Environment = Record<string, string | undefined>;

function readAppOrigin(environment: Environment, hosted: boolean) {
  if (!hosted) return 'http://127.0.0.1:5173';
  if (environment.VERCEL_ENV !== 'production') {
    throw new Error('The personal data API is enabled only for Vercel production.');
  }
  // Operator acknowledgement, NOT authentication: Vercel must protect All Deployments.
  if (environment.VERCEL_AUTHENTICATION_CONFIRMED !== '1') {
    throw new Error('Enable Vercel Authentication for All Deployments before enabling the API.');
  }
  const production = environment.VERCEL_PROJECT_PRODUCTION_URL;
  const origin = environment.APP_ORIGIN ?? (production && `https://${production}`);
  if (!origin?.startsWith('https://')) {
    throw new Error('Set APP_ORIGIN to the production https:// address.');
  }
  return new URL(origin).origin;
}

// The Neon connection string. Errors never echo it, since it contains the password.
function readDatabaseURL(value: string) {
  if (!value) throw new Error('POSTGRES_URL is required. Add your Neon connection string to .env.');
  try {
    const url = new URL(value);
    // Without an explicit port, pg would use this machine's PGPORT.
    url.port ||= '5432';
    return url;
  } catch {
    throw new Error('POSTGRES_URL must be a valid PostgreSQL connection string.');
  }
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

// Both websites use the same judge, on its VM, with a token it checks on every call.
function readJudge(environment: Environment) {
  const token = environment.JUDGE_TOKEN ?? '';
  if (token.length < 32) throw new Error('JUDGE_TOKEN must be at least 32 characters.');
  const address = environment.JUDGE_URL?.trim();
  if (!address) throw new Error('JUDGE_URL is required, for example https://judge.example.com.');
  return createJudge(address, token);
}

// Reads private configuration once per warm function; connections open on first use.
export function loadConfig(environment: Environment) {
  const hosted = environment.VERCEL === '1';
  const appOrigin = readAppOrigin(environment, hosted);
  const poolURL = readDatabaseURL(environment.POSTGRES_URL?.trim() ?? '');
  const judge = readJudge(environment);
  let pool: Pool | undefined;
  return {
    protect: protectRequest(appOrigin, hosted),
    database: () => (pool ??= openPool(poolURL, hosted)),
    judge,
  };
}

// What the router hands every controller: the configured services and the parsed JSON body.
export type ApiEnv = { Variables: { services: ReturnType<typeof loadConfig>; body: unknown } };
