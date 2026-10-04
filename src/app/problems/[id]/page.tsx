'use client';

import { use, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  EmptyState,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileQuestion,
  List,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { Problem } from '../../../schemas/catalog';
import type { Attempt } from '../../../schemas/progress';
import { ProgressWarning, useAppData } from '../../../components/AppProvider';
import type { ProblemTab } from '../../../components/ProblemPanel';
import Results from '../../../components/Results';
import TopBar from '../../../components/TopBar';
import { useRunner } from '../../../hooks/useRunner';

const CodeEditor = dynamic(() => import('../../../components/CodeEditor'), { ssr: false });
const ProblemPanel = dynamic(() => import('../../../components/ProblemPanel'));
const BORDER = '1px solid var(--mantine-color-dark-4)';

// "/problems/[id]": the problem, its code editor, and Run/Submit results.
export default function ProblemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = use(params);
  const initialTab = use(searchParams).tab === 'solution' ? 'solution' : 'question';
  const { catalog } = useAppData();
  const problem = catalog.problems.find((item) => item.id === id);
  if (!problem)
    return (
      <main>
        <EmptyState mt={120} icon={<FileQuestion size={25} />}>
          <EmptyState.Title order={1}>Problem not found</EmptyState.Title>
          <EmptyState.Actions>
            <Button component={Link} href="/">
              Back to practice
            </Button>
          </EmptyState.Actions>
        </EmptyState>
      </main>
    );
  return <ProblemView key={problem.id} problem={problem} initialTab={initialTab} />;
}

function ProblemView({ problem, initialTab }: { problem: Problem; initialTab: ProblemTab }) {
  const router = useRouter();
  const { catalog, store } = useAppData();
  const problems = catalog.problems;
  const { progress: data } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [showReset, setShowReset] = useState(false);
  const [mobilePane, setMobilePane] = useState('problem');
  const [viewAttempt, setViewAttempt] = useState<Attempt | null>(null);
  const code = data.exercises[problem.id]?.draft ?? problem.starterCode;
  const attempts = data.exercises[problem.id]?.attempts ?? [];
  const currentIndex = problems.findIndex((item) => item.id === problem.id);
  const showCode = useCallback(() => setMobilePane('code'), []);
  const {
    execution,
    running,
    stopping,
    notice,
    setNotice,
    consoleOpen,
    setConsoleOpen,
    execute,
    cancel,
    clearResult,
  } = useRunner(store, problem, code, showCode);

  useEffect(() => {
    document.title = `${problem.title} · Code Practice`;
  }, [problem.title]);

  // Leaving unmounts this page, so useRunner stops watching; a submission keeps running.
  const openProblem = (next: Problem) => router.push(`/problems/${encodeURIComponent(next.id)}`);

  const updateDraft = useCallback(
    (next: string) => store.setDraft(problem.id, next),
    [store, problem.id],
  );
  const showCodeLimit = useCallback(() => {
    setNotice('That edit was not applied: code is limited to 32,768 characters (50 KiB).');
  }, [setNotice]);

  function resetDraft() {
    updateDraft(problem.starterCode);
    setShowReset(false);
    clearResult();
  }
  // On narrow screens, one pane shows at a time; wider screens show both side by side.
  const pane = (name: string) => ({ base: mobilePane === name ? 'flex' : 'none', sm: 'flex' });

  return (
    <Stack h="100dvh" gap={0}>
      <TopBar>
        <Group gap={4} wrap="nowrap">
          <Button
            component={Link}
            href="/"
            variant="subtle"
            color="gray"
            leftSection={<List size={17} />}
            aria-label="Back to practice"
          >
            {problem.deck}
          </Button>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Previous problem"
            disabled={currentIndex <= 0}
            onClick={() => openProblem(problems[currentIndex - 1])}
          >
            <ChevronLeft size={17} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Next problem"
            disabled={currentIndex < 0 || currentIndex >= problems.length - 1}
            onClick={() => openProblem(problems[currentIndex + 1])}
          >
            <ChevronRight size={17} />
          </ActionIcon>
        </Group>
      </TopBar>
      <ProgressWarning store={store} />
      <SegmentedControl
        hiddenFrom="sm"
        fullWidth
        radius={0}
        value={mobilePane}
        onChange={setMobilePane}
        data={[
          { value: 'problem', label: 'Problem' },
          { value: 'code', label: 'Code & results' },
        ]}
      />
      <Box component="main" flex={1} mih={0} display="flex">
        <Box flex={1} miw={0} display={pane('problem')} style={{ borderRight: BORDER }}>
          <ProblemPanel
            problem={problem}
            solved={Boolean(data.exercises[problem.id]?.solved)}
            attempts={attempts}
            initialTab={initialTab}
            onViewAttempt={setViewAttempt}
          />
        </Box>
        <Box
          component="section"
          aria-label="Coding workspace"
          flex={1}
          miw={0}
          display={pane('code')}
          style={{ flexDirection: 'column' }}
        >
          <Group justify="space-between" px="md" py={6}>
            <Text fw={600}>{problem.language}</Text>
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              leftSection={<RotateCcw size={15} />}
              disabled={running}
              onClick={() => setShowReset(true)}
              title="Reset code"
            >
              Reset
            </Button>
          </Group>
          <Box flex={1} mih={80}>
            <CodeEditor
              code={code}
              language={problem.language}
              onChange={updateDraft}
              onLimit={showCodeLimit}
              readOnly={running && !execution?.jobState}
            />
          </Box>
          {notice && (
            <Alert
              color="yellow"
              radius={0}
              withCloseButton
              closeButtonLabel="Dismiss message"
              onClose={() => setNotice('')}
            >
              {notice}
            </Alert>
          )}
          {consoleOpen && (
            <Paper
              component="section"
              aria-labelledby="console-results-title"
              radius={0}
              p="md"
              mah="45%"
              style={{ overflow: 'auto', borderTop: BORDER }}
            >
              <Title id="console-results-title" order={2} size="h6" mb="sm">
                Results
              </Title>
              <Results
                execution={execution}
                running={running}
                stale={execution?.code !== undefined && execution.code !== code}
              />
            </Paper>
          )}
          <Group justify="space-between" px="md" py="xs" style={{ borderTop: BORDER }}>
            <Button
              variant="subtle"
              color="gray"
              rightSection={consoleOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              aria-label="Console"
              aria-expanded={consoleOpen}
              onClick={() => setConsoleOpen((value) => !value)}
            >
              Console
            </Button>
            <Group gap="xs">
              {running || stopping ? (
                <Button
                  color="red"
                  leftSection={<Square size={14} />}
                  onClick={() => void cancel()}
                  disabled={stopping || execution?.jobState === 'canceling'}
                >
                  {stopping || execution?.jobState === 'canceling' ? 'Stopping…' : 'Stop'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="default"
                    onClick={() => void execute('example')}
                    aria-label="Run example"
                    title="Run example · Ctrl+Enter"
                  >
                    Run
                  </Button>
                  <Button onClick={() => void execute('submit')} title="Ctrl+Shift+Enter">
                    Submit
                  </Button>
                </>
              )}
            </Group>
          </Group>
        </Box>
      </Box>
      <Modal opened={showReset} onClose={() => setShowReset(false)} title="Reset this solution?">
        <Text fz="sm">
          This replaces your current draft with the starter code. Your past submissions and solved
          status will stay.
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setShowReset(false)}>
            Keep editing
          </Button>
          <Button onClick={resetDraft}>Reset code</Button>
        </Group>
      </Modal>
      <Modal
        opened={viewAttempt !== null}
        onClose={() => setViewAttempt(null)}
        title="Saved submission"
        size="xl"
      >
        {viewAttempt && (
          <>
            <Text fz="sm" c="dimmed" mb="sm">
              {new Date(viewAttempt.at).toLocaleString()} · {viewAttempt.passed}/{viewAttempt.total}{' '}
              passed
            </Text>
            <Paper withBorder mah="52dvh" style={{ overflow: 'auto' }}>
              <CodeEditor code={viewAttempt.code} language={problem.language} readOnly />
            </Paper>
            <Group justify="flex-end" mt="md">
              <Button
                variant="default"
                leftSection={<ArrowLeft size={15} />}
                onClick={() => setViewAttempt(null)}
              >
                Back to editor
              </Button>
            </Group>
          </>
        )}
      </Modal>
    </Stack>
  );
}
