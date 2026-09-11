import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, ChevronLeft, ChevronRight, Flame, Heart, Trophy, X } from 'lucide-react';
import { practiceClock } from '../../shared/practice-activity.mjs';
import type { Exercise } from '../lib/exercises';
import type { ProgressData } from '../lib/progress';
import {
  loadActivity,
  monthCells,
  repairActivity,
  shiftMonth,
  type ActivitySnapshot,
} from '../lib/practice-activity';
import Modal from './Modal';
import '../practice-tracker.css';

const difficulties = ['Easy', 'Medium', 'Hard'] as const;
const colors = ['#00bd7e', '#e7a321', '#ee4959'];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const circumference = 2 * Math.PI * 52;

type ClockAnchor = { serverTime: number; receivedAt: number };

// Only this small row ticks each second; the calendar and library do not rerender.
function DayCountdown({
  anchor,
  onDayChange,
}: {
  anchor: ClockAnchor | null;
  onDayChange: (day: string) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () =>
      setNow(
        new Date(anchor ? anchor.serverTime + performance.now() - anchor.receivedAt : Date.now()),
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [anchor]);
  const clock = practiceClock(now);
  useEffect(() => onDayChange(clock.today), [clock.today, onDayChange]);
  const seconds = Math.max(0, Math.ceil((Date.parse(clock.resetAt) - now.getTime()) / 1000));
  const countdown = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return (
    <div className="tracker-day-heading">
      <strong data-testid="tracker-day">Day {Number(clock.today.slice(-2))}</strong>
      <span data-testid="tracker-reset-countdown" title="Day resets at 8 PM Eastern time">
        {countdown} left
      </span>
    </div>
  );
}

export default function PracticeTracker({
  exercises,
  progress,
  saveState,
}: {
  exercises: Exercise[];
  progress: ProgressData;
  saveState: string;
}) {
  const [today, setToday] = useState(() => practiceClock().today);
  const [clockAnchor, setClockAnchor] = useState<ClockAnchor | null>(null);
  const lastClockAnchor = useRef<ClockAnchor | null>(null);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const previousToday = useRef(today);
  const [history, setHistory] = useState<ActivitySnapshot | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [repairDate, setRepairDate] = useState<string | null>(null);
  const [repairPending, setRepairPending] = useState(false);
  const [repairError, setRepairError] = useState('');
  const requestGeneration = useRef(0);
  const repairInFlight = useRef(false);
  const repairController = useRef<AbortController | null>(null);
  const acceptedKey = Object.values(progress.exercises)
    .flatMap((item) =>
      item.attempts.filter((attempt) => attempt.status === 'accepted').map((attempt) => attempt.id),
    )
    .sort()
    .join('|');
  const acknowledged = saveState === 'saved' || saveState === 'conflict';

  function acceptHistory(value: ActivitySnapshot) {
    const receivedAt = performance.now();
    const previous = lastClockAnchor.current;
    // A delayed refresh must not move an already-synchronized clock backwards.
    const serverTime = Math.max(
      Date.parse(value.serverNow),
      previous ? previous.serverTime + receivedAt - previous.receivedAt : 0,
    );
    const anchor = { serverTime, receivedAt };
    lastClockAnchor.current = anchor;
    setClockAnchor(anchor);
    const currentDay = practiceClock(new Date(serverTime)).today;
    setToday(currentDay);
    setHistory(value);
    if (currentDay !== value.today) setRetry((number) => number + 1);
  }

  useEffect(() => {
    const refresh = () => setRetry((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useEffect(() => () => repairController.current?.abort(), []);

  useEffect(() => {
    // A lost POST response can still have committed. A later GET confirms the
    // date without charging again, even when that repair spent the last heart.
    if (repairDate && history?.repairs.includes(repairDate)) {
      setRepairDate(null);
      setRepairError('');
    }
  }, [history, repairDate]);

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
    if (repairInFlight.current) return;
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setError('');
    void loadActivity(controller.signal)
      .then((value) => {
        if (generation !== requestGeneration.current) return;
        acceptHistory(value);
      })
      .catch(() => {
        if (generation === requestGeneration.current) {
          setHistory(null);
          setError('Activity could not be loaded.');
        }
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      ++requestGeneration.current;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [acceptedKey, acknowledged, today, retry]);

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
  const streak = history?.streak;
  const cells = useMemo(
    () => monthCells(month, history?.days ?? [], today),
    [month, history, today],
  );
  const repaired = new Set(history?.repairs ?? []);
  const selectedCount = history?.days.find((day) => day.date === selected)?.count ?? 0;
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

  function selectDay(date: string, missed: boolean) {
    setSelected(date);
    if (missed) {
      setRepairError('');
      setRepairDate(date);
    }
  }

  async function confirmRepair() {
    if (!repairDate || repairInFlight.current || !streak?.hearts || !history) return;
    repairInFlight.current = true;
    ++requestGeneration.current;
    setRepairPending(true);
    setRepairError('');
    const controller = new AbortController();
    repairController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const value = await repairActivity(repairDate, controller.signal);
      if (controller.signal.aborted) return;
      acceptHistory(value);
      setRepairDate(null);
    } catch (reason) {
      setRepairError(
        reason instanceof Error && reason.name !== 'AbortError'
          ? reason.message
          : 'Repair could not be confirmed. Retry; a saved repair will not cost another heart.',
      );
    } finally {
      clearTimeout(timeout);
      repairInFlight.current = false;
      repairController.current = null;
      setRepairPending(false);
      setRetry((value) => value + 1);
    }
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
        <DayCountdown anchor={clockAnchor} onDayChange={setToday} />
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
                {cells.slice(week * 7, week * 7 + 7).map((cell, column) => {
                  const isRepaired = !!cell.date && repaired.has(cell.date) && cell.count === 0;
                  const isMissed = !!(
                    history &&
                    cell.date &&
                    streak?.startedOn &&
                    cell.date >= streak.startedOn &&
                    cell.date < today &&
                    !isRepaired &&
                    cell.count === 0
                  );
                  const label = !history
                    ? 'activity unavailable'
                    : isRepaired
                      ? 'repaired day'
                      : isMissed
                        ? 'missed day'
                        : `${cell.count} accepted ${cell.count === 1 ? 'submission' : 'submissions'}`;
                  return (
                    <td key={cell.date ?? `blank-${column}`}>
                      {cell.date && (
                        <button
                          type="button"
                          className={[
                            cell.count > 0 ? 'is-active-day' : '',
                            isMissed ? 'is-missed-day' : '',
                            isRepaired ? 'is-repaired-day' : '',
                            cell.isToday ? 'is-today' : '',
                          ].join(' ')}
                          aria-label={`${dateLabel(cell.date)}: ${label}`}
                          aria-current={cell.isToday ? 'date' : undefined}
                          aria-pressed={selected === cell.date}
                          disabled={cell.isFuture}
                          data-date={cell.date}
                          data-count={cell.count}
                          onClick={() => selectDay(cell.date!, isMissed)}
                        >
                          <span>{cell.day}</span>
                          {cell.count > 0 && (
                            <Check className="tracker-day-mark" aria-hidden="true" />
                          )}
                          {isMissed && <X className="tracker-day-mark" aria-hidden="true" />}
                          {isRepaired && <Heart className="tracker-day-mark" aria-hidden="true" />}
                        </button>
                      )}
                    </td>
                  );
                })}
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
            {dateLabel(selected).replace(/, \d{4}$/, '')} ·{' '}
            {repaired.has(selected) && !selectedCount
              ? 'Streak repaired'
              : `${selectedCount} accepted`}
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
        <div className="tracker-hearts">
          <strong
            aria-label={
              streak
                ? `${streak.hearts} ${streak.hearts === 1 ? 'heart' : 'hearts'} available`
                : 'Hearts unavailable'
            }
          >
            <Heart size={17} fill="currentColor" aria-hidden="true" />
            <span data-testid="tracker-hearts">{streak ? streak.hearts : '—'}</span>
          </strong>
          <div title="Earn one heart for every five solved days in a streak. Repaired days do not earn hearts.">
            <span data-testid="tracker-heart-progress">
              {streak ? `${streak.heartProgress}/5` : '—/5'} to next
            </span>
            <progress
              max={5}
              value={streak?.heartProgress ?? 0}
              aria-label="Solved days toward next heart"
            />
          </div>
        </div>
      </section>
      {repairDate && (
        <Modal
          title="Repair streak"
          onClose={() => {
            if (!repairInFlight.current) setRepairDate(null);
          }}
        >
          <div className="tracker-repair-dialog">
            <p>Use one heart to repair {dateLabel(repairDate)}?</p>
            <p className="tracker-repair-explanation">
              This day will count toward your streak, not your solved problems or heart rewards.
            </p>
            {!history ? (
              <p role="alert">Load activity before repairing this day.</p>
            ) : (
              !streak?.hearts && (
                <p>No hearts available. Solve on five days in a streak to earn one.</p>
              )
            )}
            {repairError && (
              <p className="tracker-repair-error" role="alert">
                {repairError}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button"
                type="button"
                disabled={repairPending}
                onClick={() => setRepairDate(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                disabled={repairPending || !history || !streak?.hearts}
                onClick={() => void confirmRepair()}
              >
                {repairPending ? 'Repairing…' : 'Use 1 heart'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </aside>
  );
}
