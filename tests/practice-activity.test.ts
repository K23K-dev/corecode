import { describe, expect, it } from 'vitest';
import {
  localDateKey,
  monthCells,
  shiftMonth,
  summarizeStreak,
  type ActivityDay,
} from '../src/lib/practice-activity';

const activeDays = (...dates: string[]): ActivityDay[] => dates.map((date) => ({ date, count: 1 }));

describe('practice streaks', () => {
  it('has no streak before any accepted submissions', () => {
    expect(summarizeStreak([], '2026-09-08')).toEqual({ current: 0, best: 0 });
    expect(summarizeStreak([{ date: '2026-09-08', count: 0 }], '2026-09-08')).toEqual({
      current: 0,
      best: 0,
    });
  });

  it("includes today's accepted activity and counts dates rather than submissions", () => {
    expect(
      summarizeStreak(
        [{ date: '2026-09-08', count: 5 }, ...activeDays('2026-09-06', '2026-09-07')],
        '2026-09-08',
      ),
    ).toEqual({ current: 3, best: 3 });
  });

  it('keeps a streak ending yesterday alive until the current day ends', () => {
    const days = activeDays('2026-09-06', '2026-09-07');
    expect(summarizeStreak(days, '2026-09-08')).toEqual({ current: 2, best: 2 });
    expect(summarizeStreak(days, '2026-09-09')).toEqual({ current: 0, best: 2 });
  });

  it('resets the current streak after a missed day while preserving the historical best', () => {
    const days = activeDays('2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07', '2026-09-08');
    expect(summarizeStreak(days, '2026-09-08')).toEqual({ current: 2, best: 3 });
  });

  it('crosses leap days, month ends, and year ends', () => {
    expect(
      summarizeStreak(activeDays('2024-02-28', '2024-02-29', '2024-03-01'), '2024-03-01'),
    ).toEqual({ current: 3, best: 3 });
    expect(
      summarizeStreak(activeDays('2025-12-30', '2025-12-31', '2026-01-01'), '2026-01-02'),
    ).toEqual({ current: 3, best: 3 });
  });

  it('consolidates duplicate dates and ignores future activity', () => {
    const days = activeDays(
      '2026-09-09',
      '2026-09-07',
      '2026-09-08',
      '2026-09-07',
      '2026-09-10',
      '2026-09-11',
    );
    expect(summarizeStreak(days, '2026-09-08')).toEqual({ current: 2, best: 2 });
    expect(summarizeStreak(activeDays('2026-09-09', '2026-09-10'), '2026-09-08')).toEqual({
      current: 0,
      best: 0,
    });
  });

  it('ignores invalid dates and nonpositive, fractional, nonnumeric, or unsafe counts', () => {
    const invalid = [
      { date: '2026-02-29', count: 1 },
      { date: '2026-13-01', count: 1 },
      { date: '2026-02-30', count: 1 },
      { date: '2026-2-28', count: 1 },
      { date: '2026-02-28T12:00:00Z', count: 1 },
      { date: '2026-02-28', count: 0 },
      { date: '2026-02-28', count: -1 },
      { date: '2026-02-28', count: 0.5 },
      { date: '2026-02-28', count: NaN },
      { date: '2026-02-28', count: Infinity },
      { date: '2026-02-28', count: Number.MAX_SAFE_INTEGER + 1 },
      { date: '2026-02-28', count: '1' },
      { date: null, count: 1 },
      null,
    ] as ActivityDay[];
    expect(summarizeStreak(invalid, '2026-03-01')).toEqual({ current: 0, best: 0 });
    expect(
      summarizeStreak([...invalid, ...activeDays('2026-02-28', '2026-03-01')], '2026-03-01'),
    ).toEqual({ current: 2, best: 2 });
  });

  it('rejects an invalid today instead of silently shifting dates', () => {
    expect(() => summarizeStreak([], '2026-02-29')).toThrow(RangeError);
    expect(() => summarizeStreak([], '2026-9-8')).toThrow(RangeError);
  });
});

describe('local calendar dates', () => {
  it('uses local midnight, not UTC midnight', () => {
    expect(localDateKey(new Date('2026-09-08T03:59:59Z'), 'America/New_York')).toBe('2026-09-07');
    expect(localDateKey(new Date('2026-09-08T04:00:00Z'), 'America/New_York')).toBe('2026-09-08');
    expect(localDateKey(new Date('2026-12-31T15:00:00Z'), 'Asia/Tokyo')).toBe('2027-01-01');
  });

  it('keeps consecutive dates across the spring daylight-saving transition', () => {
    const dates = ['2026-03-07T05:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'].map(
      (instant) => localDateKey(new Date(instant), 'America/New_York'),
    );
    expect(dates).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(summarizeStreak(activeDays(...dates), '2026-03-09')).toEqual({ current: 3, best: 3 });
  });

  it('keeps consecutive dates across the autumn daylight-saving transition', () => {
    const dates = ['2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'].map(
      (instant) => localDateKey(new Date(instant), 'America/New_York'),
    );
    expect(dates).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(summarizeStreak(activeDays(...dates), '2026-11-02')).toEqual({ current: 3, best: 3 });
  });

  it('rejects invalid instants and time zones', () => {
    expect(() => localDateKey(new Date(NaN), 'UTC')).toThrow(RangeError);
    expect(() => localDateKey(new Date('2026-09-08T00:00:00Z'), 'Not/A_Time_Zone')).toThrow(
      RangeError,
    );
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
