export type ActivityDay = { date: string; count: number };

export type ActivityEvent = { date: string; at: number; repair?: boolean };

export type ActivitySummary = {
  current: number;
  best: number;
  hearts: number;
  earnedHearts: number;
  heartProgress: number;
  /** Profile join practice date, including imported earlier activity. */
  startedOn: string | null;
};

export type ActivitySnapshot = {
  timeZone: 'America/New_York';
  resetHour: 20;
  today: string;
  resetAt: string;
  serverNow: string;
  days: ActivityDay[];
  repairs: string[];
  streak: ActivitySummary;
};

type HeartEvent = { day: number; at: number; repair: boolean };
type ActivitySegment = { solved: number; parent?: ActivitySegment };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const MAX_STREAK_HEARTS = 3;
const easternTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  era: 'short',
});

/** Treat date keys as calendar days, not instants in a daylight-saving time zone. */
export function dateOrdinal(value: unknown): number | null {
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

export function isDateKey(value: unknown): value is string {
  return dateOrdinal(value) !== null;
}

export function requireDateOrdinal(value: string): number {
  const ordinal = dateOrdinal(value);
  if (ordinal === null)
    throw new RangeError('Expected a valid calendar date in YYYY-MM-DD format.');
  return ordinal;
}

function ordinalKey(ordinal: number): string {
  const key = new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
  requireDateOrdinal(key);
  return key;
}

function easternParts(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Expected a valid Date.');
  const parts = Object.fromEntries(
    easternTime.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const key = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  if (parts.era !== 'AD') throw new RangeError('Calendar dates must be in years 0001 to 9999.');
  return {
    ordinal: requireDateOrdinal(key),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** A practice day is named for the date on which it ends at 8 PM Eastern. */
export function practiceDateKey(date: Date): string {
  const { ordinal, hour } = easternParts(date);
  return ordinalKey(ordinal + (hour >= 20 ? 1 : 0));
}

export function practiceClock(now = new Date()): { today: string; resetAt: string } {
  const today = practiceDateKey(now);
  const wallTime = requireDateOrdinal(today) * DAY_MS + 20 * HOUR_MS;
  let reset = wallTime;
  // Resolve 20:00 Eastern from wall-clock parts, not a fixed UTC offset. This
  // keeps the deadline correct on both 23-hour and 25-hour practice days.
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = easternParts(new Date(reset));
    const localTime =
      parts.ordinal * DAY_MS + parts.hour * HOUR_MS + parts.minute * 60_000 + parts.second * 1_000;
    reset += wallTime - localTime;
  }
  return { today, resetAt: new Date(reset).toISOString() };
}

/** Replay when credits became available, not the calendar day a later repair fills. */
function heartBalance(events: HeartEvent[]): number {
  const segments = new Map<number, ActivitySegment>();
  const solved = new Set<number>();
  const spent = new Set<number>();
  let hearts = 0;
  const root = (segment: ActivitySegment): ActivitySegment => {
    let current = segment;
    while (current.parent) current = current.parent;
    while (segment.parent) {
      const next = segment.parent;
      segment.parent = current;
      segment = next;
    }
    return current;
  };
  for (const event of [...events].sort(
    (left, right) => left.at - right.at || Number(left.repair) - Number(right.repair),
  )) {
    if (event.repair) {
      if (spent.has(event.day)) continue;
      spent.add(event.day);
      // Historical repairs remain valid even if a newly capped wallet would not
      // have funded them. They are never refunded when a late solve overlaps.
      hearts = Math.max(0, hearts - 1);
    } else {
      if (solved.has(event.day)) continue;
      solved.add(event.day);
    }
    const neighbors = new Set(
      [event.day - 1, event.day, event.day + 1]
        .map((day) => segments.get(day))
        .filter((segment) => segment !== undefined)
        .map(root),
    );
    let before = 0;
    let count = event.repair ? 0 : 1;
    for (const segment of neighbors) {
      before += Math.floor(segment.solved / 5);
      count += segment.solved;
    }
    const merged: ActivitySegment = { solved: count };
    for (const segment of neighbors) segment.parent = merged;
    segments.set(event.day, merged);
    hearts = Math.min(MAX_STREAK_HEARTS, hearts + Math.floor(count / 5) - before);
  }
  return hearts;
}

/** Count solved dates once; repairs preserve continuity but do not earn a solved day. */
export function summarizeActivity(
  days: ActivityDay[],
  repairedDates: string[],
  today: string,
  { joinedOn, events }: { joinedOn: string; events: ActivityEvent[] },
): ActivitySummary {
  const todayOrdinal = requireDateOrdinal(today);
  const solved = new Set<number>();
  let first = dateOrdinal(joinedOn);
  if (first !== null && first > todayOrdinal) first = null;
  for (const day of days) {
    if (!day || !Number.isSafeInteger(day.count) || day.count <= 0) continue;
    const ordinal = dateOrdinal(day.date);
    if (ordinal !== null && ordinal <= todayOrdinal) {
      solved.add(ordinal);
      first = first === null ? ordinal : Math.min(first, ordinal);
    }
  }
  const repaired = new Set<number>();
  for (const date of repairedDates) {
    const ordinal = dateOrdinal(date);
    if (first !== null && ordinal !== null && ordinal >= first && ordinal < todayOrdinal)
      repaired.add(ordinal);
  }
  const active = [...new Set([...solved, ...repaired])].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let solvedInRun = 0;
  let earnedHearts = 0;
  let previous: number | undefined;
  for (const ordinal of active) {
    if (previous === undefined || ordinal !== previous + 1) {
      earnedHearts += Math.floor(solvedInRun / 5);
      run = 0;
      solvedInRun = 0;
    }
    run += 1;
    if (solved.has(ordinal)) solvedInRun += 1;
    best = Math.max(best, run);
    previous = ordinal;
  }
  earnedHearts += Math.floor(solvedInRun / 5);
  const isCurrent = previous === todayOrdinal || previous === todayOrdinal - 1;
  const timeline = events.flatMap((event) => {
    const day = dateOrdinal(event.date);
    return day !== null && (event.repair ? repaired.has(day) : solved.has(day))
      ? [{ day, at: event.at, repair: Boolean(event.repair) }]
      : [];
  });
  return {
    current: isCurrent ? run : 0,
    best,
    hearts: heartBalance(timeline),
    earnedHearts,
    heartProgress: isCurrent ? solvedInRun % 5 : 0,
    startedOn: first === null ? null : ordinalKey(first),
  };
}
