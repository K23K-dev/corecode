const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
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

function dateOrdinal(value) {
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

export function isDateKey(value) {
  return dateOrdinal(value) !== null;
}

function requireDateOrdinal(value) {
  const ordinal = dateOrdinal(value);
  if (ordinal === null)
    throw new RangeError('Expected a valid calendar date in YYYY-MM-DD format.');
  return ordinal;
}

function ordinalKey(ordinal) {
  const key = new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
  requireDateOrdinal(key);
  return key;
}

function easternParts(date) {
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
export function practiceDateKey(date) {
  const { ordinal, hour } = easternParts(date);
  return ordinalKey(ordinal + (hour >= 20 ? 1 : 0));
}

export function practiceClock(now = new Date()) {
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

/** Count solved dates once; repaired dates preserve continuity but do not earn hearts. */
export function summarizeActivity(days, repairedDates, today) {
  const todayOrdinal = requireDateOrdinal(today);
  const solved = new Set();
  let first = null;
  for (const day of days) {
    if (!day || !Number.isSafeInteger(day.count) || day.count <= 0) continue;
    const ordinal = dateOrdinal(day.date);
    if (ordinal !== null && ordinal <= todayOrdinal) {
      solved.add(ordinal);
      first = first === null ? ordinal : Math.min(first, ordinal);
    }
  }
  const repaired = new Set();
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
  let previous;
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
  return {
    current: isCurrent ? run : 0,
    best,
    // A stored repair remains spent if delayed accepted activity later overlaps
    // it. The accepted day can still earn credit, but does not refund the repair.
    hearts: Math.max(0, earnedHearts - repaired.size),
    earnedHearts,
    heartProgress: isCurrent ? solvedInRun % 5 : 0,
    startedOn: first === null ? null : ordinalKey(first),
  };
}
