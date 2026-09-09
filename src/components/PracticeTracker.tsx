import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Flame, Trophy } from 'lucide-react';
import type { Exercise } from '../lib/exercises';
import type { ProgressData } from '../lib/progress';
import {
  localDateKey,
  monthCells,
  shiftMonth,
  summarizeStreak,
  type ActivityDay,
} from '../lib/practice-activity';
import '../practice-tracker.css';

const difficulties = ['Easy', 'Medium', 'Hard'] as const;
const colors = ['#00bd7e', '#e7a321', '#ee4959'];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const circumference = 2 * Math.PI * 52;

export default function PracticeTracker({
  exercises,
  progress,
  saveState,
}: {
  exercises: Exercise[];
  progress: ProgressData;
  saveState: string;
}) {
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [now, setNow] = useState(() => new Date());
  const today = localDateKey(now, timeZone);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const previousToday = useRef(today);
  const [history, setHistory] = useState<ActivityDay[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const acceptedKey = Object.values(progress.exercises)
    .flatMap((item) =>
      item.attempts.filter((attempt) => attempt.status === 'accepted').map((attempt) => attempt.id),
    )
    .sort()
    .join('|');
  const acknowledged = saveState === 'saved' || saveState === 'conflict';

  useEffect(() => {
    const update = () => setNow(new Date());
    const refresh = () => {
      update();
      setRetry((value) => value + 1);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useEffect(() => {
    const previous = previousToday.current;
    if (previous === today) return;
    // Follow the new day without interrupting someone browsing older history.
    setMonth((value) => (value === previous.slice(0, 7) ? today.slice(0, 7) : value));
    setSelected((value) => (value === previous ? today : value));
    previousToday.current = today;
  }, [today]);

  useEffect(() => {
    // Reads always show committed history; saving acknowledgments trigger a
    // fresh read, but offline drafts must not prevent explicitly retrying it.
    const controller = new AbortController();
    setError('');
    void fetch(`/api/activity?timeZone=${encodeURIComponent(timeZone)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Activity could not be loaded.');
        const value = (await response.json()) as { days?: ActivityDay[] };
        if (
          !Array.isArray(value.days) ||
          value.days.length > 100_000 ||
          value.days.some(
            (day) =>
              !day ||
              !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
              !Number.isSafeInteger(day.count) ||
              day.count < 1,
          )
        ) {
          throw new Error('Activity could not be loaded.');
        }
        if (!controller.signal.aborted) setHistory(value.days);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory(null);
          setError('Activity could not be loaded.');
        }
      });
    return () => controller.abort();
  }, [acceptedKey, acknowledged, today, timeZone, retry]);

  const totals = difficulties.map((difficulty) => {
    const items = exercises.filter((item) => item.difficulty === difficulty);
    return {
      difficulty,
      total: items.length,
      solved: items.filter((item) => progress.exercises[item.id]?.solved).length,
    };
  });
  const solved = totals.reduce((sum, item) => sum + item.solved, 0);
  let arcOffset = 0;
  const arcs = totals.map((item, index) => {
    const span = exercises.length ? (item.total / exercises.length) * circumference * 0.75 : 0;
    const length = Math.max(0, span - 6);
    const offset = arcOffset;
    arcOffset += span;
    return (
      <g key={item.difficulty} transform="rotate(135 64 64)">
        {length > 0 && (
          <circle
            cx="64"
            cy="64"
            r="52"
            fill="none"
            stroke={colors[index]}
            opacity=".2"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${length} ${circumference}`}
            strokeDashoffset={-offset}
          />
        )}
        {item.solved > 0 && (
          <circle
            cx="64"
            cy="64"
            r="52"
            fill="none"
            stroke={colors[index]}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${(length * item.solved) / item.total} ${circumference}`}
            strokeDashoffset={-offset}
          />
        )}
      </g>
    );
  });
  const streak = history ? summarizeStreak(history, today) : null;
  const cells = monthCells(month, history ?? [], today);
  const selectedCount = history?.find((day) => day.date === selected)?.count ?? 0;
  const monthTitle = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T12:00:00Z`));
  const dateLabel = (date: string) =>
    new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T12:00:00Z`));
  function changeMonth(delta: number) {
    const next = shiftMonth(month, delta);
    setMonth(next);
    setSelected(next === today.slice(0, 7) ? today : `${next}-01`);
  }

  return (
    <aside className="practice-tracker" aria-label="Practice tracker">
      <section className="tracker-card tracker-progress" aria-labelledby="tracker-progress-title">
        <h2 id="tracker-progress-title">
          <BarChart3 size={17} /> Your progress
        </h2>
        <div className="tracker-progress-body">
          <dl className="tracker-difficulties">
            {totals.map((item) => (
              <div key={item.difficulty}>
                <dt className={`tracker-${item.difficulty.toLowerCase()}`}>{item.difficulty}</dt>
                <dd data-testid={`tracker-${item.difficulty.toLowerCase()}-count`}>
                  {item.solved}
                  <span>/{item.total}</span>
                </dd>
              </div>
            ))}
          </dl>
          <div
            className="tracker-gauge"
            role="img"
            aria-label={`${solved} of ${exercises.length} problems solved`}
          >
            <svg viewBox="0 0 128 128" aria-hidden="true">
              {arcs}
            </svg>
            <div>
              <strong>{solved}</strong>
              <span>/{exercises.length}</span>
              <span>Solved</span>
            </div>
          </div>
        </div>
      </section>
      <section className="tracker-card tracker-calendar" aria-label="Practice calendar">
        <div className="tracker-month-heading">
          <button
            type="button"
            aria-label="Previous month"
            disabled={month === '0001-01'}
            onClick={() => changeMonth(-1)}
          >
            <ChevronLeft size={19} />
          </button>
          <h2 aria-live="polite">{monthTitle}</h2>
          <button
            type="button"
            aria-label="Next month"
            disabled={month >= today.slice(0, 7)}
            onClick={() => changeMonth(1)}
          >
            <ChevronRight size={19} />
          </button>
        </div>
        <table className="tracker-month" aria-label={monthTitle}>
          <thead>
            <tr>
              {weekdays.map((day) => (
                <th scope="col" key={day}>
                  <abbr title={day}>{day[0]}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: cells.length / 7 }, (_, week) => (
              <tr key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((cell, column) => (
                  <td key={cell.date ?? `blank-${column}`}>
                    {cell.date && (
                      <button
                        type="button"
                        className={[
                          cell.count > 0 ? 'is-active-day' : '',
                          cell.isToday ? 'is-today' : '',
                        ].join(' ')}
                        aria-label={`${dateLabel(cell.date)}: ${history ? `${cell.count} accepted ${cell.count === 1 ? 'submission' : 'submissions'}` : 'activity unavailable'}`}
                        aria-current={cell.isToday ? 'date' : undefined}
                        aria-pressed={selected === cell.date}
                        disabled={cell.isFuture}
                        data-date={cell.date}
                        data-count={cell.count}
                        onClick={() => setSelected(cell.date!)}
                      >
                        {cell.day}
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {error ? (
          <div className="tracker-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Retry activity
            </button>
          </div>
        ) : !history ? (
          <p className="tracker-day-detail" role="status">
            {saveState === 'offline' ? 'Reconnect to load activity.' : 'Loading activity…'}
          </p>
        ) : (
          <p className="tracker-day-detail" aria-live="polite">
            {dateLabel(selected).replace(/, \d{4}$/, '')} · {selectedCount} accepted
          </p>
        )}
        <div className="tracker-streaks">
          <div>
            <span>Current streak</span>
            <strong data-testid="current-streak">
              <Flame size={20} />
              {streak ? `${streak.current} ${streak.current === 1 ? 'day' : 'days'}` : '—'}
            </strong>
          </div>
          <div>
            <span>Best streak</span>
            <strong data-testid="best-streak">
              <Trophy size={20} />
              {streak ? `${streak.best} ${streak.best === 1 ? 'day' : 'days'}` : '—'}
            </strong>
          </div>
        </div>
      </section>
    </aside>
  );
}
