import {
  Badge,
  Code,
  EmptyState,
  Group,
  List,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { Check, ChevronRight, Code2, FileCode2, History, X } from 'lucide-react';
import CodeEditor from './CodeEditor';
import FrontendPreview from './FrontendPreview';
import type { Problem } from '../schemas/catalog';
import type { Attempt } from '../schemas/progress';
import { DIFFICULTY_COLORS } from '../lib/theme';

export type ProblemTab = 'question' | 'solution' | 'history';

type ProblemPanelProps = {
  problem: Problem;
  solved: boolean;
  attempts: Attempt[];
  tab: ProblemTab;
  onTabChange: (tab: ProblemTab) => void;
  onViewAttempt: (attempt: Attempt) => void;
};

const STATUS_LABELS = { accepted: 'Accepted', failed: 'Not accepted', error: 'Run error' };

export default function ProblemPanel({
  problem,
  solved,
  attempts,
  tab,
  onTabChange,
  onViewAttempt,
}: ProblemPanelProps) {
  return (
    <Tabs
      value={tab}
      onChange={(value) => value && onTabChange(value as ProblemTab)}
      keepMounted={false}
      aria-label="Problem description"
      flex={1}
      miw={0}
      display="flex"
      style={{ flexDirection: 'column' }}
    >
      <Tabs.List>
        <Tabs.Tab value="question" leftSection={<FileCode2 size={16} />}>
          Question
        </Tabs.Tab>
        <Tabs.Tab value="solution" leftSection={<Code2 size={16} />}>
          Solution
        </Tabs.Tab>
        <Tabs.Tab
          value="history"
          leftSection={<History size={16} />}
          rightSection={attempts.length > 0 && <Badge size="xs">{attempts.length}</Badge>}
        >
          Submissions
        </Tabs.Tab>
      </Tabs.List>
      <ScrollArea flex={1} mih={0}>
        <Tabs.Panel value="question" p="lg">
          <Question problem={problem} solved={solved} />
        </Tabs.Panel>
        <Tabs.Panel value="solution" p="lg">
          <ReferenceSolution problem={problem} />
        </Tabs.Panel>
        <Tabs.Panel value="history" p="lg">
          <SubmissionHistory attempts={attempts} onViewAttempt={onViewAttempt} />
        </Tabs.Panel>
      </ScrollArea>
    </Tabs>
  );
}

function Question({ problem, solved }: { problem: Problem; solved: boolean }) {
  // React previews would need a bundler, so those problems show their examples instead.
  const preview = problem.preview && !['jsx', 'tsx'].includes(problem.extension);
  return (
    <Stack>
      <Group gap="xs">
        <Title order={1} size="h3">
          {problem.title}
        </Title>
        {solved && <Check size={21} color="var(--mantine-color-teal-5)" aria-label="Solved" />}
      </Group>
      <Group gap="xs">
        <Badge variant="light" color={DIFFICULTY_COLORS[problem.difficulty]}>
          {problem.difficulty}
        </Badge>
        {problem.topic && problem.topic !== problem.language && (
          <Badge variant="default">{problem.topic}</Badge>
        )}
      </Group>
      <Text style={{ whiteSpace: 'pre-line' }}>{problem.prompt}</Text>
      {preview && <FrontendPreview key={`${problem.id}:${problem.version}`} problem={problem} />}
      {!preview &&
        problem.examples?.map((example, index) => (
          <div key={index}>
            <Title order={2} size="h6" mb={6}>
              Example {index + 1}:
            </Title>
            <Code block>
              {`${example.inputLabel ?? 'Input'}: ${example.input}\n${example.outputLabel ?? 'Output'}: ${example.output}`}
            </Code>
          </div>
        ))}
      {!!problem.requirements?.length && (
        <div>
          <Title order={2} size="h6" mb={6}>
            Requirements:
          </Title>
          <List size="sm" spacing={4}>
            {problem.requirements.map((item) => (
              <List.Item key={item}>{item}</List.Item>
            ))}
          </List>
        </div>
      )}
    </Stack>
  );
}

function ReferenceSolution({ problem }: { problem: Problem }) {
  return (
    <Stack>
      <Title order={1} size="h3">
        Reference solution
      </Title>
      {problem.explanation && <Text>{problem.explanation}</Text>}
      <Paper withBorder>
        <CodeEditor code={problem.referenceCode} language={problem.language} readOnly />
      </Paper>
      {problem.solutionAlternatives?.map((alternative) => (
        <Stack key={alternative.title} gap="xs">
          <Title order={2} size="h5">
            {alternative.title}
          </Title>
          <Text>{alternative.explanation}</Text>
          <Paper withBorder>
            <CodeEditor code={alternative.code} language={problem.language} readOnly />
          </Paper>
          {alternative.complexity && (
            <Text fz="sm" c="dimmed">
              {alternative.complexity}
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

function SubmissionHistory({
  attempts,
  onViewAttempt,
}: Pick<ProblemPanelProps, 'attempts' | 'onViewAttempt'>) {
  if (!attempts.length)
    return (
      <EmptyState
        icon={<History size={25} />}
        title="No submissions yet"
        description="Your last 20 submissions for this problem will appear here."
      />
    );
  return (
    <Stack gap={4}>
      <Title order={1} size="h3" mb="xs">
        Your submissions
      </Title>
      {[...attempts].reverse().map((attempt) => (
        <NavLink
          key={attempt.id}
          component="button"
          active
          variant="subtle"
          color={attempt.status === 'accepted' ? 'teal' : 'red'}
          leftSection={attempt.status === 'accepted' ? <Check size={16} /> : <X size={16} />}
          label={STATUS_LABELS[attempt.status]}
          description={`${attempt.passed}/${attempt.total} passed · ${new Date(attempt.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
          rightSection={<ChevronRight size={15} />}
          onClick={() => onViewAttempt(attempt)}
        />
      ))}
    </Stack>
  );
}
