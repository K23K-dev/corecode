export type ActivitySummary = {
  current: number;
  best: number;
  hearts: number;
  earnedHearts: number;
  heartProgress: number;
  /** Profile join practice date, including imported earlier activity. */
  startedOn: string | null;
};

export const MAX_STREAK_HEARTS: 3;

export function isDateKey(value: unknown): value is string;
export function practiceDateKey(date: Date): string;
export function practiceClock(now?: Date): { today: string; resetAt: string };
export function summarizeActivity(
  days: Array<{ date: string; count: number }>,
  repairedDates: string[],
  today: string,
  options?: {
    joinedOn?: string | null;
    events?: Array<{ date: string; at: number; repair?: boolean }>;
  },
): ActivitySummary;
