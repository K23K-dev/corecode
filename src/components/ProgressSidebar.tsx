import { Box, Group, Paper, RingProgress, Stack, Text, Title } from '@mantine/core';
import { BarChart3 } from 'lucide-react';
import type { Problem } from '../schemas/catalog';
import type { ProgressData } from '../schemas/progress';
import { DIFFICULTIES, DIFFICULTY_COLORS } from '../lib/theme';

// Solved counts per difficulty, and a ring with one colored section per difficulty.
export default function ProgressSidebar({
  problems,
  progress,
}: {
  problems: Problem[];
  progress: ProgressData;
}) {
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
    <Box component="aside" aria-label="Practice tracker" w={{ base: '100%', lg: 290 }}>
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
    </Box>
  );
}
