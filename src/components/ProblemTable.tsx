import { memo } from 'react';
import { ActionIcon, Table, Text, UnstyledButton } from '@mantine/core';
import { Circle, CircleCheck, FileText, Star } from 'lucide-react';
import type { Problem } from '../schemas/catalog';
import type { ProgressData } from '../schemas/progress';
import { DIFFICULTY_COLORS } from '../lib/theme';

// Opening a deck changes only its disclosure shell, not its problem rows.
const ProblemTable = memo(function ProblemTable({
  items,
  label,
  progress,
  starred,
  onSelect,
  onStar,
}: {
  items: Problem[];
  label: string;
  progress: ProgressData;
  starred: string[];
  onSelect: (problem: Problem, tab?: 'question' | 'solution') => void;
  onStar: (id: string, value: boolean) => void;
}) {
  const stars = new Set(starred);
  return (
    <Table highlightOnHover aria-label={label}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={70}>Status</Table.Th>
          <Table.Th w={60}>Star</Table.Th>
          <Table.Th>Problem</Table.Th>
          <Table.Th>Difficulty</Table.Th>
          <Table.Th w={80}>Solution</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((problem) => {
          // Solved comes only from an accepted submission.
          const solved = Boolean(progress.exercises[problem.id]?.solved);
          const isStarred = stars.has(problem.id);
          return (
            <Table.Tr
              key={problem.id}
              style={{ cursor: 'pointer' }}
              onClick={(event) => {
                // The whole row opens the problem; its buttons keep their own actions.
                if (event.target instanceof Element && event.target.closest('button')) return;
                onSelect(problem);
              }}
            >
              <Table.Td>
                {solved ? (
                  <CircleCheck size={18} color="var(--mantine-color-teal-5)" aria-label="Solved" />
                ) : (
                  <Circle size={17} color="var(--mantine-color-dark-2)" aria-label="Not solved" />
                )}
              </Table.Td>
              <Table.Td>
                <ActionIcon
                  variant="subtle"
                  color={isStarred ? 'yellow' : 'gray'}
                  aria-label={`${isStarred ? 'Unstar' : 'Star'} ${problem.title}`}
                  aria-pressed={isStarred}
                  onClick={() => onStar(problem.id, !isStarred)}
                >
                  <Star size={19} fill={isStarred ? 'currentColor' : 'none'} />
                </ActionIcon>
              </Table.Td>
              <Table.Td>
                <UnstyledButton fw={600} onClick={() => onSelect(problem)}>
                  {problem.title}
                </UnstyledButton>
              </Table.Td>
              <Table.Td>
                <Text span fz="sm" c={DIFFICULTY_COLORS[problem.difficulty]}>
                  {problem.difficulty}
                </Text>
              </Table.Td>
              <Table.Td>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`View solution for ${problem.title}`}
                  onClick={() => onSelect(problem, 'solution')}
                >
                  <FileText size={17} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
});

export default ProblemTable;
