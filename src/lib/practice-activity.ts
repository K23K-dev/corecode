export type ActivityDay = { date: string; count: number };

export type ActivityCalendarCell = {
  date: string | null;
  day: number | null;
  count: number;
  isToday: boolean;
  isFuture: boolean;
};

const DAY_MS = 86_400_000;

// Treat date keys as calendar days, not instants in a daylight-saving time zone.
function dateOrdinal(value: string): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.getTime() / DAY_MS;
}

function requireDateOrdinal(value: string): number {
  const ordinal = dateOrdinal(value);
  if (ordinal === null)
    throw new RangeError('Expected a valid calendar date in YYYY-MM-DD format.');
  return ordinal;
}

function activityCounts(days: ActivityDay[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const day of days) {
    if (!day || !Number.isSafeInteger(day.count) || day.count <= 0) continue;
    const ordinal = dateOrdinal(day.date);
    if (ordinal === null) continue;
    counts.set(ordinal, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(ordinal) ?? 0) + day.count));
  }
  return counts;
}

/** The calendar date at an instant in the browser's reported IANA time zone. */
export function localDateKey(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Expected a valid Date.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    era: 'short',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const key = `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
  if (value('era') !== 'AD' || dateOrdinal(key) === null)
    throw new RangeError('Calendar dates must fall between years 0001 and 9999.');
  return key;
}

/** Today can still be completed, so a streak ending yesterday remains current. */
export function summarizeStreak(
  days: ActivityDay[],
  today: string,
): { current: number; best: number } {
  const todayOrdinal = requireDateOrdinal(today);
  const active = [...activityCounts(days).keys()]
    .filter((day) => day <= todayOrdinal)
    .sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let previous: number | undefined;
  for (const day of active) {
    run = previous !== undefined && day === previous + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  const current = previous === todayOrdinal || previous === todayOrdinal - 1 ? run : 0;
  return { current, best };
}

function monthStart(month: string): number {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month))
    throw new RangeError('Expected a month in YYYY-MM format.');
  return requireDateOrdinal(`${month}-01`);
}

/** A Sunday-first month padded to full weeks with empty cells. */
export function monthCells(
  month: string,
  days: ActivityDay[],
  today: string,
): ActivityCalendarCell[] {
  const firstOrdinal = monthStart(month);
  const todayOrdinal = requireDateOrdinal(today);
  const firstDate = new Date(firstOrdinal * DAY_MS);
  const lastDate = new Date(firstDate);
  lastDate.setUTCMonth(lastDate.getUTCMonth() + 1, 0);
  const daysInMonth = lastDate.getUTCDate();
  const leading = firstDate.getUTCDay();
  const length = Math.ceil((leading + daysInMonth) / 7) * 7;
  const counts = activityCounts(days);
  return Array.from({ length }, (_, index) => {
    const day = index - leading + 1;
    if (day < 1 || day > daysInMonth)
      return { date: null, day: null, count: 0, isToday: false, isFuture: false };
    const ordinal = firstOrdinal + day - 1;
    return {
      date: `${month}-${String(day).padStart(2, '0')}`,
      day,
      count: counts.get(ordinal) ?? 0,
      isToday: ordinal === todayOrdinal,
      isFuture: ordinal > todayOrdinal,
    };
  });
}

export function shiftMonth(month: string, delta: number): string {
  monthStart(month);
  if (!Number.isSafeInteger(delta)) throw new RangeError('Expected an integer month offset.');
  const [year, number] = month.split('-').map(Number);
  const shifted = year * 12 + number - 1 + delta;
  if (shifted < 12 || shifted >= 10_000 * 12)
    throw new RangeError('Calendar dates must fall between years 0001 and 9999.');
  return `${String(Math.floor(shifted / 12)).padStart(4, '0')}-${String((shifted % 12) + 1).padStart(2, '0')}`;
}
