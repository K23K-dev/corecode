import { describe, expect, it } from 'vitest';
import {
  isDateKey,
  practiceClock,
  practiceDateKey,
  summarizeActivity,
} from '../shared/practice-activity.mjs';

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
