export type ActivitySummary = {
  current: number;
  best: number;
  hearts: number;
  earnedHearts: number;
  heartProgress: number;
  startedOn: string | null;
};

export function isDateKey(value: unknown): value is string;
export function practiceDateKey(date: Date): string;
export function practiceClock(now?: Date): { today: string; resetAt: string };
export function summarizeActivity(
  days: Array<{ date: string; count: number }>,
  repairedDates: string[],
  today: string,
): ActivitySummary;
