import {
  isDateKey,
  MAX_STREAK_HEARTS,
  requireDateOrdinal,
  type ActivityDay,
  type ActivitySnapshot,
} from '../shared/practice-activity.ts';

/** Validate the response shape; the server owns streak and heart calculations. */
function parseActivity(value: unknown): ActivitySnapshot {
  const invalid = () => new Error('Activity could not be loaded.');
  if (!value || typeof value !== 'object') throw invalid();
  const activity = value as ActivitySnapshot;
  const { streak } = activity;
  if (
    activity.timeZone !== 'America/New_York' ||
    activity.resetHour !== 20 ||
    typeof activity.serverNow !== 'string' ||
    !Number.isFinite(Date.parse(activity.serverNow)) ||
    !isDateKey(activity.today) ||
    typeof activity.resetAt !== 'string' ||
    !Number.isFinite(Date.parse(activity.resetAt)) ||
    !Array.isArray(activity.days) ||
    activity.days.length > 100_000 ||
    activity.days.some(
      (day) => !day || !isDateKey(day.date) || !Number.isSafeInteger(day.count) || day.count < 1,
    ) ||
    !Array.isArray(activity.repairs) ||
    activity.repairs.length > 100_000 ||
    activity.repairs.some((day) => !isDateKey(day)) ||
    !streak ||
    (streak.startedOn !== null && !isDateKey(streak.startedOn)) ||
    [streak.current, streak.best, streak.hearts, streak.earnedHearts, streak.heartProgress].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    streak.hearts > MAX_STREAK_HEARTS ||
    streak.heartProgress >= 5
  )
    throw invalid();
  return activity;
}

export async function loadActivity(signal: AbortSignal): Promise<ActivitySnapshot> {
  const response = await fetch('/api/activity', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Activity could not be loaded.');
  return parseActivity(await response.json());
}

export async function repairActivity(date: string, signal: AbortSignal): Promise<ActivitySnapshot> {
  const response = await fetch('/api/activity/repairs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
    body: JSON.stringify({ date }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(
        'Your activity changed. Refresh activity, then check your hearts and this day.',
      );
    }
    throw new Error(
      'Repair could not be confirmed. Retry; a saved repair will not cost another heart.',
    );
  }
  return parseActivity(await response.json());
}

type ActivityCalendarCell = {
  date: string | null;
  day: number | null;
  count: number;
  isToday: boolean;
  isFuture: boolean;
};

const DAY_MS = 86_400_000;

/** A Sunday-first month padded to full weeks with empty cells. */
export function monthCells(
  month: string,
  days: ActivityDay[],
  today: string,
): ActivityCalendarCell[] {
  const firstOrdinal = requireDateOrdinal(`${month}-01`);
  const todayOrdinal = requireDateOrdinal(today);
  const firstDate = new Date(firstOrdinal * DAY_MS);
  const lastDate = new Date(firstDate);
  lastDate.setUTCMonth(lastDate.getUTCMonth() + 1, 0);
  const daysInMonth = lastDate.getUTCDate();
  const leading = firstDate.getUTCDay();
  const length = Math.ceil((leading + daysInMonth) / 7) * 7;
  const counts = new Map<string, number>();
  for (const { date, count } of days)
    counts.set(date, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(date) ?? 0) + count));
  return Array.from({ length }, (_, index) => {
    const day = index - leading + 1;
    if (day < 1 || day > daysInMonth)
      return { date: null, day: null, count: 0, isToday: false, isFuture: false };
    const ordinal = firstOrdinal + day - 1;
    const date = `${month}-${String(day).padStart(2, '0')}`;
    return {
      date,
      day,
      count: counts.get(date) ?? 0,
      isToday: ordinal === todayOrdinal,
      isFuture: ordinal > todayOrdinal,
    };
  });
}

export function shiftMonth(month: string, delta: number): string {
  requireDateOrdinal(`${month}-01`);
  if (!Number.isSafeInteger(delta)) throw new RangeError('Expected an integer month offset.');
  const [year, number] = month.split('-').map(Number);
  const shifted = year * 12 + number - 1 + delta;
  if (shifted < 12 || shifted >= 10_000 * 12)
    throw new RangeError('Calendar dates must fall between years 0001 and 9999.');
  return `${String(Math.floor(shifted / 12)).padStart(4, '0')}-${String((shifted % 12) + 1).padStart(2, '0')}`;
}
