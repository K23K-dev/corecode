import { useEffect, useState } from 'react';
import { Alert, Button, Code, EmptyState, Group, Loader, Stack, Text } from '@mantine/core';
import { Check, CircleAlert, CircleCheck, Terminal, X } from 'lucide-react';
import type { JobSnapshot, RunResult } from '../lib/runner';

export interface Execution {
  mode: 'example' | 'submit';
  result?: RunResult;
  error?: string;
  code?: string;
  jobState?: JobSnapshot['state'];
}

/** One labeled output box; a colored edge marks a passing or failing value. */
function Value({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <section aria-label={label}>
      <Text fz="xs" c="dimmed" mb={4}>
        {label}
      </Text>
      <Code
        block
        mah={240}
        style={{
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          borderLeft: color && `3px solid var(--mantine-color-${color}-6)`,
        }}
      >
        {value}
      </Code>
    </section>
  );
}

export default function Results({
  execution,
  running,
  stale = false,
}: {
  execution: Execution | null;
  running: boolean;
  stale?: boolean;
}) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [execution]);
  if (running)
    return (
      <EmptyState
        role="status"
        icon={<Loader size="sm" />}
        title={
          execution?.jobState === 'queued'
            ? 'Submission queued'
            : execution?.jobState === 'canceling'
              ? 'Canceling submission…'
              : execution?.mode === 'submit'
                ? 'Grading your submission…'
                : 'Running your code…'
        }
        description={
          execution?.jobState
            ? 'You can leave this page and return to your result.'
            : 'You can stop this run at any time.'
        }
      />
    );
  if (!execution)
    return (
      <EmptyState
        icon={<Terminal size={25} />}
        title="Try your solution"
        description="Run checks the first example; Submit checks every case."
      />
    );
  const staleNotice = stale && (
    <Text fz="sm" c="yellow" role="status">
      Your code has changed. These results are from the previous run.
    </Text>
  );
  const failure = execution.error || execution.result?.error;
  if (failure)
    return (
      <Stack gap="xs">
        {staleNotice}
        <Alert
          color="red"
          icon={<CircleAlert size={19} />}
          title={execution.mode === 'submit' ? 'Submission stopped' : 'Run stopped'}
        >
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {failure}
          </Code>
          <Text fz="sm" mt="xs">
            Your code is still saved.
          </Text>
        </Alert>
      </Stack>
    );
  const result = execution.result;
  if (!result) return null;
  const passed = result.cases.filter((test) => test.passed).length;
  const success = passed === result.cases.length && result.cases.length > 0;
  const test = result.cases[active] ?? result.cases[0];
  return (
    <Stack gap="sm">
      {staleNotice}
      <Group gap="xs" role="status">
        {success ? (
          <CircleCheck size={20} color="var(--mantine-color-teal-5)" />
        ) : (
          <CircleAlert size={20} color="var(--mantine-color-red-5)" />
        )}
        <Text fw={700} fz="lg" c={success ? 'teal' : 'red'}>
          {success
            ? execution.mode === 'submit'
              ? 'Accepted'
              : 'Example passed'
            : 'Not quite yet'}
        </Text>
        <Text fz="sm" c="dimmed">
          {passed} / {result.cases.length} cases passed
        </Text>
      </Group>
      <Group gap={6} aria-label="Test cases">
        {result.cases.map((item, index) => (
          <Button
            key={index}
            size="compact-sm"
            variant={active === index ? 'light' : 'subtle'}
            color={item.passed ? 'teal' : 'red'}
            leftSection={item.passed ? <Check size={13} /> : <X size={13} />}
            aria-pressed={active === index}
            aria-label={`Case ${index + 1}: ${item.passed ? 'passed' : 'failed'}`}
            title={item.name}
            onClick={() => setActive(index)}
          >
            Case {index + 1}
          </Button>
        ))}
      </Group>
      {test && (
        <Stack gap="xs">
          <Value label="Input" value={test.input} />
          <Value
            label={test.error ? 'Error' : 'Your Output'}
            value={test.error ?? test.actual ?? '(no output)'}
            color={test.error || test.passed === false ? 'red' : test.passed ? 'teal' : undefined}
          />
          {test.expected !== undefined && <Value label="Expected Output" value={test.expected} />}
        </Stack>
      )}
      {result.stdout && (
        <details open>
          <summary>Console output</summary>
          <Code block mt="xs" mah={180} style={{ overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {result.stdout}
          </Code>
        </details>
      )}
    </Stack>
  );
}
