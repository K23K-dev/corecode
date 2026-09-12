import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDateKey,
  practiceClock,
  practiceDateKey,
  summarizeActivity,
} from '../shared/practice-activity.mjs';
import {
  loadActivity,
  monthCells,
  parseActivity,
  repairActivity,
  shiftMonth,
  type ActivitySnapshot,
} from '../src/lib/practice-activity';

const activeDays = (...dates: string[]) => dates.map((date) => ({ date, count: 1 }));
const september = (...days: number[]) =>
  activeDays(...days.map((day) => `2026-09-${String(day).padStart(2, '0')}`));

describe('Eastern practice-day rollover', () => {
  it('labels each day by the date on which it ends at exactly 8 PM Eastern', () => {
    expect(practiceDateKey(new Date('2026-09-11T23:59:59.999Z'))).toBe('2026-09-11');
    expect(practiceDateKey(new Date('2026-09-12T00:00:00.000Z'))).toBe('2026-09-12');
    expect(practiceDateKey(new Date('2026-01-12T00:59:59.999Z'))).toBe('2026-01-11');
    expect(practiceDateKey(new Date('2026-01-12T01:00:00.000Z'))).toBe('2026-01-12');
  });

  it('uses midnight UTC in summer and 01:00 UTC in winter for the deadline', () => {
    expect(practiceClock(new Date('2026-09-11T12:00:00Z'))).toEqual({
      today: '2026-09-11',
      resetAt: '2026-09-12T00:00:00.000Z',
    });
    expect(practiceClock(new Date('2026-01-11T12:00:00Z'))).toEqual({
      today: '2026-01-11',
      resetAt: '2026-01-12T01:00:00.000Z',
    });
  });

  it('keeps one practice date across the spring clock change and has a 23-hour day', () => {
    const start = new Date('2026-03-08T01:00:00Z');
    expect(practiceClock(start)).toEqual({
      today: '2026-03-08',
      resetAt: '2026-03-09T00:00:00.000Z',
    });
    expect((Date.parse(practiceClock(start).resetAt) - start.getTime()) / 3_600_000).toBe(23);
    for (const instant of ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z']) {
      expect(practiceDateKey(new Date(instant))).toBe('2026-03-08');
      expect(practiceClock(new Date(instant)).resetAt).toBe('2026-03-09T00:00:00.000Z');
    }
    expect(practiceDateKey(new Date('2026-03-08T00:59:59.999Z'))).toBe('2026-03-07');
    expect(practiceDateKey(new Date('2026-03-08T23:59:59.999Z'))).toBe('2026-03-08');
    expect(practiceDateKey(new Date('2026-03-09T00:00:00Z'))).toBe('2026-03-09');
  });

  it('keeps one practice date across the autumn clock change and has a 25-hour day', () => {
    const start = new Date('2026-11-01T00:00:00Z');
    expect(practiceClock(start)).toEqual({
      today: '2026-11-01',
      resetAt: '2026-11-02T01:00:00.000Z',
    });
    expect((Date.parse(practiceClock(start).resetAt) - start.getTime()) / 3_600_000).toBe(25);
    for (const instant of ['2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z']) {
      expect(practiceDateKey(new Date(instant))).toBe('2026-11-01');
      expect(practiceClock(new Date(instant)).resetAt).toBe('2026-11-02T01:00:00.000Z');
    }
    expect(practiceDateKey(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-31');
    expect(practiceDateKey(new Date('2026-11-02T00:59:59.999Z'))).toBe('2026-11-01');
    expect(practiceDateKey(new Date('2026-11-02T01:00:00Z'))).toBe('2026-11-02');
  });

  it('crosses month, leap-day, and year boundaries at the same Eastern hour', () => {
    expect(practiceDateKey(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09-01');
    expect(practiceDateKey(new Date('2024-02-29T01:00:00Z'))).toBe('2024-02-29');
    expect(practiceDateKey(new Date('2024-03-01T01:00:00Z'))).toBe('2024-03-01');
    expect(practiceClock(new Date('2027-01-01T00:59:59.999Z'))).toEqual({
      today: '2026-12-31',
      resetAt: '2027-01-01T01:00:00.000Z',
    });
    expect(practiceClock(new Date('2027-01-01T01:00:00Z'))).toEqual({
      today: '2027-01-01',
      resetAt: '2027-01-02T01:00:00.000Z',
    });
  });

  it('rejects invalid instants', () => {
    expect(() => practiceDateKey(new Date(NaN))).toThrow(RangeError);
    expect(() => practiceClock(new Date(NaN))).toThrow(RangeError);
  });
});

describe('date-key validation', () => {
  it('requires an actual Gregorian date, not a normalized or partial date', () => {
    for (const valid of ['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31'])
      expect(isDateKey(valid)).toBe(true);
    for (const invalid of [
      null,
      undefined,
      20260911,
      '',
      '2026-2-01',
      '2026-02-29',
      '2100-02-29',
      '2026-04-31',
      '2026-00-01',
      '2026-13-01',
      '2026-01-00',
      '0000-01-01',
      '10000-01-01',
      '2026-09-11T00:00:00Z',
    ])
      expect(isDateKey(invalid)).toBe(false);
  });
});

describe('streaks and repair hearts', () => {
  it('starts empty without accepting repairs as the first day of activity', () => {
    expect(summarizeActivity([], ['2026-09-01'], '2026-09-11')).toEqual({
      current: 0,
      best: 0,
      hearts: 0,
      earnedHearts: 0,
      heartProgress: 0,
      startedOn: null,
    });
  });

  it('earns one heart per five distinct consecutive solved dates, not submissions', () => {
    const days = [...september(1, 2, 3, 4), { date: '2026-09-04', count: 50 }];
    expect(summarizeActivity(days, [], '2026-09-04')).toMatchObject({
      current: 4,
      hearts: 0,
      heartProgress: 4,
    });
    expect(summarizeActivity([...days, ...september(5)], [], '2026-09-05')).toMatchObject({
      current: 5,
      best: 5,
      hearts: 1,
      earnedHearts: 1,
      heartProgress: 0,
      startedOn: '2026-09-01',
    });
    expect(
      summarizeActivity(september(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), [], '2026-09-10'),
    ).toMatchObject({
      hearts: 2,
      earnedHearts: 2,
      heartProgress: 0,
    });
  });

  it('keeps yesterday current until today ends; broken streaks retain earned hearts', () => {
    const days = september(1, 2, 3, 4, 5, 6);
    expect(summarizeActivity(days, [], '2026-09-07')).toMatchObject({
      current: 6,
      hearts: 1,
      heartProgress: 1,
    });
    expect(summarizeActivity(days, [], '2026-09-08')).toMatchObject({
      current: 0,
      best: 6,
      hearts: 1,
      heartProgress: 0,
    });
  });

  it('does not combine progress from separate streaks but retains lifetime earned hearts', () => {
    expect(summarizeActivity(september(1, 2, 3, 5, 6), [], '2026-09-06')).toMatchObject({
      current: 2,
      best: 3,
      earnedHearts: 0,
      heartProgress: 2,
    });
    expect(
      summarizeActivity(september(1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12), [], '2026-09-12'),
    ).toMatchObject({ current: 6, best: 6, earnedHearts: 2, hearts: 2, heartProgress: 1 });
  });

  it('bridges a missed day without counting the repair toward the next heart', () => {
    const days = september(1, 2, 3, 4, 5, 7, 8, 9, 10);
    expect(summarizeActivity(days, ['2026-09-06'], '2026-09-10')).toMatchObject({
      current: 10,
      best: 10,
      earnedHearts: 1,
      hearts: 0,
      heartProgress: 4,
    });
    expect(
      summarizeActivity([...days, ...september(11)], ['2026-09-06'], '2026-09-11'),
    ).toMatchObject({ current: 11, earnedHearts: 2, hearts: 1, heartProgress: 0 });
  });

  it('can restore a streak ending yesterday without pretending a problem was solved then', () => {
    expect(summarizeActivity(september(1, 2, 3, 4, 5), ['2026-09-06'], '2026-09-07')).toMatchObject(
      {
        current: 6,
        best: 6,
        hearts: 0,
        earnedHearts: 1,
        heartProgress: 0,
      },
    );
  });

  it('recomputes earned milestones when a repair reconnects older streak segments', () => {
    const days = september(1, 2, 3, 4, 5, 10, 11, 12, 14, 15);
    expect(summarizeActivity(days, [], '2026-09-15')).toMatchObject({
      hearts: 1,
      earnedHearts: 1,
      heartProgress: 2,
    });
    expect(summarizeActivity(days, ['2026-09-13'], '2026-09-15')).toMatchObject({
      current: 6,
      hearts: 1,
      earnedHearts: 2,
      heartProgress: 0,
    });
  });

  it('deduplicates repairs and does not refund a repair when delayed real activity overlaps it', () => {
    const days = september(1, 2, 3, 4, 5, 6, 7);
    expect(summarizeActivity(days, ['2026-09-06', '2026-09-06'], '2026-09-07')).toMatchObject({
      current: 7,
      earnedHearts: 1,
      hearts: 0,
      heartProgress: 2,
    });
  });

  it('ignores repairs before first real activity, on today, in the future, or invalid', () => {
    const repairs = ['2026-08-31', '2026-09-05', '2026-09-06', '2026-02-29', 'invalid'];
    expect(summarizeActivity(september(1, 2, 3, 4, 5), repairs, '2026-09-05')).toMatchObject({
      hearts: 1,
      earnedHearts: 1,
      current: 5,
      startedOn: '2026-09-01',
    });
  });

  it('never displays a negative balance if stored repairs exceed calculated earnings', () => {
    expect(
      summarizeActivity(september(1, 5), ['2026-09-02', '2026-09-03'], '2026-09-05'),
    ).toMatchObject({
      hearts: 0,
      earnedHearts: 0,
    });
  });

  it('uses calendar dates for streaks across leap days, month ends, and year ends', () => {
    const days = activeDays('2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02');
    expect(summarizeActivity(days, [], '2024-03-02')).toMatchObject({ current: 5, hearts: 1 });
    expect(
      summarizeActivity(activeDays('2026-12-30', '2027-01-01'), ['2026-12-31'], '2027-01-01'),
    ).toMatchObject({ current: 3, best: 3, heartProgress: 2 });
  });

  it('ignores malformed and future activity, including nonpositive or unsafe counts', () => {
    const invalid = [
      { date: '2026-02-29', count: 1 },
      { date: '2026-09-12', count: 1 },
      { date: '2026-09-10', count: 0 },
      { date: '2026-09-10', count: -1 },
      { date: '2026-09-10', count: 0.5 },
      { date: '2026-09-10', count: NaN },
      { date: '2026-09-10', count: Infinity },
      { date: '2026-09-10', count: Number.MAX_SAFE_INTEGER + 1 },
      { date: '2026-09-10', count: '1' },
      { date: null, count: 1 },
      null,
    ] as Array<{ date: string; count: number }>;
    expect(summarizeActivity([...invalid, ...september(11)], [], '2026-09-11')).toMatchObject({
      current: 1,
      best: 1,
      heartProgress: 1,
      startedOn: '2026-09-11',
    });
    expect(summarizeActivity(invalid, [], '2026-09-11').startedOn).toBeNull();
    expect(() => summarizeActivity([], [], '2026-02-29')).toThrow(RangeError);
  });
});

describe('activity month grids', () => {
  it('creates Sunday-first complete weeks with leading and trailing empty cells', () => {
    const cells = monthCells('2026-09', [], '2026-09-08');
    expect(cells).toHaveLength(35);
    expect(cells.slice(0, 2)).toEqual(
      Array(2).fill({ date: null, day: null, count: 0, isToday: false, isFuture: false }),
    );
    expect(cells[2]).toEqual({
      date: '2026-09-01',
      day: 1,
      count: 0,
      isToday: false,
      isFuture: false,
    });
    expect(cells[31].date).toBe('2026-09-30');
    expect(cells.slice(32).every((cell) => cell.date === null)).toBe(true);
  });

  it('supports leap years and century-year exceptions', () => {
    expect(monthCells('2024-02', [], '2024-02-29').filter((cell) => cell.day)).toHaveLength(29);
    expect(monthCells('2000-02', [], '2000-02-29').filter((cell) => cell.day)).toHaveLength(29);
    expect(monthCells('2100-02', [], '2100-02-28').filter((cell) => cell.day)).toHaveLength(28);
    expect(monthCells('2026-02', [], '2026-02-28')).toHaveLength(28);
    expect(monthCells('2026-08', [], '2026-08-31')).toHaveLength(42);
  });

  it('consolidates accepted counts and marks today and future dates', () => {
    const days = [
      { date: '2026-09-07', count: 2 },
      { date: '2026-09-07', count: 3 },
      { date: '2026-09-07', count: -1 },
      { date: '2026-09-08', count: 1 },
      { date: '2026-08-31', count: 7 },
    ];
    const cells = monthCells('2026-09', days, '2026-09-08');
    expect(cells.find((cell) => cell.day === 7)).toEqual({
      date: '2026-09-07',
      day: 7,
      count: 5,
      isToday: false,
      isFuture: false,
    });
    expect(cells.find((cell) => cell.day === 8)).toEqual({
      date: '2026-09-08',
      day: 8,
      count: 1,
      isToday: true,
      isFuture: false,
    });
    expect(cells.find((cell) => cell.day === 9)).toEqual({
      date: '2026-09-09',
      day: 9,
      count: 0,
      isToday: false,
      isFuture: true,
    });
    expect(cells.filter((cell) => cell.isToday)).toHaveLength(1);
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(6);
  });

  it('marks future months and does not mark a today outside the viewed month', () => {
    const future = monthCells('2027-01', [], '2026-12-31');
    expect(future.filter((cell) => cell.day).every((cell) => cell.isFuture && !cell.isToday)).toBe(
      true,
    );
    expect(
      monthCells('2026-12', [], '2027-01-01').every((cell) => !cell.isFuture && !cell.isToday),
    ).toBe(true);
  });

  it('rejects invalid month and today values', () => {
    for (const month of ['2026-00', '2026-13', '2026-9', 'invalid', '0000-01']) {
      expect(() => monthCells(month, [], '2026-09-08')).toThrow(RangeError);
    }
    expect(() => monthCells('2026-09', [], '2026-09-31')).toThrow(RangeError);
  });
});

describe('month navigation', () => {
  it('navigates across year boundaries in either direction', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-09', 0)).toBe('2026-09');
    expect(shiftMonth('2026-09', -24)).toBe('2024-09');
    expect(shiftMonth('0099-12', 1)).toBe('0100-01');
  });

  it('rejects invalid offsets and out-of-range years', () => {
    expect(() => shiftMonth('2026-09', 0.5)).toThrow(RangeError);
    expect(() => shiftMonth('2026-09', Infinity)).toThrow(RangeError);
    expect(() => shiftMonth('0001-01', -1)).toThrow(RangeError);
    expect(() => shiftMonth('9999-12', 1)).toThrow(RangeError);
  });
});

describe('activity API', () => {
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
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('private details', { status })),
      );
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
});
