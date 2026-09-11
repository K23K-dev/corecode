import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadCatalog,
  mergeProgress,
  MIGRATION_KEY,
  OUTBOX_PREFIX,
  ProgressClient,
  STAR_STORAGE_KEY,
  type StateSnapshot,
} from '../src/lib/database-client';
import {
  parseProgressBackup,
  PROGRESS_STORAGE_KEY,
  type Attempt,
  type ExerciseProgress,
  type ProgressData,
} from '../src/lib/progress';

const DATE = '2026-09-08T12:00:00.000Z';
const LATER = '2026-09-08T13:00:00.000Z';
const VERSION = 'a'.repeat(64);
const empty = (): ProgressData => ({ version: 1, exercises: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (draft = 'draft', updatedAt = DATE, attempts: Attempt[] = []): ExerciseProgress => ({
  draft,
  updatedAt,
  solved: false,
  attempts,
});
const progress = (draft = 'draft', updatedAt = DATE): ProgressData => ({
  version: 1,
  exercises: { problem: record(draft, updatedAt) },
});
const attempt = (index: number): Attempt => ({
  id: `attempt-${index}`,
  at: new Date(Date.parse(DATE) + index).toISOString(),
  code: `return ${index}`,
  passed: 1,
  total: 1,
  status: 'accepted',
  durationMs: 1,
  problemVersion: VERSION,
});

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

type Write = {
  expectedRevision: number;
  progress: ProgressData;
  stars: string[];
  migrationId?: string;
  writeIds: string[];
};
function database(initial?: Partial<StateSnapshot>) {
  const api = {
    state: {
      revision: 0,
      progress: empty(),
      stars: [],
      migrations: [],
      writes: [],
      ...initial,
    } as StateSnapshot,
    requests: [] as Write[],
    archive: new Map<string, Attempt>(),
    failWrites: false,
    loseNextResponse: false,
    fetch: vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
  };
  api.fetch.mockImplementation(async (_input, init) => {
    if (init?.method !== 'PUT') return Response.json(clone(api.state));
    const body = JSON.parse(String(init.body)) as Write;
    api.requests.push(body);
    expect((init.headers as Record<string, string>)['X-Code-Practice-Client']).toBe('1');
    if (api.failWrites) throw new Error('Database is offline.');
    if (body.migrationId && api.state.migrations.includes(body.migrationId))
      return Response.json(clone(api.state));
    if (
      body.expectedRevision !== api.state.revision ||
      body.writeIds.some((id) => api.state.writes.includes(id))
    ) {
      return Response.json({ ...clone(api.state), code: 'revision_conflict' }, { status: 409 });
    }
    for (const value of Object.values(body.progress.exercises))
      for (const item of value.attempts) api.archive.set(item.id, item);
    api.state = {
      revision: api.state.revision + 1,
      progress: parseProgressBackup(JSON.stringify(body.progress)),
      stars: body.stars,
      migrations: [...api.state.migrations, ...(body.migrationId ? [body.migrationId] : [])],
      writes: [...api.state.writes, ...body.writeIds],
    };
    if (api.loseNextResponse) {
      api.loseNextResponse = false;
      throw new Error('Response was lost after commit.');
    }
    return Response.json(clone(api.state));
  });
  return api;
}

const clients: ProgressClient[] = [];
let sequence = 0;
async function open(
  api: ReturnType<typeof database>,
  saved = storage(),
  overrides: Partial<Parameters<typeof ProgressClient.open>[0]> = {},
) {
  const client = await ProgressClient.open({
    fetch: api.fetch as typeof fetch,
    storage: saved,
    id: () => `client-${++sequence}`,
    now: () => DATE,
    delay: 60_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}
function edit(client: ProgressClient, draft: string, at = DATE) {
  client.updateProgress((previous) => ({
    version: 1,
    exercises: {
      ...previous.exercises,
      problem: { ...record(draft, at), ...previous.exercises.problem, draft, updatedAt: at },
    },
  }));
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.useRealTimers();
});

describe('database hydration and catalog', () => {
  it('hydrates without an empty autosave, and no-op updates or empty restores stay saved', async () => {
    const api = database({ progress: progress('database draft'), stars: ['unknown-star'] });
    const client = await open(api);
    expect(client.getSnapshot().progress.exercises.problem.draft).toBe('database draft');
    client.updateProgress((value) => value);
    client.restore(empty());
    await client.flush();
    expect(client.getSnapshot().status).toBe('saved');
    expect(api.requests).toHaveLength(0);
  });

  it('does not write anything when initial database hydration fails', async () => {
    const saved = storage({ [PROGRESS_STORAGE_KEY]: JSON.stringify(progress()) });
    await expect(
      ProgressClient.open({
        storage: saved,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
      }),
    ).rejects.toThrow('offline');
    expect([...saved.values.keys()]).toEqual([PROGRESS_STORAGE_KEY]);
  });

  it('loads versioned database exercises and rejects an unavailable catalog without a seed fallback', async () => {
    const catalog = {
      version: VERSION,
      decks: [{ id: 'python', name: 'Python' }],
      exercises: [
        {
          id: 'example',
          version: VERSION,
          deckId: 'python',
          deck: 'Python',
          title: 'Example',
          difficulty: 'Easy',
          language: 'Python',
          extension: 'py',
          prompt: 'Return one.',
          starterCode: 'def answer():\n    pass',
          referenceCode: 'def answer():\n    return 1',
          cases: [{ name: 'Example', args: '()', expected: '1' }],
        },
      ],
    };
    expect(await loadCatalog(vi.fn(async () => Response.json(catalog)) as typeof fetch)).toEqual(
      catalog,
    );
    await expect(
      loadCatalog(
        vi.fn(async () => Response.json({ error: 'offline' }, { status: 503 })) as typeof fetch,
      ),
    ).rejects.toThrow(/catalog is unavailable/);
    await expect(
      loadCatalog(
        vi.fn(async () =>
          Response.json({
            ...catalog,
            exercises: [{ ...catalog.exercises[0], version: 'invalid' }],
          }),
        ) as typeof fetch,
      ),
    ).rejects.toThrow(/Invalid catalog problem/);
  });

  it('preserves a genuinely empty Neon catalog without supplying local fallback problems', async () => {
    const emptyCatalog = { version: VERSION, decks: [], exercises: [] };
    const fetcher = vi.fn(async () => Response.json(emptyCatalog));
    expect(await loadCatalog(fetcher as typeof fetch)).toEqual(emptyCatalog);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cap the lifetime star receipt log at 1,000 writes', async () => {
    const api = database({ writes: Array.from({ length: 1_001 }, (_, index) => `write-${index}`) });
    const client = await open(api);
    client.setStar('problem', true);
    await client.flush();
    expect(client.getSnapshot().status).toBe('saved');
    expect(api.state.writes).toHaveLength(1_002);
  });
});

describe('deployment response errors', () => {
  it.each(['text/plain', 'text/html', 'application/json'])(
    'identifies a missing API from a 404 %s response without displaying its body',
    async (contentType) => {
      const response = new Response('private upstream details', {
        status: 404,
        headers: { 'Content-Type': contentType },
      });
      const read = vi.spyOn(response, 'text');
      await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
        'The practice API could not be found (HTTP 404). Check that the backend is included in this deployment.',
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, 'text/html'],
    [403, 'application/json'],
  ])('explains access protection for HTTP %i with %s', async (status, contentType) => {
    const response = new Response('private sign-in details', {
      status: Number(status),
      headers: { 'Content-Type': String(contentType) },
    });
    await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
      'Access to the practice API was denied. Sign in with an account that has access, then reload the page.',
    );
  });

  it('explains a followed sign-in redirect instead of treating its page as database data', async () => {
    const response = new Response('<html>Sign in</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
      'The practice API redirected to another page. Reload the website and sign in if prompted.',
    );
  });

  it.each(['text/html', 'text/plain', ''])(
    'identifies non-JSON successful responses with content type "%s" as a routing issue',
    async (contentType) => {
      const response = new Response('<html>App shell or sign-in page</html>', {
        headers: { 'Content-Type': contentType },
      });
      await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
        'The practice API did not return JSON data. Check the deployment’s API routing, then retry.',
      );
    },
  );

  it.each(['text/plain', 'application/json'])(
    'identifies upstream HTTP failures before malformed %s response data',
    async (contentType) => {
      const response = new Response('private connection details', {
        status: 502,
        headers: { 'Content-Type': contentType },
      });
      await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
        'The practice API is unavailable (HTTP 502). Please retry in a moment.',
      );
    },
  );

  it('distinguishes malformed JSON data from missing deployment routes', async () => {
    const response = new Response('{', { headers: { 'Content-Type': 'application/json' } });
    await expect(loadCatalog(vi.fn(async () => response) as typeof fetch)).rejects.toThrow(
      'The practice API returned malformed JSON. Please retry in a moment.',
    );
  });

  it.each(['application/json; charset=utf-8', 'Application/JSON', 'application/vnd.practice+json'])(
    'accepts JSON data with content type %s',
    async (contentType) => {
      const catalog = { version: VERSION, decks: [], exercises: [] };
      const response = new Response(JSON.stringify(catalog), {
        headers: { 'Content-Type': contentType },
      });
      expect(await loadCatalog(vi.fn(async () => response) as typeof fetch)).toEqual(catalog);
    },
  );

  it('leaves browser backups untouched when protected state hydration fails', async () => {
    const original = { [PROGRESS_STORAGE_KEY]: JSON.stringify(progress('local draft')) };
    const saved = storage(original);
    const fetcher = vi.fn(async () => new Response('Sign in', { status: 401 }));
    await expect(ProgressClient.open({ fetch: fetcher, storage: saved })).rejects.toThrow(
      /Access to the practice API was denied/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(saved.values)).toEqual(original);
  });

  it('retains pending drafts and stars when deployment access expires during a save', async () => {
    const api = database();
    const saved = storage();
    const client = await open(api, saved);
    api.fetch.mockImplementationOnce(async () => new Response('Sign in', { status: 401 }));
    edit(client, 'pending draft');
    client.setStar('problem', true);
    await client.flush();
    expect(client.getSnapshot().status).toBe('offline');
    expect(client.getSnapshot().warning).toMatch(/Sign in with an account that has access/);
    expect(client.getSnapshot().progress.exercises.problem.draft).toBe('pending draft');
    expect(client.getSnapshot().stars).toEqual(['problem']);
    expect(api.state.progress).toEqual(empty());
    expect(api.state.stars).toEqual([]);
    client.dispose();

    const recovered = await open(api, saved);
    expect(recovered.getSnapshot().progress.exercises.problem.draft).toBe('pending draft');
    expect(recovered.getSnapshot().stars).toEqual(['problem']);
    await recovered.flush();
    expect(recovered.getSnapshot().status).toBe('saved');
    expect(api.state.progress.exercises.problem.draft).toBe('pending draft');
    expect(api.state.stars).toEqual(['problem']);
  });
});

describe('one-time non-destructive browser migration', () => {
  it('preserves unknown IDs and original strings, archives all legacy attempts, and never re-stars on reload', async () => {
    const legacy: ProgressData = {
      version: 1,
      exercises: {
        retired: record(
          'old draft',
          DATE,
          Array.from({ length: 25 }, (_, index) => attempt(index)),
        ),
      },
    };
    const raw = JSON.stringify(legacy);
    const saved = storage({ [PROGRESS_STORAGE_KEY]: raw, [STAR_STORAGE_KEY]: '["retired"]' });
    const api = database();
    const client = await open(api, saved);
    expect(api.archive.size).toBe(25);
    expect(client.getSnapshot().progress.exercises.retired.attempts).toHaveLength(20);
    expect(saved.getItem(PROGRESS_STORAGE_KEY)).toBe(raw);
    expect(saved.getItem(STAR_STORAGE_KEY)).toBe('["retired"]');
    expect(JSON.parse(saved.getItem(MIGRATION_KEY)!).done).toBe(true);
    client.setStar('retired', false);
    await client.flush();
    const revision = api.state.revision;
    client.dispose();
    expect((await open(api, saved)).getSnapshot().stars).toEqual([]);
    expect(api.state.revision).toBe(revision);
  });

  it('uses one deterministic receipt for simultaneous tabs with the same legacy payload', async () => {
    const original = {
      [PROGRESS_STORAGE_KEY]: JSON.stringify(progress()),
      [STAR_STORAGE_KEY]: '["problem"]',
    };
    const api = database();
    const [first, second] = await Promise.all([
      open(api, storage(original)),
      open(api, storage(original)),
    ]);
    expect(first.getSnapshot().stars).toEqual(['problem']);
    expect(second.getSnapshot().stars).toEqual(['problem']);
    expect(api.state.revision).toBe(1);
    expect(api.state.migrations).toHaveLength(1);
    expect(api.state.migrations[0]).toMatch(/^browser-[a-f0-9]{64}$/);
  });

  it('recovers an interrupted migration using the committed receipt without replaying an old star', async () => {
    const saved = storage({ [STAR_STORAGE_KEY]: '["problem"]' });
    const api = database();
    api.loseNextResponse = true;
    await expect(open(api, saved)).rejects.toThrow(/Response was lost/);
    expect(JSON.parse(saved.getItem(MIGRATION_KEY)!).done).not.toBe(true);
    api.state.stars = [];
    api.state.revision++;
    const requestCount = api.requests.length;
    expect((await open(api, saved)).getSnapshot().stars).toEqual([]);
    expect(api.requests).toHaveLength(requestCount);
    expect(JSON.parse(saved.getItem(MIGRATION_KEY)!).done).toBe(true);
  });
});

describe('durable pending work and revision merging', () => {
  it('keeps failed writes pending in the browser and recovers them after reload', async () => {
    const saved = storage();
    const api = database();
    const first = await open(api, saved);
    api.failWrites = true;
    edit(first, 'unsaved draft');
    first.setStar('unknown-star', true);
    await first.flush();
    expect(first.getSnapshot().status).toBe('offline');
    expect([...saved.values.keys()].some((key) => key.startsWith(OUTBOX_PREFIX))).toBe(true);
    expect(api.state.progress).toEqual(empty());
    first.dispose();
    api.failWrites = false;
    const second = await open(api, saved);
    expect(second.getSnapshot().progress.exercises.problem.draft).toBe('unsaved draft');
    await second.flush();
    expect(second.getSnapshot().status).toBe('saved');
    expect(api.state.progress.exercises.problem.draft).toBe('unsaved draft');
    expect(api.state.stars).toEqual(['unknown-star']);
  });

  it('continues after corrupt outboxes without partially applying their stars', async () => {
    const saved = storage({
      [OUTBOX_PREFIX + 'broken-json']: '{',
      [OUTBOX_PREFIX + 'broken-stars']: JSON.stringify({
        version: 1,
        generation: 'bad',
        progress: empty(),
        stars: {
          leaked: { value: true, at: DATE, id: 'first' },
          invalid: { value: 'wrong', at: DATE, id: 'second' },
        },
      }),
      [OUTBOX_PREFIX + 'valid']: JSON.stringify({
        version: 1,
        generation: 'valid',
        progress: progress('recovered'),
        stars: {},
      }),
    });
    const api = database();
    const client = await open(api, saved);
    expect(client.getSnapshot().progress.exercises.problem.draft).toBe('recovered');
    expect(client.getSnapshot().stars).toEqual([]);
    expect(client.getSnapshot().warning).toMatch(/could not be read/);
    await client.flush();
    expect(saved.getItem(OUTBOX_PREFIX + 'broken-json')).toBe('{');
    expect(api.state.stars).toEqual([]);
  });

  it('merges attempts and solved state while preserving unrelated records and deliberate unstars', async () => {
    const api = database({
      progress: { version: 1, exercises: { retired: record('keep') } },
      stars: ['problem', 'retired'],
    });
    const first = await open(api);
    const second = await open(api);
    first.updateProgress((previous) => ({
      version: 1,
      exercises: {
        ...previous.exercises,
        problem: { ...record('first', DATE, [attempt(1)]), solved: true },
      },
    }));
    second.updateProgress((previous) => ({
      version: 1,
      exercises: { ...previous.exercises, problem: record('second', LATER, [attempt(2)]) },
    }));
    first.setStar('new-star', true);
    second.setStar('problem', false);
    await first.flush();
    await second.flush();
    expect(api.state.progress.exercises.problem.draft).toBe('second');
    expect(api.state.progress.exercises.problem.solved).toBe(true);
    expect(api.state.progress.exercises.problem.attempts.map((item) => item.id)).toEqual([
      'attempt-1',
      'attempt-2',
    ]);
    expect(api.state.progress.exercises.retired.draft).toBe('keep');
    expect(api.state.stars).toEqual(['new-star', 'retired']);
  });

  it('does not replay an acknowledged star after a lost response, and still saves a newer draft', async () => {
    const api = database();
    const first = await open(api);
    edit(first, 'draft A');
    first.setStar('problem', true);
    api.loseNextResponse = true;
    await first.flush();
    expect(first.getSnapshot().status).toBe('offline');
    const second = await open(api);
    second.setStar('problem', false);
    await second.flush();
    edit(first, 'draft B', LATER);
    await first.flush();
    expect(first.getSnapshot().status).toBe('saved');
    expect(api.state.stars).toEqual([]);
    expect(api.state.progress.exercises.problem.draft).toBe('draft B');
    expect(api.requests.at(-1)?.writeIds).toEqual([]);
  });

  it('keeps edits made while a save is in flight for a second save', async () => {
    const api = database();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pause = true;
    const client = await open(api, storage(), {
      fetch: (async (input, init) => {
        if (init?.method === 'PUT' && pause) {
          pause = false;
          await gate;
        }
        return api.fetch(input, init);
      }) as typeof fetch,
    });
    edit(client, 'draft A');
    const saving = client.flush();
    edit(client, 'draft B');
    client.setStar('problem', true);
    release();
    await saving;
    expect(client.getSnapshot().status).toBe('saving');
    await client.flush();
    expect(api.state.progress.exercises.problem.draft).toBe('draft B');
    expect(api.state.stars).toEqual(['problem']);
    expect(client.getSnapshot().status).toBe('saved');
  });

  it('warns and preserves a recovery copy when a newer remote draft wins', async () => {
    const saved = storage();
    const api = database();
    const client = await open(api, saved);
    edit(client, 'older local draft');
    api.state = { ...api.state, revision: 1, progress: progress('newer remote draft', LATER) };
    await client.flush();
    expect(client.getSnapshot().status).toBe('conflict');
    expect(client.getSnapshot().warning).toMatch(/older draft was not saved/);
    expect(api.state.progress.exercises.problem.draft).toBe('newer remote draft');
    const copy = [...saved.values.entries()].find(([key]) =>
      key.startsWith('coding-practice:conflict:'),
    );
    expect(JSON.parse(copy![1]).exercises.problem.draft).toBe('older local draft');
  });

  it('does not replace a newer saved revision with a slow refresh response', async () => {
    const api = database();
    let release!: (response: Response) => void;
    let held = false;
    const client = await open(api, storage(), {
      fetch: (async (input, init) => {
        if (held && init?.method !== 'PUT')
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return api.fetch(input, init);
      }) as typeof fetch,
    });
    held = true;
    const refreshing = client.refresh();
    const stale = clone(api.state);
    edit(client, 'new draft');
    await client.flush();
    release(Response.json(stale));
    await refreshing;
    expect(client.getSnapshot().progress.exercises.problem.draft).toBe('new draft');
    expect(client.getSnapshot().status).toBe('saved');
  });

  it('bounds automatic retries and never says saved during an outage', async () => {
    vi.useFakeTimers();
    const api = database();
    const client = await open(api);
    api.failWrites = true;
    edit(client, 'pending');
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.requests).toHaveLength(4);
    expect(client.getSnapshot().status).toBe('offline');
  });
});

describe('progress merge and v1 compatibility', () => {
  it('keeps an unacknowledged solved result when restoring an unsolved draft', async () => {
    const api = database();
    const client = await open(api);
    client.updateProgress(() => ({
      version: 1,
      exercises: { problem: { ...record('accepted', DATE, [attempt(1)]), solved: true } },
    }));
    client.restore(progress('restored unsolved draft'));
    expect(client.getSnapshot().progress.exercises.problem.solved).toBe(true);
    await client.flush();
    expect(api.state.progress.exercises.problem.solved).toBe(true);
    expect(api.state.progress.exercises.problem.draft).toBe('restored unsolved draft');
    expect(api.state.progress.exercises.problem.attempts).toHaveLength(1);
  });

  it('unions all pending attempts for archival but bounds the visible snapshot', () => {
    const first = progress();
    first.exercises.problem.attempts = Array.from({ length: 15 }, (_, index) => attempt(index));
    const second = progress('later', LATER);
    second.exercises.problem.attempts = Array.from({ length: 15 }, (_, index) =>
      attempt(index + 15),
    );
    expect(mergeProgress(first, second).exercises.problem.attempts).toHaveLength(20);
    expect(mergeProgress(first, second, true).exercises.problem.attempts).toHaveLength(30);
    expect(first.exercises.problem.attempts).toHaveLength(15);
  });

  it('accepts missing and null legacy versions alongside hashed versions', () => {
    const data = progress();
    const legacy = attempt(0);
    delete legacy.problemVersion;
    data.exercises.problem.attempts = [legacy, { ...attempt(1), problemVersion: null }, attempt(2)];
    const parsed = parseProgressBackup(JSON.stringify(data));
    expect(Object.hasOwn(parsed.exercises.problem.attempts[0], 'problemVersion')).toBe(false);
    expect(parsed.exercises.problem.attempts[1].problemVersion).toBeNull();
    expect(parsed.exercises.problem.attempts[2].problemVersion).toBe(VERSION);
  });
});
