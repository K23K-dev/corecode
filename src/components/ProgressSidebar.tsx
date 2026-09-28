import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Flex,
  Group,
  Indicator,
  Paper,
  RingProgress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { Calendar } from '@mantine/dates';
import { BarChart3, Flame, Trophy } from 'lucide-react';
import { requestJson } from '../lib/api';
import {
  activityDays,
  ActivityHistorySchema,
  localDateKey,
  summarizeActivity,
  type ActivityHistory,
} from '../schemas/activity';
import type { Problem } from '../schemas/catalog';
import type { ProgressData } from '../schemas/progress';
import { DIFFICULTIES, DIFFICULTY_COLORS } from '../lib/theme';

/** Formats a YYYY-MM-DD calendar date without shifting it into another time zone. */
const formatDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );

/** Solved counts per difficulty, and a ring with one colored section per difficulty. */
function ProgressSummary({ problems, progress }: { problems: Problem[]; progress: ProgressData }) {
  const totals = DIFFICULTIES.map((difficulty) => {
    const items = problems.filter((item) => item.difficulty === difficulty);
    return {
      difficulty,
      total: items.length,
      solved: items.filter((item) => progress.exercises[item.id]?.solved).length,
    };
  });
  const solved = totals.reduce((sum, item) => sum + item.solved, 0);
  return (
    <Paper withBorder p="md" component="section" aria-label="Your progress">
      <Group gap={6}>
        <BarChart3 size={17} />
        <Title order={2} size="h5">
          Your progress
        </Title>
      </Group>
      <Group justify="space-between" wrap="nowrap" mt="xs">
        <Stack gap={6}>
          {totals.map((item) => (
            <Group key={item.difficulty} gap="xs" wrap="nowrap">
              <Text w={64} fz="sm" fw={600} c={DIFFICULTY_COLORS[item.difficulty]}>
                {item.difficulty}
              </Text>
              <Text fz="sm">
                {item.solved}
                <Text span c="dimmed" inherit>
                  /{item.total}
                </Text>
              </Text>
            </Group>
          ))}
        </Stack>
        <RingProgress
          size={112}
          thickness={8}
          roundCaps
          role="img"
          aria-label={`${solved} of ${problems.length} problems solved`}
          // Round caps would draw an empty difficulty as a dot, so skip those.
          sections={totals
            .filter((item) => item.solved > 0)
            .map((item) => ({
              value: problems.length ? (item.solved / problems.length) * 100 : 0,
              color: DIFFICULTY_COLORS[item.difficulty],
            }))}
          label={
            <Stack gap={0} align="center">
              <Text fw={700}>
                {solved}
                <Text span c="dimmed" fz="xs">
                  /{problems.length}
                </Text>
              </Text>
              <Text c="dimmed" fz="xs">
                Solved
              </Text>
            </Stack>
          }
        />
      </Group>
    </Paper>
  );
}

function Streak({ icon, label, days }: { icon: ReactNode; label: string; days?: number }) {
  return (
    <div>
      <Text fz="xs" c="dimmed">
        {label}
      </Text>
      <Group gap={6} fw={700}>
        {icon}
        {days === undefined ? '—' : `${days} ${days === 1 ? 'day' : 'days'}`}
      </Group>
    </div>
  );
}

export default function ProgressSidebar({
  problems,
  progress,
}: {
  problems: Problem[];
  progress: ProgressData;
}) {
  const today = localDateKey(new Date());
  const [history, setHistory] = useState<ActivityHistory | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  // Only accepted submissions change activity, so reload it when one appears.
  const acceptedKey = Object.values(progress.exercises)
    .flatMap((item) =>
      item.attempts.filter((attempt) => attempt.status === 'accepted').map((attempt) => attempt.id),
    )
    .sort()
    .join('|');

  useEffect(() => {
    let current = true;
    setError('');
    void requestJson('/api/activity', { timeoutMs: 15_000 })
      .then(({ value }) => current && setHistory(ActivityHistorySchema.parse(value)))
      .catch(() => current && setError('Activity could not be loaded.'));
    return () => {
      current = false;
    };
  }, [acceptedKey, retry]);

  const days = useMemo(() => activityDays(history?.accepted ?? []), [history]);
  const counts = useMemo(() => new Map(days.map(({ date, count }) => [date, count])), [days]);
  const streak = history ? summarizeActivity(days, today) : undefined;

  return (
    <Flex
      component="aside"
      aria-label="Practice tracker"
      direction="column"
      gap="md"
      w={{ base: '100%', lg: 290 }}
    >
      <ProgressSummary problems={problems} progress={progress} />
      <Paper withBorder p="md" component="section" aria-label="Practice calendar">
        <Calendar
          size="sm"
          maxDate={today}
          maxLevel="month"
          firstDayOfWeek={0}
          weekendDays={[]}
          highlightToday
          ariaLabels={{ previousMonth: 'Previous month', nextMonth: 'Next month' }}
          getDayAriaLabel={(date) =>
            `${formatDate(date, { dateStyle: 'long' })}: ${counts.get(date) ?? 0} accepted`
          }
          renderDay={(date) => (
            <Indicator size={6} color="teal" offset={-4} disabled={!counts.get(date)}>
              <div>{Number(date.slice(8))}</div>
            </Indicator>
          )}
        />
        {error && (
          <Group justify="space-between" mt="xs" role="alert">
            <Text fz="sm" c="red">
              {error}
            </Text>
            <Button
              size="compact-sm"
              variant="light"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry activity
            </Button>
          </Group>
        )}
        <Group grow mt="md">
          <Streak icon={<Flame size={20} />} label="Current streak" days={streak?.current} />
          <Streak icon={<Trophy size={20} />} label="Best streak" days={streak?.best} />
        </Group>
      </Paper>
    </Flex>
  );
}
