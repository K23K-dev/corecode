import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  makePool: vi.fn(),
  initializeDatabase: vi.fn(),
  readCatalog: vi.fn(),
  readExecutionProblem: vi.fn(),
  readState: vi.fn(),
  readActivity: vi.fn(),
  writeState: vi.fn(),
  executeProblem: vi.fn(),
}));

// The real error/validation classes are retained, but no real pool or runner can start.
vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      throw new Error('HTTP contract tests must never construct a database pool.');
    }
  },
}));
vi.mock('../server/repository.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makePool: mocks.makePool,
  initializeDatabase: mocks.initializeDatabase,
  readCatalog: mocks.readCatalog,
  readExecutionProblem: mocks.readExecutionProblem,
  readState: mocks.readState,
  readActivity: mocks.readActivity,
  writeState: mocks.writeState,
}));
vi.mock('../runner/execution.mjs', () => ({ executeProblem: mocks.executeProblem }));

const serverModule = '../server/index.mjs';
const { startDataServer } = (await import(serverModule)) as {
  startDataServer(options: {
    connectionString: string;
    port?: number;
    host?: string;
    appOrigin?: string;
  }): Promise<Server>;
};
const validationModule = '../server/validation.mjs';
const { RequestError, MAX_BODY_BYTES, validateStateUpdate } = (await import(validationModule)) as {
  RequestError: new (message: string, status?: number, code?: string) => Error;
  MAX_BODY_BYTES: number;
  validateStateUpdate(value: unknown): unknown;
};
const repositoryModule = '../server/repository.mjs';
const { StateConflict } = (await import(repositoryModule)) as {
  StateConflict: new (state: unknown, code: string, message: string) => Error;
};

const ORIGIN = 'http://127.0.0.1:5173';
const CONNECTION = 'mocked-http-test-connection';
const EMPTY_PROGRESS = { version: 1, exercises: {} };
const STATE = { revision: 4, progress: EMPTY_PROGRESS, stars: [], migrations: [], writes: [] };
const UPDATE = { expectedRevision: 4, progress: EMPTY_PROGRESS, stars: [] };
const PROBLEM = { id: 'http-fixture', version: 'a'.repeat(64), runtime: 'python' };
const EXECUTION_PROBLEM = {
  id: PROBLEM.id,
  version: PROBLEM.version,
  gradingSpec: {
    runtime: 'python',
    entryPoint: 'answer',
    cases: [{ name: 'Private fixture', args: '()', expected: '1' }],
  },
};
const CATALOG = { version: 'b'.repeat(64), decks: [], exercises: [PROBLEM] };
const RUN = {
  problemId: PROBLEM.id,
  problemVersion: PROBLEM.version,
  code: '# inert fixture: execution is always mocked',
  mode: 'submit',
};
const RESULT = { cases: [{ name: 'Fixture', passed: true }], stdout: '', durationMs: 1 };
const pool = { query: mocks.query, end: mocks.end };
let server: Server;
let servers: Server[];

type Reply = { status: number; headers: IncomingHttpHeaders; body: unknown; text: string };
type RequestOptions = {
  headers?: Record<string, string | undefined>;
  chunks?: Buffer[];
  target?: Server;
};

function serverPort(target = server) {
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('Test listener has no TCP port.');
  return address.port;
}

function request(
  method: string,
  pathname: string,
  body?: string | Buffer,
  { headers: overrides = {}, chunks, target = server }: RequestOptions = {},
) {
  const headers: Record<string, string> = ['PUT', 'POST'].includes(method)
    ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' }
    : {};
  if (body !== undefined && !chunks) headers['Content-Length'] = String(Buffer.byteLength(body));
  if (chunks) headers['Transfer-Encoding'] = 'chunked';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return new Promise<Reply>((resolve, reject) => {
    // A raw path option preserves malformed/encoded request targets for routing tests.
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort(target),
        path: pathname,
        method,
        headers,
        agent: false,
      },
      (response) => {
        const buffers: Buffer[] = [];
        response.on('data', (chunk) => buffers.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(buffers).toString('utf8');
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
    req.setTimeout(5_000, () => req.destroy(new Error('Mocked HTTP request timed out.')));
    req.on('error', reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    req.end(chunks ? undefined : body);
  });
}

function expectPrivateJson(reply: Reply) {
  expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  expect(reply.headers['x-powered-by']).toBeUndefined();
  expect(reply.headers.etag).toBeUndefined();
}

function close(target: Server) {
  return new Promise<void>((resolve, reject) =>
    target.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.end.mockResolvedValue(undefined);
  mocks.makePool.mockReturnValue(pool);
  mocks.readCatalog.mockResolvedValue(CATALOG);
  mocks.readExecutionProblem.mockResolvedValue(EXECUTION_PROBLEM);
  mocks.readState.mockResolvedValue(STATE);
  mocks.readActivity.mockImplementation(async (_pool, timeZone) => ({ timeZone, days: [] }));
  mocks.writeState.mockImplementation(async (_pool, value) => {
    validateStateUpdate(value);
    return { ...STATE, revision: 5 };
  });
  mocks.executeProblem.mockResolvedValue(RESULT);
  servers = [];
  server = await startDataServer({ connectionString: CONNECTION, port: 0 });
  servers.push(server);
});

afterEach(async () => {
  await Promise.all(servers.map(close));
});

describe('HTTP routes and response contract without a database', () => {
  it('starts on an ephemeral loopback port and serves health, catalog, state, and activity', async () => {
    expect(server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(mocks.makePool).toHaveBeenCalledWith(CONNECTION);
    expect(mocks.query).toHaveBeenCalledWith('SELECT 1');
    for (const [pathname, expected] of [
      ['/api/health', { ok: true }],
      ['/api/catalog', CATALOG],
      ['/api/state', STATE],
      ['/api/activity', { timeZone: 'UTC', days: [] }],
    ] as const) {
      const reply = await request('GET', pathname);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(expected);
      expectPrivateJson(reply);
    }
    expect(mocks.readCatalog).toHaveBeenCalledWith(pool);
    expect(mocks.readState).toHaveBeenCalledWith(pool);
    expect(mocks.readActivity).toHaveBeenCalledWith(pool, 'UTC');
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
  });

  it('returns current JSON even for conditional GETs rather than an empty 304', async () => {
    const reply = await request('GET', '/api/state', undefined, {
      headers: { 'If-None-Match': '*', 'If-Modified-Since': 'Wed, 01 Jan 2099 00:00:00 GMT' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(STATE);
    expectPrivateJson(reply);
  });

  it('passes the first decoded timeZone query value, preserving an explicit empty value', async () => {
    const reply = await request('GET', '/api/activity?timeZone=America%2FNew_York&timeZone=UTC');
    expect(reply.body).toEqual({ timeZone: 'America/New_York', days: [] });
    expect(mocks.readActivity).toHaveBeenLastCalledWith(pool, 'America/New_York');
    await request('GET', '/api/activity?timeZone=');
    expect(mocks.readActivity).toHaveBeenLastCalledWith(pool, '');
  });

  it('passes validated save input to storage and returns its authoritative snapshot', async () => {
    const reply = await request('PUT', '/api/state', JSON.stringify(UPDATE));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ...STATE, revision: 5 });
    expect(mocks.writeState).toHaveBeenCalledExactlyOnceWith(pool, UPDATE);
    expectPrivateJson(reply);
  });

  it('loads only the requested execution problem and passes its private spec to the runner', async () => {
    const reply = await request('POST', '/api/run', JSON.stringify(RUN));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(RESULT);
    expect(mocks.readExecutionProblem).toHaveBeenCalledExactlyOnceWith(pool, PROBLEM.id);
    expect(mocks.readCatalog).not.toHaveBeenCalled();
    expect(mocks.executeProblem).toHaveBeenCalledExactlyOnceWith(RUN, EXECUTION_PROBLEM, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.executeProblem.mock.calls[0][2].signal.aborted).toBe(false);
    expectPrivateJson(reply);
  });

  it('does not expose the private spec or replace it with counterfeit browser fields', async () => {
    const body = {
      ...RUN,
      spec: { runtime: 'shell', cases: [] },
      gradingSpec: { runtime: 'javascript', cases: [] },
      cases: [{ expected: 'counterfeit' }],
      runtime: 'shell',
    };
    const reply = await request('POST', '/api/run', JSON.stringify(body));
    expect(reply.status).toBe(200);
    expect(mocks.readExecutionProblem).toHaveBeenCalledExactlyOnceWith(pool, PROBLEM.id);
    expect(mocks.executeProblem).toHaveBeenCalledExactlyOnceWith(body, EXECUTION_PROBLEM, {
      signal: expect.any(AbortSignal),
    });
    expect(reply.body).toEqual(RESULT);
    expect(reply.text).not.toContain('Private fixture');
    expect(reply.text).not.toContain('gradingSpec');
  });

  it('preserves a missing private spec for fail-closed execution and propagates its safe error', async () => {
    const unavailable = { ...EXECUTION_PROBLEM, gradingSpec: null };
    mocks.readExecutionProblem.mockResolvedValueOnce(unavailable);
    mocks.executeProblem.mockRejectedValueOnce(
      new RequestError('Grading is unavailable.', 503, 'grading_unavailable'),
    );
    const reply = await request('POST', '/api/run', JSON.stringify(RUN));
    expect(mocks.executeProblem).toHaveBeenCalledWith(RUN, unavailable, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.readCatalog).not.toHaveBeenCalled();
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'Grading is unavailable.', code: 'grading_unavailable' });
    expectPrivateJson(reply);
  });

  it('preserves invalid problem identifier errors without invoking the runner', async () => {
    mocks.readExecutionProblem.mockRejectedValueOnce(new RequestError('Invalid problem ID.'));
    const reply = await request('POST', '/api/run', JSON.stringify({ ...RUN, problemId: [] }));
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'Invalid problem ID.', code: 'invalid_request' });
    expect(mocks.executeProblem).not.toHaveBeenCalled();
  });

  it.each(['/api/state/', '/API/state', '/api/State', '/api/%73tate', '/api//state', '/api/%'])(
    'does not widen route matching for %s',
    async (pathname) => {
      const reply = await request('GET', pathname);
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: 'not_found' });
      expect(mocks.readState).not.toHaveBeenCalled();
      expectPrivateJson(reply);
    },
  );

  it('retains URL dot-segment normalization before exact route matching', async () => {
    for (const pathname of ['/api/../api/state', '/api/%2e%2e/api/state']) {
      const reply = await request('GET', pathname);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(STATE);
    }
  });

  it.each(['//api/state', 'http://127.0.0.1/api/state', '*'])(
    'rejects invalid raw request targets: %s',
    async (pathname) => {
      const reply = await request('GET', pathname);
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ code: 'invalid_request' });
      expect(mocks.readState).not.toHaveBeenCalled();
    },
  );

  it.each(['/api/health', '/api/catalog', '/api/state', '/api/activity', '/api/run'])(
    'rejects HEAD and OPTIONS without implicit Express responses for %s',
    async (pathname) => {
      for (const method of ['HEAD', 'OPTIONS']) {
        const reply = await request(method, pathname);
        expect(reply.status).toBe(405);
        if (method === 'HEAD') expect(reply.text).toBe('');
        else expect(reply.body).toMatchObject({ code: 'method_not_allowed' });
        expect(reply.headers.allow).toBeUndefined();
        expectPrivateJson(reply);
      }
      expect(mocks.readCatalog).not.toHaveBeenCalled();
      expect(mocks.readExecutionProblem).not.toHaveBeenCalled();
      expect(mocks.readState).not.toHaveBeenCalled();
      expect(mocks.executeProblem).not.toHaveBeenCalled();
    },
  );

  it('returns method/not-found errors without parsing irrelevant malformed bodies', async () => {
    for (const [method, pathname, status] of [
      ['POST', '/api/state', 405],
      ['PUT', '/api/run', 405],
      ['PUT', '/api/health', 405],
      ['PATCH', '/api/state', 405],
      ['GET', '/api/run', 405],
      ['POST', '/api/missing', 404],
    ] as const) {
      const reply = await request(method, pathname, '{broken');
      expect(reply.status).toBe(status);
      expectPrivateJson(reply);
    }
    expect(mocks.writeState).not.toHaveBeenCalled();
    expect(mocks.executeProblem).not.toHaveBeenCalled();
  });
});

describe('loopback and browser request boundaries', () => {
  it.each([
    { Host: 'evil.example' },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: ORIGIN + '/' },
    { 'Sec-Fetch-Site': 'cross-site' },
    {
      Host: 'evil.example',
      'X-Forwarded-Host': '127.0.0.1:5173',
      'X-Forwarded-For': '127.0.0.1',
      'X-Forwarded-Proto': 'http',
      Forwarded: 'for=127.0.0.1;host=127.0.0.1:5173;proto=http',
    },
  ])('rejects invalid browser authority despite forwarding headers: %#', async (headers) => {
    const reply = await request('GET', '/api/state', undefined, { headers });
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: 'forbidden' });
    expect(mocks.readState).not.toHaveBeenCalled();
    expectPrivateJson(reply);
  });

  it('accepts only the configured frontend or actual listener loopback authorities', async () => {
    for (const host of ['127.0.0.1:5173', `localhost:${serverPort()}`, `[::1]:${serverPort()}`]) {
      expect(
        (await request('GET', '/api/state', undefined, { headers: { Host: host } })).status,
      ).toBe(200);
    }
    expect(
      (await request('GET', '/api/state', undefined, { headers: { Host: 'localhost:1' } })).status,
    ).toBe(403);
  });

  it.each([
    { Origin: undefined },
    { 'X-Code-Practice-Client': undefined },
    { 'X-Code-Practice-Client': 'true' },
    { Origin: 'http://localhost:5173' },
  ])('checks write origin and marker before routes or bodies: %#', async (headers) => {
    for (const pathname of ['/api/state', '/api/missing']) {
      const reply = await request('PUT', pathname, '{broken', { headers });
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ code: 'forbidden' });
    }
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it.each([
    'text/plain',
    'application/problem+json',
    'application/json; charset=utf-16',
    'application/json; charset="utf-8"',
    'application/json; extra=1',
  ])('rejects unsupported media types before parsing: %s', async (contentType) => {
    const reply = await request('PUT', '/api/state', '{broken', {
      headers: { 'Content-Type': contentType },
    });
    expect(reply.status).toBe(415);
    expect(reply.body).toMatchObject({ code: 'unsupported_media_type' });
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive JSON and UTF-8 media-type spelling', async () => {
    const reply = await request('PUT', '/api/state', JSON.stringify(UPDATE), {
      headers: { 'Content-Type': 'Application/JSON ; Charset=UTF-8' },
    });
    expect(reply.status).toBe(200);
  });
});

describe('bounded JSON parsing and error responses', () => {
  it.each(['', '{broken', '{"text":"unterminated', Buffer.from([0xc3, 0x28])])(
    'rejects empty, malformed, or invalid UTF-8 request bytes: %#',
    async (body) => {
      for (const [method, pathname] of [
        ['PUT', '/api/state'],
        ['POST', '/api/run'],
      ] as const) {
        const reply = await request(method, pathname, body);
        expect(reply.status).toBe(400);
        expect(reply.body).toMatchObject({ code: 'invalid_request' });
        expectPrivateJson(reply);
      }
      expect(mocks.writeState).not.toHaveBeenCalled();
      expect(mocks.executeProblem).not.toHaveBeenCalled();
    },
  );

  it('decodes chunked UTF-8 across boundaries but rejects malformed chunked bytes', async () => {
    const body = Buffer.from(JSON.stringify({ ...UPDATE, stars: ['café'] }));
    const split = body.indexOf(Buffer.from('é')) + 1;
    const good = await request('PUT', '/api/state', undefined, {
      chunks: [body.subarray(0, split), body.subarray(split)],
    });
    expect(good.status).toBe(200);
    mocks.writeState.mockClear();
    const bad = await request('PUT', '/api/state', undefined, {
      chunks: [Buffer.from('{"value":"'), Buffer.from([0xc3]), Buffer.from('("}')],
    });
    expect(bad.status).toBe(400);
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it.each(['null', 'true', '123', '"scalar"', '[]'])(
    'leaves valid JSON shape rejection to downstream validation: %s',
    async (body) => {
      const reply = await request('PUT', '/api/state', body);
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ code: 'invalid_request' });
      expect(mocks.writeState).toHaveBeenCalledWith(pool, JSON.parse(body));
    },
  );

  it('retains downstream unsafe-property validation', async () => {
    const body =
      '{"expectedRevision":4,"progress":{"version":1,"exercises":{"__proto__":{}}},"stars":[]}';
    const reply = await request('PUT', '/api/state', body);
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'invalid_request' });
  });

  it('accepts exactly 10 MiB of valid JSON bytes', async () => {
    const json = Buffer.from(JSON.stringify(UPDATE));
    const body = Buffer.concat([json, Buffer.alloc(MAX_BODY_BYTES - json.length, 32)]);
    const reply = await request('PUT', '/api/state', body);
    expect(reply.status).toBe(200);
    expect(mocks.writeState).toHaveBeenCalledExactlyOnceWith(pool, UPDATE);
  });

  it.each(['length', 'chunked'] as const)(
    'rejects over-limit %s bodies before storage or execution',
    async (framing) => {
      const body = Buffer.alloc(MAX_BODY_BYTES + 1, 32);
      const reply = await request(
        'POST',
        '/api/run',
        framing === 'length' ? body : undefined,
        framing === 'chunked'
          ? { chunks: [body.subarray(0, MAX_BODY_BYTES), body.subarray(MAX_BODY_BYTES)] }
          : {},
      );
      expect(reply.status).toBe(413);
      expect(reply.body).toMatchObject({ code: 'payload_too_large' });
      expectPrivateJson(reply);
      expect(mocks.readCatalog).not.toHaveBeenCalled();
      expect(mocks.readExecutionProblem).not.toHaveBeenCalled();
      expect(mocks.executeProblem).not.toHaveBeenCalled();
    },
  );

  it('rejects an oversized declared length before the client sends or ends its body', async () => {
    let req: http.ClientRequest | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<Reply>((resolve, reject) => {
        req = http.request(
          {
            hostname: '127.0.0.1',
            port: serverPort(),
            path: '/api/run',
            method: 'POST',
            agent: false,
            headers: {
              Origin: ORIGIN,
              'Content-Type': 'application/json',
              'X-Code-Practice-Client': '1',
              'Content-Length': MAX_BODY_BYTES + 1,
            },
          },
          (response) => {
            const buffers: Buffer[] = [];
            response.on('data', (chunk) => buffers.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              const text = Buffer.concat(buffers).toString('utf8');
              try {
                resolve({
                  status: response.statusCode!,
                  headers: response.headers,
                  body: JSON.parse(text),
                  text,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        deadline = setTimeout(
          () => req?.destroy(new Error('Oversized headers must be rejected without a body.')),
          1_500,
        );
        // Deliberately never call write() or end(): draining a body would hang here.
        req.flushHeaders();
      });
      expect(reply.status).toBe(413);
      expect(reply.body).toMatchObject({ code: 'payload_too_large' });
      expectPrivateJson(reply);
      expect(mocks.readCatalog).not.toHaveBeenCalled();
      expect(mocks.readExecutionProblem).not.toHaveBeenCalled();
      expect(mocks.executeProblem).not.toHaveBeenCalled();
    } finally {
      clearTimeout(deadline);
      req?.destroy();
    }
  }, 2_000);

  it('does not inflate compressed request bodies', async () => {
    const reply = await request('PUT', '/api/state', gzipSync(JSON.stringify(UPDATE)), {
      headers: { 'Content-Encoding': 'gzip' },
    });
    expect(reply.status).toBe(415);
    expect(reply.body).toMatchObject({ code: 'unsupported_media_type' });
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it('returns authoritative conflict state and preserves application error status/code', async () => {
    mocks.writeState.mockRejectedValueOnce(
      new StateConflict(STATE, 'revision_conflict', 'Newer state exists.'),
    );
    const conflict = await request('PUT', '/api/state', JSON.stringify(UPDATE));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      ...STATE,
      error: 'Newer state exists.',
      code: 'revision_conflict',
    });
    expectPrivateJson(conflict);
    mocks.executeProblem.mockRejectedValueOnce(
      new RequestError('Refresh this problem.', 409, 'problem_changed'),
    );
    const stale = await request('POST', '/api/run', JSON.stringify(RUN));
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'Refresh this problem.', code: 'problem_changed' });
    expectPrivateJson(stale);
  });

  it.each(['health', 'catalog', 'state', 'activity', 'save', 'run'] as const)(
    'sanitizes unexpected %s errors without fabricating data',
    async (operation) => {
      const failure = new Error('postgresql://private:do-not-leak@database.invalid/private');
      const method = operation === 'save' ? 'PUT' : operation === 'run' ? 'POST' : 'GET';
      const pathname = operation === 'save' ? '/api/state' : `/api/${operation}`;
      const target = {
        health: mocks.query,
        catalog: mocks.readCatalog,
        state: mocks.readState,
        activity: mocks.readActivity,
        save: mocks.writeState,
        run: mocks.executeProblem,
      }[operation];
      target.mockRejectedValueOnce(failure);
      const reply = await request(
        method,
        pathname,
        operation === 'save'
          ? JSON.stringify(UPDATE)
          : operation === 'run'
            ? JSON.stringify(RUN)
            : undefined,
      );
      expect(reply.status).toBe(503);
      expect(reply.body).toEqual({
        error:
          'Database storage is temporarily unavailable. Your browser draft has not been replaced.',
        code: 'storage_unavailable',
      });
      expect(reply.text).not.toContain('do-not-leak');
      expectPrivateJson(reply);
    },
  );

  it('sanitizes private grading lookup failures without starting execution', async () => {
    mocks.readExecutionProblem.mockRejectedValueOnce(
      new Error('postgresql://private:do-not-leak@database.invalid/private-grading'),
    );
    const reply = await request('POST', '/api/run', JSON.stringify(RUN));
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({
      error:
        'Database storage is temporarily unavailable. Your browser draft has not been replaced.',
      code: 'storage_unavailable',
    });
    expect(reply.text).not.toContain('do-not-leak');
    expect(mocks.executeProblem).not.toHaveBeenCalled();
    expectPrivateJson(reply);
  });
});

describe('execution cancellation and listener lifecycle', () => {
  it('does not start execution when the client disconnects during the database spec lookup', async () => {
    let started!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (problem: typeof EXECUTION_PROBLEM) => void;
    mocks.readExecutionProblem.mockImplementation(() => {
      started();
      return new Promise<typeof EXECUTION_PROBLEM>((resolve) => {
        release = resolve;
      });
    });
    const disconnected = new Promise<void>((resolve) => {
      server.once('request', (_request, response) => response.once('close', resolve));
    });
    const body = JSON.stringify(RUN);
    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort(),
      path: '/api/run',
      method: 'POST',
      agent: false,
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-Code-Practice-Client': '1',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.setTimeout(5_000, () => req.destroy());
    try {
      req.end(body);
      await loading;
      req.destroy();
      await disconnected;
      release(EXECUTION_PROBLEM);
      // Let the route resume after its pending database read before checking it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.executeProblem).not.toHaveBeenCalled();
    } finally {
      req.destroy();
      release?.(EXECUTION_PROBLEM);
    }
  });

  it('aborts the active runner when its HTTP client disconnects', async () => {
    let started!: (signal: AbortSignal) => void;
    const running = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    let canceled!: () => void;
    const aborted = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    mocks.executeProblem.mockImplementation(
      (_body, _problem, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              canceled();
              reject(new RequestError('Run canceled.', 503, 'runner_stopped'));
            },
            { once: true },
          );
          started(signal);
        }),
    );
    const body = JSON.stringify(RUN);
    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort(),
      path: '/api/run',
      method: 'POST',
      agent: false,
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-Code-Practice-Client': '1',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.setTimeout(5_000, () => req.destroy());
    try {
      req.end(body);
      const signal = await running;
      expect(signal.aborted).toBe(false);
      req.destroy();
      await aborted;
      expect(signal.aborted).toBe(true);
    } finally {
      req.destroy();
    }
  });

  it('closes its pool exactly once and notifies repeated close callbacks afterward', async () => {
    let release!: () => void;
    mocks.end.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const completed = vi.fn();
    const first = close(server).then(completed);
    const second = close(server).then(completed);
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('ends the pool if the startup health check or listener bind fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('synthetic unavailable pool'));
    await expect(startDataServer({ connectionString: CONNECTION, port: 0 })).rejects.toThrow(
      'synthetic unavailable pool',
    );
    expect(mocks.end).toHaveBeenCalledOnce();
    await expect(
      startDataServer({ connectionString: CONNECTION, port: serverPort() }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });

  it('refuses non-loopback listeners and inexact application origins before creating a pool', async () => {
    mocks.makePool.mockClear();
    for (const options of [
      { host: '0.0.0.0' },
      { appOrigin: 'https://example.com' },
      { appOrigin: ORIGIN + '/' },
      { appOrigin: 'http://user:password@127.0.0.1:5173' },
    ]) {
      await expect(
        startDataServer({ connectionString: CONNECTION, port: 0, ...options }),
      ).rejects.toThrow();
    }
    expect(mocks.makePool).not.toHaveBeenCalled();
  });

  it('retains finite server request, header, and idle timeouts', () => {
    expect(server.requestTimeout).toBe(20_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(1_000);
  });
});
