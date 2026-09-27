import { memo } from 'react';
import { ActionIcon, Button, Table, Text, UnstyledButton } from '@mantine/core';
import { ArrowDown, ArrowUp, ArrowUpDown, Circle, CircleCheck, FileText, Star } from 'lucide-react';
import type { Problem } from '../schemas/catalog';
import type { ProgressData } from '../schemas/progress';
import type { ProblemSort } from '../hooks/useProblemList';
import { DIFFICULTY_COLORS } from '../lib/theme';

type SortKey = 'title' | 'difficulty';

// Opening a deck changes only its disclosure shell, not its problem rows.
const ProblemTable = memo(function ProblemTable({
  items,
  label,
  progress,
  starred,
  sort,
  onSort,
  onSelect,
  onStar,
  onSolved,
}: {
  items: Problem[];
  label: string;
  progress: ProgressData;
  starred: string[];
  sort: ProblemSort;
  onSort: (key: SortKey) => void;
  onSelect: (problem: Problem, tab?: 'question' | 'solution') => void;
  onStar: (id: string, value: boolean) => void;
  onSolved: (problem: Problem, value: boolean) => void;
}) {
  const stars = new Set(starred);
  const sortHeader = (key: SortKey, text: string) => {
    const Icon =
      sort?.key !== key ? ArrowUpDown : sort.direction === 'ascending' ? ArrowUp : ArrowDown;
    return (
      <Table.Th aria-sort={sort?.key === key ? sort.direction : 'none'}>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          rightSection={<Icon size={12} />}
          onClick={() => onSort(key)}
        >
          {text}
        </Button>
      </Table.Th>
    );
  };
  return (
    <Table highlightOnHover aria-label={label}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={70}>Status</Table.Th>
          <Table.Th w={60}>Star</Table.Th>
          {sortHeader('title', 'Problem')}
          {sortHeader('difficulty', 'Difficulty')}
          <Table.Th w={80}>Solution</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((problem) => {
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
                <ActionIcon
                  variant="subtle"
                  color={solved ? 'teal' : 'gray'}
                  aria-label={`Mark ${problem.title} ${solved ? 'incomplete' : 'complete'}`}
                  aria-pressed={solved}
                  title={solved ? 'Mark incomplete' : 'Mark complete'}
                  onClick={() => onSolved(problem, !solved)}
                >
                  {solved ? <CircleCheck size={18} /> : <Circle size={17} />}
                </ActionIcon>
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
