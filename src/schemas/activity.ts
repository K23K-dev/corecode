import { z } from 'zod';
import { Timestamp } from './progress';

// Accepted-submission times from the full archive; the browser groups them into days.
export const ActivityHistorySchema = z.object({ accepted: z.array(Timestamp).max(100_000) });
export type ActivityHistory = z.infer<typeof ActivityHistorySchema>;
type ActivityDay = { date: string; count: number };

// The calendar date in this browser's time zone, as YYYY-MM-DD.
export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Days since 1970 for a YYYY-MM-DD date, so consecutive dates differ by exactly one.
function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// Count accepted submissions per local calendar day.
export function activityDays(accepted: string[]): ActivityDay[] {
  const counts = new Map<string, number>();
  for (const at of accepted) {
    const date = localDateKey(new Date(at));
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}

// Count consecutive days with accepted submissions.
export function summarizeActivity(days: ActivityDay[], today: string) {
  const active = [
    ...new Set(
      days.filter((day) => day.count > 0 && day.date <= today).map((day) => dayNumber(day.date)),
    ),
  ].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let previous: number | undefined;
  for (const day of active) {
    run = previous === day - 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  const todayNumber = dayNumber(today);
  return {
    current: previous === todayNumber || previous === todayNumber - 1 ? run : 0,
    best,
  };
}
