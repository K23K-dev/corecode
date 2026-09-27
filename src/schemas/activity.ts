import { z } from 'zod';
import { Timestamp } from './progress';

/** Accepted-submission times from the full archive; the browser groups them into days. */
export const ActivityHistorySchema = z.object({ accepted: z.array(Timestamp).max(100_000) });
export type ActivityHistory = z.infer<typeof ActivityHistorySchema>;
type ActivityDay = { date: string; count: number };

const DAY_MS = 86_400_000;

/** Treat date keys as calendar days, not instants in a daylight-saving time zone. */
function dateOrdinal(value: unknown): number | null {
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

/** The calendar date in this browser's time zone, as YYYY-MM-DD. */
export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Count accepted submissions per local calendar day. */
export function activityDays(accepted: string[]): ActivityDay[] {
  const counts = new Map<string, number>();
  for (const at of accepted) {
    const date = localDateKey(new Date(at));
    if (dateOrdinal(date) !== null) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}

/** Count consecutive days with accepted submissions. */
export function summarizeActivity(days: ActivityDay[], today: string) {
  const todayOrdinal = requireDateOrdinal(today);
  const active = [
    ...new Set(
      days
        .filter((day) => day.count > 0 && day.date <= today)
        .map((day) => requireDateOrdinal(day.date)),
    ),
  ].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let previous: number | undefined;
  for (const ordinal of active) {
    run = previous === ordinal - 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = ordinal;
  }
  return {
    current: previous === todayOrdinal || previous === todayOrdinal - 1 ? run : 0,
    best,
  };
}
