import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachPool: vi.fn(),
  createPool: vi.fn(),
  initializeDatabase: vi.fn(),
  readCatalog: vi.fn(),
  readState: vi.fn(),
  readActivity: vi.fn(),
  writeState: vi.fn(),
  readExecutionProblem: vi.fn(),
  localExecute: vi.fn(),
  hostedExecute: vi.fn(),
  after: vi.fn(),
}));

vi.mock('@vercel/functions', () => ({ attachDatabasePool: mocks.attachPool }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      throw new Error('Offline deployment tests must never open a database connection.');
    }
  },
}));
vi.mock('../server/repository.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makePool: mocks.createPool,
  initializeDatabase: mocks.initializeDatabase,
  readCatalog: mocks.readCatalog,
  readState: mocks.readState,
  readActivity: mocks.readActivity,
  writeState: mocks.writeState,
  readExecutionProblem: mocks.readExecutionProblem,
}));
vi.mock('../runner/execution.mjs', () => ({ executeProblem: mocks.localExecute }));
vi.mock('../runner/sandbox.mjs', () => ({ executeSandboxProblem: mocks.hostedExecute }));

const serverModule = '../server/index.mjs';
const { readVercelConfiguration, createApiHandler } = (await import(serverModule)) as {
  readVercelConfiguration(environment: Record<string, string | undefined>): {
    appOrigin: string;
    connectionString: string;
  };
  createApiHandler(options: {
    environment: Record<string, string | undefined>;
    executeCode: typeof mocks.hostedExecute;
  }): (request: Request) => Promise<Response>;
};
const adapterModule = './http-test-server.mjs';
const { requestListener } = (await import(adapterModule)) as {
  requestListener(handle: (request: Request) => Promise<Response>): http.RequestListener;
};
const ORIGIN = 'https://practice.example.com';
// Synthetic fixture only. No real connection or remote call is used in this suite.
const CONNECTION =
  'postgresql://test:test@ep-fixture-pooler.us-east-1.aws.neon.tech/db?sslmode=require';
const ENVIRONMENT = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_AUTHENTICATION_CONFIRMED: '1',
  VERCEL_PROJECT_PRODUCTION_URL: 'practice.example.com',
  POSTGRES_URL: CONNECTION,
};
const CATALOG = { version: 'a'.repeat(64), decks: [], exercises: [] };
const STATE = { revision: 4, progress: { version: 1, exercises: {} }, stars: [] };
const EXECUTION = { id: 'fixture', version: 'b'.repeat(64), gradingSpec: { private: true } };
const pool = { query: vi.fn(), end: vi.fn() };
let servers: Server[];

async function serve(overrides: Record<string, string | undefined> = {}) {
  const handler = createApiHandler({
    environment: { ...ENVIRONMENT, ...overrides },
    executeCode: mocks.hostedExecute,
  });
  const server = http.createServer(requestListener(handler));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function request(
  server: Server,
  method: string,
  path: string,
  body?: string,
  overrides: Record<string, string | undefined> = {},
) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  const headers: Record<string, string> = { Host: 'practice.example.com' };
  if (body !== undefined) {
    Object.assign(headers, {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-Code-Practice-Client': '1',
      'Content-Length': String(Buffer.byteLength(body)),
    });
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown; text: string }>(
    (resolve, reject) => {
      const outgoing = http.request(
        { host: '127.0.0.1', port: address.port, method, path, headers, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body: text ? JSON.parse(text) : undefined,
                text,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('Offline test timed out.')));
      outgoing.on('error', reject);
      outgoing.end(body);
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  servers = [];
  mocks.createPool.mockReturnValue(pool);
  mocks.readCatalog.mockResolvedValue(CATALOG);
  mocks.readState.mockResolvedValue(STATE);
  mocks.readActivity.mockResolvedValue({ timeZone: 'America/New_York', days: [] });
  mocks.writeState.mockResolvedValue({ ...STATE, revision: 5 });
  mocks.readExecutionProblem.mockResolvedValue(EXECUTION);
  mocks.hostedExecute.mockResolvedValue({ cases: [], stdout: '', durationMs: 1 });
  pool.query.mockResolvedValue({ rows: [] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('private Vercel deployment configuration', () => {
  it('uses the platform production domain and allows an explicit canonical origin', () => {
    expect(readVercelConfiguration(ENVIRONMENT)).toEqual({
      appOrigin: ORIGIN,
      connectionString: CONNECTION,
    });
    expect(
      readVercelConfiguration({ ...ENVIRONMENT, APP_ORIGIN: 'https://custom.example.com' })
        .appOrigin,
    ).toBe('https://custom.example.com');
  });

  it.each([
    { VERCEL: undefined },
    { VERCEL_ENV: 'preview' },
    { VERCEL_ENV: 'development' },
    { VERCEL_AUTHENTICATION_CONFIRMED: undefined },
    { VERCEL_AUTHENTICATION_CONFIRMED: 'true' },
    { POSTGRES_URL: undefined },
    { POSTGRES_URL: 'postgresql://test:test@localhost/db?sslmode=require' },
    { VERCEL_PROJECT_PRODUCTION_URL: undefined },
  ])('refuses incomplete or nonproduction configuration: %j', (overrides) => {
    expect(() => readVercelConfiguration({ ...ENVIRONMENT, ...overrides })).toThrow();
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it.each([
    'http://practice.example.com',
    'https://practice.example.com/',
    'https://practice.example.com/path',
    'https://practice.example.com?query=1',
    'https://practice.example.com#fragment',
    'https://practice.example.com:8443',
    'https://user:password@practice.example.com',
    'https://localhost',
    'https://app.localhost',
    'https://app.local',
    'https://127.0.0.1',
    'https://[::1]',
    '',
  ])('rejects noncanonical or local production origins: %s', (APP_ORIGIN) => {
    expect(() => readVercelConfiguration({ ...ENVIRONMENT, APP_ORIGIN })).toThrow();
  });

  it('does not fall back to arbitrary preview domain variables', () => {
    expect(() =>
      readVercelConfiguration({
        ...ENVIRONMENT,
        VERCEL_PROJECT_PRODUCTION_URL: undefined,
        VERCEL_URL: 'preview.example.com',
        VERCEL_BRANCH_URL: 'branch.example.com',
      }),
    ).toThrow();
  });
});

describe('Vercel handler with an offline repository', () => {
  it('initializes the local schema lazily once and shares the resulting pool across concurrent reads', async () => {
    const handler = createApiHandler({
      environment: { POSTGRES_URL: CONNECTION },
      executeCode: mocks.localExecute,
    });
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.createPool).not.toHaveBeenCalled();
    const replies = await Promise.all(
      ['/api/state', '/api/catalog'].map((path) =>
        handler(
          new Request('http://127.0.0.1:5173' + path, { headers: { Host: '127.0.0.1:5173' } }),
        ),
      ),
    );
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    expect(mocks.initializeDatabase).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    expect(mocks.createPool).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    expect(mocks.attachPool).not.toHaveBeenCalled();
  });

  it('rejects untrusted local requests before schema initialization or pool creation', async () => {
    const handler = createApiHandler({
      environment: { POSTGRES_URL: CONNECTION },
      executeCode: mocks.localExecute,
    });
    const reply = await handler(
      new Request('http://127.0.0.1:5173/api/state', {
        headers: { Host: 'attacker.example.com' },
      }),
    );
    expect(reply.status).toBe(403);
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it('allows retry after local schema initialization fails without retaining a rejected promise', async () => {
    mocks.initializeDatabase.mockRejectedValueOnce(new Error('private connection failure'));
    const handler = createApiHandler({
      environment: { POSTGRES_URL: CONNECTION },
      executeCode: mocks.localExecute,
    });
    const request = () =>
      new Request('http://127.0.0.1:5173/api/state', {
        headers: { Host: '127.0.0.1:5173' },
      });
    const failed = await handler(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private connection failure');
    expect((await handler(request())).status).toBe(200);
    expect(mocks.initializeDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.createPool).toHaveBeenCalledOnce();
  });

  it('does not create a pool at module/handler creation and reuses it across requests', async () => {
    const server = await serve();
    expect(mocks.createPool).not.toHaveBeenCalled();
    for (const [path, expected] of [
      ['/api/catalog', CATALOG],
      ['/api/state', STATE],
      ['/api/activity?timeZone=America%2FNew_York', { timeZone: 'America/New_York', days: [] }],
    ] as const) {
      const reply = await request(server, 'GET', path);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(expected);
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(mocks.createPool).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    expect(mocks.attachPool).toHaveBeenCalledExactlyOnceWith(pool);
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('uses the standard Web Request/Response contract expected by Next route handlers', async () => {
    const handler = createApiHandler({
      environment: ENVIRONMENT,
      executeCode: mocks.hostedExecute,
    });
    expect(mocks.createPool).not.toHaveBeenCalled();
    const response = await handler(
      new Request(ORIGIN + '/api/health', {
        headers: { Host: new URL(ORIGIN).host },
      }),
    );
    expect(response).toBeInstanceOf(Response);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns fixed JSON setup errors without disclosing configuration or opening storage', async () => {
    const server = await serve({ VERCEL_AUTHENTICATION_CONFIRMED: undefined });
    const reply = await request(server, 'GET', '/api/state', undefined, {
      'X-Vercel-Authenticated': '1',
      'X-Vercel-SSO-User': 'forged@example.com',
    });
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ code: 'deployment_not_configured' });
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.text).not.toContain(CONNECTION);
    expect(mocks.createPool).not.toHaveBeenCalled();
    expect(mocks.readState).not.toHaveBeenCalled();
  });

  it('blocks preview requests even if someone accidentally adds production credentials there', async () => {
    const server = await serve({ VERCEL_ENV: 'preview' });
    expect((await request(server, 'GET', '/api/catalog')).status).toBe(503);
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it.each([
    { Host: 'attacker.example.com' },
    { Host: 'practice.example.com.attacker.com' },
    { Host: 'preview.example.com', 'X-Forwarded-Host': 'practice.example.com' },
    { Origin: 'https://attacker.example.com' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ])('rejects untrusted request authorities/origins: %j', async (headers) => {
    const server = await serve();
    const reply = await request(server, 'GET', '/api/state', undefined, headers);
    expect(reply.status).toBe(403);
    expect(mocks.readState).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: undefined },
    { Origin: 'https://attacker.example.com' },
    { 'X-Code-Practice-Client': undefined },
  ])('requires same-origin JSON client requests before saving: %j', async (headers) => {
    const server = await serve();
    expect((await request(server, 'PUT', '/api/state', '{}', headers)).status).toBe(403);
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it('retains strict raw JSON parsing and does not pass invalid data to storage', async () => {
    const server = await serve();
    expect((await request(server, 'PUT', '/api/state', '{')).status).toBe(400);
    expect(
      (await request(server, 'PUT', '/api/state', '{}', { 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it('sends same-origin saves to the existing repository without adding another profile', async () => {
    const server = await serve();
    const update = { expectedRevision: 4, progress: STATE.progress, stars: [] };
    const reply = await request(server, 'PUT', '/api/state', JSON.stringify(update));
    expect(reply.status).toBe(200);
    expect(mocks.writeState).toHaveBeenCalledExactlyOnceWith(pool, update);
  });

  it('injects the hosted executor with the private versioned spec and does not call Docker', async () => {
    const server = await serve();
    const submission = { problemId: EXECUTION.id, code: '# inert test fixture' };
    const reply = await request(server, 'POST', '/api/run', JSON.stringify(submission));
    expect(reply.status).toBe(200);
    expect(mocks.hostedExecute).toHaveBeenCalledExactlyOnceWith(submission, EXECUTION, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.localExecute).not.toHaveBeenCalled();
  });

  it('returns JSON for unknown API routes and wrong methods, never the frontend document', async () => {
    const server = await serve();
    expect((await request(server, 'GET', '/api/not-found')).body).toMatchObject({
      code: 'not_found',
    });
    expect((await request(server, 'DELETE', '/api/state')).status).toBe(405);
    expect((await request(server, 'GET', '/api/state/')).status).toBe(404);
  });
});

describe('Next route cancellation lifecycle', () => {
  it.each(['run', 'state'] as const)(
    'retains pending %s cleanup or transaction completion after client cancellation',
    async (operation) => {
      for (const [key, value] of Object.entries(ENVIRONMENT)) vi.stubEnv(key, value);
      vi.stubEnv('APP_ORIGIN', ORIGIN);
      const route = await import('../src/app/api/[...path]/route');
      const pendingOperation = operation === 'run' ? mocks.hostedExecute : mocks.writeState;
      let release!: (value: unknown) => void;
      pendingOperation.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const controller = new AbortController();
      const request = new Request(`${ORIGIN}/api/${operation}`, {
        method: operation === 'run' ? 'POST' : 'PUT',
        headers: {
          Host: new URL(ORIGIN).host,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'X-Code-Practice-Client': '1',
        },
        body: JSON.stringify(
          operation === 'run'
            ? { problemId: EXECUTION.id, code: '# inert fixture' }
            : { expectedRevision: 4, progress: STATE.progress, stars: [] },
        ),
        signal: controller.signal,
      });
      const response = operation === 'run' ? route.POST(request) : route.PUT(request);
      expect(mocks.after).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(pendingOperation).toHaveBeenCalledOnce());
      const finished = vi.fn();
      const retained = mocks.after.mock.calls[0][0]().then(finished);
      controller.abort();
      if (operation === 'run')
        expect(mocks.hostedExecute.mock.calls[0][2].signal.aborted).toBe(true);
      await Promise.resolve();
      expect(finished).not.toHaveBeenCalled();
      release(operation === 'run' ? { cases: [], stdout: '', durationMs: 1 } : STATE);
      expect((await response).status).toBe(200);
      await retained;
      expect(finished).toHaveBeenCalledOnce();
    },
  );
});

describe('Next.js + Vercel deployment routing', () => {
  it('excludes private configuration and local artifacts from direct CLI uploads', async () => {
    // Vercel CLI source uploads do not read .gitignore. These exclusions must
    // stay in the deployment-specific ignore file even when Git also ignores them.
    const rules = (await readFile(new URL('../.vercelignore', import.meta.url), 'utf8'))
      .split(/\r?\n/)
      .map((rule) => rule.trim().replace(/\/$/, ''))
      .filter((rule) => rule && !rule.startsWith('#'));
    expect(rules).toEqual(
      expect.arrayContaining([
        '.env',
        '.env.*',
        '.local',
        'docs',
        'AGENTS.md',
        '.git',
        '.vercel',
        'node_modules',
        'dist',
        'build',
        '.next',
        '*.log',
        'playwright-report',
        'test-results',
      ]),
    );
    // The remote build still type-checks tests, and API imports require both
    // server and runner source. Do not hide these to reduce the upload size.
    for (const source of ['server', 'runner', 'src', 'tests']) {
      expect(rules).not.toContain(source);
    }
    expect(rules.some((rule) => rule.startsWith('!'))).toBe(false);
  });

  it('lets Next own routing and keeps API execution server-only and uncached', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(config.framework).toBe('nextjs');
    expect(config.outputDirectory).toBeUndefined();
    expect(config.functions).toEqual({ 'src/app/api/**/*': { supportsCancellation: true } });
    expect(config.rewrites).toBeUndefined();
    expect(config.builds).toBeUndefined();
    expect(config.env).toBeUndefined();
    const route = await readFile(
      new URL('../src/app/api/[...path]/route.ts', import.meta.url),
      'utf8',
    );
    expect(route).toContain("runtime = 'nodejs'");
    expect(route).toContain("dynamic = 'force-dynamic'");
    expect(route).toContain('maxDuration = 300');
  });
});
