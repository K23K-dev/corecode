import { afterEach, describe, expect, it, vi } from 'vitest';
import { practiceClock, summarizeActivity } from '../shared/practice-activity.mjs';
import {
  loadActivity,
  parseActivity,
  repairActivity,
  type ActivitySnapshot,
} from '../src/lib/practice-activity';

function snapshot(repairs: string[] = []): ActivitySnapshot {
  const serverNow = '2026-09-07T12:00:00.000Z';
  const clock = practiceClock(new Date(serverNow));
  const days = [1, 2, 3, 4, 5].map((day) => ({ date: `2026-09-0${day}`, count: 3 }));
  return {
    timeZone: 'America/New_York',
    resetHour: 20,
    ...clock,
    serverNow,
    days,
    repairs,
    streak: summarizeActivity(days, repairs, clock.today),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('activity response validation', () => {
  it('accepts a complete snapshot with server-derived Eastern clock and heart balance', () => {
    const value = snapshot();
    expect(parseActivity(value)).toBe(value);
    expect(parseActivity(value).streak).toMatchObject({
      current: 0,
      best: 5,
      earnedHearts: 1,
      hearts: 1,
    });
    const repaired = snapshot(['2026-09-06']);
    expect(parseActivity(repaired)).toBe(repaired);
    expect(parseActivity(repaired).streak).toMatchObject({
      current: 6,
      earnedHearts: 1,
      hearts: 0,
    });
  });

  it.each([null, undefined, false, 7, 'activity', [], {}])(
    'rejects an incomplete root: %j',
    (value) => {
      expect(() => parseActivity(value)).toThrow('Activity could not be loaded.');
    },
  );

  it('requires every field of the snapshot', () => {
    for (const key of Object.keys(snapshot())) {
      const value = { ...snapshot() } as Record<string, unknown>;
      delete value[key];
      expect(() => parseActivity(value), key).toThrow();
    }
  });

  it('rejects a different timezone, reset hour, or invalid server instant', () => {
    for (const change of [
      { timeZone: 'UTC' },
      { resetHour: 0 },
      { resetHour: '20' },
      { serverNow: 'not-a-date' },
      { serverNow: 1_789_776_000_000 },
    ]) {
      expect(() => parseActivity({ ...snapshot(), ...change })).toThrow();
    }
  });

  it('rejects a stale day or reset deadline inconsistent with the server clock', () => {
    const value = snapshot();
    expect(() => parseActivity({ ...value, today: '2026-09-06' })).toThrow();
    expect(() => parseActivity({ ...value, today: '2026-09-08' })).toThrow();
    expect(() => parseActivity({ ...value, resetAt: '2026-09-08T01:00:00.000Z' })).toThrow();
    expect(() => parseActivity({ ...value, resetAt: '2026-09-07T00:00:00.000Z' })).toThrow();
    expect(() => parseActivity({ ...value, serverNow: '2026-09-08T00:00:00.000Z' })).toThrow();
  });

  it('rejects malformed dates, counts, lists, and oversized activity history', () => {
    for (const day of [
      null,
      {},
      { date: '2026-02-29', count: 1 },
      { date: '2026-9-01', count: 1 },
      { date: '2026-09-01', count: 0 },
      { date: '2026-09-01', count: -1 },
      { date: '2026-09-01', count: 1.5 },
      { date: '2026-09-01', count: '1' },
      { date: '2026-09-01', count: NaN },
      { date: '2026-09-01', count: Infinity },
      { date: '2026-09-01', count: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseActivity({ ...snapshot(), days: [day] })).toThrow();
    }
    expect(() => parseActivity({ ...snapshot(), days: {} })).toThrow();
    expect(() => parseActivity({ ...snapshot(), days: new Array(100_001) })).toThrow();
    expect(() => parseActivity({ ...snapshot(), repairs: {} })).toThrow();
    expect(() => parseActivity({ ...snapshot(), repairs: ['2026-02-29'] })).toThrow();
    expect(() => parseActivity({ ...snapshot(), repairs: [null] })).toThrow();
    expect(() => parseActivity({ ...snapshot(), repairs: new Array(100_001) })).toThrow();
  });

  it('rejects heart balances or streak totals that disagree with the recorded dates', () => {
    const value = snapshot(['2026-09-06']);
    for (const change of [
      { current: 5 },
      { best: 7 },
      { hearts: 1 },
      { hearts: -1 },
      { earnedHearts: 2 },
      { heartProgress: 1 },
      { heartProgress: '0' },
      { startedOn: '2026-09-02' },
    ]) {
      expect(() => parseActivity({ ...value, streak: { ...value.streak, ...change } })).toThrow();
    }
    expect(() => parseActivity({ ...value, streak: null })).toThrow();
    expect(() => parseActivity({ ...value, streak: {} })).toThrow();
  });
});

describe('activity requests', () => {
  it('loads the fixed endpoint without a browser timezone and bypasses cached responses', async () => {
    const value = snapshot();
    const fetcher = vi.fn().mockResolvedValue(Response.json(value));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await expect(loadActivity(controller.signal)).resolves.toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/activity', {
      cache: 'no-store',
      signal: controller.signal,
    });
  });

  it.each([401, 403, 404, 500, 503])('rejects a failed activity request (%s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private details', { status })));
    await expect(loadActivity(new AbortController().signal)).rejects.toThrow(
      'Activity could not be loaded.',
    );
  });

  it('posts only the repair date with JSON and the required client protection header', async () => {
    const value = snapshot(['2026-09-06']);
    const fetcher = vi.fn().mockResolvedValue(Response.json(value));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await expect(repairActivity('2026-09-06', controller.signal)).resolves.toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/activity/repairs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
      body: JSON.stringify({ date: '2026-09-06' }),
      signal: controller.signal,
    });
  });

  it('explains a repair conflict without exposing server details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'private details' }, { status: 409 })),
    );
    await expect(repairActivity('2026-09-06', new AbortController().signal)).rejects.toThrow(
      'Your activity changed. Refresh activity, then check your hearts and this day.',
    );
  });

  it.each([400, 401, 403, 404, 500, 503])(
    'handles uncertain failed repairs (%s)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('private details', { status })),
      );
      await expect(repairActivity('2026-09-06', new AbortController().signal)).rejects.toThrow(
        'Repair could not be confirmed. Retry; a saved repair will not cost another heart.',
      );
    },
  );

  for (const [name, request] of [
    ['load', (signal: AbortSignal) => loadActivity(signal)],
    ['repair', (signal: AbortSignal) => repairActivity('2026-09-06', signal)],
  ] as const) {
    it(`validates successful ${name} responses rather than trusting HTTP 200`, async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ days: [] }))
        .mockResolvedValueOnce(new Response('<html>Sign in</html>'))
        .mockResolvedValueOnce(Response.json({ ...snapshot(), streak: { hearts: 50 } }));
      vi.stubGlobal('fetch', fetcher);
      for (let attempt = 0; attempt < 3; attempt += 1)
        await expect(request(new AbortController().signal)).rejects.toThrow();
    });

    it(`passes the caller's abort signal through the ${name} request`, async () => {
      const controller = new AbortController();
      const failure = new DOMException('Request aborted', 'AbortError');
      const fetcher = vi.fn(
        (_url: unknown, options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            expect(options?.signal).toBe(controller.signal);
            options?.signal?.addEventListener('abort', () => reject(failure), { once: true });
          }),
      );
      vi.stubGlobal('fetch', fetcher);
      const pending = request(controller.signal);
      controller.abort();
      await expect(pending).rejects.toBe(failure);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }
});
